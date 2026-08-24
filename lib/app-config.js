/**
 * lib/app-config.js
 *
 * Configuración principal de la aplicación (.daybeat-config.json, gitignored).
 * Es la fuente de verdad de la configuración base: la crea el asistente de
 * setup inicial y se edita desde el menú "6. Configuración", sin tocar .env.
 *
 * Prioridad de valores: .daybeat-config.json → .env → defaults.
 *
 * En el primer arranque sin archivo de configuración se MIGRA el .env al
 * archivo (una sola vez). Desde ahí el archivo manda: syncEnv() lo aplica a
 * process.env para que los módulos existentes (que leen process.env) sigan
 * funcionando sin cambios.
 *
 * El archivo guarda solo la configuración base y preferencias; las
 * credenciales de las integraciones siguen en sus stores especializados
 * (.daybeat-ai.json, .daybeat-clockify.json, .daybeat-jira-tokens.json).
 *
 * API pública:
 *   initialize()               → migra .env (si aplica) y aplica la config a env
 *   load() / reload()          → config normalizada en memoria / desde disco
 *   isSetupComplete()          → los 4 datos de Daybeat están cargados
 *   getDaybeat() / setDaybeat()
 *   getGit() / setGit()
 *   getHeadless() / setHeadless()
 *   isJiraEnabled() / setJiraEnabled()
 *   getStatus()                → texto legible para el menú de configuración
 *   syncEnv()                  → aplica la config a process.env
 */

const fs = require('fs');
const path = require('path');

// APP_CONFIG_PATH permite aislar el archivo en los tests (path temporal).
const CONFIG_FILE = process.env.APP_CONFIG_PATH
  || path.join(__dirname, '..', '.daybeat-config.json');

let cached = null;

const readFile = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    return null;
  }
};

const writeFile = (data) => {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.log(`  [Config] No se pudo guardar la configuración: ${err.message}`);
    return false;
  }
};

const normalize = (raw) => {
  const s = raw && typeof raw === 'object' ? raw : {};
  s.version = s.version || 1;
  s.setupCompleted = !!s.setupCompleted;
  s.daybeat = {
    link: s.daybeat?.link || '',
    company: s.daybeat?.company || '',
    username: s.daybeat?.username || '',
    password: s.daybeat?.password || ''
  };
  s.git = {
    rootDir: s.git?.rootDir || '',
    authorEmail: s.git?.authorEmail || ''
  };
  s.preferences = { headless: !!s.preferences?.headless };
  s.integrations = { jira: !!s.integrations?.jira };
  return s;
};

const load = () => {
  if (!cached) cached = normalize(readFile());
  return cached;
};

const reload = () => {
  cached = normalize(readFile());
  return cached;
};

const hasFile = () => fs.existsSync(CONFIG_FILE);

const isDaybeatComplete = (c = null) => {
  const s = c || load();
  return Boolean(s.daybeat.link && s.daybeat.company && s.daybeat.username && s.daybeat.password);
};

const isSetupComplete = () => load().setupCompleted || isDaybeatComplete();

// Migración única .env → .daybeat-config.json (el .env no se toca).
const migrateFromEnv = () => {
  if (hasFile()) return false;
  const c = normalize(null);
  c.daybeat = {
    link: process.env.LINK_DAYBEAT || '',
    company: process.env.COMPANY || '',
    username: process.env.USERNAME_DAYBEAT || '',
    password: process.env.PASSWORD || ''
  };
  c.git = {
    rootDir: process.env.ROOT_DIR || '',
    authorEmail: process.env.GIT_AUTHOR_EMAIL || ''
  };
  c.preferences.headless = process.env.HEADLESS === 'true';
  c.integrations.jira = process.env.ATLASSIAN_ENABLED === 'true' || Boolean(process.env.ATLASSIAN_EMAIL);
  c.setupCompleted = isDaybeatComplete(c);
  writeFile(c);
  cached = c;
  return true;
};

const setOrClear = (key, value) => {
  if (value && String(value).trim() !== '') process.env[key] = String(value);
  else delete process.env[key];
};

// Aplica la config a process.env. La config existente es autoritativa: los
// valores vacíos se limpian del env (así desactivar Jira quita su flag aunque
// el .env de respaldo lo tenga).
const syncEnv = () => {
  const c = load();
  setOrClear('LINK_DAYBEAT', c.daybeat.link);
  setOrClear('COMPANY', c.daybeat.company);
  setOrClear('USERNAME_DAYBEAT', c.daybeat.username);
  setOrClear('PASSWORD', c.daybeat.password);
  setOrClear('ROOT_DIR', c.git.rootDir);
  setOrClear('GIT_AUTHOR_EMAIL', c.git.authorEmail);
  if (c.preferences.headless) process.env.HEADLESS = 'true';
  else delete process.env.HEADLESS;
  if (c.integrations.jira) {
    process.env.ATLASSIAN_ENABLED = 'true';
    // email/token se dejan como vengan del .env (respaldo del modo API token)
  } else {
    delete process.env.ATLASSIAN_ENABLED;
    delete process.env.ATLASSIAN_EMAIL;
    delete process.env.ATLASSIAN_API_TOKEN;
  }
  return c;
};

// initialize() = migración (si aplica) + aplicación a env. Llamar UNA vez al
// arranque ANTES de require() de módulos que lean process.env al cargar.
const initialize = () => {
  migrateFromEnv();
  return syncEnv();
};

// ---------------------------------------------------------------------------
// Setters (guardan el archivo y re-aplican a env)
// ---------------------------------------------------------------------------

const save = (data) => {
  cached = normalize(data);
  writeFile(cached);
  syncEnv();
};

const setDaybeat = ({ link, company, username, password } = {}) => {
  const c = load();
  if (link !== undefined) c.daybeat.link = String(link || '');
  if (company !== undefined) c.daybeat.company = String(company || '');
  if (username !== undefined) c.daybeat.username = String(username || '');
  if (password !== undefined) c.daybeat.password = String(password || '');
  c.setupCompleted = isDaybeatComplete(c);
  save(c);
  return c;
};

const setGit = ({ rootDir, authorEmail } = {}) => {
  const c = load();
  if (rootDir !== undefined) c.git.rootDir = String(rootDir || '');
  if (authorEmail !== undefined) c.git.authorEmail = String(authorEmail || '');
  save(c);
  return c;
};

const setHeadless = (value) => {
  const c = load();
  c.preferences.headless = !!value;
  save(c);
  return c;
};

const setJiraEnabled = (value) => {
  const c = load();
  c.integrations.jira = !!value;
  save(c);
  return c;
};

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

const getDaybeat = () => ({ ...load().daybeat });
const getGit = () => ({ ...load().git });
const getHeadless = () => load().preferences.headless;
const isJiraEnabled = () => load().integrations.jira;

const getStatus = () => {
  const c = load();
  const dayOk = isDaybeatComplete(c);
  const dayStatus = dayOk ? '✓' : '✗';
  return [
    `App: Configuración base ${dayStatus} · ${c.daybeat.link || 'sin URL de Daybeat'}`,
    `  - Git: ${c.git.rootDir || 'no configurado'}`,
    `  - Jira: ${c.integrations.jira ? 'activado' : 'desactivado'}`,
    `  - Navegador: ${c.preferences.headless ? 'oculto' : 'visible'}`
  ].join('\n');
};

module.exports = {
  initialize,
  load,
  reload,
  syncEnv,
  isSetupComplete,
  getDaybeat,
  setDaybeat,
  getGit,
  setGit,
  getHeadless,
  setHeadless,
  isJiraEnabled,
  setJiraEnabled,
  getStatus
};
