require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const findGitRepos = (rootDir) => {
  const repos = [];
  if (!rootDir || !fs.existsSync(rootDir)) {
    console.log('ERROR: ROOT_DIR no existe o no está configurado.');
    return repos;
  }

  try {
    const items = fs.readdirSync(rootDir, { withFileTypes: true });
    
    const hasGit = items.some(item => item.isDirectory() && item.name === '.git');
    if (hasGit) {
      repos.push(rootDir);
    }
    
    for (const item of items) {
      const fullPath = path.join(rootDir, item.name);
      if (item.isDirectory() && item.name !== '.git') {
        const subRepos = findGitRepos(fullPath);
        repos.push(...subRepos);
      }
    }
  } catch (err) {
    console.log(`Error accediendo a ${rootDir}: ${err.message}`);
  }
  return repos;
};

const getGitAuthor = (repos) => {
  if (process.env.GIT_AUTHOR_EMAIL) {
    return process.env.GIT_AUTHOR_EMAIL;
  }
  
  for (const repo of repos) {
    try {
      const email = execSync('git config user.email', {
        cwd: repo,
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
      `git log --since="${dateStr}" --all ${authorFilter} --format="%H|%ai|%s"`,
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
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
    return [];
  }
};

const rootDir = process.env.ROOT_DIR;
console.log('====================================');
console.log('DIAGNÓSTICO DE COMMITS - ÚLTIMOS 30 DÍAS');
console.log('====================================\n');

console.log('ROOT_DIR:', rootDir);
const repos = findGitRepos(rootDir);
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
