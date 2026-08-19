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
const promptStub = {
  ask: async () => '1',            // modo 1 (automático) y luego bloque único
  askConfirm: async () => true,    // "¿Desea continuar con estos datos?" -> sí
  askSelect: async () => 0,
  askCheckbox: async () => [],
  restoreReadline: () => {},
  close: () => {},
  ALL: '__ALL__',
};
const jiraStub = {
  isConfigured: () => false,       // sin Jira: modo 5 no aparece
  getDailyActivity: async () => ({ issues: [], comments: [], worklogs: [] }),
  formatActivityForReport: () => '',
  closeConnection: async () => {},
};
const aiStub = { isAIEnabled: () => false };
const gitStub = {
  getReposWithCache: () => [],     // sin repos -> resumen fake
  getGitAuthor: () => 'autor@test',
  getTodayCommits: () => [],
  getRecentCommits: () => [],
  getCommitsWithTime: () => [],
};
const summaryStub = {
  generateWithGemini: async () => null,
  generateFakeSummary: () => 'Resumen fake',
  generateDetail: () => 'Detalle fake',
  summarizeCommits: () => 'Resumen',
  smartTruncate: (s) => s,
};
const pathStub = { resolveRootDir: (d) => d, toLinuxPath: (p) => p };
const persistenceStub = {
  getLastUsedHours: () => ({ start: '0730', end: '1630' }),
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
  askPeriod: async () => ({ days: 30, label: '1 mes' }),
  checkHolidaysYear: async () => [],
};

function stubFile(relPath, exportsObj) {
  const resolved = require.resolve(path.join(__dirname, relPath));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

stubFile('prompt.js', promptStub);
stubFile('jira-report.js', jiraStub);
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
const page = {
  frames: () => currentFrames,
  browser: () => browser,
  on: () => {},
  once: () => {},
  removeAllListeners: () => {},
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

  await registerNewTransaction(
    original, page, null,
    { value: '5', text: 'Certificación (Calidad)' },
    { value: '658', text: 'PRI/NE - 0 - Preparación de Data' },
    'Sección', 'Item'
  );

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
});
