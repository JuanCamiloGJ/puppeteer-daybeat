/**
 * lib/ai-config.js
 *
 * Módulo autocontenido de configuración de IA para el registro de Daybeat.
 * Centraliza los providers de IA y su almacén de credenciales, de forma que
 * los flujos de registro solo consumen callAI() / isAIEnabled().
 *
 * Providers soportados:
 *   1. opencode — OpenCode Zen (https://opencode.ai/zen), modelos gratis
 *      (*-free) con la cuenta gratuita de opencode. La key se importa
 *      automáticamente desde el auth.json de opencode cuando existe
 *      (~/.local/share/opencode/auth.json), o se pega manualmente.
 *   2. gemini — Google Gemini (endpoint oficial de interacciones), la key
 *      viene del config o, por compatibilidad, de GEMINI_API_KEY del .env.
 *
 * API pública:
 *   isAIEnabled()
 *   getStatus()                     → texto legible del estado actual
 *   getActiveProvider()
 *   setActiveProvider(name)
 *   getProviderNames()
 *   getModel(provider)
 *   setModel(provider, model)
 *   setGeminiKey(key)
 *   saveOpenCodeKey(key, source)
 *   detectOpenCodeKey()             → { key, source } | null
 *   setOpenCodeKeySource(source)
 *   callAI(prompt)                  → texto crudo del modelo | null
 *   testConnection()                → { ok, text | error, provider, model }
 *   ZEN_FREE_MODELS                 → modelos gratis de OpenCode Zen
 *
 * Nunca lanza errores hacia el flujo de registro: las funciones devuelven
 * null / datos vacíos y el consumidor decide cómo degradar.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const STORE_PATH = path.join(__dirname, '..', '.daybeat-ai.json');

const ZEN_URL = 'https://opencode.ai/zen/v1/chat/completions';
const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const ZEN_DEFAULT_MODEL = 'deepseek-v4-flash-free';
const ZEN_SIGNUP_URL = 'https://opencode.ai/auth';
const ZEN_MODELS_TTL_MS = 24 * 60 * 60 * 1000; // cache de la lista de modelos: 24h

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_DEFAULT_MODEL = 'gemini-3.1-flash-lite';

const MAX_RETRIES = 4;
const BASE_DELAY = 2000;

// Modelos gratuitos de OpenCode Zen (endpoint OpenAI-compatible). Lista de
// RESPALDO: la lista real se obtiene en vivo desde /zen/v1/models (ver
// getZenModels) y se cachea 24h; esta constante cubre la caída de red.
const ZEN_FREE_MODELS = [
  'deepseek-v4-flash-free',
  'mimo-v2.5-free',
  'hy3-free',
  'laguna-s-2.1-free',
  'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free',
  'big-pickle'
];

// Devuelve la lista de modelos de OpenCode Zen en TIEMPO REAL, cacheada 24h
// en .daybeat-ai.json. Fallback a ZEN_FREE_MODELS si la red falla o el
// endpoint no responde. Nunca lanza.
const getZenModels = async () => {
  const s = normalizeStore(readStore());
  const cache = s.modelsCache;
  if (cache && cache.fetchedAt && Array.isArray(cache.models) && cache.models.length > 0
      && Date.now() - cache.fetchedAt < ZEN_MODELS_TTL_MS) {
    return cache.models;
  }
  try {
    console.log('  [IA] Consultando modelos disponibles de OpenCode Zen...');
    const response = await fetch(ZEN_MODELS_URL, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return ZEN_FREE_MODELS;
    const data = await response.json();
    const models = (data.data || []).map(m => m.id).filter(id => typeof id === 'string' && id.length > 0);
    if (models.length > 0) {
      s.modelsCache = { fetchedAt: Date.now(), models };
      writeStore(s);
      return models;
    }
  } catch (err) {
    console.log('  [IA] No se pudo consultar la lista de modelos (red): usando lista de respaldo.');
  }
  return ZEN_FREE_MODELS;
};

// Un modelo es "free" si su ID termina en -free (convención de Zen) o si
// estaba en la lista de respaldo.
const isFreeModel = (id) => typeof id === 'string' && (id.endsWith('-free') || ZEN_FREE_MODELS.includes(id));

// ---------------------------------------------------------------------------
// Almacén (.daybeat-ai.json)
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
    console.log(`  [IA] No se pudo guardar la configuración: ${err.message}`);
  }
};

// Asegura la estructura base del store y la devuelve normalizada.
const normalizeStore = (store) => {
  const s = store || {};
  s.providers = s.providers || {};
  s.providers.opencode = s.providers.opencode || {};
  s.providers.gemini = s.providers.gemini || {};
  // Compatibilidad con la configuración vieja (solo .env): si no hay
  // provider activo guardado, se asume Gemini (respeta GEMINI_API_KEY).
  s.activeProvider = s.activeProvider || 'gemini';
  return s;
};

// ---------------------------------------------------------------------------
// Detección de la key de opencode (auth.json del CLI de opencode)
// ---------------------------------------------------------------------------

const getOpenCodeAuthCandidates = () => {
  const candidates = [];
  if (process.platform === 'win32') {
    if (process.env.USERPROFILE) {
      candidates.push(path.join(process.env.USERPROFILE, '.local', 'share', 'opencode', 'auth.json'));
    }
  } else {
    if (os.homedir()) {
      candidates.push(path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json'));
    }
  }
  return candidates;
};

// Lee el auth.json de opencode y extrae la key de OpenCode Zen (provider
// "opencode"; fallback al plan "opencode-go"). Devuelve { key, source } o
// null si no hay ninguna.
const detectOpenCodeKey = () => {
  for (const candidate of getOpenCodeAuthCandidates()) {
    try {
      const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const key = data.opencode?.key || data['opencode-go']?.key;
      if (key && typeof key === 'string' && key.length > 0) {
        return { key, source: candidate };
      }
    } catch (err) {
      // archivo inexistente o ilegible: probar el siguiente candidato
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const getProviderNames = () => ['opencode', 'gemini'];

const getActiveProvider = () => normalizeStore(readStore()).activeProvider;

const setActiveProvider = (name) => {
  const s = normalizeStore(readStore());
  s.activeProvider = name;
  writeStore(s);
};

const getProviderConfig = (provider) => {
  const s = normalizeStore(readStore());
  return s.providers[provider] || {};
};

// La IA está disponible si el provider activo tiene key (la de Gemini admite
// el fallback a GEMINI_API_KEY del .env por compatibilidad).
const isAIEnabled = () => {
  const s = normalizeStore(readStore());
  const active = s.activeProvider;
  if (active === 'opencode') {
    return Boolean(s.providers.opencode.apiKey);
  }
  if (active === 'gemini') {
    return Boolean(s.providers.gemini.apiKey || process.env.GEMINI_API_KEY);
  }
  return false;
};

const getModel = (provider) => {
  const cfg = getProviderConfig(provider);
  if (cfg.model) return cfg.model;
  if (provider === 'opencode') return ZEN_DEFAULT_MODEL;
  return process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
};

const setModel = (provider, model) => {
  const s = normalizeStore(readStore());
  s.providers[provider].model = model;
  writeStore(s);
};

const setGeminiKey = (key) => {
  const s = normalizeStore(readStore());
  s.providers.gemini.apiKey = key.trim();
  writeStore(s);
};

const saveOpenCodeKey = (key, source) => {
  const s = normalizeStore(readStore());
  s.providers.opencode.apiKey = key.trim();
  s.providers.opencode.source = source || null;
  writeStore(s);
};

const maskKey = (key) => {
  if (!key) return null;
  if (key.length <= 8) return '***';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
};

const getStatus = () => {
  const s = normalizeStore(readStore());
  const active = s.activeProvider;
  const lines = [];
  for (const name of getProviderNames()) {
    const cfg = s.providers[name];
    const key = name === 'gemini' ? (cfg.apiKey || process.env.GEMINI_API_KEY) : cfg.apiKey;
    const status = key ? `conectado (${maskKey(key)})` : 'sin conectar';
    const source = cfg.source ? ` — ${cfg.source}` : '';
    const activeMark = name === active ? ' [ACTIVO]' : '';
    lines.push(`  - ${name}: ${status}${source}${activeMark}`);
  }
  lines.push(`  - Modelo activo: ${getModel(active)}`);
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Llamada a la IA (con retry/backoff, patrón del viejo generateWithGemini)
// ---------------------------------------------------------------------------

const openBrowser = (url) => {
  // HEADLESS=true: no abrir ventana del navegador, solo mostrar la URL
  if (process.env.HEADLESS === 'true') {
    console.log('  [IA] Modo headless: no se abrirá el navegador. Entrá a esta URL:\n  ' + url);
    return;
  }
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, { detached: true, stdio: 'ignore' }, () => {});
};

const fetchWithRetry = async (url, options, label) => {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`  [IA] Intento ${attempt}/${MAX_RETRIES} (${label})...`);
      const startTime = Date.now();
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
      const responseTime = Date.now() - startTime;
      console.log(`  [IA] Respuesta recibida en ${responseTime}ms`);

      if (!response.ok) {
        const errorBody = await response.text();
        console.log(`  [IA] Error en API: ${response.status}`);
        console.log(`  [IA] Detalle: ${errorBody.substring(0, 200)}`);
        // Retry solo para 503 (Service Unavailable) y 429 (rate limit)
        if ((response.status === 503 || response.status === 429) && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * Math.pow(2, attempt - 1);
          console.log(`  [IA] Reintentando en ${delay / 1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        return null;
      }

      return await response.json();
    } catch (err) {
      console.log(`  [IA] Error en intento ${attempt}: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY * Math.pow(2, attempt - 1);
        console.log(`  [IA] Reintentando en ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      return null;
    }
  }
  return null;
};

// Endpoint OpenAI-compatible de OpenCode Zen (chat/completions).
const callZen = async (apiKey, model, prompt) => {
  const data = await fetchWithRetry(
    ZEN_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }]
      })
    },
    `opencode · ${model}`
  );
  return data?.choices?.[0]?.message?.content || null;
};

// Endpoint oficial de Google Gemini (interacciones).
const callGemini = async (apiKey, model, prompt) => {
  const data = await fetchWithRetry(
    GEMINI_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({ model, input: prompt })
    },
    `gemini · ${model}`
  );
  const outputStep = data?.steps?.find(step => step.type === 'model_output');
  return outputStep?.content?.[0]?.text || null;
};

// Llama al provider activo con el prompt dado y devuelve el TEXTO CRUDO del
// modelo (el parseo del JSON {title, detail} lo hace el consumidor, igual que
// en el flujo original). Devuelve null si no hay IA configurada o si falla.
const callAI = async (prompt) => {
  const s = normalizeStore(readStore());
  const active = s.activeProvider;
  const cfg = s.providers[active] || {};

  let apiKey;
  if (active === 'opencode') {
    apiKey = cfg.apiKey;
  } else {
    apiKey = cfg.apiKey || process.env.GEMINI_API_KEY;
  }
  if (!apiKey) {
    console.log('  [IA] Provider activo sin API key configurada.');
    return null;
  }

  const model = getModel(active);
  console.log(`  [IA] Usando provider "${active}" con modelo ${model}`);

  if (active === 'opencode') return callZen(apiKey, model, prompt);
  return callGemini(apiKey, model, prompt);
};

// ---------------------------------------------------------------------------
// Prueba de conexión
// ---------------------------------------------------------------------------

const testConnection = async () => {
  const s = normalizeStore(readStore());
  const active = s.activeProvider;
  if (!isAIEnabled()) {
    return { ok: false, error: 'El provider activo no tiene API key configurada', provider: active };
  }
  const text = await callAI('Respondé SOLO con la palabra OK');
  if (!text) {
    return { ok: false, error: 'La llamada a la IA falló o devolvió vacío', provider: active };
  }
  return { ok: true, text: text.trim().substring(0, 120), provider: active, model: getModel(active) };
};

module.exports = {
  ZEN_FREE_MODELS,
  ZEN_SIGNUP_URL,
  isAIEnabled,
  getStatus,
  getActiveProvider,
  setActiveProvider,
  getProviderNames,
  getModel,
  setModel,
  setGeminiKey,
  saveOpenCodeKey,
  detectOpenCodeKey,
  callAI,
  testConnection,
  openBrowser,
  getZenModels,
  isFreeModel
};
