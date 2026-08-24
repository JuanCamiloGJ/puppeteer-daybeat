/**
 * test-clockify.js
 *
 * Prueba REAL de la integración con Clockify (no usa mocks): muestra qué
 * devuelve la API con la key configurada y qué consume el módulo en el
 * flujo de registro (modo 6). No afecta el proceso completo: solo consulta.
 *
 * Uso:
 *   node test-clockify.js                 (actividad de hoy)
 *   node test-clockify.js 20/08/2026      (actividad de una fecha)
 */

require('dotenv').config();
const appConfig = require('./lib/app-config.js');
appConfig.initialize();
const fs = require('fs');
const path = require('path');
const clockify = require('./lib/clockify.js');

const DEFAULT_BASE_URL = 'https://api.clockify.me/api/v1';

// La key activa: la del store (.daybeat-clockify.json) o el respaldo del .env.
const getActiveKey = () => {
  try {
    const store = JSON.parse(fs.readFileSync(path.join(__dirname, '.daybeat-clockify.json'), 'utf8'));
    if (typeof store.apiKey === 'string' && store.apiKey.trim().length > 0) return store.apiKey;
  } catch (err) { /* sin store */ }
  return process.env.CLOCKIFY_API_KEY || '';
};

const resolveBaseUrl = () =>
  (process.env.CLOCKIFY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

// 'DD/MM/YYYY' | Date → Date local a medianoche (misma regla que el módulo)
const parseDateArg = (arg) => {
  if (arg && /^\d{2}\/\d{2}\/\d{4}$/.test(arg)) {
    const [dd, mm, yyyy] = arg.split('/');
    return new Date(parseInt(yyyy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10));
  }
  return arg instanceof Date ? arg : new Date();
};

const formatHHMM = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '?';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const testClockify = async () => {
  console.log('====================================');
  console.log('PRUEBA DE ACTIVIDAD DIARIA CLOCKIFY');
  console.log('====================================');

  if (!clockify.isConfigured()) {
    console.log('ERROR: No hay API key de Clockify configurada.');
    console.log('\nPara configurarla (sin tocar .env):');
    console.log('1. Ejecutá node index.js');
    console.log('2. Menú "6. Configuración" → "6. Conectar Clockify"');
    console.log('3. Pegá la key generada en https://clockify.me/user/settings');
    console.log('   (Profile Settings → Advanced → API Key → Generate)');
    return;
  }

  console.log(clockify.getStatus());

  const argDate = process.argv[2];
  const target = parseDateArg(argDate);
  const dayStart = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const dayEnd = new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1);
  const startISO = dayStart.toISOString();
  const endISO = dayEnd.toISOString();
  console.log(`\nConsultando actividad para: ${dayStart.toLocaleDateString()}`);
  console.log(`Ventana (medianoche local → UTC): ${startISO}  →  ${endISO}`);
  console.log('');

  const key = getActiveKey();
  const base = resolveBaseUrl();
  const headers = { 'X-Api-Key': key };

  // ---------------------------------------------------------------
  // 1) Diagnóstico crudo de la API: usuario, workspaces y entries
  //    de CADA workspace (sin filtros del módulo).
  // ---------------------------------------------------------------
  console.log('------------------------------------');
  console.log('LO QUE DEVUELVE LA API (crudo)');
  console.log('------------------------------------');
  try {
    const userRes = await fetch(`${base}/user`, { headers });
    if (userRes.status === 401) {
      console.log(`✗ GET /user → 401: la key no es válida. Regenerala en https://clockify.me/user/settings y reconectá en el menú 6.`);
      return;
    }
    if (!userRes.ok) {
      console.log(`✗ GET /user → ${userRes.status}: ${userRes.statusText}`);
      return;
    }
    const user = await userRes.json();
    console.log(`Usuario de la key: ${user.name} (${user.email || 'sin email'}) · id: ${user.id}`);

    const wsRes = await fetch(`${base}/workspaces`, { headers });
    const workspaces = await wsRes.json();
    console.log(`Workspaces accesibles: ${workspaces.length}`);
    console.log('');

    for (const w of workspaces) {
      const url =
        `${base}/workspaces/${w.id}/user/${user.id}/time-entries` +
        `?start=${startISO}&end=${endISO}&page=1&page-size=500&hydrated=true`;
      const res = await fetch(url, { headers });
      const data = await res.json();
      const arr = Array.isArray(data) ? data : [];
      const completed = arr.filter(e => e.timeInterval && e.timeInterval.end);
      const running = arr.filter(e => e.timeInterval && !e.timeInterval.end);

      console.log(`- Workspace "${w.name}" (${w.id}): ${arr.length} entries ` +
        `(${completed.length} completas, ${running.length} en curso)`);
      if (!res.ok) {
        console.log(`    ✗ HTTP ${res.status} consultando time-entries`);
      }
      for (const e of arr.slice(0, 10)) {
        const ti = e.timeInterval || {};
        const proj = e.project ? e.project.name : null;
        const desc = e.description || '(sin descripción)';
        const when = ti.end
          ? `${formatHHMM(ti.start)} - ${formatHHMM(ti.end)}`
          : `${formatHHMM(ti.start)} - EN CURSO`;
        const dur = ti.duration || (ti.end ? '' : 'en curso');
        console.log(`    • [${when}] ${proj ? proj + ': ' : ''}${desc} (${dur})`);
      }
      if (arr.length > 10) console.log(`    ... y ${arr.length - 10} más`);
      console.log('');
    }
  } catch (err) {
    console.log(`✗ Error consultando la API: ${err.message}`);
  }

  // ---------------------------------------------------------------
  // 2) Lo que ve el módulo (mismo camino que el modo 6 del registro).
  // ---------------------------------------------------------------
  console.log('------------------------------------');
  console.log('LO QUE VE EL MÓDULO (getDailyActivity)');
  console.log('------------------------------------');
  try {
    const activity = await clockify.getDailyActivity(dayStart);
    console.log(`Entries normalizadas: ${activity.entries.length}`);
    for (const e of activity.entries.slice(0, 15)) {
      const when = e.inProgress
        ? `${e.startLocal} - en curso`
        : `${e.startLocal} - ${e.endLocal}`;
      const dur = e.inProgress ? 'en curso' : clockify.formatDuration(e.durationMin);
      const label = e.projectName
        ? (e.description ? `${e.projectName}: ${e.description}` : `${e.projectName}: Actividad`)
        : (e.description || '(sin descripción)');
      console.log(`  - [${when}] ${label} (${dur})`);
    }

    console.log('');
    console.log('------------------------------------');
    console.log('TEXTO FORMATEADO PARA EL REPORTE');
    console.log('------------------------------------');
    console.log(clockify.formatActivityForReport(activity));
    console.log('');
    console.log('✓ Prueba completada');
  } catch (err) {
    console.log(`✗ Error usando el módulo: ${err.message}`);
  }
};

testClockify();