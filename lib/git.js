// Descubrimiento de repositorios git y recuperación de commits (con caché de
// repos y filtro por autor). Toda invocación a git usa GIT_SAFE_DIR.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveRootDir, toLinuxPath } = require('./path.js');
const { loadRepoCache, saveRepoCache } = require('./persistence.js');

// Git para Windows rechaza repositorios WSL/UNC por "dubious ownership"
// (archivos con otro dueño). Este flag desactiva esa protección por comando.
// OJO: usar comillas dobles — cmd.exe (Windows) no interpreta las simples y
// git recibiría ''*'' literal, lo que NO matchea ninguna excepción.
const GIT_SAFE_DIR = '-c "safe.directory=*"';

const SKIP_DIRS = [
  'node_modules', '.git', '.idea', '.vscode', '__pycache__', 'vendor',
  '.svn', 'bower_components', 'dist', 'build', '.next', '.nuxt',
  'payara5', 'inttegrio', 'bin', 'dmp', 'leadtools', '.atl', 'sdd'
];

const findGitRepos = (rootDir, depth = 0, maxDepth = 3) => {
  const repos = [];
  if (!rootDir) {
    console.log('Sin repositorios Git configurados; se usará el modo sin commits.');
    return repos;
  }
  if (!fs.existsSync(rootDir)) {
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

// Rota los commits previos según el día de la semana objetivo (para el modo
// "fake" y días sin commits).
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

module.exports = {
  GIT_SAFE_DIR,
  findGitRepos,
  getReposWithCache,
  getGitAuthor,
  getTodayCommits,
  getRecentCommits,
  getCommitsForDate,
  getCommitsWithTime,
  getRecentCommitsBeforeDate,
  getRotatedCommits
};
