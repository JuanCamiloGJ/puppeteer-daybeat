const { test } = require('node:test');
const assert = require('node:assert');
const {
  toMinutes,
  toHHMM,
  parseTimeSpentHours,
  dateDDMMYYYYToTimestamp,
  formatDateFromISO,
  buildDayBlocks,
  intersectBlocksWithFree,
  getBusinessDays,
  getMissingRegistrations
} = require('./time.js');

test('toMinutes convierte HHMM a minutos', () => {
  assert.strictEqual(toMinutes('0730'), 450);
  assert.strictEqual(toMinutes('1730'), 1050);
  assert.strictEqual(toMinutes('0000'), 0);
  assert.strictEqual(toMinutes('2359'), 1439);
});

test('toHHMM convierte minutos a HHMM', () => {
  assert.strictEqual(toHHMM(450), '0730');
  assert.strictEqual(toHHMM(1050), '1730');
  assert.strictEqual(toHHMM(0), '0000');
  assert.strictEqual(toHHMM(1439), '2359');
});

test('roundtrip toMinutes/toHHMM es identidad', () => {
  for (const t of ['0000', '0730', '1200', '1730', '2359']) {
    assert.strictEqual(toHHMM(toMinutes(t)), t);
  }
});

test('parseTimeSpentHours interpreta "2h 30m"', () => {
  assert.strictEqual(parseTimeSpentHours('2h 30m'), 2.5);
  assert.strictEqual(parseTimeSpentHours('2h'), 2);
  assert.strictEqual(parseTimeSpentHours('30m'), 0.5);
  assert.strictEqual(parseTimeSpentHours('10m'), 0.5); // piso de 30min
  assert.strictEqual(parseTimeSpentHours(''), 1);
  assert.strictEqual(parseTimeSpentHours(null), 1);
});

test('dateDDMMYYYYToTimestamp compara fechas correctamente', () => {
  assert.ok(dateDDMMYYYYToTimestamp('01/01/2026') < dateDDMMYYYYToTimestamp('02/01/2026'));
  assert.strictEqual(dateDDMMYYYYToTimestamp('01/01/2026'), dateDDMMYYYYToTimestamp('01/01/2026'));
});

test('formatDateFromISO maneja input inválido', () => {
  assert.strictEqual(formatDateFromISO('garbage'), 'garbage');
  assert.strictEqual(formatDateFromISO(''), '');
  assert.match(formatDateFromISO('2026-01-05T10:30:00.000Z'), /^\d{2}\/\d{2}\/\d{4}$/);
});

test('buildDayBlocks devuelve null con menos de 2 eventos o 1 cluster', () => {
  assert.strictEqual(buildDayBlocks([], '0730', '1730'), null);
  assert.strictEqual(buildDayBlocks([{ minutes: 480, weight: 1 }], '0730', '1730'), null);
  // eventos a 60min de distancia forman UN cluster
  assert.strictEqual(
    buildDayBlocks([{ minutes: 480, weight: 1 }, { minutes: 540, weight: 1 }], '0730', '1730'),
    null
  );
});

test('buildDayBlocks reparte proporcional y suma exacto a la jornada', () => {
  const events = [
    { minutes: 480, weight: 1 }, // 08:00
    { minutes: 800, weight: 1 }  // 13:20
  ];
  const blocks = buildDayBlocks(events, '0730', '1730');
  assert.ok(Array.isArray(blocks));
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].start, '0730');
  assert.strictEqual(blocks[1].end, '1730');
  // suma exacta: el total de minutos de los bloques == jornada completa
  const total = blocks.reduce((sum, b) => sum + (toMinutes(b.end) - toMinutes(b.start)), 0);
  assert.strictEqual(total, toMinutes('1730') - toMinutes('0730'));
});

test('buildDayBlocks respeta pesos (1 vs 3)', () => {
  const events = [
    { minutes: 480, weight: 1 },
    { minutes: 800, weight: 3 }
  ];
  const blocks = buildDayBlocks(events, '0730', '1730');
  const first = toMinutes(blocks[0].end) - toMinutes(blocks[0].start);
  const second = toMinutes(blocks[1].end) - toMinutes(blocks[1].start);
  assert.strictEqual(first, 150);
  assert.strictEqual(second, 450);
  assert.strictEqual(first + second, 600);
});

test('buildDayBlocks limita a 4 bloques', () => {
  // 6 clusters aislados (separados > 60min) -> se fusionan hasta 4
  const events = [420, 540, 660, 780, 900, 1020].map(minutes => ({ minutes, weight: 1 }));
  const blocks = buildDayBlocks(events, '0730', '1730');
  assert.ok(blocks.length <= 4);
});

test('intersectBlocksWithFree devuelve los bloques intactos sin rangos ocupados', () => {
  const blocks = [{ start: '0730', end: '1730', events: [{ m: 1 }, { m: 2 }] }];
  assert.strictEqual(intersectBlocksWithFree(blocks, [], '0730', '1730'), blocks);
  assert.strictEqual(intersectBlocksWithFree(null, [{ start: '0800', end: '1100' }], '0730', '1730'), null);
});

test('intersectBlocksWithFree parte el bloque en los huecos libres', () => {
  const blocks = [{ start: '0730', end: '1730', events: [{ m: 1 }, { m: 2 }] }];
  const occupied = [{ start: '0930', end: '1030' }];
  const result = intersectBlocksWithFree(blocks, occupied, '0730', '1730');
  assert.ok(Array.isArray(result));
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].start, '0730');
  assert.strictEqual(result[0].end, '0930');
  assert.strictEqual(result[1].start, '1030');
  assert.strictEqual(result[1].end, '1730');
  assert.strictEqual(result[0].events.length, 1);
  assert.strictEqual(result[1].events.length, 1);
});

test('intersectBlocksWithFree descarta bloque totalmente ocupado', () => {
  const blocks = [{ start: '0900', end: '1000', events: [{ m: 1 }, { m: 2 }] }];
  const occupied = [{ start: '0800', end: '1100' }];
  assert.strictEqual(intersectBlocksWithFree(blocks, occupied, '0730', '1730'), null);
});

test('getBusinessDays excluye fines de semana y festivos', () => {
  // 2026-08-15 es sábado, 2026-08-17 es lunes
  const start = new Date(2026, 7, 15);
  const end = new Date(2026, 7, 17);
  assert.deepStrictEqual(getBusinessDays(start, end), ['17/08/2026']);
  assert.deepStrictEqual(getBusinessDays(start, end, ['17/08/2026']), []);
});

test('getMissingRegistrations filtra días ya registrados', () => {
  const business = ['15/08/2026', '17/08/2026', '18/08/2026'];
  assert.deepStrictEqual(
    getMissingRegistrations(['15/08/2026'], business),
    ['17/08/2026', '18/08/2026']
  );
});
