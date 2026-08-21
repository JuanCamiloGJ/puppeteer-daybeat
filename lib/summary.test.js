const { test } = require('node:test');
const assert = require('node:assert');
const {
  getContextPrefix,
  generateGenericText,
  categorizeCommits,
  generateStructuredSummary,
  generateDetail,
  summarizeCommits,
  generateFakeSummary,
  smartTruncate
} = require('./summary.js');

test('categorizeCommits clasifica por prefijo conventional', () => {
  const categories = categorizeCommits([
    'feat: nueva pantalla de login',
    'fix: corregir timeout',
    'FIX(CORE): otro fix con scope',
    'refactor: limpiar servicio',
    'docs: actualizar README',
    'test: agregar tests',
    'chore: actualizar dependencias',
    'mensaje suelto sin prefijo'
  ]);
  assert.deepStrictEqual(categories.feat, ['nueva pantalla de login']);
  assert.deepStrictEqual(categories.fix, ['corregir timeout', 'otro fix con scope']);
  assert.deepStrictEqual(categories.refactor, ['limpiar servicio']);
  assert.deepStrictEqual(categories.docs, ['actualizar README']);
  assert.deepStrictEqual(categories.test, ['agregar tests']);
  assert.deepStrictEqual(categories.chore, ['actualizar dependencias']);
  assert.deepStrictEqual(categories.other, ['mensaje suelto sin prefijo']);
});

test('generateStructuredSummary arma el resumen en orden', () => {
  const cats = categorizeCommits(['feat: a', 'feat: b', 'fix: c']);
  const summary = generateStructuredSummary(cats);
  assert.strictEqual(summary, 'Implementación de: a, b. Correcciones: c');
});

test('generateStructuredSummary trunca a 100 caracteres', () => {
  const long = 'x'.repeat(40);
  const cats = categorizeCommits([
    `feat: ${long}`,
    `feat: ${long}`,
    `fix: ${long}`,
    `refactor: ${long}`,
    `docs: ${long}`,
    `test: ${long}`,
    `chore: ${long}`
  ]);
  const summary = generateStructuredSummary(cats);
  assert.strictEqual(summary.length, 100);
  assert.ok(summary.endsWith('...'));
});

test('generateStructuredSummary usa "other" si no hay categorías', () => {
  const cats = categorizeCommits(['una cosa', 'otra cosa', 'mas cosas']);
  assert.strictEqual(generateStructuredSummary(cats), 'una cosa. otra cosa. mas cosas');
});

test('generateDetail tiene fallback para commits vacíos', () => {
  assert.strictEqual(
    generateDetail([]),
    'Actividad de desarrollo: revisión de código, pruebas y ajustes menores.'
  );
});

test('generateDetail arma partes por categoría', () => {
  const detail = generateDetail(['feat: login', 'feat: registro', 'fix: bug']);
  assert.ok(detail.startsWith('Desarrollo de funcionalidades: login, registro.'));
  assert.ok(detail.includes('Corrección de errores: bug.'));
});

test('summarizeCommits devuelve "" sin commits y deduplica', () => {
  assert.strictEqual(summarizeCommits([]), '');
  const one = summarizeCommits(['feat: a', 'feat: a']);
  const two = summarizeCommits(['feat: a', 'feat: b']);
  assert.strictEqual(one, 'Implementación de: a');
  assert.strictEqual(two, 'Implementación de: a, b');
});

test('generateFakeSummary tiene fallback para commits vacíos', () => {
  assert.strictEqual(
    generateFakeSummary([]),
    'Actividad de desarrollo: revisión de código, pruebas y ajustes menores.'
  );
});

test('smartTruncate pasa texto corto intacto', () => {
  assert.strictEqual(smartTruncate('hola', 10), 'hola');
});

test('smartTruncate corta en la última oración si el punto está en el 60% final', () => {
  const text = 'x'.repeat(13) + '. resto del texto';
  assert.strictEqual(smartTruncate(text, 20), 'x'.repeat(13) + '.');
});

test('smartTruncate corta en el último espacio y cierra con punto', () => {
  const text = 'hello world. goodbye';
  assert.strictEqual(smartTruncate(text, 10), 'hello.');
});

test('getContextPrefix según distancia del commit', () => {
  const commits = [{ message: 'a', date: '2026-08-17' }];
  assert.strictEqual(getContextPrefix('17/08/2026', commits), '');
  assert.strictEqual(getContextPrefix('18/08/2026', commits), 'Continuación de: ');
  assert.strictEqual(getContextPrefix('19/08/2026', commits), 'Seguimiento de: ');
  assert.strictEqual(getContextPrefix('22/08/2026', commits), 'Avance en: ');
  assert.strictEqual(getContextPrefix('01/09/2026', commits), 'Trabajo en: ');
  assert.strictEqual(getContextPrefix('01/09/2026', []), '');
});

test('generateGenericText devuelve título y detalle no vacíos', () => {
  const result = generateGenericText('17/08/2026'); // lunes
  assert.ok(typeof result.title === 'string' && result.title.length > 0);
  assert.ok(typeof result.detail === 'string' && result.detail.length > 0);
});
