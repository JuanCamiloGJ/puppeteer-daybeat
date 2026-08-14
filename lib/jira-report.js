/**
 * lib/jira-report.js
 *
 * Módulo autocontenido de actividad diaria en Jira (issues + comentarios + worklogs).
 *
 * Usa el MCP oficial de Atlassian (Rovo MCP Server) para buscar incidencias y,
 * como complemento, la REST API de Jira Cloud para comentarios y worklogs del día
 * (el MCP oficial no expone herramientas de comentarios ni lectura de worklogs).
 *
 * Autenticación — dos modos, ninguno depende del admin de la organización:
 *   1. OAuth 2.1 (default): flujo interactivo UNA sola vez (abre el navegador),
 *      tokens persistidos en .daybeat-jira-tokens.json y refresh automático
 *      en ejecuciones siguientes. Se activa con ATLASSIAN_ENABLED=true
 *      (el navegador trae la identidad: no hace falta email ni token).
 *   2. API token (si ATLASSIAN_EMAIL + ATLASSIAN_API_TOKEN están definidos):
 *      Basic auth silenciosa para REST. El MCP oficial con API token exige
 *      que la org lo habilite; si eso falla, los issues se degradan pero
 *      REST sigue funcionando.
 *
 * Configuración (env):
 *   ATLASSIAN_ENABLED     — activa el módulo (modo OAuth)
 *   ATLASSIAN_EMAIL       — email de la cuenta Atlassian (solo modo API token)
 *   ATLASSIAN_API_TOKEN   — opcional; con EMAIL activa Basic en vez de OAuth
 *   ATLASSIAN_CLOUD_ID    — opcional; si no se define, se autodetecta
 *   ATLASSIAN_SITE_URL    — opcional; base REST (https://x.atlassian.net) para modo Basic
 *   ATLASSIAN_MCP_URL     — opcional; endpoint MCP (default según el modo de auth)
 *
 * API pública:
 *   isConfigured()
 *   getDailyActivity(date)          → { date, jql, issues[], comments[], worklogs[] }
 *   formatActivityForReport(data)   → texto legible para consola / contexto de IA
 *   closeConnection()
 *
 * Nunca lanza errores hacia el flujo de registro: las funciones devuelven
 * datos vacíos o null y el consumidor decide cómo degradar.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { exec } = require('child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { auth } = require('@modelcontextprotocol/sdk/client/auth.js');

const MCP_URL_BASIC = 'https://mcp.atlassian.com/v1/mcp';
const MCP_URL_OAUTH = 'https://mcp.atlassian.com/v1/mcp/authv2';
const TOKEN_STORE_PATH = path.join(__dirname, '..', '.daybeat-jira-tokens.json');
const OAUTH_TIMEOUT_MS = 180000;
const PAGE_SIZE = 50;
const MAX_ISSUES = 150;
const MAX_ISSUES_DETAILED = 20;
const MAX_COMMENTS_PER_ISSUE = 100;
const MAX_WORKLOGS_PER_ISSUE = 100;
const MAX_TEXT_LENGTH = 150;

let mcpClient = null;
let mcpTransport = null;
let session = null;
let oauthProvider = null;

// ---------------------------------------------------------------------------
// Configuración / auth
// ---------------------------------------------------------------------------

const isConfigured = () =>
  process.env.ATLASSIAN_ENABLED === 'true' || Boolean(process.env.ATLASSIAN_EMAIL);

const isBasicMode = () => Boolean(process.env.ATLASSIAN_EMAIL && process.env.ATLASSIAN_API_TOKEN);

const isOAuthMode = () => isConfigured() && !isBasicMode();

const MCP_URL = process.env.ATLASSIAN_MCP_URL || (isOAuthMode() ? MCP_URL_OAUTH : MCP_URL_BASIC);

const getBasicAuthHeader = () => {
  if (!isBasicMode()) return null;
  const raw = `${process.env.ATLASSIAN_EMAIL}:${process.env.ATLASSIAN_API_TOKEN}`;
  return `Basic ${Buffer.from(raw).toString('base64')}`;
};

// ---------------------------------------------------------------------------
// Almacén de tokens OAuth (.daybeat-jira-tokens.json)
// ---------------------------------------------------------------------------

const readStore = () => {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_STORE_PATH, 'utf8'));
  } catch (err) {
    return {};
  }
};

const writeStore = (data) => {
  try {
    fs.writeFileSync(TOKEN_STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.log(`  [Jira] No se pudo guardar el token OAuth: ${err.message}`);
  }
};

const openBrowser = (url) => {
  // HEADLESS=true: no abrir ventana del navegador, solo mostrar la URL
  if (process.env.HEADLESS === 'true') {
    console.log('  [Jira] Modo headless: no se abrirá el navegador. Entrá a esta URL:\n  ' + url);
    return;
  }
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, { detached: true, stdio: 'ignore' }, () => {});
};

// Provider OAuth 2.1 (interfaz del SDK): DCR + authorization code con
// redirect loopback local + refresh automático. Flujo NO interactivo solo
// la primera vez (o cuando el refresh expira).
class OAuthProvider {
  constructor() {
    this._store = readStore();
    this._codePromise = null;
    this._resolveCode = null;
    this._rejectCode = null;
    this._authTimer = null;
    this._state = null;
    this._codeVerifier = null;
    this._server = http.createServer((req, res) => this._handleCallback(req, res));
  }

  async start() {
    await new Promise((resolve, reject) => {
      this._server.once('error', reject);
      this._server.listen(0, '127.0.0.1', resolve);
    });
    this._redirectUrl = `http://127.0.0.1:${this._server.address().port}/callback`;
    return this;
  }

  get redirectUrl() {
    return this._redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: 'daybeat-jira-report',
      redirect_uris: [this._redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'offline_access read:jira-work read:jira-user'
    };
  }

  clientInformation() {
    return this._store.clientInformation;
  }

  async saveClientInformation(info) {
    this._store.clientInformation = info;
    writeStore(this._store);
  }

  tokens() {
    return this._store.tokens;
  }

  async saveTokens(tokens) {
    this._store.tokens = tokens;
    writeStore(this._store);
  }

  state() {
    this._state = Math.random().toString(36).slice(2);
    return this._state;
  }

  saveCodeVerifier(verifier) {
    this._codeVerifier = verifier;
    this._store.codeVerifier = verifier;
    writeStore(this._store);
  }

  codeVerifier() {
    return this._codeVerifier || this._store.codeVerifier;
  }

  discoveryState() {
    return this._store.discoveryState;
  }

  async saveDiscoveryState(state) {
    this._store.discoveryState = state;
    writeStore(this._store);
  }

  invalidateCredentials(scope) {
    if (scope === 'all' || scope === 'client') this._store.clientInformation = undefined;
    if (scope === 'all' || scope === 'tokens') this._store.tokens = undefined;
    if (scope === 'all' || scope === 'verifier') {
      this._store.codeVerifier = undefined;
      this._codeVerifier = undefined;
    }
    if (scope === 'all' || scope === 'discovery') this._store.discoveryState = undefined;
    writeStore(this._store);
  }

  _handleCallback(req, res) {
    const url = new URL(req.url, this._redirectUrl);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h2>Autorización recibida.</h2><p>Ya podés cerrar esta pestaña y volver al script.</p>');

    if (this._authTimer) clearTimeout(this._authTimer);
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (error) {
      this._rejectCode?.(new Error(`Autorización rechazada: ${error}`));
      return;
    }
    if (!code) {
      this._rejectCode?.(new Error('La autorización no devolvió un código'));
      return;
    }
    if (state && this._state && state !== this._state) {
      this._rejectCode?.(new Error('State de OAuth inválido (posible ataque CSRF)'));
      return;
    }
    this._resolveCode?.(code);
  }

  async redirectToAuthorization(authorizationUrl) {
    this._codePromise = new Promise((resolve, reject) => {
      this._resolveCode = resolve;
      this._rejectCode = reject;
    });
    this._authTimer = setTimeout(() => {
      this._rejectCode?.(new Error('Se agotó el tiempo esperando la autorización en el navegador'));
    }, OAUTH_TIMEOUT_MS);

    console.log('\n  [Jira] Primera vez: hay que autorizar el acceso a Jira.');
    console.log(`  [Jira] Si el navegador no se abre solo, entrá a esta URL:\n  ${authorizationUrl}`);
    openBrowser(String(authorizationUrl));
  }

  waitForAuthorizationCode() {
    return this._codePromise;
  }

  async close() {
    if (this._authTimer) clearTimeout(this._authTimer);
    await new Promise((resolve) => {
      try {
        this._server.close(resolve);
      } catch (err) {
        resolve();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

const normalizeDate = (date) => {
  if (date instanceof Date) return date;
  if (typeof date === 'string') {
    const parts = date.split('/');
    if (parts.length === 3) {
      return new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
    }
    return new Date(date);
  }
  return new Date();
};

const toJqlDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const toDaybeatDate = (d) =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

const toIsoUtcMidnight = (d) =>
  `${toJqlDate(d)}T00:00:00.000+0000`;

const isSameLocalDay = (iso, target) => {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return false;
  return dt.getFullYear() === target.getFullYear()
    && dt.getMonth() === target.getMonth()
    && dt.getDate() === target.getDate();
};

// ---------------------------------------------------------------------------
// Cliente MCP (conexión única, lazy)
// ---------------------------------------------------------------------------

const ensureOAuthAuthorized = async () => {
  if (!oauthProvider) oauthProvider = await new OAuthProvider().start();

  let result = await auth(oauthProvider, { serverUrl: new URL(MCP_URL), fetchFn: fetch });
  if (result === 'AUTHORIZED') return;

  // REDIRECT: el usuario debe autorizar en el navegador (una sola vez)
  const code = await oauthProvider.waitForAuthorizationCode();
  result = await auth(oauthProvider, { serverUrl: new URL(MCP_URL), authorizationCode: code, fetchFn: fetch });
  if (result !== 'AUTHORIZED') {
    throw new Error('No se pudo completar la autorización OAuth');
  }
};

const connect = async () => {
  if (mcpClient) return mcpClient;

  if (isOAuthMode()) {
    await ensureOAuthAuthorized();
    mcpTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      authProvider: oauthProvider
    });
  } else {
    const basic = getBasicAuthHeader();
    if (!basic) {
      throw new Error('Faltan ATLASSIAN_EMAIL y/o ATLASSIAN_API_TOKEN para conectar con Jira');
    }
    mcpTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      headers: { Authorization: basic }
    });
  }

  mcpClient = new Client({ name: 'daybeat-jira-report', version: '1.0.0' });
  await mcpClient.connect(mcpTransport);
  return mcpClient;
};

const closeConnection = async () => {
  try {
    if (mcpClient) await mcpClient.close();
  } catch (err) {
    // Ignorar errores al cerrar
  }
  mcpClient = null;
  mcpTransport = null;
  session = null;
  if (oauthProvider) {
    await oauthProvider.close();
    oauthProvider = null;
  }
};

// ---------------------------------------------------------------------------
// Helpers de respuesta MCP
// ---------------------------------------------------------------------------

const parseToolResult = (result) => {
  if (!result) return null;
  if (result.isError) {
    const raw = JSON.stringify(result.content || {}).substring(0, 300);
    throw new Error(`Tool MCP falló: ${raw}`);
  }
  const text = (result.content || []).find(c => c.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    return text;
  }
};

// Busca el primer valor que cumpla el predicado recorriendo objetos y arrays
const deepFind = (obj, test, seen = new Set()) => {
  if (!obj || typeof obj !== 'object') return undefined;
  if (seen.has(obj)) return undefined;
  seen.add(obj);
  if (test(obj)) return obj;
  for (const key of Object.keys(obj)) {
    const found = deepFind(obj[key], test, seen);
    if (found !== undefined) return found;
  }
  return undefined;
};

const findIssuesArray = (parsed) => {
  if (!parsed || typeof parsed !== 'object') return [];
  const arr = deepFind(parsed, (v) =>
    Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' && /^[A-Z]+-\d+$/.test(v[0].key || v[0].id || '')
  );
  return Array.isArray(arr) ? arr : [];
};

const findTotal = (parsed) => {
  const node = deepFind(parsed, (v) => v && typeof v === 'object' && typeof v.total === 'number');
  return node && typeof node.total === 'number' ? node.total : null;
};

// Adapta los argumentos de una tool a su esquema real (nombres de campos varían)
const toolArgsCache = new Map();

const callTool = async (name, preferredArgs) => {
  const client = await connect();
  let args = { ...preferredArgs };

  if (!toolArgsCache.has(name)) {
    try {
      const { tools } = await client.listTools();
      const tool = tools.find(t => t.name === name);
      toolArgsCache.set(name, tool ? (tool.inputSchema || {}).properties || {} : null);
    } catch (err) {
      toolArgsCache.set(name, null);
    }
  }

  const props = toolArgsCache.get(name);
  if (props) {
    const filtered = {};
    for (const [key, value] of Object.entries(preferredArgs)) {
      if (props[key] !== undefined) filtered[key] = value;
    }
    args = filtered;
  }

  const result = await client.callTool({ name, arguments: args });
  return parseToolResult(result);
};

// ---------------------------------------------------------------------------
// Sesión: cloudId + accountId + configuración REST
// ---------------------------------------------------------------------------

const getUserInfo = async () => {
  try {
    const info = await callTool('atlassianUserInfo', {});
    const node = deepFind(info, (v) =>
      v &&
      typeof v === 'object' &&
      (typeof v.account_id === 'string' ||
        typeof v.accountId === 'string' ||
        typeof v.id === 'string' ||
        typeof v.email === 'string')
    );
    if (!node) return null;
    return {
      accountId: node.account_id || node.accountId || node.id || null,
      email: node.email || node.emailAddress || null
    };
  } catch (err) {
    return null;
  }
};

const buildSession = async (cloudId, siteUrl) => {
  const user = await getUserInfo();
  session = { cloudId, siteUrl, accountId: user?.accountId || null, email: user?.email || null };
  return session;
};

// ¿Este autor soy yo? Si no podemos identificarlo, NO incluir (seguro):
// mostrar comentarios de otros sería un falso positivo.
const isMyAuthor = (author) => {
  if (session?.accountId && author?.accountId) return author.accountId === session.accountId;
  if (session?.email && author?.emailAddress) return author.emailAddress === session.email;
  return false;
};

const getSession = async () => {
  if (session) return session;

  if (process.env.ATLASSIAN_CLOUD_ID) {
    return buildSession(process.env.ATLASSIAN_CLOUD_ID, process.env.ATLASSIAN_SITE_URL || null);
  }

  const resources = await callTool('getAccessibleAtlassianResources', {});
  const arr = Array.isArray(resources) ? resources : deepFind(resources, Array.isArray);
  const first = Array.isArray(arr) && arr.length > 0 ? arr[0] : null;

  if (!first || (!first.id && !first.cloudId)) {
    throw new Error('No se pudo determinar el cloudId de Atlassian (sin sitios accesibles)');
  }

  return buildSession(first.id || first.cloudId, first.url || null);
};

// ---------------------------------------------------------------------------
// REST API (complemento para comentarios y worklogs)
// ---------------------------------------------------------------------------

const restRequest = async (path) => {
  const s = await getSession();

  let base = null;
  let authHeader = null;
  if (isOAuthMode()) {
    const token = oauthProvider?.tokens()?.access_token;
    if (token) {
      base = `https://api.atlassian.com/ex/jira/${s.cloudId}`;
      authHeader = `Bearer ${token}`;
    }
  } else {
    base = s.siteUrl;
    authHeader = getBasicAuthHeader();
  }

  if (!base || !authHeader) return null;

  const url = base.replace(/\/$/, '') + path;
  const response = await fetch(url, {
    headers: {
      'Authorization': authHeader,
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const snippet = body.trim().substring(0, 200);
    throw new Error(`REST ${response.status} en ${path.split('?')[0]}${snippet ? ` — ${snippet}` : ''}`);
  }
  return response.json();
};

const bodyToText = (body) => {
  if (!body) return '';
  if (typeof body === 'string') return body;
  if (typeof body === 'object' && Array.isArray(body.content)) {
    return body.content
      .map((node) => {
        if (node?.type === 'text' && typeof node.text === 'string') return node.text;
        if (Array.isArray(node?.content)) return bodyToText(node);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
};

const getCommentsToday = async (jql, target) => {
  // Nota: /rest/api/3/search fue removido por Atlassian (410 Gone, CHANGE-2046);
  // el reemplazo es /rest/api/3/search/jql. Además expand=comments ya no existe:
  // el search solo se usa para listar las keys y los comentarios se consultan
  // por issue en el loop de abajo.
  const query = new URLSearchParams({
    jql,
    fields: 'summary',
    maxResults: String(PAGE_SIZE)
  });
  const search = await restRequest(`/rest/api/3/search/jql?${query.toString()}`);
  if (!search || !Array.isArray(search.issues)) return [];

  const comments = [];
  const issues = search.issues.slice(0, MAX_ISSUES_DETAILED);

  for (const issue of issues) {
    const key = issue.key;
    let page = 0;
    let total = Infinity;
    while (page * MAX_COMMENTS_PER_ISSUE < total && page < 2) {
      const data = await restRequest(
        `/rest/api/3/issue/${key}/comment?startAt=${page * MAX_COMMENTS_PER_ISSUE}&maxResults=${MAX_COMMENTS_PER_ISSUE}`
      );
      if (!data || !Array.isArray(data.comments)) break;
      total = data.total || data.comments.length;

      for (const comment of data.comments) {
        const created = comment.created ? new Date(comment.created) : null;
        if (!created) continue;
        if (!isMyAuthor(comment.author)) continue;
        if (!isSameLocalDay(created, target)) continue;
        comments.push({
          issueKey: key,
          author: comment.author?.displayName || 'Desconocido',
          created: comment.created,
          body: bodyToText(comment.body).substring(0, MAX_TEXT_LENGTH)
        });
      }
      page++;
    }
  }

  return comments;
};

const getWorklogsToday = async (issueKeys, target) => {
  const worklogs = [];
  const started = toIsoUtcMidnight(target);

  for (const key of issueKeys) {
    let page = 0;
    let total = Infinity;
    while (page * MAX_WORKLOGS_PER_ISSUE < total && page < 2) {
      const data = await restRequest(
        `/rest/api/3/issue/${key}/worklog?started=${encodeURIComponent(started)}&startAt=${page * MAX_WORKLOGS_PER_ISSUE}&maxResults=${MAX_WORKLOGS_PER_ISSUE}`
      );
      if (!data || !Array.isArray(data.worklogs)) break;
      total = data.total || data.worklogs.length;

      for (const worklog of data.worklogs) {
        const startedAt = worklog.started ? new Date(worklog.started) : null;
        if (!startedAt) continue;
        if (!isMyAuthor(worklog.author)) continue;
        if (!isSameLocalDay(startedAt, target)) continue;
        worklogs.push({
          issueKey: key,
          author: worklog.author?.displayName || 'Desconocido',
          started: worklog.started,
          timeSpent: worklog.timeSpent || '',
          timeSpentSeconds: worklog.timeSpentSeconds || 0,
          comment: (worklog.comment || '').substring(0, MAX_TEXT_LENGTH)
        });
      }
      page++;
    }
  }

  return worklogs;
};

// ---------------------------------------------------------------------------
// Consulta de issues (MCP)
// ---------------------------------------------------------------------------

const searchIssues = async (cloudId, jql) => {
  const issues = [];
  let startAt = 0;
  let total = null;

  while (true) {
    const parsed = await callTool('searchJiraIssuesUsingJql', {
      cloudId,
      jql,
      maxResults: PAGE_SIZE,
      startAt
    });

    if (parsed === null || parsed === undefined) break;
    if (total === null) total = findTotal(parsed);

    const page = findIssuesArray(parsed);
    if (page.length === 0) break;

    for (const issue of page) {
      const key = issue.key || issue.id;
      if (!key) continue;
      issues.push({
        key,
        summary: extractSummary(issue),
        status: extractStatus(issue),
        url: session?.siteUrl ? `${session.siteUrl.replace(/\/$/, '')}/browse/${key}` : null
      });
    }

    const expectedTotal = total !== null ? total : issues.length;
    startAt += page.length;
    if (startAt >= expectedTotal || issues.length >= MAX_ISSUES || page.length < PAGE_SIZE) break;
  }

  return issues;
};

const extractSummary = (issue) => {
  const node = deepFind(issue, (v) => v && typeof v === 'object' && typeof v.summary === 'string');
  return node ? node.summary : (issue.fields?.summary || null);
};

const extractStatus = (issue) => {
  if (issue.fields?.status?.name) return issue.fields.status.name;
  if (issue.status?.name) return issue.status.name;
  const node = deepFind(issue, (v) => v && typeof v === 'object' && typeof v.name === 'string' && !Array.isArray(v));
  return node && (node.id !== undefined || node.self !== undefined || node.iconUrl !== undefined) ? node.name : null;
};

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

const getDailyActivity = async (date) => {
  const target = normalizeDate(date);
  const empty = { date: toDaybeatDate(target), jql: null, issues: [], comments: [], worklogs: [] };

  if (!isConfigured()) return empty;

  // En modo OAuth, garantiza autorización antes de tocar REST (usa el token)
  try {
    await connect();
  } catch (err) {
    console.log(`  [Jira] No se pudo autenticar con Atlassian: ${err.message}`);
    return empty;
  }

  const s = await getSession();
  const jqlDate = toJqlDate(target);
  // Regla de selección de issues del reporte:
  //  - "In Progress": se incluyen SIEMPRE (el estado indica que se están haciendo,
  //    no importa cuándo empezaron).
  //  - Done: solo las resueltas HOY (resolutiondate del día).
  //  - "To Do": nunca (no se están trabajando).
  const jql =
    `assignee = currentUser() AND (statusCategory = "In Progress" OR ` +
    `(statusCategory = Done AND resolutiondate >= startOfDay("${jqlDate}")))`;
  // JQL AMPLIO solo para comentarios: cualquier issue asignado a mí (aunque
  // esté en "To Do", donde también puedo comentar) o actualizado hoy (un
  // comentario propio de hoy siempre actualiza el issue). Luego se filtran
  // por mi accountId y la fecha objetivo.
  const commentsJql =
    `assignee = currentUser() OR updated >= startOfDay("${jqlDate}")`;

  let issues = [];
  try {
    issues = await searchIssues(s.cloudId, jql);
  } catch (err) {
    console.log(`  [Jira] No se pudieron consultar issues (MCP): ${err.message}`);
  }

  let comments = [];
  let worklogs = [];
  try {
    comments = await getCommentsToday(commentsJql, target);
  } catch (err) {
    console.log(`  [Jira] No se pudieron consultar comentarios (REST): ${err.message}`);
  }
  try {
    worklogs = await getWorklogsToday(issues.slice(0, MAX_ISSUES_DETAILED).map(i => i.key), target);
  } catch (err) {
    console.log(`  [Jira] No se pudieron consultar worklogs (REST): ${err.message}`);
  }

  return { date: toDaybeatDate(target), jql, issues, comments, worklogs };
};

const formatActivityForReport = (data) => {
  if (!data) return null;
  const lines = [];
  const { date, issues, comments, worklogs } = data;

  lines.push(`Actividad en Jira del ${date}:`);

  if (issues.length > 0) {
    lines.push('Incidencias:');
    for (const issue of issues.slice(0, 15)) {
      const status = issue.status ? ` (${issue.status})` : '';
      lines.push(`  - ${issue.key}: ${issue.summary || 'Sin resumen'}${status}`);
    }
    if (issues.length > 15) lines.push(`  ... y ${issues.length - 15} más`);
  }

  if (comments.length > 0) {
    lines.push('Comentarios propios:');
    for (const comment of comments.slice(0, 15)) {
      const time = comment.created ? ` (${comment.created.substring(0, 16).replace('T', ' ')})` : '';
      lines.push(`  - ${comment.issueKey}: "${comment.body}"${time}`);
    }
  }

  if (worklogs.length > 0) {
    lines.push('Worklogs (tiempo imputado):');
    for (const worklog of worklogs.slice(0, 15)) {
      lines.push(`  - ${worklog.issueKey}: ${worklog.timeSpent}${worklog.comment ? ` — "${worklog.comment}"` : ''}`);
    }
  }

  if (issues.length === 0 && comments.length === 0 && worklogs.length === 0) {
    lines.push('  (sin actividad registrada en Jira para esta fecha)');
  }

  return lines.join('\n');
};

module.exports = {
  isConfigured,
  getDailyActivity,
  formatActivityForReport,
  closeConnection
};