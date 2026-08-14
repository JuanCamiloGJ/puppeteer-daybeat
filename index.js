require('dotenv').config();
const puppeteer = require('puppeteer');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { isConfigured, getDailyActivity, formatActivityForReport, closeConnection } = require('./lib/jira-report.js');

// Git para Windows rechaza repositorios WSL/UNC por "dubious ownership"
// (archivos con otro dueño). Este flag desactiva esa protección por comando.
// OJO: usar comillas dobles — cmd.exe (Windows) no interpreta las simples y
// git recibiría ''*'' literal, lo que NO matchea ninguna excepción.
const GIT_SAFE_DIR = '-c "safe.directory=*"';


// Configurar readline para leer la entrada del usuario
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// @inquirer/checkbox toma control de stdin y al terminar lo deja PAUSADO:
// sin resume() el stream no emite 'data' y rl.question queda colgado.
// No recrear el readline: el listener 'data' del interface existente sigue
// registrado y recrearlo reactiva raw mode innecesariamente.
const restoreReadline = () => {
  try { process.stdin.setRawMode(false); } catch (err) { /* no TTY */ }
  process.stdin.resume();
};

// Resolución de rutas WSL/Windows
const resolveRootDir = (dir) => {
  if (!dir) return dir;

  const isWindows = process.platform === 'win32';

  if (isWindows && dir.startsWith('/')) {
    if (dir.startsWith('//')) return dir;

    try {
      const output = execSync('wsl -l -q', { encoding: 'utf-16le', stdio: ['pipe', 'pipe', 'pipe'] });
      const distros = output.split('\n').map(d => d.replace(/\0/g, '').trim()).filter(Boolean);
      for (const distro of distros) {
        const uncBase = `//wsl.localhost/${distro}`;
        const candidate = `${uncBase}${dir}`;
        if (fs.existsSync(candidate)) {
          console.log(`Ruta resuelta: ${dir} -> ${candidate}`);
          return candidate;
        }
      }
      console.log(`No se encontró distro WSL para la ruta: ${dir}`);
      console.log(`Distros disponibles: ${distros.join(', ')}`);
    } catch (err) {
      console.log(`Error detectando distro WSL: ${err.message}`);
    }
    return dir;
  }

  if (!isWindows && dir.startsWith('//wsl.localhost')) {
    const parts = dir.split('/').filter(p => p);
    const linuxPath = '/' + parts.slice(2).join('/');
    console.log(`Ruta resuelta: ${dir} -> ${linuxPath}`);
    return linuxPath;
  }

  if (!isWindows && dir.startsWith('\\\\wsl.localhost')) {
    const parts = dir.split('\\').filter(p => p);
    const linuxPath = '/' + parts.slice(2).join('/');
    console.log(`Ruta resuelta: ${dir} -> ${linuxPath}`);
    return linuxPath;
  }

  return dir;
};

// Normaliza rutas UNC/Windows a su forma Linux para comparaciones
const toLinuxPath = (p) => {
  if (p.startsWith('//wsl.localhost')) {
    return '/' + p.split('/').filter(Boolean).slice(2).join('/');
  }
  if (p.startsWith('\\\\wsl.localhost')) {
    return '/' + p.split('\\').filter(Boolean).slice(2).join('/');
  }
  return p;
};

// Funciones auxiliares.

const listElements = async (frame, selector) => {
  await frame.waitForSelector(selector);
  // Listar todos los links dentro del frame
  const links = await frame.$$eval(selector, elements =>
    elements.map(el => ({
      href: el.href,
      text: el.textContent.trim(),
      value: el.value
    }))
  );
  // Mostrar opciones al usuario
  console.log('---------------------');
  console.log('OPCIONES DISPONIBLES:');
  console.log('---------------------');
  links.forEach((item, index) => {
    console.log(`${index + 1}. ${item.text}`);
  });
  console.log('---------------------');

  return links;
}

const normalizeText = (s) => s ? s.replace(/\s+/g, ' ').trim() : '';

const whriteAndNavigateElementSelect = async (frame, selector, links) => {
  return new Promise((resolve) => {
    rl.question('Por favor, elige una opción (número): ', async (choice) => {
      const index = parseInt(choice) - 1;

      if (index >= 0 && index < links.length) {
        const selectedItem = links[index];
        const linkHandle = await frame.evaluateHandle((text, selector) => {
          const elements = Array.from(document.querySelectorAll(selector));
          return elements.find(el => el.textContent.trim() === text);
        }, selectedItem.text, selector);

        if (linkHandle) {
          await frame.evaluate(el => el.click(), linkHandle);
        }
        resolve(selectedItem.text);
      } else {
        console.log('Opción inválida.');
        resolve(null);
      }
    });
  });
}

const whriteAndNavigateOtherElementSelect = async (frame, selector, links) => {
  return new Promise((resolve) => {
    rl.question('Por favor, elige una opción (número): ', async (choice) => {
      const index = parseInt(choice) - 1;

      if (index >= 0 && index < links.length) {
        const selectedItem = links[index];

        const linkHandle = await frame.evaluateHandle((text, selector) => {
          const elements = Array.from(document.querySelectorAll(selector));
          const elementSelect = elements.find(el => el.textContent.trim() === text);

          if (elementSelect) {
            const parentTd = elementSelect.parentElement;
            const grandParentTr = parentTd.parentElement;
            const allLinksInRow = Array.from(grandParentTr.querySelectorAll('td > a'));

            if (allLinksInRow.length >= 2) {
              const penultimateLink = allLinksInRow[allLinksInRow.length - 2];
              return penultimateLink;
            }
          }

          return null;
        }, selectedItem.text, selector);

        if (linkHandle) {
          await linkHandle.click();
        }
        resolve(selectedItem.text);
      } else {
        console.log('Opción inválida.');
        resolve(null);
      }
    });
  });
}

const selectOptionSelector = async (frame, selector, links) => {
  return new Promise((resolve) => {
    // Pedir al usuario que elija una opción
    rl.question('Por favor, elige una opción (número): ', async (choice) => {
      const index = parseInt(choice) - 1;

      if (index >= 0 && index < links.length) {
        // Interactuar con la opción seleccionada
        const selectedItem = links[index];
        // console.log(`Seleccionaste: `, selectedItem.text);
        // Encontrar y seleccionar el elemento seleccionado.
        await frame.select(selector, selectedItem.value); // Selecciona la opción
        resolve(); // Resuelve la promesa una vez que la selección se realiza
      } else {
        console.log('Opción inválida.');
        resolve(); // También resuelve aunque la opción sea inválida para continuar el flujo
      }
    });
  });
};

const whriteInput = async (frame, selector, title) => {
  return new Promise((resolve) => {
    // Pedir al usuario que elija una opción
    console.log("-------------------------");
    console.log(title);
    console.log("-------------------------");
    rl.question("", async (choice) => {
      // escribir el input con lo diligenciado por el usuario.
      await frame.type(selector, choice);
      resolve();
    });
  });
}

const questionUserResponse = async (frame, question) => {
  return new Promise((resolve) => {
    // Pedir al usuario que elija una opción
    rl.question(question, async (choice) => {
      resolve(choice);
    });
  });
}

// Selección múltiple interactiva de la actividad de Jira (@inquirer/checkbox):
// espacio marca/desmarca, "a" selecciona todos, enter confirma.
// La primera opción "Seleccionar todos" marca todo de una; si no, solo los
// marcados entran al contexto del reporte.
const ALL_JIRA = '__ALL__';

const selectJiraActivityMulti = async (activity) => {
  const { default: checkbox, Separator } = await import('@inquirer/checkbox');
  const choices = [{ name: 'Seleccionar todos', value: ALL_JIRA }];

  if (activity.issues.length > 0) {
    choices.push(new Separator('-- Incidencias --'));
    activity.issues.slice(0, 15).forEach((issue, i) => {
      const status = issue.status ? ` (${issue.status})` : '';
      choices.push({
        name: `${issue.key}: ${issue.summary || 'Sin resumen'}${status}`,
        value: { kind: 'issue', i }
      });
    });
  }
  if (activity.comments.length > 0) {
    choices.push(new Separator('-- Comentarios --'));
    activity.comments.slice(0, 15).forEach((comment, i) => {
      const time = comment.created ? ` (${comment.created.substring(0, 16).replace('T', ' ')})` : '';
      choices.push({
        name: `${comment.issueKey}: "${comment.body}"${time}`,
        value: { kind: 'comment', i }
      });
    });
  }
  if (activity.worklogs.length > 0) {
    choices.push(new Separator('-- Worklogs --'));
    activity.worklogs.slice(0, 15).forEach((worklog, i) => {
      choices.push({
        name: `${worklog.issueKey}: ${worklog.timeSpent}${worklog.comment ? ` — "${worklog.comment}"` : ''}`,
        value: { kind: 'worklog', i }
      });
    });
  }

  const answer = await checkbox({
    message: 'Seleccione la actividad de Jira a incluir (espacio: marcar, a: todos, enter: confirmar):',
    pageSize: 12,
    choices
  });

  if (answer.includes(ALL_JIRA)) {
    restoreReadline();
    return activity;
  }

  const filtered = { ...activity, issues: [], comments: [], worklogs: [] };
  for (const sel of answer) {
    if (sel.kind === 'issue') filtered.issues.push(activity.issues[sel.i]);
    else if (sel.kind === 'comment') filtered.comments.push(activity.comments[sel.i]);
    else filtered.worklogs.push(activity.worklogs[sel.i]);
  }
  restoreReadline();
  return filtered;
}

// Funciones de automatización basadas en commits

const SKIP_DIRS = [
  'node_modules', '.git', '.idea', '.vscode', '__pycache__', 'vendor',
  '.svn', 'bower_components', 'dist', 'build', '.next', '.nuxt',
  'payara5', 'inttegrio', 'bin', 'dmp', 'leadtools', '.atl', 'sdd'
];

const findGitRepos = (rootDir, depth = 0, maxDepth = 3) => {
  const repos = [];
  if (!rootDir || !fs.existsSync(rootDir)) {
    console.log('ERROR: ROOT_DIR no existe o no está configurado.');
    return repos;
  }

  if (depth > maxDepth) return repos;

  try {
    const items = fs.readdirSync(rootDir, { withFileTypes: true });

    const hasGit = items.some(item => item.isDirectory() && item.name === '.git');
    if (hasGit) {
      repos.push(rootDir);
    }

    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (item.name.startsWith('.') && item.name !== '.git') continue;
      if (SKIP_DIRS.includes(item.name)) continue;

      const fullPath = path.join(rootDir, item.name);
      const subRepos = findGitRepos(fullPath, depth + 1, maxDepth);
      repos.push(...subRepos);
    }
  } catch (err) {
    console.log(`Error accediendo a ${rootDir}: ${err.message}`);
  }
  return repos;
};

const REPOS_FILE = path.join(__dirname, '.daybeat-repos.json');

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

const getReposWithCache = (rootDir, forceRescan = false) => {
  if (!forceRescan) {
    const cached = loadRepoCache();
    if (cached && toLinuxPath(cached.rootDir) === toLinuxPath(rootDir)) {
      const valid = cached.repos
        .map(repo => resolveRootDir(repo))
        .filter(r => fs.existsSync(r));
      if (valid.length > 0) {
        console.log(`Usando repositorios cacheados (${valid.length})`);
        return valid;
      }
    }
  }
  console.log('Escaneando repositorios...');
  const repos = findGitRepos(rootDir);
  if (repos.length > 0) saveRepoCache(repos, rootDir);
  return repos;
};

const getGitAuthor = (repos) => {
  if (process.env.GIT_AUTHOR_EMAIL) {
    return process.env.GIT_AUTHOR_EMAIL;
  }
  
  for (const repo of repos) {
    try {
      const email = execSync(`git ${GIT_SAFE_DIR} -C "${repo}" config user.email`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      if (email) return email;
    } catch (err) {
      continue;
    }
  }
  
  return null;
};

const getTodayCommits = (repoPath, author = null) => {
  try {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day} 00:00:00`;
    
    const authorFilter = author ? `--author="${author}"` : '';
    const result = execSync(
      `git ${GIT_SAFE_DIR} -C "${repoPath}" log --since="${dateStr}" --all ${authorFilter} --format="%s"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const commits = result.trim().split('\n').filter(msg => msg.length > 0);
    console.log(`  ${repoPath}: ${commits.length} commits hoy (${dateStr})`);
    return commits;
  } catch (err) {
    console.log(`  ${repoPath}: Error al obtener commits de hoy`);
    return [];
  }
};

const getRecentCommits = (repoPath, days = 7, author = null) => {
  try {
    const today = new Date();
    const pastDate = new Date(today.getTime() - (days * 24 * 60 * 60 * 1000));
    const year = pastDate.getFullYear();
    const month = String(pastDate.getMonth() + 1).padStart(2, '0');
    const day = String(pastDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day} 00:00:00`;
    
    const authorFilter = author ? `--author="${author}"` : '';
    const result = execSync(
      `git ${GIT_SAFE_DIR} -C "${repoPath}" log --since="${dateStr}" --all ${authorFilter} --format="%s"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const commits = result.trim().split('\n').filter(msg => msg.length > 0);
    console.log(`  ${repoPath}: ${commits.length} commits encontrados (${dateStr})`);
    return commits;
  } catch (err) {
    console.log(`  ${repoPath}: Error al obtener commits`);
    return [];
  }
};

const getCommitsForDate = (repoPath, dateStr, author = null) => {
  try {
    const [day, month, year] = dateStr.split('/');
    const targetDate = `${year}-${month}-${day}`;
    // Hora LOCAL (new Date('YYYY-MM-DD') parsea UTC y rompe el +1 día en UTC-x)
    const nextDate = new Date(year, month - 1, day);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
    
    const authorFilter = author ? `--author="${author}"` : '';
    const result = execSync(
      `git ${GIT_SAFE_DIR} -C "${repoPath}" log --since="${targetDate} 00:00:00" --until="${nextDateStr} 00:00:00" --all ${authorFilter} --format="%s"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const commits = result.trim().split('\n').filter(msg => msg.length > 0);
    console.log(`  ${repoPath}: ${commits.length} commits (${targetDate})`);
    return commits;
  } catch (err) {
    return [];
  }
};

// Commits de una fecha específica CON la hora del commit (formato HH:MM local).
// Se usa solo para armar los bloques del día (registro multi-bloque).
const getCommitsWithTime = (repoPath, dateStr, author = null) => {
  try {
    const [day, month, year] = dateStr.split('/');
    const targetDate = `${year}-${month}-${day}`;
    // Construir en hora LOCAL (new Date('YYYY-MM-DD') parsea en UTC y en
    // zonas UTC-x el setDate(+1) cae en el mismo día calendario).
    const nextDate = new Date(year, month - 1, day);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;

    const authorFilter = author ? `--author="${author}"` : '';
    const result = execSync(
      `git ${GIT_SAFE_DIR} -C "${repoPath}" log --since="${targetDate} 00:00:00" --until="${nextDateStr} 00:00:00" --all ${authorFilter} --format="%s|%ai"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.trim().split('\n').filter(line => line.length > 0).map(line => {
      const [message, iso] = line.split('|');
      const time = iso ? iso.substring(11, 16) : null; // HH:MM (hora local del autor)
      return { message, time };
    }).filter(c => c.time);
  } catch (err) {
    return [];
  }
};

// ---------------------------------------------------------------------------
// Registro por bloques: reparte el día en varios bloques según la actividad
// ---------------------------------------------------------------------------

const toMinutes = (hhmm) => {
  const h = parseInt(hhmm.substring(0, 2), 10);
  const m = parseInt(hhmm.substring(2, 4), 10);
  return h * 60 + m;
};

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

const getRecentCommitsBeforeDate = (repoPath, dateStr, days = 5, author = null) => {
  try {
    const [day, month, year] = dateStr.split('/');
    // Hora LOCAL (new Date('YYYY-MM-DD') parsea UTC y rompe el cálculo en UTC-x)
    const targetDate = new Date(year, month - 1, day);
    const pastDate = new Date(targetDate.getTime() - (days * 24 * 60 * 60 * 1000));
    const pastDateStr = `${pastDate.getFullYear()}-${String(pastDate.getMonth() + 1).padStart(2, '0')}-${String(pastDate.getDate()).padStart(2, '0')}`;
    const targetDateStr = `${year}-${month}-${day}`;
    
    const authorFilter = author ? `--author="${author}"` : '';
    const result = execSync(
      `git ${GIT_SAFE_DIR} -C "${repoPath}" log --since="${pastDateStr} 00:00:00" --until="${targetDateStr} 00:00:00" --all ${authorFilter} --format="%s|%ad" --date=short`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const commits = result.trim().split('\n').filter(msg => msg.length > 0).map(line => {
      const [message, date] = line.split('|');
      return { message, date };
    });
    console.log(`  ${repoPath}: ${commits.length} commits (${pastDateStr} a ${targetDateStr})`);
    return commits;
  } catch (err) {
    return [];
  }
};

const getRotatedCommits = (commitsWithDates, targetDateStr) => {
  if (commitsWithDates.length === 0) return [];
  
  const [day, month, year] = targetDateStr.split('/');
  const targetDate = new Date(`${year}-${month}-${day}`);
  const dayOfWeek = targetDate.getDay();
  
  const sortedCommits = [...commitsWithDates].sort((a, b) => {
    const dateA = new Date(a.date);
    const dateB = new Date(b.date);
    return dateB - dateA;
  });
  
  const uniqueDates = [...new Set(sortedCommits.map(c => c.date))];
  
  let selectedDate;
  switch (dayOfWeek) {
    case 1: selectedDate = uniqueDates[0]; break;
    case 2: selectedDate = uniqueDates[1] || uniqueDates[0]; break;
    case 3: selectedDate = uniqueDates[2] || uniqueDates[1] || uniqueDates[0]; break;
    case 4:
      const date1 = uniqueDates[0];
      const date2 = uniqueDates[1] || uniqueDates[0];
      return sortedCommits.filter(c => c.date === date1 || c.date === date2).map(c => c.message);
    case 5: selectedDate = uniqueDates[0]; break;
    default: selectedDate = uniqueDates[0]; break;
  }
  
  return sortedCommits.filter(c => c.date === selectedDate).map(c => c.message);
};

const getContextPrefix = (targetDateStr, commitsWithDates) => {
  if (commitsWithDates.length === 0) return '';
  
  const [day, month, year] = targetDateStr.split('/');
  const targetDate = new Date(`${year}-${month}-${day}`);
  
  const commitDates = commitsWithDates.map(c => new Date(c.date));
  const mostRecentCommit = new Date(Math.max(...commitDates));
  
  const daysDiff = Math.floor((targetDate - mostRecentCommit) / (1000 * 60 * 60 * 24));
  
  if (daysDiff === 0) return '';
  if (daysDiff === 1) return 'Continuación de: ';
  if (daysDiff <= 3) return 'Seguimiento de: ';
  if (daysDiff <= 5) return 'Avance en: ';
  return 'Trabajo en: ';
};

const generateGenericText = (targetDateStr) => {
  const [day, month, year] = targetDateStr.split('/');
  const targetDate = new Date(`${year}-${month}-${day}`);
  const dayOfWeek = targetDate.getDay();
  
  const genericTexts = {
    1: {
      titles: [
        "Inicio de semana: revisión de código y planificación",
        "Lunes: análisis de requerimientos y organización del sprint",
        "Revisión de pendientes y planificación de tareas de la semana"
      ],
      details: [
        "Inicio de semana laboral. Revisión de código pendiente, planificación de tareas para el sprint actual y organización de prioridades. Análisis de requerimientos pendientes y coordinación con el equipo.",
        "Lunes de planificación. Revisión de tareas pendientes del sprint anterior, análisis de nuevos requerimientos y organización del trabajo para la semana. Coordinación con el equipo de desarrollo.",
        "Inicio de semana enfocado en revisión y planificación. Análisis de código pendiente, actualización de documentación y organización de tareas prioritarias para el sprint actual."
      ]
    },
    2: {
      titles: [
        "Desarrollo de funcionalidades y pruebas unitarias",
        "Implementación de mejoras y correcciones menores",
        "Avance en tareas de desarrollo y refactorización"
      ],
      details: [
        "Martes de desarrollo activo. Implementación de funcionalidades pendientes, escritura de pruebas unitarias y corrección de errores menores. Refactorización de código para mejorar mantenibilidad.",
        "Continuación de desarrollo. Implementación de mejoras solicitadas, corrección de bugs reportados y avance en tareas del sprint. Pruebas unitarias para nuevas funcionalidades.",
        "Día enfocado en desarrollo y refactorización. Implementación de mejoras de código, optimización de consultas y avance en tareas pendientes. Revisión de calidad de código."
      ]
    },
    3: {
      titles: [
        "Continuación de desarrollo y pruebas de integración",
        "Avance en implementación y revisión de código",
        "Desarrollo de features y ajustes de rendimiento"
      ],
      details: [
        "Miércoles de desarrollo continuo. Avance en implementación de features, pruebas de integración y revisión de código con el equipo. Ajustes de rendimiento y optimización de consultas.",
        "Continuación de tareas de desarrollo. Implementación de funcionalidades complejas, pruebas de integración y revisión de pull requests. Ajustes menores basados en feedback del equipo.",
        "Día de avance significativo en desarrollo. Implementación de features críticas, pruebas de integración y optimización de rendimiento. Revisión de código y documentación técnica."
      ]
    },
    4: {
      titles: [
        "Finalización de features y pruebas de calidad",
        "Cierre de tareas pendientes y ajustes finales",
        "Desarrollo completado y preparación para deploy"
      ],
      details: [
        "Jueves de cierre de tareas. Finalización de features en desarrollo, pruebas de calidad y preparación para integración. Ajustes finales basados en revisión de código y feedback del equipo.",
        "Cierre de tareas pendientes. Completación de features, pruebas exhaustivas y ajustes finales. Preparación de código para deploy y actualización de documentación técnica.",
        "Día enfocado en finalizar tareas. Completación de desarrollo pendiente, pruebas de calidad y ajustes de último momento. Preparación para integración y deploy."
      ]
    },
    5: {
      titles: [
        "Cierre de semana: finalización y documentación",
        "Viernes: cierre de tareas y actualización de documentación",
        "Finalización de sprint y preparación para revisión"
      ],
      details: [
        "Cierre de semana laboral. Finalización de tareas pendientes, actualización de documentación técnica y preparación para revisión de sprint. Limpieza de código y organización para la próxima semana.",
        "Viernes de cierre. Completación de tareas del sprint, actualización de documentación y preparación para revisión semanal. Organización de pendientes para la próxima semana.",
        "Cierre de semana enfocado en finalización. Completación de features, actualización de documentación y preparación para revisión de sprint. Limpieza de código y organización de tareas."
      ]
    }
  };
  
  const dayTexts = genericTexts[dayOfWeek] || genericTexts[2];
  const randomIndex = Math.floor(Math.random() * dayTexts.titles.length);
  
  return {
    title: dayTexts.titles[randomIndex],
    detail: dayTexts.details[randomIndex]
  };
};

const categorizeCommits = (commits) => {
  const categories = {
    feat: [],
    fix: [],
    refactor: [],
    docs: [],
    test: [],
    chore: [],
    other: []
  };
  
  for (const commit of commits) {
    const match = commit.match(/^(feat|fix|refactor|docs|test|chore)(\(.*\))?:\s*(.*)/i);
    if (match) {
      const type = match[1].toLowerCase();
      const message = match[3] || commit;
      categories[type].push(message);
    } else {
      categories.other.push(commit);
    }
  }
  
  return categories;
};

const generateStructuredSummary = (categories) => {
  const parts = [];
  
  if (categories.feat.length > 0) {
    const items = categories.feat.slice(0, 2).join(', ');
    parts.push(`Implementación de: ${items}`);
  }
  
  if (categories.fix.length > 0) {
    const items = categories.fix.slice(0, 1).join(', ');
    parts.push(`Correcciones: ${items}`);
  }
  
  if (categories.refactor.length > 0) {
    const items = categories.refactor.slice(0, 1).join(', ');
    parts.push(`Refactorización: ${items}`);
  }
  
  if (categories.docs.length > 0) {
    const items = categories.docs.slice(0, 1).join(', ');
    parts.push(`Documentación: ${items}`);
  }
  
  if (categories.test.length > 0) {
    const items = categories.test.slice(0, 1).join(', ');
    parts.push(`Pruebas: ${items}`);
  }
  
  if (categories.chore.length > 0) {
    const items = categories.chore.slice(0, 1).join(', ');
    parts.push(`Mantenimiento: ${items}`);
  }
  
  if (categories.other.length > 0 && parts.length === 0) {
    const items = categories.other.slice(0, 3).join('. ');
    parts.push(items);
  }
  
  let summary = parts.join('. ');
  if (summary.length > 100) {
    summary = summary.substring(0, 97) + '...';
  }
  
  return summary;
};

const generateDetail = (commits) => {
  if (commits.length === 0) return 'Actividad de desarrollo: revisión de código, pruebas y ajustes menores.';
  
  const unique = [...new Set(commits)];
  const categories = categorizeCommits(unique);
  const parts = [];
  
  if (categories.feat.length > 0) {
    const items = categories.feat.slice(0, 3).join(', ');
    parts.push(`Desarrollo de funcionalidades: ${items}.`);
  }
  
  if (categories.fix.length > 0) {
    const items = categories.fix.slice(0, 2).join(', ');
    parts.push(`Corrección de errores: ${items}.`);
  }
  
  if (categories.refactor.length > 0) {
    const items = categories.refactor.slice(0, 2).join(', ');
    parts.push(`Mejoras de código: ${items}.`);
  }
  
  if (categories.docs.length > 0) {
    const items = categories.docs.slice(0, 2).join(', ');
    parts.push(`Actualización de documentación: ${items}.`);
  }
  
  if (categories.test.length > 0) {
    const items = categories.test.slice(0, 2).join(', ');
    parts.push(`Pruebas implementadas: ${items}.`);
  }
  
  if (categories.chore.length > 0) {
    const items = categories.chore.slice(0, 2).join(', ');
    parts.push(`Tareas de mantenimiento: ${items}.`);
  }
  
  if (categories.other.length > 0 && parts.length === 0) {
    const items = categories.other.slice(0, 5).join('. ');
    parts.push(items);
  }
  
  let detail = parts.join(' ');
  if (detail.length > 500) {
    detail = detail.substring(0, 497) + '...';
  }
  
  return detail;
};

const summarizeCommits = (commits) => {
  if (commits.length === 0) return '';
  
  const unique = [...new Set(commits)];
  const categories = categorizeCommits(unique);
  return generateStructuredSummary(categories);
};

const generateFakeSummary = (commits) => {
  if (commits.length === 0) return 'Actividad de desarrollo: revisión de código, pruebas y ajustes menores.';
  
  const unique = [...new Set(commits)];
  const categories = categorizeCommits(unique);
  return generateStructuredSummary(categories);
};

const smartTruncate = (text, maxLength) => {
  if (text.length <= maxLength) return text;
  const truncated = text.substring(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  if (lastPeriod > maxLength * 0.6) {
    return truncated.substring(0, lastPeriod + 1);
  }
  const lastSpace = truncated.lastIndexOf(' ');
  return truncated.substring(0, lastSpace) + '.';
};

const generateWithGemini = async (commits, context = 'same-day', targetDate = null, extraContext = null) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  
  if (!apiKey) {
    return null;
  }
  
  if (!commits || commits.length === 0) {
    return null;
  }
  
  const commitsText = commits.join('\n');
  
  let contextInstruction = '';
  if (context === 'continuation') {
    contextInstruction = '\n\nIMPORTANTE: Estos commits son de días anteriores (no del día que se está registrando). Genera la descripción indicando que se CONTINÚA con el trabajo de días previos, usando frases como "Continuación de...", "Seguimiento de...", "Avance en...". No digas que se hizo hoy, sino que se continúa trabajando en ello.';
  } else if (context === 'follow-up') {
    contextInstruction = '\n\nIMPORTANTE: Estos commits son de días anteriores. Genera la descripción indicando que se da SEGUIMIENTO a tareas recientes, usando frases como "Seguimiento de...", "Trabajo en...", "Continuación de tareas de...". No digas que se hizo hoy, sino que se da seguimiento.';
  } else if (context === 'no-commits') {
    contextInstruction = '\n\nIMPORTANTE: No hay commits disponibles. Genera una descripción genérica pero variada de actividad de desarrollo según el día de la semana. Evita usar siempre el mismo texto.';
  }
  
  const dateInfo = targetDate ? `\nDía a registrar: ${targetDate}` : '';
  const contextLabel = extraContext ? ' y el contexto adicional proporcionado' : '';
  
  const prompt = `Eres un asistente que ayuda a generar descripciones de actividades laborales para un sistema de registro de tiempo.

Basándote en los siguientes commits de git${contextLabel}, genera:
1. Un título corto (máximo 100 caracteres) que resuma la actividad
2. Una descripción detallada (1-2 oraciones completas, máximo 1000 caracteres) que explique el trabajo realizado
${dateInfo}
Commits:
${commitsText}
${extraContext ? `\nContexto adicional del usuario:\n"${extraContext}"` : ''}
${contextInstruction}

REGLAS IMPORTANTES:
- Completa TODAS las oraciones. NO termines con "..." ni dejes frases a medias.
- La descripción debe ser un párrafo completo con sentido.
- Si necesitas más espacio, prioriza completar la idea principal.

Responde SOLO en formato JSON válido, sin texto adicional:
{"title": "título corto aquí", "detail": "descripción detallada aquí"}`;
  
  const maxRetries = 4;
  const baseDelay = 2000; // 2 segundos
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';
      console.log(`  [IA] Usando modelo: ${model}`);
      console.log(`  [IA] Intento ${attempt}/${maxRetries}...`);
      
      const startTime = Date.now();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          model: model,
          input: prompt
        }),
        signal: AbortSignal.timeout(60000)
      });
      
      const responseTime = Date.now() - startTime;
      console.log(`  [IA] Respuesta recibida en ${responseTime}ms`);
      
      if (!response.ok) {
        const errorBody = await response.text();
        console.log(`  [IA] Error en API: ${response.status}`);
        console.log(`  [IA] Detalle: ${errorBody.substring(0, 200)}`);
        
        // Retry solo para errores 503 (Service Unavailable)
        if (response.status === 503 && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.log(`  [IA] Reintentando en ${delay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        return null;
      }
      
      const data = await response.json();
      
      // Buscar el step con type === "model_output"
      const outputStep = data.steps?.find(step => step.type === 'model_output');
      const text = outputStep?.content?.[0]?.text;
      
      if (!text) {
        console.log('  [IA] Respuesta vacía de Gemini');
        return null;
      }
      
      // Intentar parsear JSON de la respuesta
      let result;
      try {
        // Buscar JSON en la respuesta (puede tener texto adicional)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          console.log('  [IA] No se encontró JSON válido en la respuesta');
          return null;
        }
      } catch (parseErr) {
        console.log('  [IA] Error parseando JSON:', parseErr.message);
        return null;
      }
      
      if (!result.title || !result.detail) {
        console.log('  [IA] Respuesta incompleta');
        return null;
      }
      
      // Limitar longitud
      let title = result.title;
      let detail = result.detail;
      
      title = smartTruncate(title, 100);
      detail = smartTruncate(detail, 1000);
      
      return { title, detail };
      
    } catch (err) {
      console.log(`  [IA] Error en intento ${attempt}: ${err.message}`);
      
      // Retry para errores de timeout o red
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`  [IA] Reintentando en ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      return null;
    }
  }
  
  return null;
};

const HISTORY_FILE = path.join(__dirname, '.daybeat-history.json');

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

const PATH_CACHE_FILE = path.join(__dirname, '.daybeat-path.json');

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

const getMissingRegistrations = (existingDates, businessDays) => {
  return businessDays.filter(day => !existingDates.includes(day));
};

const HOLIDAYS_FILE = path.join(__dirname, 'holidays.json');

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

const checkHolidaysYear = async () => {
  const currentYear = new Date().getFullYear();
  const { year, holidays } = loadHolidays();

  if (year === currentYear && holidays.length > 0) {
    return holidays;
  }

  console.log('\n====================================');
  if (year && year !== currentYear) {
    console.log(`Los festivos configurados son del año ${year}, pero estamos en ${currentYear}.`);
  } else {
    console.log('No hay festivos configurados.');
  }
  console.log('====================================\n');

  const answer = await questionUserResponse(null, '¿Desea ingresar los festivos del año actual? (si/no): ');
  if (answer === 'si') {
    console.log('Ingrese los festivos en formato DD/MM/YYYY separados por coma:');
    console.log('Ejemplo: 01/01/2026,12/01/2026,23/03/2026');
    const input = await questionUserResponse(null, 'Festivos: ');
    const newHolidays = input.split(',').map(h => h.trim()).filter(h => h.length > 0);
    saveHolidays(currentYear, newHolidays);
    console.log(`${newHolidays.length} festivos guardados.\n`);
    return newHolidays;
  }

  return holidays;
};

const getCurrentUser = async (page, rl = null) => {
  try {
    // Buscar en todos los frames para mayor robustez
    const frames = page.frames();
    
    for (const frame of frames) {
      const userName = await frame.evaluate(() => {
        // Buscar el td que contiene "Usuario:" y tomar el siguiente td hermano
        const allLabels = document.querySelectorAll('td.titcliente');
        
        for (const label of allLabels) {
          const text = label.textContent.replace(/&nbsp;/g, '').trim();
          if (text === 'Usuario:') {
            // Tomar el siguiente td hermano
            const nextTd = label.nextElementSibling;
            if (nextTd && nextTd.tagName === 'TD') {
              return nextTd.textContent.replace(/&nbsp;/g, '').trim();
            }
          }
        }
        
        // Fallback: buscar cualquier td.titclientev con formato de nombre
        const allTd = document.querySelectorAll('td.titclientev');
        for (const el of allTd) {
          const text = el.textContent.replace(/&nbsp;/g, '').trim();
          // El nombre del usuario típicamente tiene formato "Nombre Apellido" o "Nombre A. Apellido"
          // Excluir textos como "Corporación" que son una sola palabra
          if (text.match(/^[A-Z][a-záéíóú]+\s+[A-Z]/)) {
            return text;
          }
        }
        
        return null;
      });
      
      if (userName) {
        console.log(`[DEBUG] Usuario detectado en frame: "${frame.name()}"`);
        console.log(`[DEBUG] Usuario logueado: "${userName}"`);
        return userName;
      }
    }
    
    console.log('[DEBUG] No se encontró el usuario en ningún frame');
    
    // Fallback: preguntar al usuario
    if (rl) {
      console.log('\nNo se pudo detectar el usuario automáticamente.');
      const manualUser = await new Promise((resolve) => {
        rl.question('Ingresa el nombre exacto que aparece en la columna "Usuario Transacción" (o presiona Enter para omitir): ', (answer) => {
          resolve(answer.trim() || null);
        });
      });
      
      if (manualUser) {
        console.log(`[DEBUG] Usuario ingresado manualmente: "${manualUser}"`);
      } else {
        console.log('[DEBUG] Usuario omitido, mostrando todos los registros');
      }
      
      return manualUser;
    }
    
    return null;
  } catch (err) {
    console.log('[DEBUG] Error extrayendo usuario:', err.message);
    return null;
  }
};

const extractRegistrations = async (frameTree, startDate = null, currentUser = null) => {
  try {
    const allDates = [];
    let currentPage = 1;
    let hasNextPage = true;
    const MAX_PAGES = 5;
    
    let startTimestamp = null;
    if (startDate) {
      const [dd, mm, yyyy] = startDate.split('/');
      startTimestamp = new Date(`${yyyy}-${mm}-${dd}`).getTime();
    }
    
    while (hasNextPage && currentPage <= MAX_PAGES) {
      console.log(`      [DEBUG] Extrayendo página ${currentPage}...`);
      const registrations = await frameTree.evaluate((currentUser) => {
        const dates = [];
        const tables = document.querySelectorAll('table');
        
        for (const table of tables) {
          const headerRow = table.querySelector('tr');
          if (!headerRow) continue;
          
          const headers = Array.from(headerRow.querySelectorAll('td, th')).map(h => h.textContent.trim());
          const fechaIndex = headers.findIndex(h => h.includes('Fecha Transacción'));
          const usuarioIndex = headers.findIndex(h => h.includes('Usuario Transacción'));
          
          if (fechaIndex === -1) continue;
          
          const rows = table.querySelectorAll('tr');
          for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length > fechaIndex) {
              // Si hay currentUser y columna de usuario, filtrar
              if (currentUser && usuarioIndex !== -1 && cells.length > usuarioIndex) {
                const usuarioText = cells[usuarioIndex].textContent.trim();
                if (usuarioText !== currentUser) {
                  continue; // Saltar si no es el usuario logueado
                }
              }
              
              const fechaText = cells[fechaIndex].textContent.trim();
              const match = fechaText.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
              if (match) {
                const year = match[1];
                const month = match[2].padStart(2, '0');
                const day = match[3].padStart(2, '0');
                dates.push(`${day}/${month}/${year}`);
              }
            }
          }
        }
        
        return dates;
      }, currentUser);
      
      console.log(`      [DEBUG] Página ${currentPage}: ${registrations.length} fechas encontradas`);
      if (registrations.length > 0) {
        console.log(`      [DEBUG] Fechas: ${registrations.join(', ')}`);
      }
      
      let allDatesOutOfRange = true;
      
      for (const dateStr of registrations) {
        const [dd, mm, yyyy] = dateStr.split('/');
        const dateTimestamp = new Date(`${yyyy}-${mm}-${dd}`).getTime();
        
        if (!startTimestamp) {
          allDates.push(dateStr);
          allDatesOutOfRange = false;
        } else {
          if (dateTimestamp >= startTimestamp) {
            allDates.push(dateStr);
            allDatesOutOfRange = false;
          }
        }
      }
      
      if (startTimestamp && registrations.length > 0 && allDatesOutOfRange) {
        console.log(`      [DEBUG] Todas las fechas están fuera del rango, deteniendo paginación`);
        break;
      }
      
      // Buscar el enlace de "siguiente página" de transacciones
      // Daybeat usa imágenes: 3up.gif (siguiente), 3dw.gif (siguiente), 3regresar.gif (regresar)
      // El enlace correcto tiene page_trans=N donde N > 0 para páginas siguientes
      const nextPageLink = await frameTree.evaluate((currentPageNum) => {
        const links = Array.from(document.querySelectorAll('a'));
        
        // Primero: buscar enlaces con imágenes de paginación que NO sean "regresar"
        for (const link of links) {
          const img = link.querySelector('img');
          if (!img) continue;
          
          const imgSrc = img.src.toLowerCase();
          
          // Excluir imágenes de regresar/volver
          if (imgSrc.includes('regresar') || imgSrc.includes('back') || imgSrc.includes('return')) {
            continue;
          }
          
          // Buscar imágenes de paginación de transacciones (3up.gif, 3dw.gif, next, forward)
          const isPaginationImage = imgSrc.includes('3up.gif') || 
                                    imgSrc.includes('3dw.gif') ||
                                    imgSrc.includes('next') ||
                                    imgSrc.includes('forward');
          
          if (!isPaginationImage) continue;
          
          // Verificar que el enlace tenga page_trans=N donde N es la página siguiente
          const href = link.href;
          const pageTransMatch = href.match(/page_trans=(\d+)/);
          if (pageTransMatch) {
            const pageTransNum = parseInt(pageTransMatch[1]);
            // page_trans > 0 significa que hay más páginas
            if (pageTransNum > 0) {
              return { href: href, imgSrc: img.src, type: 'image_page_trans' };
            }
          }
        }
        
        // Segundo: buscar enlaces con texto de paginación
        for (const link of links) {
          const text = link.textContent.trim();
          if (text.includes('Siguiente') || text === '>>' || text === '>' || text.includes('Next')) {
            return { href: link.href, text: text, type: 'text' };
          }
        }
        
        return null;
      }, currentPage);
      
      if (nextPageLink) {
        console.log(`      [DEBUG] Siguiente página encontrada:`);
        console.log(`      [DEBUG]   Tipo: ${nextPageLink.type}`);
        console.log(`      [DEBUG]   Href: ${nextPageLink.href}`);
        if (nextPageLink.imgSrc) {
          console.log(`      [DEBUG]   Imagen: ${nextPageLink.imgSrc}`);
        }
        
        await frameTree.evaluate((href) => {
          window.location.href = href;
        }, nextPageLink.href);
        await frameTree.waitForNavigation();
        await delay(1500);
        currentPage++;
      } else {
        console.log(`      [DEBUG] No hay más páginas`);
        hasNextPage = false;
      }
    }
    
    if (currentPage > MAX_PAGES) {
      console.log(`      [DEBUG] ADVERTENCIA: Se alcanzó el límite de ${MAX_PAGES} páginas`);
    }
    
    const uniqueDates = [...new Set(allDates)];
    console.log(`      [DEBUG] Total fechas únicas extraídas: ${uniqueDates.length}`);
    return uniqueDates;
  } catch (err) {
    console.log('Error extrayendo registros:', err.message);
    return [];
  }
};

// Parsea la tabla de transacciones de la página de detalle del item
// (itemsint_actualizar.asp). Devuelve [{ start, end, desc, id2, updateHref }]
// para la fecha objetivo (targetDate en formato YYYY-MM-DD): la columna
// "Fecha Transacción" expone la hora FINAL y "Tiempo" los minutos ->
// inicio = fin - duración. id2 y updateHref provienen del link de
// actualización de cada fila (transaccionesint_actualizar.asp...upd_trans=1).
const parseTransactionTable = async (frameTree, targetDate, currentUser = null) => {
  const rows = await frameTree.evaluate((targetDate, currentUser) => {
    const ranges = [];
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headerRow = table.querySelector('tr');
      if (!headerRow) continue;
      const headers = Array.from(headerRow.querySelectorAll('td, th')).map(h => h.textContent.trim());
      const fechaIndex = headers.findIndex(h => h.includes('Fecha Transacción'));
      const usuarioIndex = headers.findIndex(h => h.includes('Usuario Transacción'));
      const tiempoIndex = headers.findIndex(h => h.includes('Tiempo'));
      const descIndex = headers.findIndex(h => h.includes('Descripción'));
      if (fechaIndex === -1) continue;

      const trs = table.querySelectorAll('tr');
      for (let i = 1; i < trs.length; i++) {
        const cells = trs[i].querySelectorAll('td');
        if (cells.length <= fechaIndex) continue;
        if (currentUser && usuarioIndex !== -1 && cells.length > usuarioIndex) {
          const usuarioText = cells[usuarioIndex].textContent.trim();
          if (usuarioText !== currentUser) continue;
        }
        const fechaText = cells[fechaIndex].textContent.trim();
        const match = fechaText.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
        if (!match) continue;
        const fechaDate = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
        if (fechaDate !== targetDate) continue;

        const endMin = parseInt(match[4], 10) * 60 + parseInt(match[5], 10);
        let durationMin = 0;
        if (tiempoIndex !== -1 && cells.length > tiempoIndex) {
          const tMatch = cells[tiempoIndex].textContent.trim().match(/(\d+)\s*min/);
          if (tMatch) durationMin = parseInt(tMatch[1], 10);
        }
        const startMin = endMin - durationMin;
        const start = `${String(Math.floor(startMin / 60)).padStart(2, '0')}${String(startMin % 60).padStart(2, '0')}`;
        const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}${String(endMin % 60).padStart(2, '0')}`;
        const desc = (descIndex !== -1 && cells.length > descIndex)
          ? cells[descIndex].textContent.trim().substring(0, 60)
          : '';

        // id2 (id de la transacción) y href del link de actualización (UPD)
        let id2 = null;
        let updateHref = null;
        for (const link of trs[i].querySelectorAll('a')) {
          const href = link.href || '';
          const id2Match = href.match(/transaccionesint_actualizar\.asp[^'"]*id2=(\d+)/);
          if (id2Match) {
            id2 = id2Match[1];
            if (!updateHref || href.includes('upd_trans=1')) updateHref = href;
          }
        }
        ranges.push({ start, end, desc, id2, updateHref });
      }
    }
    return ranges;
  }, targetDate, currentUser);
  return rows;
};

// Lee los rangos horarios ya registrados por el usuario en el item para una
// fecha dada. Navega al detalle del item (itemsint_actualizar.asp) desde el
// formulario de creación (mismos query params, cambia solo el script), lee la
// tabla de transacciones (página 1; la de la fecha objetivo es la primera fila
// por orden descendente) y deduce el rango: la columna "Fecha Transacción"
// expone la hora FINAL y "Tiempo" los minutos -> inicio = fin - duración.
// Devuelve { ranges: [{start, end, desc}], count } o null si no pudo leer
// (fail-open: no bloquea el registro).
const getExistingRanges = async (frameTree, page, dateStr, currentUser = null, catValue = null, transValue = null) => {
  try {
    const formUrl = await frameTree.evaluate(() => window.location.href);
    const detailUrl = formUrl.replace('transaccionesint_crear.asp', 'itemsint_actualizar.asp');
    if (detailUrl === formUrl) return null; // no es el formulario de creación

    await frameTree.evaluate((href) => { window.location.href = href; }, detailUrl);
    await frameTree.waitForNavigation();
    await delay(1200);
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) return null;

    const [dd, mm, yyyy] = dateStr.split('/');
    const targetDate = `${yyyy}-${mm}-${dd}`;

    const rows = await parseTransactionTable(frameTree, targetDate, currentUser);

    // Volver al formulario de creación
    await frameTree.evaluate((href) => { window.location.href = href; }, formUrl);
    await frameTree.waitForNavigation();
    await delay(1500);
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) return null;
    await frameTree.waitForSelector('select');

    // La recarga resetea los selects obligatorios: re-seleccionar
    if (catValue) {
      await frameTree.select('select[name="id_categoria"]', catValue);
      await delay(1500);
    }
    if (transValue) {
      await frameTree.select('select[name="cod_tipotransaccion"]', transValue);
    }

    return { ranges: rows, count: rows.length };
  } catch (err) {
    console.log('  ✗ Error leyendo registros existentes:', err.message);
    return null;
  }
};

// Intersecta los bloques propuestos con los horarios libres de la jornada
// (jornada [startTime, endTime] menos los rangos ocupados). Un bloque puede
// partirse en varias piezas; las piezas < MIN_BLOCK se descartan. Los eventos
// del bloque original se reparten a sus piezas en orden. Devuelve los bloques
// ajustados o null si no queda ninguna pieza.
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

const inspectTableStructure = async (frameTree) => {
  try {
    const structure = await frameTree.evaluate(() => {
      const tables = document.querySelectorAll('table');
      if (tables.length === 0) return 'No se encontraron tablas';
      
      const result = [`Total de tablas encontradas: ${tables.length}\n`];
      
      for (let t = 0; t < tables.length; t++) {
        const table = tables[t];
        const rows = table.querySelectorAll('tr');
        result.push(`=== TABLA ${t} (${rows.length} filas) ===`);
        
        for (let i = 0; i < Math.min(10, rows.length); i++) {
          const cells = rows[i].querySelectorAll('td, th');
          const rowData = Array.from(cells).map(cell => {
            const text = cell.textContent.trim();
            return text.substring(0, 20) || '[vacío]';
          });
          result.push(`  Fila ${i}: ${rowData.join(' | ')}`);
        }
        result.push('');
      }
      
      return result.join('\n');
    });
    
    console.log('Estructura de las tablas:');
    console.log(structure);
  } catch (err) {
    console.log('Error inspeccionando tablas:', err.message);
  }
};

const showMissingRegistrations = async (page, browser, company, usernameDaybeat, password, holidays = []) => {
  console.log('====================================');
  console.log('CONSULTANDO DÍAS SIN REGISTRO');
  console.log('====================================');
  
  console.log('\nSeleccione el período a consultar:');
  console.log('1. Último mes');
  console.log('2. Últimos 2 meses');
  console.log('3. Últimos 3 meses');
  
  const periodOption = await new Promise((resolve) => {
    rl.question('Seleccione opción (1/2/3): ', (answer) => {
      resolve(answer);
    });
  });
  
  let monthsToCheck = 1;
  if (periodOption === '2') {
    monthsToCheck = 2;
  } else if (periodOption === '3') {
    monthsToCheck = 3;
  }
  
  console.log(`\nPeríodo seleccionado: ${monthsToCheck} mes(es)`);
  
  let frameTree = page.frames().find(frame => frame.name() === 'tres');
  
  if (!frameTree) {
    console.log('Frame no encontrado');
    browser.close();
    return;
  }
  
  await frameTree.waitForSelector('input');
  
  await frameTree.type('input[name="id_cliente"]', company);
  await frameTree.type('input[name="login"]', usernameDaybeat);
  await frameTree.type('input[name="password"]', password);
  
  await delay(1000);
  await frameTree.click('input[type="submit"]');
  await frameTree.waitForNavigation();
  
  console.log('Login completado, esperando carga de página...');
  await delay(3000);
  
  // Obtener el nombre del usuario logueado para filtrar registros
  const currentUser = await getCurrentUser(page, rl);
  if (currentUser) {
    console.log(`\n[INFO] Filtrando registros del usuario: ${currentUser}`);
  } else {
    console.log('\n[WARN] No se especificó usuario, mostrando todos los registros');
  }
  
  const frameOne = page.frames().find(frame => frame.name() === 'uno');
  if (!frameOne) {
    console.log('ERROR: Frame "uno" no encontrado');
    browser.close();
    return;
  }
  
  await frameOne.waitForSelector('div', { timeout: 5000 });
  const divHandle = await frameOne.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Requerimientos');
  });
  
  await delay(1000);
  
  if (divHandle) {
    await frameOne.evaluate(el => {
      const event = new MouseEvent('mouseover', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      el.dispatchEvent(event);
    }, divHandle);
  }
  
  await frameTree.waitForSelector('div');
  const divHandleConsulta = await frameTree.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Consultar');
  });
  
  if (divHandleConsulta) {
    await frameTree.evaluate(el => el.click(), divHandleConsulta);
    await frameTree.waitForNavigation();
  }
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('input');
  
  console.log('Buscando proyectos...');
  const availableLinks = await frameTree.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    return links.map(link => ({
      text: link.textContent.trim(),
      href: link.href
    })).filter(l => l.text.length > 0 && l.href.includes('itemsint.asp'));
  });
  
  console.log(`Proyectos encontrados: ${availableLinks.length}`);
  
  // Calcular startDate ANTES de extraer fechas para optimizar paginación
  const today = new Date();
  const startDate = new Date(today.getTime() - (monthsToCheck * 30 * 24 * 60 * 60 * 1000));
  const startDateStr = `${String(startDate.getDate()).padStart(2, '0')}/${String(startDate.getMonth() + 1).padStart(2, '0')}/${startDate.getFullYear()}`;
  console.log(`[DEBUG] Rango de búsqueda: ${startDateStr} a ${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`);
  
  const allDates = [];
  
  // Guardar la URL de la página de consulta para volver después
  const consultaUrl = await frameTree.evaluate(() => window.location.href);
  
  // Iterar por cada proyecto
  for (const project of availableLinks) {
    console.log(`\nProcesando proyecto: ${project.text}`);
    
    // Navegar al proyecto
    await frameTree.evaluate((href) => {
      window.location.href = href;
    }, project.href);
    await frameTree.waitForNavigation();
    await delay(1500);
    
    // Guardar URL de items para volver
    const itemsUrl = await frameTree.evaluate(() => window.location.href);
    
    // Buscar items en este proyecto
    const items = await frameTree.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .filter(link => link.href.includes('itemsint_actualizar.asp'))
        .map(link => ({
          text: link.textContent.trim(),
          href: link.href
        }));
    });
    
    console.log(`  Items encontrados: ${items.length}`);
    
    // Iterar por cada item
    for (const item of items) {
      console.log(`    Procesando item: ${item.text}`);
      
      // Navegar al item
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, item.href);
      await frameTree.waitForNavigation();
      await delay(1500);
      
      // Extraer fechas de las transacciones (con paginación limitada al rango y filtrado por usuario)
      const dates = await extractRegistrations(frameTree, startDateStr, currentUser);
      console.log(`    Transacciones encontradas: ${dates.length}`);
      allDates.push(...dates);
      
      // Volver a la lista de items navegando directamente
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, itemsUrl);
      await frameTree.waitForNavigation();
      await delay(1000);
    }
    
    // Volver a la lista de proyectos navegando directamente
    await frameTree.evaluate((href) => {
      window.location.href = href;
    }, consultaUrl);
    await frameTree.waitForNavigation();
    await delay(1000);
  }
  
  const existingDates = [...new Set(allDates)];
  console.log(`\n\nTotal de registros encontrados: ${existingDates.length}`);
  console.log('[DEBUG] Fechas encontradas:', existingDates.sort().join(', '));
  
  const businessDays = getBusinessDays(startDate, today, holidays);
  
  console.log('[DEBUG] Total días hábiles en el rango:', businessDays.length);
  console.log('[DEBUG] Días hábiles:', businessDays.join(', '));
  
  const missingDays = getMissingRegistrations(existingDates, businessDays);
  
  console.log('\n====================================');
  console.log(`DÍAS HÁBILES SIN REGISTRO (últimos ${monthsToCheck} mes(es)): ${missingDays.length}`);
  console.log('====================================');
  
  if (missingDays.length === 0) {
    console.log('¡Todos los días hábiles tienen registro!');
  } else {
    missingDays.forEach(day => console.log(day));
  }
  
  console.log('====================================');
  
  rl.close();
  browser.close();
};


const registerBulkMissingDays = async (page, browser, company, usernameDaybeat, password, holidays = []) => {
  console.log('====================================');
  console.log('REGISTRO MASIVO DE DÍAS SIN REGISTRO');
  console.log('====================================');
  
  console.log('\nSeleccione el período a registrar:');
  console.log('1. Último mes');
  console.log('2. Últimos 2 meses');
  console.log('3. Últimos 3 meses');
  
  const periodOption = await new Promise((resolve) => {
    rl.question('Seleccione opción (1/2/3): ', (answer) => {
      resolve(answer);
    });
  });
  
  let monthsToCheck = 1;
  if (periodOption === '2') {
    monthsToCheck = 2;
  } else if (periodOption === '3') {
    monthsToCheck = 3;
  }
  
  console.log(`\nPeríodo seleccionado: ${monthsToCheck} mes(es)`);
  
  let frameTree = page.frames().find(frame => frame.name() === 'tres');
  
  if (!frameTree) {
    console.log('Frame no encontrado');
    browser.close();
    return;
  }
  
  await frameTree.waitForSelector('input');
  
  await frameTree.type('input[name="id_cliente"]', company);
  await frameTree.type('input[name="login"]', usernameDaybeat);
  await frameTree.type('input[name="password"]', password);
  
  await delay(1000);
  await frameTree.click('input[type="submit"]');
  await frameTree.waitForNavigation();
  
  console.log('Login completado, esperando carga de página...');
  await delay(3000);
  
  // Obtener el nombre del usuario logueado para filtrar registros
  const currentUser = await getCurrentUser(page, rl);
  if (currentUser) {
    console.log(`\n[INFO] Filtrando registros del usuario: ${currentUser}`);
  } else {
    console.log('\n[WARN] No se especificó usuario, mostrando todos los registros');
  }
  
  const frameOne = page.frames().find(frame => frame.name() === 'uno');
  if (!frameOne) {
    console.log('ERROR: Frame "uno" no encontrado');
    browser.close();
    return;
  }
  
  await frameOne.waitForSelector('div', { timeout: 5000 });
  const divHandle = await frameOne.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Requerimientos');
  });
  
  await delay(1000);
  
  if (divHandle) {
    await frameOne.evaluate(el => {
      const event = new MouseEvent('mouseover', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      el.dispatchEvent(event);
    }, divHandle);
  }
  
  await frameTree.waitForSelector('div');
  const divHandleConsulta = await frameTree.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Consultar');
  });
  
  if (divHandleConsulta) {
    await frameTree.evaluate(el => el.click(), divHandleConsulta);
    await frameTree.waitForNavigation();
  }
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('input');
  
  console.log('Buscando proyectos...');
  const availableLinks = await frameTree.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    return links.map(link => ({
      text: link.textContent.trim(),
      href: link.href
    })).filter(l => l.text.length > 0 && l.href.includes('itemsint.asp'));
  });
  
  console.log(`Proyectos encontrados: ${availableLinks.length}`);
  
  // Calcular startDate ANTES de extraer fechas para optimizar paginación
  const today = new Date();
  const startDate = new Date(today.getTime() - (monthsToCheck * 30 * 24 * 60 * 60 * 1000));
  const startDateStr = `${String(startDate.getDate()).padStart(2, '0')}/${String(startDate.getMonth() + 1).padStart(2, '0')}/${startDate.getFullYear()}`;
  console.log(`[DEBUG] Rango de búsqueda: ${startDateStr} a ${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`);
  
  const allDates = [];
  const consultaUrl = await frameTree.evaluate(() => window.location.href);
  
  for (const project of availableLinks) {
    console.log(`\nProcesando proyecto: ${project.text}`);
    
    await frameTree.evaluate((href) => {
      window.location.href = href;
    }, project.href);
    await frameTree.waitForNavigation();
    await delay(1500);
    
    const itemsUrl = await frameTree.evaluate(() => window.location.href);
    
    const items = await frameTree.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .filter(link => link.href.includes('itemsint_actualizar.asp'))
        .map(link => ({
          text: link.textContent.trim(),
          href: link.href
        }));
    });
    
    console.log(`  Items encontrados: ${items.length}`);
    
    for (const item of items) {
      console.log(`    Procesando item: ${item.text}`);
      
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, item.href);
      await frameTree.waitForNavigation();
      await delay(1500);
      
      const dates = await extractRegistrations(frameTree, startDateStr, currentUser);
      console.log(`    Transacciones encontradas: ${dates.length}`);
      if (dates.length > 0) {
        console.log(`    Fechas: ${dates.join(', ')}`);
      }
      allDates.push(...dates);
      
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, itemsUrl);
      await frameTree.waitForNavigation();
      await delay(1000);
    }
    
    await frameTree.evaluate((href) => {
      window.location.href = href;
    }, itemsUrl);
    await frameTree.waitForNavigation();
    await delay(1000);
  }
  
  const existingDates = [...new Set(allDates)];
  console.log(`\n\nTotal de registros encontrados: ${existingDates.length}`);
  console.log('[DEBUG] Fechas encontradas:', existingDates.sort().join(', '));
  
  const businessDays = getBusinessDays(startDate, today, holidays);
  
  console.log('[DEBUG] Total días hábiles en el rango:', businessDays.length);
  console.log('[DEBUG] Días hábiles:', businessDays.join(', '));
  
  const missingDays = getMissingRegistrations(existingDates, businessDays);
  
  console.log('\n====================================');
  console.log(`DÍAS HÁBILES SIN REGISTRO (últimos ${monthsToCheck} mes(es)): ${missingDays.length}`);
  console.log('====================================');
  
  if (missingDays.length === 0) {
    console.log('¡Todos los días hábiles tienen registro!');
    rl.close();
    browser.close();
    return;
  }
  
  missingDays.forEach(day => console.log(day));
  
  console.log('\n====================================');
  console.log('SELECCIONAR PARÁMETROS PARA REGISTRO MASIVO');
  console.log('====================================');
  
  await frameTree.evaluate((href) => {
    window.location.href = href;
  }, consultaUrl);
  await frameTree.waitForNavigation();
  await delay(1500);
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const links = await listElements(frameTree, 'a');
  
  console.log('Seleccione la sección donde registrar:');
  const sectionIndex = await new Promise((resolve) => {
    rl.question('Número de sección: ', (answer) => {
      resolve(parseInt(answer) - 1);
    });
  });
  
  if (sectionIndex < 0 || sectionIndex >= links.length) {
    console.log('Opción inválida');
    rl.close();
    browser.close();
    return;
  }
  
  const selectedSection = links[sectionIndex];
  await frameTree.evaluate((href) => {
    window.location.href = href;
  }, selectedSection.href);
  await frameTree.waitForNavigation();
  await delay(1500);
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const otherLinks = await listElements(frameTree, 'a');
  
  console.log('Seleccione el item donde registrar:');
  const itemIndex = await new Promise((resolve) => {
    rl.question('Número de item: ', (answer) => {
      resolve(parseInt(answer) - 1);
    });
  });
  
  if (itemIndex < 0 || itemIndex >= otherLinks.length) {
    console.log('Opción inválida');
    rl.close();
    browser.close();
    return;
  }
  
  const selectedItem = otherLinks[itemIndex];
  const itemHandle = await frameTree.evaluateHandle((text, selector) => {
    const elements = Array.from(document.querySelectorAll(selector));
    const elementSelect = elements.find(el => el.textContent.trim() === text);
    if (elementSelect) {
      const parentTd = elementSelect.parentElement;
      const grandParentTr = parentTd.parentElement;
      const allLinksInRow = Array.from(grandParentTr.querySelectorAll('td > a'));
      if (allLinksInRow.length >= 2) {
        return allLinksInRow[allLinksInRow.length - 2];
      }
    }
    return null;
  }, selectedItem.text, 'a');
  
  if (!itemHandle) {
    console.log('No se encontró el item');
    rl.close();
    browser.close();
    return;
  }
  
  await itemHandle.click();
  await frameTree.waitForNavigation();
  await delay(1500);
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const itemUrl = await frameTree.evaluate(() => window.location.href);
  await frameTree.waitForSelector('select');
  
  console.log('\nSELECCIONE LA CATEGORIA: ');
  const optionsCategory = await listElements(frameTree, 'select[name="id_categoria"]>option');
  const categoryIndex = await new Promise((resolve) => {
    rl.question('Número de categoría: ', (answer) => {
      resolve(parseInt(answer) - 1);
    });
  });
  
  if (categoryIndex < 0 || categoryIndex >= optionsCategory.length) {
    console.log('Opción inválida');
    rl.close();
    browser.close();
    return;
  }
  
  const selectedCategory = optionsCategory[categoryIndex];
  
  // Seleccionar la categoría primero para que se carguen los tipos de transacción
  await frameTree.select('select[name="id_categoria"]', selectedCategory.value);
  await delay(1500); // Esperar a que se carguen las opciones dinámicas
  
  console.log('\nSELECCIONE TIPO DE TRANSACCION: ');
  const optionsTransaction = await listElements(frameTree, 'select[name="cod_tipotransaccion"]>option');
  const transactionIndex = await new Promise((resolve) => {
    rl.question('Número de tipo de transacción: ', (answer) => {
      resolve(parseInt(answer) - 1);
    });
  });
  
  if (transactionIndex < 0 || transactionIndex >= optionsTransaction.length) {
    console.log('Opción inválida');
    rl.close();
    browser.close();
    return;
  }
  
  const selectedTransaction = optionsTransaction[transactionIndex];
  
  const rootDir = resolveRootDir(process.env.ROOT_DIR);
  console.log('\nBuscando repositorios en:', rootDir);
  const repos = getReposWithCache(rootDir);
  console.log(`Repositorios encontrados: ${repos.length}`);
  
  const author = getGitAuthor(repos);
  if (author) {
    console.log(`Filtrando commits por autor: ${author}`);
  }
  
  const hours = getLastUsedHours();
  const startTime = hours.start;
  const endTime = hours.end;
  
  // Preguntar si se desea incluir información de Jira en los reportes
  let useJira = false;
  if (isConfigured()) {
    const jiraResponse = await new Promise((resolve) => {
      rl.question('\n¿Desea incluir información de Jira (issues/comentarios/worklogs) en los reportes? (si/no): ', (answer) => {
        resolve(answer);
      });
    });
    useJira = jiraResponse === 'si';
  }
  
  console.log(`\nHorario a usar: ${startTime} - ${endTime}`);
  console.log(`Categoría: ${selectedCategory.text}`);
  console.log(`Tipo de transacción: ${selectedTransaction.text}`);
  console.log(`Item: ${selectedItem.text}`);
  console.log(`Incluir info de Jira: ${useJira ? 'Sí' : 'No'}`);
  console.log(`Días a registrar: ${missingDays.length}`);
  
  const confirmBulk = await new Promise((resolve) => {
    rl.question('\n¿Desea continuar con el registro masivo? (si/no): ', (answer) => {
      resolve(answer);
    });
  });
  
  if (confirmBulk !== 'si') {
    console.log('Registro masivo cancelado');
    rl.close();
    browser.close();
    return;
  }
  
  const successDays = [];
  const errorDays = [];
  const alreadyRegisteredDays = [];
  
  console.log('\n====================================');
  console.log('INICIANDO REGISTRO MASIVO');
  console.log('====================================\n');
  
  for (let i = 0; i < missingDays.length; i++) {
    const day = missingDays[i];
    console.log(`\n[${i + 1}/${missingDays.length}] Procesando día: ${day}`);
    
    // Verificar si el día ya tiene registro en cualquier item
    console.log(`  Verificando si ya existe registro...`);
    const alreadyExists = existingDates.includes(day);
    
    if (alreadyExists) {
      console.log(`  ⚠ Día ${day} ya tiene registro, saltando...`);
      alreadyRegisteredDays.push(day);
      continue;
    }
    
    try {
      const allCommits = repos.flatMap(repo => getCommitsForDate(repo, day, author));
      console.log(`  Commits encontrados del día: ${allCommits.length}`);
      
      let commitsToUse = allCommits;
      let commitsWithDates = [];
      let context = 'same-day';
      
      if (allCommits.length === 0) {
        console.log('  No hay commits ese día, buscando últimos 5 días antes de la fecha');
        commitsWithDates = repos.flatMap(repo => getRecentCommitsBeforeDate(repo, day, 5, author));
        console.log(`  Commits encontrados en últimos 5 días: ${commitsWithDates.length}`);
        
        if (commitsWithDates.length === 0) {
          console.log('  No hay commits en últimos 5 días, buscando últimos 7 días');
          commitsWithDates = repos.flatMap(repo => getRecentCommitsBeforeDate(repo, day, 7, author));
          console.log(`  Commits encontrados en últimos 7 días: ${commitsWithDates.length}`);
        }
        
        if (commitsWithDates.length > 0) {
          commitsToUse = getRotatedCommits(commitsWithDates, day);
          console.log(`  Commits seleccionados (rotación): ${commitsToUse.length}`);
          
          const prefix = getContextPrefix(day, commitsWithDates);
          context = prefix.includes('Continuación') ? 'continuation' : 'follow-up';
        } else {
          console.log('  No hay commits disponibles, generando texto genérico variado');
          context = 'no-commits';
        }
      }
      
      let title, detail;
      let extraContext = null;
      let geminiUsed = false;
      
      // Consultar actividad de Jira para el día
      if (useJira) {
        console.log('  Consultando actividad en Jira...');
        try {
          const activity = await getDailyActivity(day);
          extraContext = formatActivityForReport(activity);
        } catch (err) {
          console.log(`  ✗ Error consultando Jira para ${day}: ${err.message}`);
        }
      }
      
      if (context === 'no-commits') {
        if (process.env.GEMINI_API_KEY) {
          console.log('  Generando texto variado con Gemini AI...');
          const fakeCommits = ['Sin commits específicos'];
          const aiResult = await generateWithGemini(fakeCommits, 'no-commits', day, extraContext);
          
          if (aiResult) {
            title = aiResult.title;
            detail = aiResult.detail;
            geminiUsed = true;
            console.log('  ✓ Texto variado generado con Gemini AI');
          } else {
            console.log('  ✗ IA falló, usando texto genérico por defecto');
            const genericText = generateGenericText(day);
            title = genericText.title;
            detail = genericText.detail;
          }
        } else {
          console.log('  Sin GEMINI_API_KEY, usando texto genérico variado');
          const genericText = generateGenericText(day);
          title = genericText.title;
          detail = genericText.detail;
        }
      } else if (process.env.GEMINI_API_KEY && commitsToUse.length > 0) {
        console.log(`  Generando con Gemini AI (contexto: ${context})...`);
        const aiResult = await generateWithGemini(commitsToUse, context, day, extraContext);
        
        if (aiResult) {
          title = aiResult.title;
          detail = aiResult.detail;
          geminiUsed = true;
          console.log('  ✓ Generado con Gemini AI');
        } else {
          console.log('  ✗ IA falló, usando método por defecto');
          const prefix = getContextPrefix(day, commitsWithDates);
          const summary = summarizeCommits(commitsToUse);
          title = prefix + summary;
          detail = generateDetail(commitsToUse);
        }
      } else {
        if (!process.env.GEMINI_API_KEY && commitsToUse.length > 0) {
          console.log('  Sin GEMINI_API_KEY, usando método por defecto');
        }
        const prefix = getContextPrefix(day, commitsWithDates);
        const summary = summarizeCommits(commitsToUse);
        title = prefix + summary;
        detail = generateDetail(commitsToUse);
      }
      
      // Agregar el bloque de Jira al detalle cuando no lo generó la IA
      if (extraContext && !geminiUsed) {
        detail = `${detail}\n\n${extraContext}`;
      }
      
      console.log(`  Título: ${title.substring(0, 50)}...`);
      
      // Navegar a la página del item (que es el formulario de nueva transacción)
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, itemUrl);
      await frameTree.waitForNavigation();
      await delay(1500);
      
      frameTree = page.frames().find(frame => frame.name() === 'tres');
      await frameTree.waitForSelector('select');
      
      // Seleccionar categoría y tipo de transacción
      await frameTree.select('select[name="id_categoria"]', selectedCategory.value);
      await delay(500);
      await frameTree.select('select[name="cod_tipotransaccion"]', selectedTransaction.value);
      
      await frameTree.type('input[name="descripcion_corta"]', title);
      
      const [dd, mm, yyyy] = day.split('/');
      const formattedDate = `${dd}${mm}${yyyy}`;
      await frameTree.type('input[name="fechaini"]', formattedDate);
      
      await frameTree.type('input[name="horaini"]', startTime);
      await frameTree.type('input[name="horafin"]', endTime);
      
      await frameTree.type('textarea[name="texto_largo"]', detail);
      
      // Registrar listener del dialog ANTES de hacer click
      const dialogPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ handled: false });
        }, 8000);
        
        page.once('dialog', async (dialog) => {
          clearTimeout(timeout);
          const message = dialog.message();
          console.log(`  Diálogo: ${message}`);
          await dialog.accept();
          resolve({ 
            handled: true, 
            success: message.includes('éxitosamente') || message.includes('exitosamente')
          });
        });
      });
      
      // Hacer click en submit
      await frameTree.click('input[type="submit"][class="bot"]');
      
      // Esperar resultado del dialog
      const result = await dialogPromise;
      
      if (result.handled && result.success) {
        console.log(`  ✓ Día ${day} registrado exitosamente`);
        successDays.push(day);
      } else {
        console.log(`  ✗ Día ${day} falló: no se confirmó el registro`);
        errorDays.push({ day, error: 'No se confirmó el registro' });
      }
      
      await delay(1500);
      
    } catch (err) {
      console.log(`  ✗ Error registrando ${day}: ${err.message}`);
      errorDays.push({ day, error: err.message });
    }
  }
  
  console.log('\n====================================');
  console.log('RESUMEN DE REGISTRO MASIVO');
  console.log('====================================');
  console.log(`Total días sin registro: ${missingDays.length}`);
  console.log(`Días registrados exitosamente: ${successDays.length}`);
  console.log(`Días ya registrados (saltados): ${alreadyRegisteredDays.length}`);
  console.log(`Días con error: ${errorDays.length}`);
  
  if (successDays.length > 0) {
    console.log('\nDías registrados:');
    successDays.forEach(day => console.log(`  ✓ ${day}`));
  }
  
  if (alreadyRegisteredDays.length > 0) {
    console.log('\nDías ya registrados (saltados):');
    alreadyRegisteredDays.forEach(day => console.log(`  ⚠ ${day}`));
  }
  
  if (errorDays.length > 0) {
    console.log('\nDías con error:');
    errorDays.forEach(({ day, error }) => console.log(`  ✗ ${day} - ${error}`));
  }
  
  console.log('====================================');
  
  await closeConnection();
  rl.close();
  browser.close();
};

// Lee el estado actual del formulario de actualización de transacción
// (transaccionesint_actualizar.asp): valores seleccionados y opciones de los
// selects, campos de texto y detalle. Útil para el flujo interactivo de
// corrección (Enter = conservar valor actual).
const readTransactionForm = async (frameTree) => {
  return frameTree.evaluate(() => {
    const getVal = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.value : '';
    };
    const getText = (sel) => {
      const el = document.querySelector(sel);
      return el && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text.trim() : '';
    };
    const getOptions = (sel) => Array.from(document.querySelectorAll(sel))
      .map(o => ({ value: o.value, text: o.textContent.trim() }))
      .filter(o => o.value !== '');
    return {
      categoria: { value: getVal('select[name="id_categoria"]'), text: getText('select[name="id_categoria"]') },
      tipo: { value: getVal('select[name="cod_tipotransaccion"]'), text: getText('select[name="cod_tipotransaccion"]') },
      descripcion: getVal('input[name="descripcion_corta"]'),
      fecha: getVal('input[name="fechaini"]'),
      horaini: getVal('input[name="horaini"]'),
      horafin: getVal('input[name="horafin"]'),
      detalle: getVal('textarea[name="texto_largo"]'),
      optionsCategoria: getOptions('select[name="id_categoria"]>option'),
      optionsTipo: getOptions('select[name="cod_tipotransaccion"]>option')
    };
  });
};

// Núcleo reutilizable de corrección: aplica los campos indicados en `fields`
// al formulario de actualización de una transacción y lo envía con manejo de
// diálogo (patrón del registro por bloques). Si `updateHref` se omite se
// asume que el frame ya está en el formulario (caso del flujo interactivo).
// fields: { category, transactionType, descripcion, fecha, horaini, horafin,
// detalle } — valores undefined se ignoran (conservan el valor actual);
// fecha en formato DDMMYYYY. Devuelve { success, message } sin cerrar nada.
const updateTransaction = async (frameTree, page, updateHref = null, fields = {}) => {
  try {
    if (updateHref) {
      await frameTree.evaluate((href) => { window.location.href = href; }, updateHref);
      await frameTree.waitForNavigation();
      await delay(1200);
    }
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) return { success: false, message: 'Frame no encontrado' };
    await frameTree.waitForSelector('select[name="id_categoria"]');

    const setInput = (selector, value) =>
      frameTree.$eval(selector, (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);

    // Mismo orden que el formulario de creación: categoría primero (carga
    // dependiente del tipo) y luego el resto.
    if (fields.category !== undefined) {
      await frameTree.select('select[name="id_categoria"]', String(fields.category));
      await delay(1500);
    }
    if (fields.transactionType !== undefined) {
      await frameTree.select('select[name="cod_tipotransaccion"]', String(fields.transactionType));
    }
    if (fields.descripcion !== undefined && fields.descripcion.trim() !== '') {
      await setInput('input[name="descripcion_corta"]', fields.descripcion.trim());
    }
    if (fields.fecha !== undefined) {
      await setInput('input[name="fechaini"]', fields.fecha);
    }
    if (fields.horaini !== undefined) {
      await setInput('input[name="horaini"]', fields.horaini);
    }
    if (fields.horafin !== undefined) {
      await setInput('input[name="horafin"]', fields.horafin);
    }
    if (fields.detalle !== undefined && fields.detalle.trim() !== '') {
      await setInput('textarea[name="texto_largo"]', fields.detalle.trim());
    }

    // Listener del dialog ANTES del click (evita race condition)
    const dialogPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ handled: false, message: '' }), 8000);
      page.once('dialog', async (dialog) => {
        clearTimeout(timeout);
        const message = dialog.message();
        console.log(`  Diálogo: ${message}`);
        await dialog.accept();
        resolve({ handled: true, message });
      });
    });
    await frameTree.click('input[type="submit"][class="bot"]');
    const result = await dialogPromise;

    if (!result.handled) return { success: false, message: 'Sin respuesta del servidor (timeout)' };
    return { success: /exitosamente/i.test(result.message), message: result.message };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

// Opción de menú: corregir / mover un registro existente. Daybeat NO expone
// borrado de transacciones (verificado en la app real); la única mutación es
// el UPDATE del formulario transaccionesint_actualizar.asp. "Eliminar" un
// registro = corregirlo o moverlo (p.ej. cambiar la fecha para liberar un
// día mal registrado). Reutiliza parseTransactionTable (listado) y
// updateTransaction (edición).
const correctRegistration = async (page, browser, company, usernameDaybeat, password, holidays = []) => {
  console.log('====================================');
  console.log('CORREGIR / MOVER REGISTRO');
  console.log('====================================');

  let frameTree = page.frames().find(frame => frame.name() === 'tres');
  if (!frameTree) {
    console.log('Frame no encontrado');
    browser.close();
    return;
  }

  await frameTree.waitForSelector('input');
  await frameTree.type('input[name="id_cliente"]', company);
  await frameTree.type('input[name="login"]', usernameDaybeat);
  await frameTree.type('input[name="password"]', password);
  await delay(1000);
  await frameTree.click('input[type="submit"]');
  await frameTree.waitForNavigation();

  console.log('Login completado, esperando carga de página...');
  await delay(3000);

  const currentUser = await getCurrentUser(page, rl);
  if (currentUser) {
    console.log(`\n[INFO] Filtrando registros del usuario: ${currentUser}`);
  }

  const frameOne = page.frames().find(frame => frame.name() === 'uno');
  if (!frameOne) {
    console.log('ERROR: Frame "uno" no encontrado');
    browser.close();
    return;
  }
  await frameOne.waitForSelector('div', { timeout: 5000 });
  const divHandle = await frameOne.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Requerimientos');
  });
  await delay(1000);
  if (divHandle) {
    await frameOne.evaluate(el => {
      const event = new MouseEvent('mouseover', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      el.dispatchEvent(event);
    }, divHandle);
  }

  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('div');
  const divHandleConsulta = await frameTree.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Consultar');
  });
  if (divHandleConsulta) {
    await frameTree.evaluate(el => el.click(), divHandleConsulta);
    await frameTree.waitForNavigation();
  }

  // Mostrar todos los requerimientos (desde 01/01/2000)
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('input');
  const inputHandle = await frameTree.$('input[name="re_fechad"][type="text"]');
  if (inputHandle) {
    await frameTree.evaluate(el => el.focus(), inputHandle);
    await frameTree.evaluate((el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, inputHandle, '01012000');
    await frameTree.click('input[type="image"]');
    await frameTree.waitForNavigation();
  }

  // Seleccionar sección (reusando la ruta cacheada si existe)
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const links = await listElements(frameTree, 'a');

  const cachedPath = loadPathCache();
  let useCachedPath = false;

  if (cachedPath?.section?.text && cachedPath?.item?.text) {
    const sectionExists = links.some(l => normalizeText(l.text) === normalizeText(cachedPath.section.text));
    if (sectionExists) {
      console.log(`\nRuta anterior: ${cachedPath.section.text} > ${cachedPath.item.text}`);
      const answer = await questionUserResponse(frameTree, '\n¿Usar la misma ruta? (si/no): ');
      if (answer === 'si') useCachedPath = true;
    } else {
      console.log('\nLa sección anterior ya no existe. Seleccione manualmente.');
    }
  }

  if (useCachedPath) {
    const selectedLink = links.find(l => l.text === cachedPath.section.text);
    const linkHandle = await frameTree.evaluateHandle((text, selector) => {
      const elements = Array.from(document.querySelectorAll(selector));
      return elements.find(el => el.textContent.trim() === text);
    }, selectedLink.text, 'a');
    if (linkHandle) await frameTree.evaluate(el => el.click(), linkHandle);
  } else {
    await whriteAndNavigateElementSelect(frameTree, 'a', links);
  }
  await frameTree.waitForNavigation();

  // Seleccionar item: el link con el texto del item es el detalle
  // (itemsint_actualizar.asp), no el formulario de creación.
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  if (useCachedPath) {
    const otherLinks = await listElements(frameTree, 'a');
    const itemIdx = otherLinks.findIndex(l => normalizeText(l.text) === normalizeText(cachedPath.item.text));
    if (itemIdx >= 0) {
      const itemHandle = await frameTree.evaluateHandle((text, selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.find(el => el.textContent.trim() === text);
      }, otherLinks[itemIdx].text, 'a');
      if (itemHandle) await itemHandle.click();
      await frameTree.waitForNavigation();
    }
  } else {
    await whriteAndNavigateElementSelect(frameTree, 'a', await listElements(frameTree, 'a'));
    await frameTree.waitForNavigation();
  }

  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('table');
  const itemDetailUrl = await frameTree.evaluate(() => window.location.href);

  const today = new Date();
  const defaultDateStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

  let keepCorrecting = true;
  while (keepCorrecting) {
    const dateAnswer = await questionUserResponse(frameTree, `\nFecha del registro a corregir (DD/MM/AAAA) [${defaultDateStr}]: `);
    const dateStr = dateAnswer.trim() === '' ? defaultDateStr : dateAnswer.trim();

    // Re-navegar al detalle para refrescar la tabla
    await frameTree.evaluate((href) => { window.location.href = href; }, itemDetailUrl);
    await frameTree.waitForNavigation();
    await delay(1200);
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) break;
    await frameTree.waitForSelector('table');

    const [dd, mm, yyyy] = dateStr.split('/');
    const targetDate = `${yyyy}-${mm}-${dd}`;
    const rows = await parseTransactionTable(frameTree, targetDate, currentUser);

    if (rows.length === 0) {
      console.log(`\nNo hay registros del usuario en ${dateStr}.`);
      const again = await questionUserResponse(frameTree, '¿Desea probar con otra fecha? (si/no): ');
      if (again.trim() !== 'si') keepCorrecting = false;
      continue;
    }

    console.log('\nRegistros encontrados:');
    rows.forEach((r, i) => console.log(`  ${i + 1}. ${r.start} - ${r.end}  ${r.desc || ''}`));
    const pick = await questionUserResponse(frameTree, `\nSeleccione el registro a corregir (1-${rows.length}) o Enter para volver: `);
    const pickIdx = parseInt(pick, 10) - 1;
    if (isNaN(pickIdx) || pickIdx < 0 || pickIdx >= rows.length) {
      continue; // vuelve a pedir la fecha
    }

    const row = rows[pickIdx];
    if (!row.updateHref) {
      console.log('  ✗ No se pudo obtener el link de actualización del registro.');
      continue;
    }

    // Navegar al formulario de actualización y leer el estado actual
    await frameTree.evaluate((href) => { window.location.href = href; }, row.updateHref);
    await frameTree.waitForNavigation();
    await delay(1200);
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) break;
    await frameTree.waitForSelector('select[name="id_categoria"]');
    const form = await readTransactionForm(frameTree);

    const fmtDate = (f) => f && f.length === 8 ? `${f.slice(0, 2)}/${f.slice(2, 4)}/${f.slice(4)}` : (f || '');
    console.log(`\nRegistro seleccionado: ${row.start} - ${row.end}  ${row.desc || ''}`);
    console.log(`  Categoría: ${form.categoria.text} | Tipo: ${form.tipo.text}`);
    console.log(`  Fecha: ${fmtDate(form.fecha)} | Horario: ${form.horaini} - ${form.horafin}`);
    console.log('\nIngrese el nuevo valor para cada campo (Enter = conservar el actual):');

    const fields = {};

    console.log('\nCATEGORÍA:');
    form.optionsCategoria.forEach((o, i) => console.log(`  ${i + 1}. ${o.text}`));
    const catAnswer = await questionUserResponse(frameTree, `Categoría actual: ${form.categoria.text}. Nueva (número, Enter = mantener): `);
    const catIdx = parseInt(catAnswer, 10) - 1;
    if (!isNaN(catIdx) && catIdx >= 0 && catIdx < form.optionsCategoria.length) {
      fields.category = form.optionsCategoria[catIdx].value;
    }

    console.log('\nTIPO DE TRANSACCIÓN:');
    form.optionsTipo.forEach((o, i) => console.log(`  ${i + 1}. ${o.text}`));
    const tipoAnswer = await questionUserResponse(frameTree, `Tipo actual: ${form.tipo.text}. Nuevo (número, Enter = mantener): `);
    const tipoIdx = parseInt(tipoAnswer, 10) - 1;
    if (!isNaN(tipoIdx) && tipoIdx >= 0 && tipoIdx < form.optionsTipo.length) {
      fields.transactionType = form.optionsTipo[tipoIdx].value;
    }

    const descAnswer = await questionUserResponse(frameTree, `\nDescripción actual: ${form.descripcion || '(vacía)'}\nNueva descripción (Enter = mantener): `);
    if (descAnswer.trim() !== '') fields.descripcion = descAnswer.trim();

    const fechaAnswer = await questionUserResponse(frameTree, `Fecha actual: ${fmtDate(form.fecha)}. Nueva (DD/MM/AAAA, Enter = mantener): `);
    if (fechaAnswer.trim() !== '') {
      const fd = fechaAnswer.trim().split('/');
      if (fd.length === 3 && fd[0].trim() && fd[1].trim() && fd[2].trim()) {
        fields.fecha = `${fd[0].trim().padStart(2, '0')}${fd[1].trim().padStart(2, '0')}${fd[2].trim()}`;
      } else {
        console.log('  Formato de fecha inválido, se mantiene la actual.');
      }
    }

    const hiAnswer = await questionUserResponse(frameTree, `Hora inicio actual: ${form.horaini}. Nueva (HHMM, Enter = mantener): `);
    if (/^\d{4}$/.test(hiAnswer.trim())) fields.horaini = hiAnswer.trim();
    const hfAnswer = await questionUserResponse(frameTree, `Hora fin actual: ${form.horafin}. Nueva (HHMM, Enter = mantener): `);
    if (/^\d{4}$/.test(hfAnswer.trim())) fields.horafin = hfAnswer.trim();

    const detAnswer = await questionUserResponse(frameTree, `\nDetalle actual: ${form.detalle || '(vacío)'}\nNuevo detalle (Enter = mantener): `);
    if (detAnswer.trim() !== '') fields.detalle = detAnswer.trim();

    if (Object.keys(fields).length === 0) {
      console.log('\nNo se modificó ningún campo.');
      const again = await questionUserResponse(frameTree, '¿Desea corregir otro registro? (si/no): ');
      if (again.trim() !== 'si') keepCorrecting = false;
      continue;
    }

    console.log('\nCAMBIOS A APLICAR:');
    if (fields.category !== undefined) {
      const newText = form.optionsCategoria.find(o => o.value === String(fields.category))?.text || fields.category;
      console.log(`  Categoría: ${form.categoria.text} -> ${newText}`);
    }
    if (fields.transactionType !== undefined) {
      const newText = form.optionsTipo.find(o => o.value === String(fields.transactionType))?.text || fields.transactionType;
      console.log(`  Tipo: ${form.tipo.text} -> ${newText}`);
    }
    if (fields.descripcion !== undefined) console.log(`  Descripción: ${form.descripcion || '(vacía)'} -> ${fields.descripcion}`);
    if (fields.fecha !== undefined) console.log(`  Fecha: ${fmtDate(form.fecha)} -> ${fmtDate(fields.fecha)}`);
    if (fields.horaini !== undefined) console.log(`  Hora inicio: ${form.horaini} -> ${fields.horaini}`);
    if (fields.horafin !== undefined) console.log(`  Hora fin: ${form.horafin} -> ${fields.horafin}`);
    if (fields.detalle !== undefined) console.log(`  Detalle: ${form.detalle || '(vacío)'} -> ${fields.detalle}`);

    const confirm = await questionUserResponse(frameTree, '\n¿Desea actualizar el registro? (si/no): ');
    if (confirm.trim() !== 'si') {
      console.log('Actualización cancelada.');
      continue;
    }

    const result = await updateTransaction(frameTree, page, null, fields);
    if (result.success) {
      console.log('  ✓ Registro actualizado.');
    } else {
      console.log(`  ✗ Error al actualizar: ${result.message}`);
      if (result.message.includes('traslapa')) {
        console.log('  El horario se traslapa con otra transacción del mismo día.');
      }
    }

    const again = await questionUserResponse(frameTree, '\n¿Desea corregir otro registro? (si/no): ');
    if (again.trim() !== 'si') keepCorrecting = false;
  }

  console.log('Proceso finalizado.');
  await closeConnection();
  rl.close();
  browser.close();
};

const listAndNavigateNewTransaction = async (frameTree, page) => {
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const otherLinks = await listElements(frameTree, 'a');
  return await whriteAndNavigateOtherElementSelect(frameTree, 'a', otherLinks);
}

const registerNewTransaction = async (frameTree, page, autoData = null, cachedCategory = null, cachedTransaction = null, sectionText = null, itemText = null) => {
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('select');

  // CATEGORÍA
  console.log('SELECCIONE LA CATEGORIA: ');
  const optionsCategory = await listElements(frameTree, 'select[name="id_categoria"]>option');
  let selectedCategoryValue = null;
  let selectedCategoryText = null;
  
  if (cachedCategory?.value) {
    const found = optionsCategory.find(o => o.value === cachedCategory.value);
    if (found) {
      console.log(`  Usando: ${cachedCategory.text}`);
      selectedCategoryValue = cachedCategory.value;
      selectedCategoryText = cachedCategory.text;
      await frameTree.select('select[name="id_categoria"]', cachedCategory.value);
      await delay(1500);
    } else {
      console.log('  Categoría anterior no existe. Seleccione manualmente.');
      await selectOptionSelector(frameTree, 'select[name="id_categoria"]', optionsCategory);
    }
  } else {
    await selectOptionSelector(frameTree, 'select[name="id_categoria"]', optionsCategory);
  }
  
  // Capturar selección actual del dropdown
  if (!selectedCategoryValue) {
    const selectedIdx = await frameTree.$eval('select[name="id_categoria"]', el => el.selectedIndex);
    selectedCategoryValue = optionsCategory[selectedIdx]?.value;
    selectedCategoryText = optionsCategory[selectedIdx]?.text;
  }

  // TIPO DE TRANSACCIÓN
  console.log('SELECCIONE TIPO DE TRANSACCION: ');
  const optionsTransaction = await listElements(frameTree, 'select[name="cod_tipotransaccion"]>option');
  let selectedTransactionValue = null;
  let selectedTransactionText = null;
  
  if (cachedTransaction?.value) {
    const found = optionsTransaction.find(o => o.value === cachedTransaction.value);
    if (found) {
      console.log(`  Usando: ${cachedTransaction.text}`);
      selectedTransactionValue = cachedTransaction.value;
      selectedTransactionText = cachedTransaction.text;
      await frameTree.select('select[name="cod_tipotransaccion"]', cachedTransaction.value);
    } else {
      console.log('  Transacción anterior no existe. Seleccione manualmente.');
      await selectOptionSelector(frameTree, 'select[name="cod_tipotransaccion"]', optionsTransaction);
    }
  } else {
    await selectOptionSelector(frameTree, 'select[name="cod_tipotransaccion"]', optionsTransaction);
  }
  
  // Capturar selección actual del dropdown
  if (!selectedTransactionValue) {
    const selectedIdx = await frameTree.$eval('select[name="cod_tipotransaccion"]', el => el.selectedIndex);
    selectedTransactionValue = optionsTransaction[selectedIdx]?.value;
    selectedTransactionText = optionsTransaction[selectedIdx]?.text;
  }

  // Guardar ruta para próxima vez
  if (sectionText && itemText && selectedCategoryValue && selectedTransactionValue) {
    savePathCache({
      section: { text: sectionText },
      item: { text: itemText },
      category: { value: selectedCategoryValue, text: selectedCategoryText },
      transactionType: { value: selectedTransactionValue, text: selectedTransactionText }
    });
    console.log('\n✓ Ruta guardada para próxima vez');
  }

  // Mostrar menú de modo de registro
  console.log('-------------------------');
  console.log('MODO DE REGISTRO:');
  console.log('1. Automático (commits de hoy)');
  console.log('2. Con IA (Gemini)');
  console.log('3. Automático fake (basado en días anteriores)');
  console.log('4. Manual');
  if (isConfigured()) {
    console.log('5. Con información de Jira');
  }
  console.log('-------------------------');

  const mode = await questionUserResponse(frameTree, 'Seleccione modo (1/2/3/4' + (isConfigured() ? '/5' : '') + '): ');

  // Opción de registro: un solo bloque (jornada completa) o varios bloques
  // según la actividad del día (solo en modos automáticos con horarios)
  let blockMode = '1';
  if (mode === '1' || mode === '2' || mode === '5') {
    const resp = await questionUserResponse(frameTree, '¿Cómo desea registrar? (1: Un solo bloque / 2: Varios bloques según actividad): ');
    blockMode = resp.trim() === '2' ? '2' : '1';
  }

  let title = null;
  let formattedDate = null;
  let startTime = null;
  let endTime = null;
  let detail = null;
  let selectedJiraActivity = null; // actividad Jira elegida en modo 5 (para bloques)
  let userExtraContext = null;     // contexto adicional del modo IA (para bloques)
  let today = new Date();
  let dd = String(today.getDate()).padStart(2, '0');
  let mm = String(today.getMonth() + 1).padStart(2, '0');
  let yyyy = today.getFullYear();
  let defaultDate = dd + mm + yyyy;

  if (mode === '1') {
    const rootDir = resolveRootDir(process.env.ROOT_DIR);
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = getReposWithCache(rootDir);
    console.log(`Repositorios encontrados: ${repos.length}`);
    
    const author = getGitAuthor(repos);
    if (author) {
      console.log(`Filtrando commits por autor: ${author}`);
    } else {
      console.log('No se pudo determinar el autor. Mostrando todos los commits.');
    }
    
    if (repos.length === 0) {
      console.log('No se encontraron repositorios. Cambiando a modo fake...');
      const recentCommits = repos.flatMap(repo => getRecentCommits(repo, 7, author));
      title = generateFakeSummary(recentCommits);
      const hours = getLastUsedHours();
      startTime = hours.start;
      endTime = hours.end;
      detail = generateDetail(recentCommits);
    } else {
      const allCommits = repos.flatMap(repo => getTodayCommits(repo, author));
      console.log(`Total de commits hoy: ${allCommits.length}`);

      if (allCommits.length === 0) {
        console.log('No hay commits hoy. Cambiando a modo fake...');
        const recentCommits = repos.flatMap(repo => getRecentCommits(repo, 7, author));
        console.log(`Total de commits en últimos 7 días: ${recentCommits.length}`);
        title = generateFakeSummary(recentCommits);
        const hours = getLastUsedHours();
        startTime = hours.start;
        endTime = hours.end;
        detail = generateDetail(recentCommits);
      } else {
        title = summarizeCommits(allCommits);
        const hours = getLastUsedHours();
        startTime = hours.start;
        endTime = hours.end;
        detail = generateDetail(allCommits);
      }
    }
    formattedDate = defaultDate;

    console.log('-------------------------');
    console.log('RESUMEN AUTOMÁTICO:');
    console.log(`Título: ${title}`);
    console.log(`Detalle: ${detail}`);
    console.log(`Fecha: ${dd}/${mm}/${yyyy}`);
    console.log(`Horario: ${startTime} - ${endTime}`);
    console.log('-------------------------');

    // Con bloques la confirmación se difiere hasta después de la propuesta
    const confirm = blockMode === '2' ? 'si' : await questionUserResponse(frameTree, '¿Desea continuar con estos datos? (si/no): ');
    if (confirm !== 'si') {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  } else if (mode === '2') {
    // Modo Con IA (Gemini)
    const rootDir = resolveRootDir(process.env.ROOT_DIR);
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = getReposWithCache(rootDir);
    console.log(`Repositorios encontrados: ${repos.length}`);
    
    const author = getGitAuthor(repos);
    if (author) {
      console.log(`Filtrando commits por autor: ${author}`);
    } else {
      console.log('No se pudo determinar el autor. Mostrando todos los commits.');
    }
    
    let allCommits = [];
    if (repos.length > 0) {
      allCommits = repos.flatMap(repo => getTodayCommits(repo, author));
      console.log(`Total de commits hoy: ${allCommits.length}`);
      
      if (allCommits.length === 0) {
        console.log('No hay commits hoy, usando últimos 3 días...');
        allCommits = repos.flatMap(repo => getRecentCommits(repo, 3, author));
        console.log(`Total de commits en últimos 3 días: ${allCommits.length}`);
      }
    }
    
    const hours = getLastUsedHours();
    startTime = hours.start;
    endTime = hours.end;
    formattedDate = defaultDate;
    
    // Preguntar por contexto adicional (solo registro diario con IA)
    let extraContext = null;
    if (process.env.GEMINI_API_KEY && allCommits.length > 0) {
      console.log('\nCommits encontrados:');
      for (const commit of allCommits.slice(0, 10)) {
        console.log(`  - ${commit.substring(0, 80)}`);
      }
      if (allCommits.length > 10) {
        console.log(`  ... y ${allCommits.length - 10} más`);
      }
      
      const wantContext = await questionUserResponse(frameTree, 
        '\n¿Desea agregar contexto adicional para la IA? (si/no): ');
      if (wantContext === 'si') {
        extraContext = await questionUserResponse(frameTree, 
          'Describa qué más hizo hoy (reuniones, debugging, diseño, etc.): ');
      }
      userExtraContext = extraContext;
    }
    
    // Intentar generar con IA
    if (process.env.GEMINI_API_KEY && allCommits.length > 0) {
      console.log('  Generando con Gemini AI...');
      const aiResult = await generateWithGemini(allCommits, 'same-day', null, extraContext);
      
      if (aiResult) {
        title = aiResult.title;
        detail = aiResult.detail;
        console.log('  ✓ Generado con Gemini AI');
      } else {
        console.log('  ✗ IA falló, usando método por defecto');
        title = allCommits.length > 0 ? summarizeCommits(allCommits) : generateFakeSummary(allCommits);
        detail = generateDetail(allCommits);
      }
    } else {
      if (!process.env.GEMINI_API_KEY) {
        console.log('  No hay GEMINI_API_KEY, usando método por defecto');
      }
      title = allCommits.length > 0 ? summarizeCommits(allCommits) : generateFakeSummary(allCommits);
      detail = generateDetail(allCommits);
    }
    
    console.log('-------------------------');
    console.log('RESUMEN CON IA:');
    console.log(`Título: ${title}`);
    console.log(`Detalle: ${detail}`);
    if (extraContext) {
      console.log(`Contexto adicional: ${extraContext}`);
    }
    console.log(`Fecha: ${dd}/${mm}/${yyyy}`);
    console.log(`Horario: ${startTime} - ${endTime}`);
    console.log('-------------------------');
    
    // Con bloques la confirmación se difiere hasta después de la propuesta
    const confirm = blockMode === '2' ? 'si' : await questionUserResponse(frameTree, '¿Desea continuar con estos datos? (si/no): ');
    if (confirm !== 'si') {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  } else if (mode === '5') {
    // Modo Con información de Jira
    const rootDir = resolveRootDir(process.env.ROOT_DIR);
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = getReposWithCache(rootDir);
    console.log(`Repositorios encontrados: ${repos.length}`);
    
    const author = getGitAuthor(repos);
    if (author) {
      console.log(`Filtrando commits por autor: ${author}`);
    }
    
    let allCommits = [];
    if (repos.length > 0) {
      allCommits = repos.flatMap(repo => getTodayCommits(repo, author));
      console.log(`Total de commits hoy: ${allCommits.length}`);
      if (allCommits.length === 0) {
        console.log('No hay commits hoy, usando últimos 3 días...');
        allCommits = repos.flatMap(repo => getRecentCommits(repo, 3, author));
        console.log(`Total de commits en últimos 3 días: ${allCommits.length}`);
      }
    }
    
    const hours = getLastUsedHours();
    startTime = hours.start;
    endTime = hours.end;
    formattedDate = defaultDate;
    
    // Consultar actividad de Jira (issues + comentarios + worklogs)
    let activity = null;
    let jiraContext = null;
    if (isConfigured()) {
      console.log('Consultando actividad en Jira...');
      try {
        activity = await getDailyActivity(today);
        if (activity.issues.length === 0 && activity.comments.length === 0 && activity.worklogs.length === 0) {
          console.log('  Sin actividad registrada en Jira para hoy.');
        } else {
          console.log('------------------------------------');
          console.log('ACTIVIDAD EN JIRA:');
          console.log(formatActivityForReport(activity));
          console.log('------------------------------------');
          // Selección interactiva: marcar qué se incluye en el reporte
          selectedJiraActivity = await selectJiraActivityMulti(activity);
          const hasContent =
            selectedJiraActivity.issues.length > 0 ||
            selectedJiraActivity.comments.length > 0 ||
            selectedJiraActivity.worklogs.length > 0;
          jiraContext = hasContent ? formatActivityForReport(selectedJiraActivity) : null;
        }
      } catch (err) {
        console.log(`  ✗ Error consultando Jira: ${err.message}`);
      }
    } else {
      console.log('  No hay ATLASSIAN_API_TOKEN. Se usará solo commits.');
    }
    
    // Generar reporte con IA o por defecto
    let geminiUsed = false;
    if (process.env.GEMINI_API_KEY && allCommits.length > 0) {
      console.log('  Generando con Gemini AI...');
      const aiResult = await generateWithGemini(allCommits, 'same-day', null, jiraContext);
      if (aiResult) {
        title = aiResult.title;
        detail = aiResult.detail;
        geminiUsed = true;
        console.log('  ✓ Generado con Gemini AI');
      } else {
        console.log('  ✗ IA falló, usando método por defecto');
      }
    } else if (!process.env.GEMINI_API_KEY) {
      console.log('  No hay GEMINI_API_KEY, usando método por defecto');
    }
    
    if (!geminiUsed) {
      if (allCommits.length > 0) {
        title = summarizeCommits(allCommits);
        detail = generateDetail(allCommits);
      } else if (activity && activity.issues.length > 0) {
        const firstIssue = activity.issues[0];
        title = smartTruncate(`Actividad en Jira: ${firstIssue.key} ${firstIssue.summary || ''}`, 100);
        detail = jiraContext;
      } else {
        title = generateFakeSummary(allCommits);
        detail = generateDetail(allCommits);
      }
      
      // Agregar el bloque de Jira al detalle cuando no lo generó la IA
      if (jiraContext && detail) {
        detail = `${detail}\n\n${jiraContext}`;
      }
    }
    
    console.log('-------------------------');
    console.log('RESUMEN CON JIRA:');
    console.log(`Título: ${title}`);
    console.log(`Detalle: ${detail}`);
    console.log(`Fecha: ${dd}/${mm}/${yyyy}`);
    console.log(`Horario: ${startTime} - ${endTime}`);
    console.log('-------------------------');
    
    // Con bloques la confirmación se difiere hasta después de la propuesta
    const confirm = blockMode === '2' ? 'si' : await questionUserResponse(frameTree, '¿Desea continuar con estos datos? (si/no): ');
    if (confirm !== 'si') {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  } else if (mode === '3') {
    const rootDir = resolveRootDir(process.env.ROOT_DIR);
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = getReposWithCache(rootDir);
    console.log(`Repositorios encontrados: ${repos.length}`);
    
    const author = getGitAuthor(repos);
    if (author) {
      console.log(`Filtrando commits por autor: ${author}`);
    } else {
      console.log('No se pudo determinar el autor. Mostrando todos los commits.');
    }
    
    if (repos.length === 0) {
      console.log('No se encontraron repositorios. Usando resumen genérico.');
    }
    
    const recentCommits = repos.flatMap(repo => getRecentCommits(repo, 7, author));
    console.log(`Total de commits en últimos 7 días: ${recentCommits.length}`);
    
    title = generateFakeSummary(recentCommits);
    const hours = getLastUsedHours();
    startTime = hours.start;
    endTime = hours.end;
    detail = generateDetail(recentCommits);
    formattedDate = defaultDate;

    console.log('-------------------------');
    console.log('RESUMEN FAKE:');
    console.log(`Título: ${title}`);
    console.log(`Detalle: ${detail}`);
    console.log(`Fecha: ${dd}/${mm}/${yyyy}`);
    console.log(`Horario: ${startTime} - ${endTime}`);
    console.log('-------------------------');

    const confirm = await questionUserResponse(frameTree, '¿Desea continuar con estos datos? (si/no): ');
    if (confirm !== 'si') {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  }

  // Validación anti-duplicado: leer los rangos ya registrados del día en este
  // item y avisar. No bloquea: el solape de Daybeat es por fecha Y hora, así
  // que registrar otra cosa con horas distintas es válido.
  let existingRanges = null;
  if (title && formattedDate) {
    const currentUser = await getCurrentUser(page, rl);
    const dayStr = `${dd}/${mm}/${yyyy}`;
    existingRanges = await getExistingRanges(
      frameTree, page, dayStr, currentUser,
      selectedCategoryValue, selectedTransactionValue
    );
    if (existingRanges && existingRanges.count > 0) {
      console.log('---------------------------------------------------');
      console.log(`⚠ El día ${dd}/${mm}/${yyyy} ya tiene transacciones registradas en este item:`);
      for (const r of existingRanges.ranges) {
        const desc = r.desc ? `  (${r.desc})` : '';
        console.log(`  ${r.start} - ${r.end}${desc}`);
      }
      console.log('---------------------------------------------------');
      const answerReg = await questionUserResponse(frameTree, '¿Desea registrar de todos modos? (si/no): ');
      if (answerReg !== 'si') {
        console.log('Registro cancelado (día ya registrado).');
        await finishOrContinue(page, page.browser());
        return frameTree;
      }
    }
  }

  // Registro por bloques (opcional): reparte el día en varios bloques según
  // la actividad con horario (commits, comentarios y worklogs de Jira).
  let blocks = null;
  if (blockMode === '2' && title && startTime && endTime) {
    const rootDirBlocks = resolveRootDir(process.env.ROOT_DIR);
    const reposBlocks = getReposWithCache(rootDirBlocks);
    const authorBlocks = getGitAuthor(reposBlocks);
    const dayStr = `${dd}/${mm}/${yyyy}`;
    const events = [];
    for (const repo of reposBlocks) {
      for (const c of getCommitsWithTime(repo, dayStr, authorBlocks)) {
        events.push({ time: c.time, label: c.message, kind: 'commit', weight: 1 });
      }
    }
    if (selectedJiraActivity) {
      for (const comment of selectedJiraActivity.comments) {
        const time = comment.created ? isoToLocalHHMM(comment.created) : null;
        if (time) {
          events.push({ time, label: `Comentario ${comment.issueKey}: ${comment.body}`, kind: 'jira', weight: 1 });
        }
      }
      for (const worklog of selectedJiraActivity.worklogs) {
        const time = worklog.started ? isoToLocalHHMM(worklog.started) : null;
        if (time) {
          events.push({
            time,
            label: `Worklog ${worklog.issueKey}: ${worklog.timeSpent}`,
            kind: 'jira',
            weight: parseTimeSpentHours(worklog.timeSpent)
          });
        }
      }
    }
    for (const ev of events) ev.minutes = toMinutes(ev.time.replace(':', ''));
    blocks = buildDayBlocks(events.filter(ev => !isNaN(ev.minutes)), startTime, endTime);

    // Ajustar los bloques a los horarios libres (día parcialmente registrado)
    if (blocks && existingRanges && existingRanges.count > 0) {
      const adjusted = intersectBlocksWithFree(blocks, existingRanges.ranges, startTime, endTime);
      if (adjusted) {
        console.log('  Bloques ajustados a los horarios libres del día:');
        blocks = adjusted;
      } else {
        console.log('  No hay horarios libres para los bloques propuestos.');
        blocks = null;
      }
    }

    if (blocks) {
      // Las incidencias no tienen hora: se adjuntan al bloque con más actividad
      if (selectedJiraActivity && selectedJiraActivity.issues.length > 0) {
        let maxIdx = 0;
        for (let i = 1; i < blocks.length; i++) {
          if (blocks[i].events.length > blocks[maxIdx].events.length) maxIdx = i;
        }
        blocks[maxIdx].issues = selectedJiraActivity.issues;
      }
      console.log('-------------------------');
      console.log('BLOQUES PROPUESTOS (según actividad del día):');
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        console.log(`  ${i + 1}. ${b.start} - ${b.end}  (${b.events.length} actividad(es))`);
        console.log(`     ${(b.events[0]?.label || '').substring(0, 90)}`);
      }
      console.log('-------------------------');
      const okBlocks = await questionUserResponse(frameTree, '¿Desea registrar estos bloques? (si/no): ');
      if (okBlocks !== 'si') blocks = null;
    } else {
      console.log('  No hay suficiente actividad con horario para dividir el día. Se usará un solo bloque.');
    }
  }

  // ---- Registro por bloques (multi-transacción del mismo día) ----
  if (blocks) {
    const browser = page.browser();
    const formUrl = await frameTree.evaluate(() => window.location.href);
    // El handler global de diálogos es para un solo envío; durante el loop
    // cada bloque maneja su propio diálogo y se restaura al final.
    page.removeAllListeners('dialog');

    let blocksOk = true;
    for (let i = 0; i < blocks.length && blocksOk; i++) {
      const block = blocks[i];
      const blockCommits = block.events.filter(ev => ev.kind === 'commit').map(ev => ev.label);
      const jiraLabels = block.events.filter(ev => ev.kind === 'jira').map(ev => ev.label);

      let blockTitle;
      let blockDetail;
      if (blockCommits.length > 0) {
        blockTitle = summarizeCommits(blockCommits);
        blockDetail = generateDetail(blockCommits);
      } else {
        blockTitle = smartTruncate(block.events[0]?.label || 'Actividad registrada', 100);
        blockDetail = block.events.map(ev => `- ${ev.label}`).join('\n') || 'Actividad del día';
      }
      if (jiraLabels.length > 0) {
        blockDetail += `\n\nActividad en Jira:\n${jiraLabels.map(l => `  - ${l}`).join('\n')}`;
      }
      if (block.issues && block.issues.length > 0) {
        blockDetail += `\n\nIncidencias:\n${block.issues.map(issue => `  - ${issue.key}: ${issue.summary || 'Sin resumen'}`).join('\n')}`;
      }

      // Con IA (modo 2): generar por bloque; el contexto adicional va al primero
      if (mode === '2' && process.env.GEMINI_API_KEY && blockCommits.length > 0) {
        const aiResult = await generateWithGemini(blockCommits, 'same-day', null, i === 0 ? userExtraContext : null);
        if (aiResult) {
          blockTitle = aiResult.title;
          blockDetail = aiResult.detail;
        }
      }

      if (i > 0) {
        // Re-navegar al formulario para dejarlo fresco
        await frameTree.evaluate((href) => {
          window.location.href = href;
        }, formUrl);
        await frameTree.waitForNavigation();
        await delay(1500);
        frameTree = page.frames().find(frame => frame.name() === 'tres');
        await frameTree.waitForSelector('select');

        // La recarga resetea los selects obligatorios: re-seleccionar
        // categoría (esperando la carga dependiente) y tipo de transacción.
        if (selectedCategoryValue) {
          await frameTree.select('select[name="id_categoria"]', selectedCategoryValue);
          await delay(1500);
        }
        if (selectedTransactionValue) {
          await frameTree.select('select[name="cod_tipotransaccion"]', selectedTransactionValue);
        }
      }

      await frameTree.type('input[name="descripcion_corta"]', blockTitle);
      await frameTree.type('input[name="fechaini"]', formattedDate);
      await frameTree.type('input[name="horaini"]', block.start);
      await frameTree.type('input[name="horafin"]', block.end);
      await frameTree.type('textarea[name="texto_largo"]', blockDetail);

      // Listener del dialog ANTES del click (evita race condition)
      const dialogPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ handled: false, message: '' }), 8000);
        page.once('dialog', async (dialog) => {
          clearTimeout(timeout);
          const message = dialog.message();
          console.log(`  Diálogo: ${message}`);
          await dialog.accept();
          resolve({
            handled: true,
            success: message.includes('éxitosamente') || message.includes('exitosamente'),
            message
          });
        });
      });
      await frameTree.click('input[type="submit"][class="bot"]');
      const result = await dialogPromise;

      if (!result.handled || !result.success) {
        blocksOk = false;
        if (result.message && result.message.includes('traslapa')) {
          console.log(`  ✗ El periodo de la transacción se traslapa con otra del mismo día (bloque ${i + 1}: ${block.start}-${block.end}).`);
        } else {
          console.log(`  ✗ Error registrando el bloque ${i + 1} (${block.start}-${block.end})`);
        }
      } else {
        console.log(`  ✓ Bloque ${i + 1}/${blocks.length} (${block.start} - ${block.end}) registrado`);
      }
    }

    // Restaurar el handler global de diálogos para el siguiente envío
    page.on('dialog', dialog => handleGlobalDialog(dialog, page, browser));
    saveHours(blocks[0].start, blocks[blocks.length - 1].end);

    if (blocksOk) {
      await finishOrContinue(page, browser);
    } else {
      // No matar la aplicación: avisar y volver al menú (pregunta si registrar
      // otra actividad o salir), igual que el flujo de éxito.
      console.log('No se pudieron registrar todos los bloques.');
      await finishOrContinue(page, browser);
    }
    return frameTree;
  }

  // Confirmación diferida del bloque único: con bloques habilitados, la
  // pregunta se hace después de la propuesta de bloques (si no se registraron)
  if (blockMode === '2' && title) {
    const confirm = await questionUserResponse(frameTree, '¿Desea continuar con estos datos? (si/no): ');
    if (confirm !== 'si') {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  }

  // ---- Registro de un solo bloque (comportamiento original) ----

  // Escribir input descripcion corta.
  if (title) {
    await frameTree.type('input[name="descripcion_corta"]', title);
  } else {
    await whriteInput(frameTree, 'input[name="descripcion_corta"]', "Digite el titulo de la actividad:");
  }

  // Definir fecha
  if (!formattedDate) {
    const responseDate = await questionUserResponse(frameTree, `¿La fecha que va registrar es ${dd}/${mm}/${yyyy} ? (si/no): `);
    if (responseDate === 'si') {
      formattedDate = defaultDate;
    } else {
      formattedDate = await questionUserResponse(frameTree, "Digite la fecha de la actividad formato ddmmyyyy: ");
    }
  }
  await frameTree.type('input[name="fechaini"]', formattedDate);

  // Definir horario
  if (!startTime) {
    const response = await questionUserResponse(frameTree, '¿El horario a diligenciar es jornada completa de 7:30am a 5:30pm? (si/no): ');
    if (response === 'si') {
      startTime = '0730';
      endTime = '1630';
    } else {
      startTime = await questionUserResponse(frameTree, "Digite la hora de inicio de la actividad sin puntos: ");
      endTime = await questionUserResponse(frameTree, "Digite la hora de finalización de la actividad sin puntos: ");
    }
  }
  await frameTree.type('input[name="horaini"]', startTime);
  await frameTree.type('input[name="horafin"]', endTime);

  // Guardar horario usado
  saveHours(startTime, endTime);

  // Escribir detalle de actividad.
  if (detail) {
    await frameTree.type('textarea[name="texto_largo"]', detail);
  } else {
    await whriteInput(frameTree, 'textarea[name="texto_largo"]', "Digite el detalle de la actividad:");
  }

  // Enviar el formulario
  await frameTree.click('input[type="submit"][class="bot"]');

  return frameTree;
}


const finishOrContinue = async (page, browser) => {
  let frameTree = page.frames().find(frame => frame.name() === 'tres');
  const response = await questionUserResponse(frameTree, '¿Deseas registrar otra actividad? (si/no): ');

  if (response === 'si') {
    console.log('====================================');
    console.log('REGISTRANDO NUEVA ACTIVIDAD...', response);
    console.log('====================================');
    await listAndNavigateNewTransaction(frameTree, page);
    await registerNewTransaction(frameTree, page);
  } else {
    console.log('Proceso finalizado.');
    await closeConnection();
    rl.close();
    browser.close();
  }
}

// Handler global de diálogos del formulario de transacción (un solo envío).
// Durante el registro por bloques se retira temporalmente y se restaura al
// final del loop (cada bloque maneja su propio diálogo).
const handleGlobalDialog = async (dialog, page, browser) => {
  console.log('-------------------------');
  console.log('ALERTA ENCONTRADA:');
  console.log('-------------------------');
  console.log(dialog.message());
  if (dialog.message().trim() === 'Transacción ingresada éxitosamente') {
    await dialog.accept();
    await finishOrContinue(page, browser);
  } else {
    await dialog.accept();
    console.log('ERROR AL REGISTRAR, EJECUTE NUEVAMENTE.');
    await closeConnection();
    rl.close();
    browser.close();
  }
};

const delay = (time) => {
  return new Promise(function (resolve) {
    setTimeout(resolve, time)
  });
}

(async () => {
  // HEADLESS: 'true' oculta el navegador (sin ventana); 'false' lo muestra.
  const browser = await puppeteer.launch({ headless: process.env.HEADLESS === 'true' });
  const page = await browser.newPage();

  const linkDaybeat = process.env.LINK_DAYBEAT;
  const company = process.env.COMPANY;
  const usernameDaybeat = process.env.USERNAME_DAYBEAT;
  const password = process.env.PASSWORD;

  if (!linkDaybeat || !company || !usernameDaybeat || !password) {
    console.log("ERROR: Defina variables de entorno para continuar.");
    browser.close();
    return;
  }

  const holidays = await checkHolidaysYear();

  await page.goto(linkDaybeat);

  let keepRunning = true;
  while (keepRunning) {
    console.log('====================================');
    console.log('¿QUÉ DESEA HACER?');
    console.log('====================================');
    console.log('1. Registrar actividad');
    console.log('2. Ver días sin registro');
    console.log('3. Registro masivo de días sin registro');
    console.log('4. Corregir / mover registro');
    console.log('5. Re-escanear repositorios');
    console.log('6. Salir');
    console.log('====================================');

    const mainOption = await new Promise((resolve) => {
      rl.question('Seleccione opción (1/2/3/4/5/6): ', (answer) => {
        resolve(answer);
      });
    });

    if (mainOption === '6') {
      console.log('Saliendo...');
      await closeConnection();
      rl.close();
      browser.close();
      return;
    }

    if (mainOption === '5') {
      const rootDir = resolveRootDir(process.env.ROOT_DIR);
      console.log('\nRe-escaneando repositorios...');
      const repos = getReposWithCache(rootDir, true);
      console.log(`Repositorios encontrados: ${repos.length}`);
      for (const repo of repos) {
        const display = repo.replace(rootDir, '.');
        console.log(`  - ${display}`);
      }
      console.log('\nPresione Enter para continuar...');
      await new Promise((resolve) => rl.question('', resolve));
      continue;
    }

    if (mainOption === '2') {
      await showMissingRegistrations(page, browser, company, usernameDaybeat, password, holidays);
      return;
    }

    if (mainOption === '3') {
      await registerBulkMissingDays(page, browser, company, usernameDaybeat, password, holidays);
      return;
    }

    if (mainOption === '4') {
      await correctRegistration(page, browser, company, usernameDaybeat, password, holidays);
      return;
    }

    if (mainOption === '1') {
      keepRunning = false;
      break;
    }

  } // end while (keepRunning)

  const cachedPath = loadPathCache();

  page.on('dialog', dialog => handleGlobalDialog(dialog, page, browser));


  // Obtener el frame con el nombre "tres"
  let frameTree = page.frames().find(frame => frame.name() === 'tres');

  if (frameTree) {
    
    // Esperar a que los inputs dentro del frame estén cargados
    await frameTree.waitForSelector('input');

    // LOGIN.
    await frameTree.type('input[name="id_cliente"]', company);
    await frameTree.type('input[name="login"]', usernameDaybeat);
    await frameTree.type('input[name="password"]', password);

    await delay(1000)

    // Enviar el formulario.
    await frameTree.click('input[type="submit"]');

    // Esperar a que la navegación termine (si redirige a otra página).
    await frameTree.waitForNavigation();

    /////////////////////////////////////////////////////////
    // INGRESAR AL MENU INICIAL UNO Y HACER HOVER.
    /////////////////////////////////////////////////////////
    const frameOne = page.frames().find(frame => frame.name() === 'uno');
    // Esperar a que los inputs dentro del frame estén cargados
    await frameOne.waitForSelector('div');
    // Encontrar el div que contiene el texto específico usando evaluate
    const divHandle = await frameOne.evaluateHandle(() => {
      const elements = Array.from(document.querySelectorAll('div'));
      return elements.find(el => el.textContent.trim() === 'Requerimientos'); // Comparación exacta
    });

    // Esperar 1 segundo
    await delay(1000);
    
    if (divHandle) {
      // Hacer hover sobre el div
      await frameOne.evaluate(el => {
        const event = new MouseEvent('mouseover', {
          bubbles: true,
          cancelable: true,
          view: window
        });
        el.dispatchEvent(event);
      }, divHandle);
    }
    ////////////////////////--END--/////////////////////////

    /////////////////////////////////////////////////////////
    // NAVEGAR A CONSULTAR.    
    /////////////////////////////////////////////////////////
    // Esperar a que los inputs dentro del frame estén cargados
    await frameTree.waitForSelector('div');
    // Encontrar el div que contiene el texto específico usando evaluate
    const divHandleConsulta = await frameTree.evaluateHandle(() => {
      const elements = Array.from(document.querySelectorAll('div'));
      return elements.find(el => el.textContent.trim() === 'Consultar'); // Comparación exacta
    });

    if (divHandleConsulta) {
      // Hacer clic en el div encontrado
      await frameTree.evaluate(el => el.click(), divHandleConsulta);
      // Esperar a que la navegación termine (si redirige a otra página).
      await frameTree.waitForNavigation();
    }
    ////////////////////////--END--/////////////////////////

    /////////////////////////////////////////////////////////
    // ACTUALIZAR LA CONSULTA.
    /////////////////////////////////////////////////////////

    // Actualizar frame 3
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    // // Esperar a que los inputs dentro del frame estén cargados
    await frameTree.waitForSelector('input');

    // Listar todos los inputs dentro del frame
    const inputs = await frameTree.$$eval('input', elements =>
      elements.map(el => ({
        type: el.type,
        name: el.name,
        id: el.id,
        class: el.className,
        placeholder: el.placeholder
      }))
    );

    // Obtener el input como un ElementHandle
    const inputHandle = await frameTree.$('input[name="re_fechad"][type="text"]');

    if (inputHandle) {
      // Enfocar el input
      await frameTree.evaluate(el => el.focus(), inputHandle);

      // Escribir el nuevo valor para ver todo el listado.
      await frameTree.evaluate((el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, inputHandle, '01012000');

      // Buscar el formulario
      await frameTree.click('input[type="image"]');

      // Esperar a que la navegación termine (si redirige a otra página).
      await frameTree.waitForNavigation();
    }
    ////////////////////////--END--/////////////////////////


    /////////////////////////////////////////////////////////
    /**          SELECCIONAR SECCIÓN A REGISTRAR.         **/
    /////////////////////////////////////////////////////////
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    const links = await listElements(frameTree, 'a');
    
    let useCachedPath = false;
    let selectedSectionText = null;
    let selectedItemText = null;
    
    if (cachedPath?.section?.text && cachedPath?.item?.text && cachedPath?.category?.value && cachedPath?.transactionType?.value) {
      const sectionExists = links.some(l => normalizeText(l.text) === normalizeText(cachedPath.section.text));
      if (sectionExists) {
        console.log(`\nRuta anterior: ${cachedPath.section.text} > ${cachedPath.item.text} > ${cachedPath.category.text} > ${cachedPath.transactionType.text}`);
        const answer = await questionUserResponse(frameTree, '\n¿Usar la misma ruta? (si/no): ');
        if (answer === 'si') {
          useCachedPath = true;
          selectedSectionText = cachedPath.section.text;
          selectedItemText = cachedPath.item.text;
        }
      } else {
        console.log('\nLa sección anterior ya no existe. Seleccione manualmente.');
      }
    }
    
    if (useCachedPath) {
      // Seleccionar sección automáticamente
      const foundIdx = links.findIndex(l => l.text === cachedPath.section.text);
      const selectedLink = links[foundIdx];
      const linkHandle = await frameTree.evaluateHandle((text, selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.find(el => el.textContent.trim() === text);
      }, selectedLink.text, 'a');
      if (linkHandle) await frameTree.evaluate(el => el.click(), linkHandle);
    } else {
      // Selección manual de sección
      selectedSectionText = await whriteAndNavigateElementSelect(frameTree, 'a', links);
    }
    ////////////////////////--END--/////////////////////////

    /////////////////////////////////////////////////////////
    /**  LISTAR Y NAVEGAR A REGISTRAR NUEVA TRANSACCIÓN.  **/
    /////////////////////////////////////////////////////////
    await frameTree.waitForNavigation();
    
    if (useCachedPath) {
      // Navegar al item automáticamente
      frameTree = page.frames().find(frame => frame.name() === 'tres');
      const otherLinks = await listElements(frameTree, 'a');
      const itemIdx = otherLinks.findIndex(l => normalizeText(l.text) === normalizeText(cachedPath.item.text));
      if (itemIdx >= 0) {
        const selectedItem = otherLinks[itemIdx];
        const itemHandle = await frameTree.evaluateHandle((text, selector) => {
          const elements = Array.from(document.querySelectorAll(selector));
          const elementSelect = elements.find(el => el.textContent.trim() === text);
          if (elementSelect) {
            const parentTd = elementSelect.parentElement;
            const grandParentTr = parentTd.parentElement;
            const allLinksInRow = Array.from(grandParentTr.querySelectorAll('td > a'));
            if (allLinksInRow.length >= 2) {
              return allLinksInRow[allLinksInRow.length - 2];
            }
          }
          return null;
        }, selectedItem.text, 'a');
        if (itemHandle) await itemHandle.click();
        await frameTree.waitForNavigation();
      }
    } else {
      selectedItemText = await listAndNavigateNewTransaction(frameTree, page);
    }
    ////////////////////////--END--/////////////////////////

    /////////////////////////////////////////////////////////
    /**     DILIGENCIAR FORMULARIO PARA NUEVO REGISTRO.   **/
    /////////////////////////////////////////////////////////
    await frameTree.waitForNavigation();
    registerNewTransaction(frameTree, page, null, 
      useCachedPath ? cachedPath.category : null, 
      useCachedPath ? cachedPath.transactionType : null,
      selectedSectionText,
      selectedItemText);

  } else {
    console.log('Frame no encontrado');
  }


  // Cerrar el navegador
  // await browser.close();
})();
