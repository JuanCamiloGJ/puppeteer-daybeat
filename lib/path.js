// Resolución de rutas WSL/Windows y normalización UNC <-> Linux.

const { execSync } = require('child_process');
const fs = require('fs');

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

module.exports = { resolveRootDir, toLinuxPath };
