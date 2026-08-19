// Persistencia de los stores JSON del proyecto (.daybeat-*.json, holidays.json).
// Cada store vive en la raíz del proyecto (no en lib/), por eso los paths
// usan `path.join(__dirname, '..', ...)`.

const fs = require('fs');
const path = require('path');
const { dateDDMMYYYYToTimestamp } = require('./time.js');

const REPOS_FILE = path.join(__dirname, '..', '.daybeat-repos.json');

const loadRepoCache = () => {
  try {
    if (fs.existsSync(REPOS_FILE)) {
      const data = JSON.parse(fs.readFileSync(REPOS_FILE, 'utf-8'));
      const ageDays = (Date.now() - new Date(data.lastScan).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays < 7) return data;
    }
  } catch (err) {}
  return null;
};

const saveRepoCache = (repos, rootDir) => {
  try {
    fs.writeFileSync(REPOS_FILE, JSON.stringify({
      rootDir,
      lastScan: new Date().toISOString(),
      repos
    }, null, 2));
  } catch (err) {}
};

// Caché por usuario de las fechas que ya tienen registro en Daybeat
// (.daybeat-registrations.json). Evita re-recorrer todos los proyectos/items
// (lento) en corridas repetidas de "Ver días sin registro" y "Registro masivo".
const REGISTRATIONS_CACHE_FILE = path.join(__dirname, '..', '.daybeat-registrations.json');

const loadRegistrationsCache = () => {
  try {
    if (fs.existsSync(REGISTRATIONS_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(REGISTRATIONS_CACHE_FILE, 'utf-8'));
      if (data && typeof data === 'object') return data;
    }
  } catch (err) {}
  return {};
};

const saveRegistrationsCache = (cache) => {
  try {
    fs.writeFileSync(REGISTRATIONS_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.log('No se pudo guardar la caché de registros.');
  }
};

// Devuelve la entrada cacheada del usuario o null. `scannedFrom` es el inicio
// de la ventana escaneada: si un período pedido arranca ANTES, la caché no lo
// cubre y hay que re-escanear (evita marcar días viejos como faltantes).
const getCachedUser = (cache, user) => {
  if (!user) return null;
  const entry = cache[user];
  if (!entry || !Array.isArray(entry.dates)) return null;
  return entry;
};

// Mergea fechas nuevas en la caché del usuario, amplía `scannedFrom` hacia el
// pasado si hace falta y guarda el archivo.
const mergeDatesForUser = (cache, user, newDates, scannedFrom) => {
  if (!user) return cache;
  const prev = cache[user] || { dates: [] };
  const merged = new Set(prev.dates);
  for (const d of newDates) merged.add(d);

  let from = prev.scannedFrom || null;
  if (from && scannedFrom && dateDDMMYYYYToTimestamp(scannedFrom) < dateDDMMYYYYToTimestamp(from)) {
    from = scannedFrom;
  }
  if (!from) from = scannedFrom || null;

  cache[user] = {
    scannedFrom: from,
    lastScan: new Date().toISOString(),
    dates: [...merged]
  };
  saveRegistrationsCache(cache);
  return cache;
};

const HISTORY_FILE = path.join(__dirname, '..', '.daybeat-history.json');

const getLastUsedHours = () => {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      return { start: data.startTime || '0730', end: data.endTime || '1630' };
    }
  } catch (err) {
    // Si hay error, usar defaults
  }
  return { start: '0730', end: '1630' };
};

const saveHours = (startTime, endTime) => {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ startTime, endTime }, null, 2));
  } catch (err) {
    console.log('No se pudo guardar el horario.');
  }
};

const PATH_CACHE_FILE = path.join(__dirname, '..', '.daybeat-path.json');

const loadPathCache = () => {
  try {
    if (fs.existsSync(PATH_CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(PATH_CACHE_FILE, 'utf-8'));
      if (data.section?.text && data.item?.text && data.category?.value && data.transactionType?.value) {
        return data;
      }
    }
  } catch (err) {}
  return null;
};

const savePathCache = (pathData) => {
  try {
    fs.writeFileSync(PATH_CACHE_FILE, JSON.stringify(pathData, null, 2));
  } catch (err) {
    console.log('No se pudo guardar la ruta de registro.');
  }
};

const HOLIDAYS_FILE = path.join(__dirname, '..', 'holidays.json');

const loadHolidays = () => {
  try {
    if (fs.existsSync(HOLIDAYS_FILE)) {
      const data = JSON.parse(fs.readFileSync(HOLIDAYS_FILE, 'utf-8'));
      if (data.year && data.holidays) {
        return { year: data.year, holidays: data.holidays };
      }
    }
  } catch (err) {}
  return { year: null, holidays: [] };
};

const saveHolidays = (year, holidays) => {
  try {
    fs.writeFileSync(HOLIDAYS_FILE, JSON.stringify({ year, holidays }, null, 2));
  } catch (err) {
    console.log('No se pudo guardar el archivo de festivos.');
  }
};

module.exports = {
  loadRepoCache,
  saveRepoCache,
  loadRegistrationsCache,
  saveRegistrationsCache,
  getCachedUser,
  mergeDatesForUser,
  getLastUsedHours,
  saveHours,
  loadPathCache,
  savePathCache,
  loadHolidays,
  saveHolidays
};
