/**
 * lib/clockify.js
 *
 * Módulo autocontenido de actividad diaria en Clockify (time entries con
 * horario). NO hay OAuth para la API de Clockify (solo SSO de login web):
 * la autenticación es por API key personal (header X-Api-Key), generada en
 * Profile Settings → Advanced → API Key (https://clockify.me/user/settings).
 *
 * Configuración — dos vías:
 *   1. Menú "6. Configuración" → "Conectar Clockify" (flujo guiado para
 *      usuarios no técnicos): pega la key, se VERIFICA contra la API
 *      (GET /user + GET /workspaces) y solo si es válida se persiste en
 *      .daybeat-clockify.json (gitignored).
 *   2. Fallback: CLOCKIFY_API_KEY en el .env (comportamiento clásico).
 *
 * Configuración (env):
 *   CLOCKIFY_API_KEY      — respaldo cuando no hay .daybeat-clockify.json
 *   CLOCKIFY_WORKSPACE_ID — opcional; si no, se autodetecta el primero
 *   CLOCKIFY_BASE_URL     — opcional; workspaces regionales (euc1/use2/euw2/apse2)
 *
 * API pública:
 *   isConfigured()
 *   getStatus()                    → texto legible del estado actual
 *   connectWithKey(apiKey)         → verifica y persiste; { ok, message }
 *   disconnect()
 *   getDailyActivity(date)         → { date, entries: [{ id, description,
 *                                    projectName, taskName, start, end,
 *                                    startLocal, endLocal, durationMin,
 *                                    inProgress }] } — las entradas EN
 *                                    PROGRESO (timer corriendo) se incluyen
 *                                    con inProgress:true, end/durationMin null
 *   formatActivityForReport(data)  → texto legible para consola / contexto de IA
 *   formatDuration(minutes)        → "1h 30m" (display)
 *   parseISODuration(iso)          → minutos desde duración ISO 8601 (PT1H30M)
 *
 * Nunca lanza errores hacia el flujo de registro: las funciones devuelven
 * datos vacíos o null y el consumidor decide cómo degradar.
 */

const fs = require('fs');
const path = require('path');
const { isoToLocalHHMM } = require('./time.js');

// CLOCKIFY_STORE_PATH permite aislar el store en los tests (path temporal).
const STORE_PATH = process.env.CLOCKIFY_STORE_PATH
  || path.join(__dirname, '..', '.daybeat-clockify.json');
const DEFAULT_BASE_URL = 'https://api.clockify.me/api/v1';
const PAGE_SIZE = 500;
const MAX_PAGES = 5;

// ---------------------------------------------------------------------------
// Almacén (.daybeat-clockify.json)
// ---------------------------------------------------------------------------

const readStore = () => {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (err) {
    return {};
  }
};

const writeStore = (data) => {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.log(`  [Clockify] No se pudo guardar la configuración: ${err.message}`);
  }
};

const resolveBaseUrl = () =>
  (process.env.CLOCKIFY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

// La key activa: la del store (menú Configuración) o el respaldo del .env.
const getApiKey = () => {
  const stored = readStore().apiKey;
  return (typeof stored === 'string' && stored.trim().length > 0)
    ? stored
    : (process.env.CLOCKIFY_API_KEY || '');
};

// ---------------------------------------------------------------------------
// Configuración / verificación
// ---------------------------------------------------------------------------

const isConfigured = () => getApiKey().length > 0;

const getStatus = () => {
  if (!isConfigured()) return 'Clockify: No configurado';
  const s = readStore();
  if (s.apiKey && (s.userName || s.userEmail)) {
    const who = [s.userName, s.userEmail].filter(Boolean).join(' (');
    const whoText = s.userName && s.userEmail ? `${who})` : who;
    return `Clockify: Conectado como ${whoText} · Workspace: ${s.workspaceName || s.workspaceId || '?'}`;
  }
  return 'Clockify: key configurada (desde .env, sin datos de perfil)';
};

const disconnect = () => writeStore({});

// Verifica la key contra la API (GET /user + GET /workspaces) y, solo si es
// válida, persiste el store. Devuelve { ok, message } — nunca lanza.
const connectWithKey = async (apiKey) => {
  const base = resolveBaseUrl();
  const headers = { 'X-Api-Key': apiKey };
  try {
    const userRes = await fetch(`${base}/user`, { headers, signal: AbortSignal.timeout(15000) });
    if (userRes.status === 401) {
      return { ok: false, message: 'La key no fue aceptada por Clockify (401). Revisá que esté bien copiada.' };
    }
    if (!userRes.ok) {
      return { ok: false, message: `Clockify respondió con error ${userRes.status}. Probá de nuevo en un momento.` };
    }
    const user = await userRes.json();

    const wsRes = await fetch(`${base}/workspaces`, { headers, signal: AbortSignal.timeout(15000) });
    if (!wsRes.ok) {
      return { ok: false, message: `No se pudieron listar los workspaces (${wsRes.status}).` };
    }
    const workspaces = await wsRes.json();
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      return { ok: false, message: 'La cuenta no tiene workspaces activos.' };
    }
    const preferred = process.env.CLOCKIFY_WORKSPACE_ID;
    const workspace = (preferred && workspaces.find(w => w.id === preferred)) || workspaces[0];

    writeStore({
      apiKey,
      workspaceId: workspace.id,
      workspaceName: workspace.name || '',
      baseUrl: base,
      userId: user.id || '',
      userName: user.name || '',
      userEmail: user.email || '',
      connectedAt: new Date().toISOString()
    });

    const who = [user.name, user.email].filter(Boolean).join(' (');
    const whoText = user.name && user.email ? `${who})` : who;
    return { ok: true, message: `Conectado como ${whoText} · Workspace: ${workspace.name || workspace.id}` };
  } catch (err) {
    return { ok: false, message: `No se pudo verificar la key: ${err.message}` };
  }
};

// ---------------------------------------------------------------------------
// Helpers de formato
// ---------------------------------------------------------------------------

// "PT1H30M" / "P1DT2H30M" -> minutos. Devuelve null si no es ISO 8601 válido.
const parseISODuration = (iso) => {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return null;
  const days = parseInt(m[1] || '0', 10);
  const hours = parseInt(m[2] || '0', 10);
  const mins = parseInt(m[3] || '0', 10);
  const secs = parseInt(m[4] || '0', 10);
  const total = days * 1440 + hours * 60 + mins + (secs > 0 ? 1 : 0);
  return total > 0 ? total : null;
};

// 90 -> "1h 30m"; 45 -> "45m"; 120 -> "2h"
const formatDuration = (minutes) => {
  const total = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

// Acepta Date, "DD/MM/YYYY" o "YYYY-MM-DD" → Date local a medianoche.
const normalizeDate = (date) => {
  if (date instanceof Date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }
  if (typeof date === 'string') {
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
      const [dd, mm, yyyy] = date.split('/');
      return new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10));
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [yyyy, mm, dd] = date.split('-').map(Number);
      return new Date(yyyy, mm - 1, dd);
    }
  }
  return new Date();
};

const toDaybeatDate = (d) =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

// ---------------------------------------------------------------------------
// Actividad diaria (time entries)
// ---------------------------------------------------------------------------

// Normaliza un time entry crudo de la API. Las entradas EN PROGRESO (timer
// corriendo, sin end) se incluyen marcadas con inProgress:true y sin duración
// conocida — sirven como contexto de actividad. Se descartan solo las que no
// caen en el día objetivo (defensa extra ante el filtro del API).
const normalizeEntry = (entry, dayStartMs, dayEndMs) => {
  const interval = entry.timeInterval || {};
  const start = new Date(interval.start);
  if (isNaN(start.getTime())) return null;
  if (start.getTime() < dayStartMs || start.getTime() >= dayEndMs) return null;

  const inProgress = !interval.end;
  const end = inProgress ? null : new Date(interval.end);
  if (!inProgress && isNaN(end.getTime())) return null;

  const durationMin = inProgress
    ? null
    : (parseISODuration(interval.duration)
        || Math.max(1, Math.round((end.getTime() - start.getTime()) / 60000)));

  return {
    id: entry.id || '',
    description: entry.description || '',
    projectName: (entry.project && entry.project.name) || '',
    taskName: (entry.task && entry.task.name) || '',
    start: interval.start,
    end: interval.end || null,
    startLocal: isoToLocalHHMM(interval.start),
    endLocal: inProgress ? null : isoToLocalHHMM(interval.end),
    durationMin,
    inProgress
  };
};

// Resuelve workspace + userId en vivo cuando el store no los tiene (caso de
// key solo en .env). Nunca lanza: devuelve null ante errores.
const resolveScope = async (apiKey) => {
  const base = resolveBaseUrl();
  const headers = { 'X-Api-Key': apiKey };
  const s = readStore();
  let workspaceId = s.workspaceId || process.env.CLOCKIFY_WORKSPACE_ID || null;
  let userId = s.userId || null;

  if (!userId || !workspaceId) {
    try {
      if (!userId) {
        const userRes = await fetch(`${base}/user`, { headers, signal: AbortSignal.timeout(15000) });
        if (userRes.ok) {
          const user = await userRes.json();
          userId = user.id || null;
        } else {
          console.log(`  [Clockify] GET /user respondió ${userRes.status} (¿key inválida o expirada?).`);
        }
      }
      if (!workspaceId) {
        const wsRes = await fetch(`${base}/workspaces`, { headers, signal: AbortSignal.timeout(15000) });
        if (wsRes.ok) {
          const workspaces = await wsRes.json();
          if (Array.isArray(workspaces) && workspaces.length > 0) workspaceId = workspaces[0].id;
        } else {
          console.log(`  [Clockify] GET /workspaces respondió ${wsRes.status}.`);
        }
      }
    } catch (err) {
      console.log(`  [Clockify] No se pudo resolver el workspace/usuario: ${err.message}`);
    }
  }
  return { workspaceId, userId };
};

const getDailyActivity = async (date) => {
  const target = normalizeDate(date);
  const empty = { date: toDaybeatDate(target), entries: [] };
  const apiKey = getApiKey();
  if (!apiKey) return empty;

  const dayStartMs = target.getTime();
  const dayEndMs = dayStartMs + 24 * 60 * 60 * 1000;
  const startISO = new Date(dayStartMs).toISOString();
  const endISO = new Date(dayEndMs).toISOString();

  let scope;
  try {
    scope = await resolveScope(apiKey);
  } catch (err) {
    console.log(`  [Clockify] No se pudo autenticar: ${err.message}`);
    return empty;
  }
  if (!scope.workspaceId || !scope.userId) {
    console.log('  [Clockify] No se pudo resolver el workspace/usuario. Verificá la API key en el menú 6 → Conectar Clockify.');
    return empty;
  }

  const base = resolveBaseUrl();
  const headers = { 'X-Api-Key': apiKey };
  const entries = [];

  try {
    // Paginado (page + header Last-Page), con tope de seguridad MAX_PAGES.
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url =
        `${base}/workspaces/${scope.workspaceId}/user/${scope.userId}/time-entries` +
        `?start=${startISO}&end=${endISO}&page=${page}&page-size=${PAGE_SIZE}&hydrated=true`;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      if (!res.ok) {
        console.log(`  [Clockify] Error consultando time entries (${res.status}); usando lo obtenido.`);
        break;
      }
      const raw = await res.json();
      if (!Array.isArray(raw)) break;
      for (const entry of raw) {
        const normalized = normalizeEntry(entry, dayStartMs, dayEndMs);
        if (normalized) entries.push(normalized);
      }
      if (res.headers.get('last-page') === 'true' || raw.length === 0) break;
    }
  } catch (err) {
    console.log(`  [Clockify] Error consultando la actividad: ${err.message}`);
  }

  entries.sort((a, b) => (a.start < b.start ? -1 : 1));
  return { date: toDaybeatDate(target), entries };
};

const formatActivityForReport = (data) => {
  if (!data) return null;
  const lines = [];
  const { date, entries } = data;
  lines.push(`Actividad en Clockify del ${date}:`);

  if (entries.length > 0) {
    for (const entry of entries.slice(0, 15)) {
      const when = entry.inProgress
        ? `[${entry.startLocal || '?'} - en curso] `
        : (entry.startLocal && entry.endLocal ? `[${entry.startLocal} - ${entry.endLocal}] ` : '');
      const label = entry.projectName
        ? (entry.description ? `${entry.projectName}: ${entry.description}` : `${entry.projectName}: Actividad`)
        : (entry.description || 'Actividad');
      const duration = entry.inProgress ? 'en curso' : formatDuration(entry.durationMin);
      lines.push(`  - ${when}${label} (${duration})`);
    }
    if (entries.length > 15) lines.push(`  ... y ${entries.length - 15} más`);
    const total = entries.reduce((acc, e) => acc + (e.durationMin || 0), 0);
    lines.push(`Total registrado: ${formatDuration(total)}`);
  } else {
    lines.push('  (sin actividad registrada en Clockify para esta fecha)');
  }

  return lines.join('\n');
};

module.exports = {
  isConfigured,
  getStatus,
  connectWithKey,
  disconnect,
  getDailyActivity,
  formatActivityForReport,
  formatDuration,
  parseISODuration
};