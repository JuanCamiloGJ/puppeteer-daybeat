require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

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
    if (cached && cached.rootDir === rootDir) {
      const valid = cached.repos.filter(r => fs.existsSync(r));
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

const resolveRootDir = (dir) => {
  if (!dir) return dir;

  const isWindows = process.platform === 'win32';

  if (isWindows && dir.startsWith('/')) {
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

const getGitAuthor = (repos) => {
  if (process.env.GIT_AUTHOR_EMAIL) {
    return process.env.GIT_AUTHOR_EMAIL;
  }

  for (const repo of repos) {
    try {
      const email = execSync(`git -C "${repo}" config user.email`, {
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

const getCommitsLast30Days = (repoPath, author = null) => {
  try {
    const today = new Date();
    const pastDate = new Date(today.getTime() - (30 * 24 * 60 * 60 * 1000));
    const year = pastDate.getFullYear();
    const month = String(pastDate.getMonth() + 1).padStart(2, '0');
    const day = String(pastDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    const authorFilter = author ? `--author="${author}"` : '';
    const result = execSync(
      `git -C "${repoPath}" log --since="${dateStr}" --all ${authorFilter} --format="%H|%ai|%s"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }
    );
    const lines = result.trim().split('\n').filter(msg => msg.length > 0);
    return lines.map(line => {
      const parts = line.split('|');
      const hash = parts[0];
      const date = parts[1];
      const message = parts.slice(2).join('|');
      return { hash, date, message };
    });
  } catch (err) {
    console.log(`  Error obteniendo commits en ${repoPath}: ${err.message}`);
    return [];
  }
};

const forceRescan = process.argv.includes('--rescan');
const rootDir = resolveRootDir(process.env.ROOT_DIR);
console.log('====================================');
console.log('DIAGNÓSTICO DE COMMITS - ÚLTIMOS 30 DÍAS');
console.log('====================================\n');

console.log('ROOT_DIR:', rootDir);
const repos = getReposWithCache(rootDir, forceRescan);
console.log(`Repositorios encontrados: ${repos.length}\n`);

const author = getGitAuthor(repos);
if (author) {
  console.log(`Autor filtrado: ${author}`);
} else {
  console.log('No se pudo determinar el autor. Mostrando todos los commits.');
}

console.log('\n====================================');
console.log('COMMITS POR REPOSITORIO');
console.log('====================================\n');

let totalCommits = 0;
const commitsByDate = {};

for (const repo of repos) {
  const commits = getCommitsLast30Days(repo, author);

  if (commits.length > 0) {
    console.log(`\n${repo} (${commits.length} commits):`);
    for (const commit of commits.slice(0, 5)) {
      const date = commit.date.split(' ')[0];
      console.log(`  ${date} - ${commit.message.substring(0, 60)}`);

      if (!commitsByDate[date]) {
        commitsByDate[date] = [];
      }
      commitsByDate[date].push({ repo: path.basename(repo), message: commit.message });
    }
    if (commits.length > 5) {
      console.log(`  ... y ${commits.length - 5} commits más`);
    }
    totalCommits += commits.length;
  }
}

console.log('\n====================================');
console.log('RESUMEN POR FECHA');
console.log('====================================\n');

const sortedDates = Object.keys(commitsByDate).sort();
for (const date of sortedDates) {
  const commits = commitsByDate[date];
  console.log(`${date}: ${commits.length} commits`);
  for (const commit of commits.slice(0, 3)) {
    console.log(`  - ${commit.repo}: ${commit.message.substring(0, 50)}`);
  }
  if (commits.length > 3) {
    console.log(`  ... y ${commits.length - 3} más`);
  }
}

console.log('\n====================================');
console.log(`TOTAL COMMITS EN ÚLTIMOS 30 DÍAS: ${totalCommits}`);
console.log('====================================');
