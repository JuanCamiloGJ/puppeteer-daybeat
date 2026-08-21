// Tests unitarios de lib/clockify.js: parseo de duraciones ISO 8601, formato
// de reporte, y el flujo de verificación/actividad con fetch mockeado.
// El store se aísla en un archivo temporal para no tocar .daybeat-clockify.json
// (la configuración real del usuario).

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.CLOCKIFY_STORE_PATH = path.join(os.tmpdir(), `.daybeat-clockify-test-${process.pid}.json`);

const test = require('node:test');
const assert = require('node:assert');
const {
  parseISODuration,
  formatDuration,
  formatActivityForReport,
  connectWithKey,
  getDailyActivity,
  disconnect,
  isConfigured,
  getStatus
} = require('./clockify.js');

// Limpieza del store temporal al terminar la corrida.
test.after(() => {
  try { fs.unlinkSync(process.env.CLOCKIFY_STORE_PATH); } catch (err) { /* ya no existe */ }
});

test('parseISODuration: duraciones ISO 8601 a minutos', () => {
  assert.strictEqual(parseISODuration('PT1H30M'), 90);
  assert.strictEqual(parseISODuration('PT30M'), 30);
  assert.strictEqual(parseISODuration('PT1H'), 60);
  assert.strictEqual(parseISODuration('P1DT2H30M'), 1590);
  assert.strictEqual(parseISODuration('PT45S'), 1);
  assert.strictEqual(parseISODuration('PT0M'), null);
  assert.strictEqual(parseISODuration('basura'), null);
  assert.strictEqual(parseISODuration(null), null);
  assert.strictEqual(parseISODuration(undefined), null);
});

test('formatDuration: minutos a texto legible', () => {
  assert.strictEqual(formatDuration(90), '1h 30m');
  assert.strictEqual(formatDuration(45), '45m');
  assert.strictEqual(formatDuration(120), '2h');
  assert.strictEqual(formatDuration(0), '0m');
  assert.strictEqual(formatDuration(-10), '0m');
  assert.strictEqual(formatDuration(undefined), '0m');
});

test('formatActivityForReport: con entradas, sin entradas y null', () => {
  assert.strictEqual(formatActivityForReport(null), null);

  const empty = formatActivityForReport({ date: '20/08/2026', entries: [] });
  assert.match(empty, /Actividad en Clockify del 20\/08\/2026/);
  assert.match(empty, /sin actividad registrada/);

  const report = formatActivityForReport({
    date: '20/08/2026',
    entries: [
      { startLocal: '08:00', endLocal: '09:30', projectName: 'Proyecto A', description: 'Debug backend', durationMin: 90 },
      { startLocal: '10:00', endLocal: '10:45', projectName: '', description: 'Reunión', durationMin: 45 }
    ]
  });
  assert.match(report, /Proyecto A: Debug backend \(1h 30m\)/);
  assert.match(report, /\[08:00 - 09:30\]/);
  assert.match(report, /Reunión \(45m\)/);
  assert.match(report, /Total registrado: 2h 15m/);

  const sinDescripcion = formatActivityForReport({
    date: '20/08/2026',
    entries: [{ startLocal: '08:00', endLocal: '08:30', projectName: 'P', description: '', durationMin: 30 }]
  });
  assert.match(sinDescripcion, /P: Actividad \(30m\)/);
});

// ---------------------------------------------------------------------------
// Flujo de conexión y actividad con fetch mockeado
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

const stubFetch = (routes) => {
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    for (const route of routes) {
      if (route.match(u)) {
        return route.handler(u, opts);
      }
    }
    throw new Error(`fetch inesperado: ${u}`);
  };
};

const restoreFetch = () => {
  globalThis.fetch = originalFetch;
};

const jsonResponse = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] || null },
  json: async () => body
});

test('formatActivityForReport: entradas en curso se marcan y no suman al total', () => {
  const report = formatActivityForReport({
    date: '20/08/2026',
    entries: [
      { startLocal: '08:00', endLocal: null, projectName: 'Proyecto A', description: 'Debug backend', durationMin: null, inProgress: true },
      { startLocal: '10:00', endLocal: '10:45', projectName: '', description: 'Reunión', durationMin: 45, inProgress: false }
    ]
  });
  assert.match(report, /\[08:00 - en curso\]/);
  assert.match(report, /Debug backend \(en curso\)/);
  assert.match(report, /Total registrado: 45m/);
});

test('connectWithKey: key inválida (401) no se persiste', async () => {
  stubFetch([{ match: (u) => u.includes('/user'), handler: () => jsonResponse({}, 401) }]);
  try {
    const result = await connectWithKey('key-mala');
    assert.strictEqual(result.ok, false);
    assert.match(result.message, /401/);
    assert.strictEqual(isConfigured(), false);
  } finally {
    restoreFetch();
    disconnect();
  }
});

test('connectWithKey: key válida verifica y persiste; disconnect limpia', async () => {
  stubFetch([
    {
      match: (u) => u.includes('/user'),
      handler: () => jsonResponse({ id: 'u1', name: 'Ana', email: 'ana@empresa.com' })
    },
    {
      match: (u) => u.includes('/workspaces'),
      handler: () => jsonResponse([{ id: 'w1', name: 'Mi Workspace' }])
    }
  ]);
  try {
    const result = await connectWithKey('key-valida');
    assert.strictEqual(result.ok, true);
    assert.match(result.message, /Ana/);
    assert.match(result.message, /Mi Workspace/);
    assert.strictEqual(isConfigured(), true);
    assert.match(getStatus(), /Ana/);
    assert.match(getStatus(), /Mi Workspace/);
  } finally {
    restoreFetch();
  }
  disconnect();
  assert.strictEqual(isConfigured(), false);
});

test('getDailyActivity: normaliza, incluye en curso, descarta fuera del día, ordena', async () => {
  stubFetch([
    {
      // IMPORTANTE: primero time-entries (su URL contiene "/user/")
      match: (u) => u.includes('/time-entries'),
      handler: (u, opts) => {
        assert.match(opts.headers['X-Api-Key'], /key-valida/);
        assert.match(u, /hydrated=true/);
        return jsonResponse([
          // Fuera del día objetivo en cualquier zona horaria → descartada
          { id: 'fuera', description: 'De otro día', timeInterval: { start: '2026-08-15T10:00:00Z', end: '2026-08-15T11:00:00Z', duration: 'PT1H' } },
          // En progreso (sin end) → se incluye marcada, sin duración
          { id: 'progreso', description: 'Timer corriendo', timeInterval: { start: '2026-08-20T10:00:00Z', end: null } },
          // Desordenadas: se espera orden por start (10:00Z, 13:00Z, 17:00Z)
          { id: 'tres', description: '', project: { id: 'p1', name: 'Proyecto A' }, timeInterval: { start: '2026-08-20T17:00:00Z', end: '2026-08-20T17:45:00Z', duration: 'PT45M' } },
          { id: 'uno', description: 'Debug backend', project: { id: 'p1', name: 'Proyecto A' }, task: { id: 't1', name: 'Bugfixing' }, timeInterval: { start: '2026-08-20T13:00:00Z', end: '2026-08-20T15:30:00Z', duration: 'PT2H30M' } }
        ], 200, { 'last-page': 'true' });
      }
    },
    {
      match: (u) => u.includes('/user'),
      handler: () => jsonResponse({ id: 'u1', name: 'Ana', email: 'ana@empresa.com' })
    },
    {
      match: (u) => u.includes('/workspaces'),
      handler: () => jsonResponse([{ id: 'w1', name: 'Mi Workspace' }])
    }
  ]);
  try {
    const result = await connectWithKey('key-valida');
    assert.strictEqual(result.ok, true);

    const data = await getDailyActivity('20/08/2026');
    assert.strictEqual(data.date, '20/08/2026');
    assert.strictEqual(data.entries.length, 3);

    // Ordenadas por start ascendente: en curso (10:00Z), luego 13:00Z y 17:00Z
    assert.strictEqual(data.entries[0].id, 'progreso');
    assert.strictEqual(data.entries[0].inProgress, true);
    assert.strictEqual(data.entries[0].durationMin, null);
    assert.strictEqual(data.entries[0].endLocal, null);
    assert.strictEqual(data.entries[0].end, null);
    assert.match(data.entries[0].startLocal, /^\d{2}:\d{2}$/);

    assert.strictEqual(data.entries[1].id, 'uno');
    assert.strictEqual(data.entries[1].durationMin, 150);
    assert.strictEqual(data.entries[1].projectName, 'Proyecto A');
    assert.strictEqual(data.entries[1].taskName, 'Bugfixing');
    assert.strictEqual(data.entries[1].description, 'Debug backend');
    assert.match(data.entries[1].startLocal, /^\d{2}:\d{2}$/);
    assert.match(data.entries[1].endLocal, /^\d{2}:\d{2}$/);

    assert.strictEqual(data.entries[2].id, 'tres');
    assert.strictEqual(data.entries[2].durationMin, 45);
    assert.strictEqual(data.entries[2].description, '');

    // La fecha pasada como Date también se normaliza
    const data2 = await getDailyActivity(new Date(2026, 7, 20));
    assert.strictEqual(data2.date, '20/08/2026');
  } finally {
    restoreFetch();
    disconnect();
  }
});

test('getDailyActivity: sin key devuelve vacío sin llamar a la API', async () => {
  stubFetch([]);
  try {
    const data = await getDailyActivity('20/08/2026');
    assert.deepStrictEqual(data, { date: '20/08/2026', entries: [] });
  } finally {
    restoreFetch();
  }
});

test('isConfigured: respeta el respaldo CLOCKIFY_API_KEY del entorno', async () => {
  const prev = process.env.CLOCKIFY_API_KEY;
  process.env.CLOCKIFY_API_KEY = 'key-de-entorno';
  try {
    assert.strictEqual(isConfigured(), true);
    assert.match(getStatus(), /\.env/);
  } finally {
    if (prev === undefined) delete process.env.CLOCKIFY_API_KEY;
    else process.env.CLOCKIFY_API_KEY = prev;
  }
  assert.strictEqual(isConfigured(), false);
});