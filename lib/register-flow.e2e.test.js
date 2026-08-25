// Harness E2E del flujo de registro con frames mockeados.
//
// Previene la regresión del bug "después de confirmar sí no termina":
//   - getExistingRanges navega el frame (detalle -> formulario) y el frame del
//     caller queda OBSOLETO (Puppeteer recrea el objeto Frame en cada
//     navegación del iframe).
//   - El flujo debe re-adquirir el frame 'tres' fresco tras el guard y escribir
//     los campos con setFieldValue (setter DOM con input/change), NUNCA con
//     frame.type (agrega texto, frágil con Unicode/newlines, y sobre un frame
//     muerto falla en silencio porque la llamada inicial no tenía await).
//
// El test mockea `page` y los `frames` (page.frames() devuelve un array
// mutable) y reemplaza solo las piezas que hacen navegación/DOM reales
// (getExistingRanges, getCurrentUser, delay). El resto del flujo (daybeat.js,
// register.js, setFieldValue real) se ejecuta tal cual.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ---------------------------- stubs de módulos ----------------------------
// `nextMode` permite al test del modo 6 responder la selección de modo sin
// romper el test original (que responde modo 1).
let nextMode = '1';
// `lastUsedHours` mutable: el test del horario no estándar lo cambia a
// 1030-1630 (horario guardado de una media jornada) para verificar que el
// flujo pregunta y usa la jornada completa al confirmar.
let lastUsedHours = { start: '0730', end: '1630' };
let confirmAnswers = [true];
let confirmCalls = [];
// Estado mutable para simular la IA (sin llamadas reales al provider):
// `aiEnabled` activa el stub de ai-config; `aiResult` es lo que devuelve
// generateWithGemini y `geminiCalls` registra cada invocación (commits,
// contexto, fecha objetivo, extraContext).
let aiEnabled = false;
let aiResult = null;
let geminiCalls = [];
const promptStub = {
  ask: async () => { const m = nextMode; nextMode = '1'; return m; },
  askConfirm: async (question) => { confirmCalls.push(question); return confirmAnswers.shift() ?? true; },
  askSelect: async () => 0,
  askCheckbox: async () => [],
  restoreReadline: () => {},
  close: () => {},
  ALL: '__ALL__',
};
const jiraStub = {
  isConfigured: () => true,        // Jira configurado (modo 5 y 6 visibles)
  getDailyActivity: async () => jiraDailyActivity,
  formatActivityForReport: () => '',
  closeConnection: async () => {},
};
// Estado mutable por test para el caso "Jira solo comentarios/worklogs +
// Clockify" (regresión modo 6): getDailyActivity devuelve lo configurado y
// multiSelectAll simula el checkbox con "Seleccionar todos" (devuelve los
// objetos ORIGINALES de activity/clockifyData, con sus arrays tal cual).
let jiraDailyActivity = { issues: [], comments: [], worklogs: [] };
let multiSelectAll = false;
// Clockify: configurado con una entry EN CURSO (el caso real: timer corriendo
// sin end). getDailyActivity y formatActivityForReport del MÓDULO de clockify.
const clockifyStub = {
  isConfigured: () => true,
  getDailyActivity: async () => ({
    date: '21/08/2026',
    entries: [{
      id: 'e1', description: 'Timer', projectName: '', taskName: '',
      start: '2026-08-21T12:43:05Z', end: null,
      startLocal: '07:43', endLocal: null, durationMin: null, inProgress: true
    }]
  }),
  formatActivityForReport: (data) => `Clockify report (${data.entries.length} entries)`,
  formatDuration: (m) => `${m}m`,
};
const aiStub = { isAIEnabled: () => aiEnabled };
const gitStub = {
  getReposWithCache: () => [],     // sin repos -> resumen fake
  getGitAuthor: () => 'autor@test',
  getTodayCommits: () => [],
  getRecentCommits: () => [],
  getCommitsWithTime: () => [],
};
const summaryStub = {
  generateWithGemini: async (commits, context, targetDate, extraContext) => {
    geminiCalls.push({ commits, context, targetDate, extraContext });
    return aiResult;
  },
  generateFakeSummary: () => 'Resumen fake',
  generateDetail: () => 'Detalle fake',
  summarizeCommits: () => 'Resumen',
  smartTruncate: (s) => s,
};
const pathStub = { resolveRootDir: (d) => d, toLinuxPath: (p) => p };
const persistenceStub = {
  getLastUsedHours: () => lastUsedHours,
  saveHours: () => {},
  savePathCache: () => {},
  loadPathCache: () => null,
  loadRepoCache: () => null,
  saveRepoCache: () => {},
  loadRegistrationsCache: () => null,
  getCachedUser: () => null,
  mergeDatesForUser: () => {},
};
const commonStub = {
  questionUserResponse: async () => promptStub.ask(),
  selectJiraActivityMulti: async () => ({}),
  selectActivityMulti: async (activity, clockifyData) =>
    multiSelectAll ? { jira: activity, clockify: clockifyData } : { jira: null, clockify: null },
  askPeriod: async () => ({ days: 30, label: '1 mes' }),
  checkHolidaysYear: async () => [],
};

function stubFile(relPath, exportsObj) {
  const resolved = require.resolve(path.join(__dirname, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stubFile('prompt.js', promptStub);
stubFile('jira-report.js', jiraStub);
stubFile('clockify.js', clockifyStub);
stubFile('ai-config.js', aiStub);
stubFile('git.js', gitStub);
stubFile('summary.js', summaryStub);
stubFile('path.js', pathStub);
stubFile('persistence.js', persistenceStub);
stubFile('flows/common.js', commonStub);

// daybeat.js real, con las piezas de navegación/DOM reemplazadas
const daybeatReal = require(path.join(__dirname, 'daybeat.js'));

// ---------------------------- frame mockeado ------------------------------
class FakeFrame {
  constructor(name, url) {
    this._name = name;
    this.name = () => name;     // Puppeteer: frame.name() es método
    this.url = url;
    this.$evalFills = [];   // escrituras via $eval (setFieldValue real)
    this.typed = [];        // frame.type (NO debe usarse)
    this.clicked = [];
    this.selected = [];
  }
  async waitForSelector() { return true; }
  async evaluate(fn, ...args) { return fn(...args); }
  async $$eval(selector, fn, ...args) {
    let elements = [];
    if (selector.includes('id_categoria')) {
      elements = [{ value: '5', textContent: 'Certificación (Calidad)' }, { value: '', textContent: 'Seleccione' }];
    } else if (selector.includes('cod_tipotransaccion')) {
      elements = [{ value: '658', textContent: 'PRI/NE - 0 - Preparación de Data' }, { value: '', textContent: 'Seleccione' }];
    }
    return fn(elements, ...args);
  }
  async $eval(selector, fn, ...args) {
    // el input parte con contenido residual: el setter debe REEMPLAZAR, no agregar
    const el = { value: 'RESIDUO_ée', events: [], dispatchEvent(ev) { this.events.push(ev.type); } };
    fn(el, ...args);
    this.$evalFills.push({ selector, value: el.value, events: el.events });
    return true;
  }
  async select(selector, value) { this.selected.push({ selector, value }); return []; }
  async type(selector, text) { this.typed.push({ selector, text }); }
  async click(selector) { this.clicked.push(selector); }
}

let currentFrames = null;
const browser = { close: async () => {} };
// Simulación real de los listeners de diálogo del navegador: el flujo retira
// el handler global (removeAllListeners), registra uno propio con page.once
// ANTES del click y fireDialog() lo dispara de forma determinística (mismo
// patrón que en producción, sin tiempos de espera reales).
let globalDialogHandler = null;
let onceDialogHandlers = [];
const fakeDialog = (message) => ({
  message: () => message,
  accept: async () => {},
});
const fireDialog = async (message) => {
  // En producción el flujo retira el handler global (removeAllListeners) antes
  // de registrar el propio, así que solo un handler está activo a la vez.
  // La simulación debe respetar ese orden: si hay handlers once, se disparan
  // esos; en caso contrario (p. ej. un diálogo inesperado), se dispara el
  // handler global (handleGlobalDialog).
  const handlers = onceDialogHandlers.splice(0);
  if (handlers.length === 0 && globalDialogHandler) {
    handlers.push(globalDialogHandler);
  }
  for (const handler of handlers) {
    await handler(fakeDialog(message));
  }
};
const page = {
  frames: () => currentFrames,
  browser: () => browser,
  on: (event, handler) => { if (event === 'dialog') globalDialogHandler = handler; },
  once: (event, handler) => { if (event === 'dialog') onceDialogHandlers.push(handler); },
  removeAllListeners: (event) => {
    if (!event || event === 'dialog') {
      globalDialogHandler = null;
      onceDialogHandlers = [];
    }
  },
};

// Arranca el flujo y espera (con acotación) a que el submit del bloque único
// registre su listener de diálogo; devuelve el flujo para que el test dispare
// el diálogo (éxito/rechazo) y luego lo espere. Se devuelve como objeto {flow}
// a propósito: devolver el promise del flujo desde una función async haría que
// el await del caller esperara el flujo COMPLETO (flattening), y fireDialog
// correría después del timeout.
const startFlowAndWaitForSubmit = async (frameTree, ...args) => {
  const flow = registerNewTransaction(frameTree, page, ...args);
  const deadline = Date.now() + 2000;
  while (onceDialogHandlers.length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { flow };
};

const overriddenDaybeat = {
  ...daybeatReal,
  delay: async () => {},
  getCurrentUser: async () => 'Jhon Carvajal',
  // simula la navegación del guard: reemplaza el frame 'tres' por uno NUEVO,
  // igual que Puppeteer cuando el iframe navega (objeto Frame distinto).
  getExistingRanges: async (frameTree, p) => {
    const idx = p.frames().findIndex(f => f.name() === 'tres');
    const fresh = new FakeFrame('tres', frameTree.url);
    fresh.isFresh = true;
    p.frames()[idx] = fresh;
    return { ranges: [], count: 0 };
  },
};
stubFile('daybeat.js', overriddenDaybeat);

const { registerNewTransaction } = require(path.join(__dirname, 'flows', 'register.js'));

test('tras getExistingRanges re-adquiere el frame fresco y escribe por DOM (no frame.type)', async () => {
  const original = new FakeFrame('tres', 'http://daybeat/transaccionesint_crear.asp?flag=&id_requerimiento=1');
  currentFrames = [original, new FakeFrame('uno'), new FakeFrame('cinco')];
  confirmAnswers = [true, false]; // continuar + salir (finishOrContinue)
  confirmCalls = [];

  const { flow } = await startFlowAndWaitForSubmit(
    original, null,
    { value: '5', text: 'Certificación (Calidad)' },
    { value: '658', text: 'PRI/NE - 0 - Preparación de Data' },
    'Sección', 'Item'
  );
  await fireDialog('Transacción ingresada éxitosamente');
  await flow;

  const fresh = currentFrames.find(f => f.name() === 'tres');
  assert.ok(fresh && fresh.isFresh, 'el flujo debe re-adquirir el frame fresco tras el guard');

  // Los 5 campos se escriben en el frame FRESCO via $eval (setFieldValue real)
  const fillSelectors = fresh.$evalFills.map(f => f.selector).sort();
  assert.deepStrictEqual(fillSelectors, [
    'input[name="descripcion_corta"]',
    'input[name="fechaini"]',
    'input[name="horaini"]',
    'input[name="horafin"]',
    'textarea[name="texto_largo"]',
  ].sort(), 'todos los campos deben escribirse en el frame fresco');

  // El valor REEMPLAZA el contenido residual (no queda "RESIDUO_ée")
  const desc = fresh.$evalFills.find(f => f.selector === 'input[name="descripcion_corta"]');
  assert.strictEqual(desc.value, 'Resumen fake');
  assert.deepStrictEqual(desc.events, ['input', 'change'], 'setFieldValue debe disparar input+change');

  const detalle = fresh.$evalFills.find(f => f.selector === 'textarea[name="texto_largo"]');
  assert.strictEqual(detalle.value, 'Detalle fake');

  const hi = fresh.$evalFills.find(f => f.selector === 'input[name="horaini"]');
  const hf = fresh.$evalFills.find(f => f.selector === 'input[name="horafin"]');
  assert.strictEqual(hi.value, '0730');
  assert.strictEqual(hf.value, '1630');

  // Nunca se escribe sobre el frame obsoleto ni se usa frame.type
  assert.strictEqual(original.$evalFills.length, 0, 'el frame viejo no debe recibir escrituras');
  assert.strictEqual(original.typed.length, 0, 'el frame viejo no debe recibir frame.type');
  assert.strictEqual(fresh.typed.length, 0, 'no se debe usar frame.type en el frame fresco');

  assert.ok(fresh.clicked.includes('input[type="submit"][class="bot"]'), 'se debe enviar el formulario');
  assert.ok(confirmCalls.includes('¿Desea registrar otra actividad?'), 'tras la confirmación del servidor se llega a finishOrContinue');
});

test('modo 6 con actividad de Clockify no crashea y completa el registro', async () => {
  // REGRESIÓN: el formateador de Clockify se usaba con el formateador de Jira
  // (formatActivityForReport bare) → TypeError: issues.length con datos de
  // Clockify (que traen { entries }, no { issues }). El flujo debe mostrar la
  // actividad detectada y completar el registro sin lanzar.
  nextMode = '6'; // selección de modo; el siguiente ask responde '1' (bloque único)
  confirmAnswers = [true, false]; // continuar + salir (finishOrContinue)
  confirmCalls = [];

  const original = new FakeFrame('tres', 'http://daybeat/transaccionesint_crear.asp?flag=&id_requerimiento=1');
  currentFrames = [original, new FakeFrame('uno'), new FakeFrame('cinco')];

  const { flow } = await startFlowAndWaitForSubmit(
    original, null,
    { value: '5', text: 'Certificación (Calidad)' },
    { value: '658', text: 'PRI/NE - 0 - Preparación de Data' },
    'Sección', 'Item'
  );
  await fireDialog('Transacción ingresada éxitosamente');
  await flow;

  const fresh = currentFrames.find(f => f.name() === 'tres');
  assert.ok(fresh && fresh.isFresh, 'el flujo debe re-adquirir el frame fresco tras el guard');

  const fillSelectors = fresh.$evalFills.map(f => f.selector).sort();
  assert.deepStrictEqual(fillSelectors, [
    'input[name="descripcion_corta"]',
    'input[name="fechaini"]',
    'input[name="horaini"]',
    'input[name="horafin"]',
    'textarea[name="texto_largo"]',
  ].sort(), 'todos los campos deben escribirse en el frame fresco');

  // Sin commits ni Jira, cae al resumen fake (el guard del modo 6 no se activa:
  // clockify está configurado en el stub)
  const desc = fresh.$evalFills.find(f => f.selector === 'input[name="descripcion_corta"]');
  assert.strictEqual(desc.value, 'Resumen fake');
  assert.strictEqual(original.$evalFills.length, 0, 'el frame viejo no debe recibir escrituras');
  assert.strictEqual(fresh.typed.length, 0, 'no se debe usar frame.type en el frame fresco');
  assert.ok(fresh.clicked.includes('input[type="submit"][class="bot"]'), 'se debe enviar el formulario');
});

test('modo 6 con Jira SOLO comentarios + Clockify: título desde el comentario, sin crashear (regresión issues[0])', async () => {
  // REGRESIÓN: con "Seleccionar todos" y Jira con SOLO comentarios (sin
  // incidencias), el fallback leía selectedJiraActivity.issues[0] → TypeError
  // (Cannot read properties of undefined reading 'key') en la línea 544. El
  // título debe salir del primer comentario y el detalle del contexto
  // combinado (Jira + Clockify), y el registro debe completarse.
  nextMode = '6'; // selección de modo; el siguiente ask responde '1' (bloque único)
  jiraDailyActivity = {
    issues: [],
    comments: [{ issueKey: 'DAY-42', body: 'Avanzo con el reporte diario', author: 'Test', created: '2026-08-21T15:00:00.000Z' }],
    worklogs: [],
  };
  multiSelectAll = true;
  confirmAnswers = [true, false]; // continuar + salir (finishOrContinue)
  confirmCalls = [];

  const original = new FakeFrame('tres', 'http://daybeat/transaccionesint_crear.asp?flag=&id_requerimiento=1');
  currentFrames = [original, new FakeFrame('uno'), new FakeFrame('cinco')];

  const { flow } = await startFlowAndWaitForSubmit(
    original, null,
    { value: '5', text: 'Certificación (Calidad)' },
    { value: '658', text: 'PRI/NE - 0 - Preparación de Data' },
    'Sección', 'Item'
  );
  await fireDialog('Transacción ingresada éxitosamente');
  await flow;

  const fresh = currentFrames.find(f => f.name() === 'tres');
  assert.ok(fresh && fresh.isFresh, 'el flujo debe re-adquirir el frame fresco tras el guard');

  const desc = fresh.$evalFills.find(f => f.selector === 'input[name="descripcion_corta"]');
  assert.strictEqual(desc.value, 'Actividad en Jira: DAY-42 (comentario)', 'el título debe derivarse del primer comentario (no de issues[0])');

  const detalle = fresh.$evalFills.find(f => f.selector === 'textarea[name="texto_largo"]');
  assert.ok(detalle.value.includes('Clockify report (1 entries)'), 'el detalle debe incluir el contexto combinado de Clockify');

  assert.strictEqual(original.$evalFills.length, 0, 'el frame viejo no debe recibir escrituras');
  assert.strictEqual(fresh.typed.length, 0, 'no se debe usar frame.type en el frame fresco');
  assert.ok(fresh.clicked.includes('input[type="submit"][class="bot"]'), 'se debe enviar el formulario');

  // Restaurar estado para no afectar otros tests
  jiraDailyActivity = { issues: [], comments: [], worklogs: [] };
  multiSelectAll = false;
  confirmAnswers = [true];
});

test('modo 6 con Jira SOLO worklogs + Clockify: título desde el worklog, sin crashear (regresión issues[0])', async () => {
  // Misma regresión que con comentarios: Jira sin incidencias pero con
  // worklogs. El título debe salir del primer worklog.
  nextMode = '6';
  jiraDailyActivity = {
    issues: [],
    comments: [],
    worklogs: [{ issueKey: 'DAY-43', timeSpent: '2h 30m', comment: 'Análisis de requerimiento', author: 'Test', started: '2026-08-21T13:00:00.000Z' }],
  };
  multiSelectAll = true;
  confirmAnswers = [true, false]; // continuar + salir (finishOrContinue)
  confirmCalls = [];

  const original = new FakeFrame('tres', 'http://daybeat/transaccionesint_crear.asp?flag=&id_requerimiento=1');
  currentFrames = [original, new FakeFrame('uno'), new FakeFrame('cinco')];

  const { flow } = await startFlowAndWaitForSubmit(
    original, null,
    { value: '5', text: 'Certificación (Calidad)' },
    { value: '658', text: 'PRI/NE - 0 - Preparación de Data' },
    'Sección', 'Item'
  );
  await fireDialog('Transacción ingresada éxitosamente');
  await flow;

  const fresh = currentFrames.find(f => f.name() === 'tres');
  assert.ok(fresh && fresh.isFresh, 'el flujo debe re-adquirir el frame fresco tras el guard');

  const desc = fresh.$evalFills.find(f => f.selector === 'input[name="descripcion_corta"]');
  assert.strictEqual(desc.value, 'Actividad en Jira: DAY-43 (worklog 2h 30m)', 'el título debe derivarse del primer worklog');

  const detalle = fresh.$evalFills.find(f => f.selector === 'textarea[name="texto_largo"]');
  assert.ok(detalle.value.includes('Clockify report (1 entries)'), 'el detalle debe incluir el contexto combinado de Clockify');

  assert.strictEqual(original.$evalFills.length, 0, 'el frame viejo no debe recibir escrituras');
  assert.strictEqual(fresh.typed.length, 0, 'no se debe usar frame.type en el frame fresco');
  assert.ok(fresh.clicked.includes('input[type="submit"][class="bot"]'), 'se debe enviar el formulario');

  // Restaurar estado para no afectar otros tests
  jiraDailyActivity = { issues: [], comments: [], worklogs: [] };
  multiSelectAll = false;
  confirmAnswers = [true];
});

test('horario guardado no estándar: pregunta y usa la jornada completa al confirmar', async () => {
  // REGRESIÓN: el flujo reusaba en silencio el horario del último registro
  // (.daybeat-history.json). Con 1030-1630 guardado, el bloque único salía
  // desde las 1030 en vez de la jornada completa 0730-1630. Ahora pregunta
  // (solo cuando difiere del estándar) y usa 0730-1630 al confirmar.
  nextMode = '1';                       // modo automático
  lastUsedHours = { start: '1030', end: '1630' };
  confirmAnswers = [true, true, false]; // jornada completa + continuar + salir (finishOrContinue)
  confirmCalls = [];

  const original = new FakeFrame('tres', 'http://daybeat/transaccionesint_crear.asp?flag=&id_requerimiento=1');
  currentFrames = [original, new FakeFrame('uno'), new FakeFrame('cinco')];

  const { flow } = await startFlowAndWaitForSubmit(
    original, null,
    { value: '5', text: 'Certificación (Calidad)' },
    { value: '658', text: 'PRI/NE - 0 - Preparación de Data' },
    'Sección', 'Item'
  );
  await fireDialog('Transacción ingresada éxitosamente');
  await flow;

  assert.ok(confirmCalls.some(q => q.includes('jornada completa')), 'debe preguntar por la jornada completa');
  const fresh = currentFrames.find(f => f.name() === 'tres');
  const hi = fresh.$evalFills.find(f => f.selector === 'input[name="horaini"]');
  const hf = fresh.$evalFills.find(f => f.selector === 'input[name="horafin"]');
  assert.strictEqual(hi.value, '0730', 'la jornada completa arranca a las 0730');
  assert.strictEqual(hf.value, '1630', 'la jornada completa termina a las 1630');

  // Restaurar estado para no afectar otros tests
  lastUsedHours = { start: '0730', end: '1630' };
  confirmAnswers = [true];
  confirmCalls = [];
});

test('modo 6 con solo Clockify y IA: la IA genera desde el contexto sin commits y se escribe UNA vez', async () => {
  // REGRESIÓN: el modo 6 solo llamaba a generateWithGemini con commits
  // (allCommits.length > 0) y generateWithGemini devolvía null sin commits,
  // así que con IA configurada pero actividad solo en Clockify se caía al
  // resumen por reglas. Ahora la IA debe invocarse con contexto 'no-commits'
  // y el contexto combinado, y su título/detalle escribirse una sola vez.
  nextMode = '6';
  multiSelectAll = true;               // selecciona el entry de Clockify
  aiEnabled = true;
  aiResult = { title: 'IA título', detail: 'IA detalle' };
  confirmAnswers = [true, false];      // continuar + salir (finishOrContinue)
  confirmCalls = [];
  geminiCalls = [];

  const original = new FakeFrame('tres', 'http://daybeat/transaccionesint_crear.asp?flag=&id_requerimiento=1');
  currentFrames = [original, new FakeFrame('uno'), new FakeFrame('cinco')];

  const { flow } = await startFlowAndWaitForSubmit(
    original, null,
    { value: '5', text: 'Certificación (Calidad)' },
    { value: '658', text: 'PRI/NE - 0 - Preparación de Data' },
    'Sección', 'Item'
  );
  await fireDialog('Transacción ingresada éxitosamente');
  await flow;

  const fresh = currentFrames.find(f => f.name() === 'tres');

  assert.strictEqual(geminiCalls.length, 1, 'la IA debe invocarse una vez (modo 6, sin commits, con contexto)');
  assert.deepStrictEqual(geminiCalls[0].commits, [], 'sin commits la lista de actividad va vacía');
  assert.strictEqual(geminiCalls[0].context, 'no-commits', 'debe usar el contexto explícito no-commits');
  assert.strictEqual(geminiCalls[0].targetDate, null);
  assert.ok(geminiCalls[0].extraContext.includes('Clockify report (1 entries)'), 'el contexto combinado alimenta a la IA');

  const desc = fresh.$evalFills.find(f => f.selector === 'input[name="descripcion_corta"]');
  const detalle = fresh.$evalFills.find(f => f.selector === 'textarea[name="texto_largo"]');
  assert.strictEqual(desc.value, 'IA título', 'el título escrito es el generado por la IA');
  assert.strictEqual(detalle.value, 'IA detalle', 'el detalle escrito es el generado por la IA (sin duplicar el contexto)');
  assert.strictEqual(
    fresh.$evalFills.filter(f => f.selector === 'textarea[name="texto_largo"]').length,
    1,
    'el detalle se escribe una sola vez'
  );

  // Restaurar estado para no afectar otros tests
  aiEnabled = false;
  aiResult = null;
  multiSelectAll = false;
  geminiCalls = [];
  confirmAnswers = [true];
});

test('modo 6 sin commits: el fallback de Clockify no duplica el contexto en el detalle', async () => {
  // REGRESIÓN: sin commits ni IA, detail = combinedContext y luego el append
  // incondicional hacía detail += combinedContext → el reporte de Clockify
  // aparecía dos veces.
  nextMode = '6';
  multiSelectAll = true;
  aiEnabled = false;
  confirmAnswers = [true, false];
  confirmCalls = [];

  const original = new FakeFrame('tres', 'http://daybeat/transaccionesint_crear.asp?flag=&id_requerimiento=1');
  currentFrames = [original, new FakeFrame('uno'), new FakeFrame('cinco')];

  const { flow } = await startFlowAndWaitForSubmit(
    original, null,
    { value: '5', text: 'Certificación (Calidad)' },
    { value: '658', text: 'PRI/NE - 0 - Preparación de Data' },
    'Sección', 'Item'
  );
  await fireDialog('Transacción ingresada éxitosamente');
  await flow;

  const fresh = currentFrames.find(f => f.name() === 'tres');

  const desc = fresh.$evalFills.find(f => f.selector === 'input[name="descripcion_corta"]');
  assert.strictEqual(desc.value, 'Actividad: Timer', 'el título sale de la primera entrada de Clockify');

  const detalle = fresh.$evalFills.find(f => f.selector === 'textarea[name="texto_largo"]');
  assert.strictEqual(detalle.value, 'Clockify report (1 entries)', 'el contexto es el detalle completo y no debe repetirse');
  assert.strictEqual(
    (detalle.value.match(/Clockify report/g) || []).length,
    1,
    'el reporte de Clockify aparece exactamente una vez'
  );

  // Restaurar estado para no afectar otros tests
  multiSelectAll = false;
  confirmAnswers = [true];
});

test('submit de un solo bloque: espera el diálogo de éxito, lo acepta y completa (finishOrContinue)', async () => {
  // REGRESIÓN: el envío del bloque único hacía click y retornaba a merced del
  // handler global no-await de index.js; si el diálogo no llegaba (o llegaba
  // con mayúsculas/acentos distintos), el flujo quedaba colgado sobre el
  // formulario llenado. Ahora el submit es determinístico: listener antes del
  // click, espera acotada y reconocimiento case/accent-insensitive.
  nextMode = '1';
  confirmAnswers = [true, false]; // continuar + salir (finishOrContinue)
  confirmCalls = [];

  const original = new FakeFrame('tres', 'http://daybeat/transaccionesint_crear.asp?flag=&id_requerimiento=1');
  currentFrames = [original, new FakeFrame('uno'), new FakeFrame('cinco')];

  const { flow } = await startFlowAndWaitForSubmit(
    original, null,
    { value: '5', text: 'Certificación (Calidad)' },
    { value: '658', text: 'PRI/NE - 0 - Preparación de Data' },
    'Sección', 'Item'
  );
  // Mensaje con mayúsculas: el reconocimiento debe ser case/accent-insensitive
  await fireDialog('TRANSACCIÓN INGRESADA ÉXITOSAMENTE');
  await flow;

  const fresh = currentFrames.find(f => f.name() === 'tres');
  assert.ok(fresh.clicked.includes('input[type="submit"][class="bot"]'), 'se debe enviar el formulario');
  assert.ok(confirmCalls.includes('¿Desea continuar con estos datos?'), 'el flujo pasa por la confirmación previa');
  assert.ok(confirmCalls.includes('¿Desea registrar otra actividad?'), 'tras la confirmación del servidor se llega a finishOrContinue');

  // Restaurar estado para no afectar otros tests
  confirmAnswers = [true];
  confirmCalls = [];
});

test('submit de un solo bloque sin diálogo: error acotado y controlado (no se cuelga)', async () => {
  // REGRESIÓN: sin diálogo del servidor el flujo quedaba colgado sobre el
  // formulario llenado sin confirmar. Ahora la espera está acotada y, al
  // agotarse, se avisa y se vuelve al flujo controlado (finishOrContinue).
  process.env.DAYBEAT_SUBMIT_DIALOG_TIMEOUT_MS = '50';
  try {
    nextMode = '1';
    confirmAnswers = [true, false]; // continuar + salir (finishOrContinue)
    confirmCalls = [];

    const original = new FakeFrame('tres', 'http://daybeat/transaccionesint_crear.asp?flag=&id_requerimiento=1');
    currentFrames = [original, new FakeFrame('uno'), new FakeFrame('cinco')];

    await registerNewTransaction(
      original, page, null,
      { value: '5', text: 'Certificación (Calidad)' },
      { value: '658', text: 'PRI/NE - 0 - Preparación de Data' },
      'Sección', 'Item'
    );

    const fresh = currentFrames.find(f => f.name() === 'tres');
    assert.ok(fresh.clicked.includes('input[type="submit"][class="bot"]'), 'se debe enviar el formulario');
    assert.ok(confirmCalls.includes('¿Desea registrar otra actividad?'), 'sin confirmación del servidor se llega a finishOrContinue (no se cuelga)');
  } finally {
    delete process.env.DAYBEAT_SUBMIT_DIALOG_TIMEOUT_MS;
    confirmAnswers = [true];
    confirmCalls = [];
  }
});
