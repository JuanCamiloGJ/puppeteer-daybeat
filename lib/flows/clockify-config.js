// Flujo: configuración guiada de Clockify (API key) — compartido por el menú
// "6. Configuración" y el modo 6 de registro (guard). Orientado a usuarios
// no técnicos: se pega la key, se verifica contra la API y solo se persiste
// si es válida (.daybeat-clockify.json, gitignored).

const { exec } = require('child_process');
const prompt = require('../prompt.js');
const clockify = require('../clockify.js');

const CLOCKIFY_SETTINGS_URL = 'https://clockify.me/user/settings';
const MAX_ATTEMPTS = 3;

const openBrowser = (url) => {
  // HEADLESS=true: no abrir ventana del navegador, solo mostrar la URL
  if (process.env.HEADLESS === 'true') {
    console.log(`  Abrí esta URL para generar tu key: ${url}`);
    return;
  }
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, { detached: true, stdio: 'ignore' }, () => {});
};

// Pide la API key, la verifica y la guarda. Devuelve true si quedó conectado
// (o reconectado) y false si se canceló, desconectó o falló la verificación.
const connectClockifyFlow = async () => {
  if (clockify.isConfigured()) {
    console.log(`\n  Estado actual: ${clockify.getStatus()}`);
    const option = await prompt.askSelect({
      message: 'Configuración de Clockify',
      choices: [
        { name: 'Reconectar con otra API key', value: '1' },
        { name: 'Desconectar', value: '2' },
        { name: 'Volver', value: '3' }
      ]
    });
    if (option === '2') {
      clockify.disconnect();
      console.log('  ✓ Clockify desconectado.');
      return false;
    }
    if (option !== '1') return false;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log('\n  Para usar Clockify necesitás una API key (gratis):');
    console.log(`  1. Se abre tu perfil: ${CLOCKIFY_SETTINGS_URL}`);
    console.log('  2. Profile Settings → Advanced → API Key → Generate');
    console.log('  3. Copiá la key y pegalá en la pregunta siguiente');
    openBrowser(CLOCKIFY_SETTINGS_URL);

    const key = (await prompt.ask('Pegá tu API key de Clockify (o Enter para cancelar): ')).trim();
    if (!key) {
      console.log('  Cancelado.');
      return false;
    }

    console.log('  Verificando la key...');
    const result = await clockify.connectWithKey(key);
    if (result.ok) {
      console.log(`  ✓ ${result.message}`);
      return true;
    }
    console.log(`  ✗ ${result.message}`);
    if (attempt < MAX_ATTEMPTS && !(await prompt.askConfirm('¿Desea intentar de nuevo?'))) {
      return false;
    }
  }
  console.log('  No se pudo conectar Clockify.');
  return false;
};

module.exports = {
  connectClockifyFlow,
  CLOCKIFY_SETTINGS_URL
};