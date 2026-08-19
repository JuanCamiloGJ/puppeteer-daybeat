const { test } = require('node:test');
const assert = require('node:assert');

// Smoke test de la estructura de módulos (Fase 2): cada módulo debe cargar sin
// errores (imports, ciclos) y exponer las funciones que el composition root y
// los flujos consumen. No ejecuta lógica de puppeteer.

const expected = {
  'session.js': ['createSession'],
  'daybeat.js': [
    'delay', 'normalizeText', 'listElements', 'collectAllItems',
    'selectItemAndNavigate', 'navigateFrameRobust', 'logStage',
    'whriteAndNavigateElementSelect', 'selectOptionSelector', 'whriteInput',
    'getCurrentUser', 'extractRegistrations', 'parseTransactionTable',
    'getExistingRanges', 'readTransactionForm', 'updateTransaction',
    'inspectTableStructure'
  ],
  'flows/common.js': ['questionUserResponse', 'selectJiraActivityMulti', 'askPeriod', 'checkHolidaysYear'],
  'flows/register.js': ['registerNewTransaction', 'listAndNavigateNewTransaction', 'finishOrContinue', 'handleGlobalDialog'],
  'flows/missing-report.js': ['showMissingRegistrations'],
  'flows/bulk.js': ['registerBulkMissingDays'],
  'flows/correct.js': ['correctRegistration'],
  'flows/ai-config.js': ['showAIConfigMenu']
};

for (const [file, exports_] of Object.entries(expected)) {
  test(`module ${file} carga y expone sus funciones`, () => {
    const mod = require(`./${file}`);
    for (const name of exports_) {
      assert.strictEqual(typeof mod[name], 'function', `${file} debe exportar ${name}()`);
    }
  });
}

test('createSession arma el objeto Session (ISP)', () => {
  const { createSession } = require('./session.js');
  const session = createSession({ page: 'p', browser: 'b', company: 'c', usernameDaybeat: 'u', password: 'pw', holidays: ['01/01/2026'] });
  assert.deepStrictEqual(session, {
    page: 'p', browser: 'b', company: 'c', usernameDaybeat: 'u', password: 'pw', holidays: ['01/01/2026']
  });
  // holidays por defecto
  assert.deepStrictEqual(createSession({ page: 'p' }).holidays, []);
});

// Limpieza: require de prompt.js crea un readline sobre stdin que mantiene
// vivo el event loop del runner. Cerrarlo permite que el proceso termine.
test('cierra el readline del prompt (limpieza)', () => {
  require('./prompt.js').close();
  assert.ok(true);
});
