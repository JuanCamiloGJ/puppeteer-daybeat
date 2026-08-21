const { test } = require('node:test');
const assert = require('node:assert');
const { getRotatedCommits } = require('./git.js');

// La implementación deriva el día de la semana con `new Date('YYYY-MM-DD')`,
// que parsea en UTC: en zonas al oeste de UTC el día local puede ser el
// anterior. Estos tests calculan el weekday EXACTAMENTE igual que el código,
// así el contrato (regla por día de la semana) se valida sin depender de la
// zona horaria de la máquina.
const dayOfWeek = (dateStr) => {
  const [day, month, year] = dateStr.split('/');
  return new Date(`${year}-${month}-${day}`).getDay();
};

const commits = [
  { message: 'a', date: '2026-08-18' },
  { message: 'b', date: '2026-08-17' },
  { message: 'c', date: '2026-08-14' }
];

test('getRotatedCommits devuelve [] sin commits', () => {
  assert.deepStrictEqual(getRotatedCommits([], '17/08/2026'), []);
});

// Para cada regla del switch, elegimos una fecha objetivo cuyo getDay() local
// coincida con el caso que queremos probar.
test('getRotatedCommits: reglas por día de la semana', () => {
  // Caso 1 (lunes local): usa el más reciente
  const mon = ['17/08/2026', '18/08/2026', '24/08/2026', '25/08/2026'].find(d => dayOfWeek(d) === 1);
  assert.ok(mon, 'no se encontró un lunes local');
  assert.deepStrictEqual(getRotatedCommits(commits, mon), ['a']);

  // Caso 2 (martes local): usa el segundo más reciente
  const tue = ['18/08/2026', '19/08/2026', '25/08/2026', '26/08/2026'].find(d => dayOfWeek(d) === 2);
  assert.ok(tue, 'no se encontró un martes local');
  assert.deepStrictEqual(getRotatedCommits(commits, tue), ['b']);

  // Caso 3 (miércoles local): usa el tercero más reciente
  const wed = ['19/08/2026', '20/08/2026', '26/08/2026', '27/08/2026'].find(d => dayOfWeek(d) === 3);
  assert.ok(wed, 'no se encontró un miércoles local');
  assert.deepStrictEqual(getRotatedCommits(commits, wed), ['c']);

  // Caso 4 (jueves local): combina los dos más recientes
  const thu = ['20/08/2026', '21/08/2026', '27/08/2026', '28/08/2026'].find(d => dayOfWeek(d) === 4);
  assert.ok(thu, 'no se encontró un jueves local');
  assert.deepStrictEqual(getRotatedCommits(commits, thu), ['a', 'b']);

  // Caso 5 (viernes local) y default (fin de semana): usa el más reciente
  const fri = ['21/08/2026', '22/08/2026', '28/08/2026', '29/08/2026'].find(d => dayOfWeek(d) === 5);
  assert.ok(fri, 'no se encontró un viernes local');
  assert.deepStrictEqual(getRotatedCommits(commits, fri), ['a']);

  const weekend = ['22/08/2026', '23/08/2026', '29/08/2026', '30/08/2026'].find(d => d === '22/08/2026' || dayOfWeek(d) === 0 || dayOfWeek(d) === 6);
  assert.deepStrictEqual(getRotatedCommits(commits, weekend), ['a']);
});
