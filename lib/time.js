// Dominio de tiempo: conversiones HH:MM, bloques de jornada, días hábiles y
// fechas. Funciones puras (sin I/O, sin puppeteer) — el único módulo que no
// depende de nada externo salvo el propio lenguaje.

// "0730" -> 450 (minutos desde medianoche)
const toMinutes = (hhmm) => {
  const h = parseInt(hhmm.substring(0, 2), 10);
  const m = parseInt(hhmm.substring(2, 4), 10);
  return h * 60 + m;
};

// 450 -> "0730"
const toHHMM = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}${String(m).padStart(2, '0')}`;
};

// Convierte un ISO (UTC de Jira) a HH:MM local, para anclar comentarios/worklogs
const isoToLocalHHMM = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// "2h 30m" / "30m" / "2h" -> horas (float)
const parseTimeSpentHours = (timeSpent) => {
  if (!timeSpent) return 1;
  const h = /(\d+)h/.exec(timeSpent);
  const m = /(\d+)m/.exec(timeSpent);
  const hours = h ? parseInt(h[1], 10) : 0;
  const minutes = m ? parseInt(m[1], 10) : 0;
  return Math.max(0.5, hours + minutes / 60);
};

// "DD/MM/YYYY" -> timestamp (parse local, no UTC: evita el salto de día en UTC-x)
const dateDDMMYYYYToTimestamp = (dateStr) => {
  const [dd, mm, yyyy] = dateStr.split('/');
  return new Date(`${yyyy}-${mm}-${dd}`).getTime();
};

const formatDateFromISO = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso || '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

// Construye los bloques del día a partir de eventos con hora (commits,
// comentarios, worklogs). Los eventos con separación < GAP_MINUTES forman un
// mismo bloque; la duración se reparte proporcional a la actividad de cada
// cluster (mínimo 30min, máximo 4 bloques) y el último absorbe el resto para
// que el total sea EXACTO (nunca quedan horas incompletas).
const buildDayBlocks = (events, startTime, endTime) => {
  const GAP_MINUTES = 60;
  const MAX_BLOCKS = 4;
  const MIN_BLOCK = 30;

  if (!events || events.length < 2) return null;

  const sorted = [...events].sort((a, b) => a.minutes - b.minutes);
  const clusters = [];
  for (const ev of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && ev.minutes - last.lastMinute <= GAP_MINUTES) {
      last.events.push(ev);
      last.lastMinute = ev.minutes;
      last.weight += ev.weight;
    } else {
      clusters.push({ events: [ev], firstMinute: ev.minutes, lastMinute: ev.minutes, weight: ev.weight });
    }
  }
  if (clusters.length < 2) return null;

  // Si hay más de MAX_BLOCKS clusters, fusionar los pares adyacentes menores
  while (clusters.length > MAX_BLOCKS) {
    let best = 1;
    let bestWeight = Infinity;
    for (let i = 1; i < clusters.length; i++) {
      const w = clusters[i - 1].weight + clusters[i].weight;
      if (w < bestWeight) {
        bestWeight = w;
        best = i;
      }
    }
    clusters[best - 1].events.push(...clusters[best].events);
    clusters[best - 1].weight += clusters[best].weight;
    clusters[best - 1].lastMinute = clusters[best].lastMinute;
    clusters.splice(best, 1);
  }

  const totalWeight = clusters.reduce((sum, c) => sum + c.weight, 0);
  const totalMinutes = toMinutes(endTime) - toMinutes(startTime);
  let cursor = toMinutes(startTime);
  const blocks = [];

  for (let i = 0; i < clusters.length; i++) {
    const isLast = i === clusters.length - 1;
    let duration;
    if (isLast) {
      duration = toMinutes(endTime) - cursor; // absorbe el resto: suma exacta
    } else {
      const share = Math.round((clusters[i].weight / totalWeight) * totalMinutes / MIN_BLOCK) * MIN_BLOCK;
      const reserve = MIN_BLOCK * (clusters.length - i - 1);
      duration = Math.max(MIN_BLOCK, Math.min(share, toMinutes(endTime) - cursor - reserve));
    }
    blocks.push({ start: toHHMM(cursor), end: toHHMM(cursor + duration), events: clusters[i].events });
    cursor += duration;
  }

  return blocks;
};

// Remodela bloques propuestos a los huecos libres de la jornada (jornada menos
// rangos ocupados): un bloque puede partirse en piezas >= 30min, los bloques
// totalmente dentro de rangos ocupados se descartan, y si un bloque tiene menos
// eventos que piezas se queda solo con la pieza más grande (evita bloques
// vacíos). Devuelve null si no queda ningún hueco libre.
const intersectBlocksWithFree = (blocks, occupiedRanges, startTime, endTime) => {
  const MIN_BLOCK = 30;
  if (!blocks || blocks.length === 0) return null;
  if (!occupiedRanges || occupiedRanges.length === 0) return blocks;

  const sorted = [...occupiedRanges]
    .map(r => ({ start: toMinutes(r.start), end: toMinutes(r.end) }))
    .sort((a, b) => a.start - b.start);

  // Construir huecos libres: [jornadaStart, jornadaEnd] menos los ocupados
  const free = [];
  let cursor = toMinutes(startTime);
  const jornadaEnd = toMinutes(endTime);
  for (const occ of sorted) {
    if (occ.end <= cursor) continue;
    if (occ.start > cursor) free.push({ start: cursor, end: Math.min(occ.start, jornadaEnd) });
    cursor = Math.max(cursor, occ.end);
    if (cursor >= jornadaEnd) break;
  }
  if (cursor < jornadaEnd) free.push({ start: cursor, end: jornadaEnd });

  const result = [];
  for (const block of blocks) {
    const bStart = toMinutes(block.start);
    const bEnd = toMinutes(block.end);
    const pieces = [];
    for (const slot of free) {
      const s = Math.max(bStart, slot.start);
      const e = Math.min(bEnd, slot.end);
      if (e - s >= MIN_BLOCK) pieces.push({ start: s, end: e });
    }
    if (pieces.length === 0) continue; // bloque sin horario libre -> descartado

    const events = [...block.events];
    // Si hay más piezas que eventos, no tiene sentido partir: quedarse con la
    // pieza más grande (evita bloques vacíos).
    if (events.length < pieces.length) {
      const biggest = pieces.reduce((acc, p) => (p.end - p.start > acc.end - acc.start ? p : acc));
      result.push({
        start: toHHMM(biggest.start),
        end: toHHMM(biggest.end),
        events
      });
      continue;
    }

    // Repartir eventos del bloque a las piezas (en orden)
    pieces.forEach((piece, i) => {
      const isLast = i === pieces.length - 1;
      const eventsForPiece = isLast ? events.splice(0) : events.splice(0, Math.ceil(events.length / (pieces.length - i)));
      result.push({
        start: toHHMM(piece.start),
        end: toHHMM(piece.end),
        events: eventsForPiece
      });
    });
  }

  return result.length > 0 ? result : null;
};

// Días hábiles (lun-vie) entre dos fechas, excluyendo festivos ("DD/MM/YYYY").
const getBusinessDays = (startDate, endDate, holidays = []) => {
  const businessDays = [];
  const current = new Date(startDate);

  while (current <= endDate) {
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const dd = String(current.getDate()).padStart(2, '0');
      const mm = String(current.getMonth() + 1).padStart(2, '0');
      const yyyy = current.getFullYear();
      const dateStr = `${dd}/${mm}/${yyyy}`;
      if (!holidays.includes(dateStr)) {
        businessDays.push(dateStr);
      }
    }
    current.setDate(current.getDate() + 1);
  }

  return businessDays;
};

// Días hábiles sin registro (los que faltan completar).
const getMissingRegistrations = (existingDates, businessDays) => {
  return businessDays.filter(day => !existingDates.includes(day));
};

module.exports = {
  toMinutes,
  toHHMM,
  isoToLocalHHMM,
  parseTimeSpentHours,
  dateDDMMYYYYToTimestamp,
  formatDateFromISO,
  buildDayBlocks,
  intersectBlocksWithFree,
  getBusinessDays,
  getMissingRegistrations
};
