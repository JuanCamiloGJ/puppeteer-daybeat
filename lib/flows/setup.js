// Asistente de configuración inicial (.daybeat-config.json). Solo los datos de
// Daybeat son obligatorios; Git, Jira, Clockify e IA son opcionales y pueden
// omitirse. Se ejecuta en el primer arranque (o desde "6. Configuración" en
// modo edición) ANTES de abrir Puppeteer: hasta no completar Daybeat, el resto
// del programa no se habilita.

const prompt = require('../prompt.js');
const appConfig = require('../app-config.js');
const ai = require('../ai-config.js');
const { connectJiraFlow } = require('./jira-config.js');
const { connectClockifyFlow } = require('./clockify-config.js');

const EXIT_AFTER_EMPTY = 3;

const askRequired = async (message, current = '') => {
  const suffix = current ? ` (actual: ${current})` : '';
  let emptyTries = 0;
  let value = (await prompt.ask(`${message}${suffix}: `)).trim();
  while (!value) {
    emptyTries += 1;
    if (emptyTries >= EXIT_AFTER_EMPTY && (await prompt.askConfirm('¿Salir del asistente sin guardar?'))) {
      return null;
    }
    console.log('  Campo obligatorio.');
    value = (await prompt.ask(`${message} (obligatorio): `)).trim();
  }
  return value;
};

const askRequiredPassword = async (message) => {
  let emptyTries = 0;
  let value = await prompt.askPassword(`${message}: `);
  while (!value) {
    emptyTries += 1;
    if (emptyTries >= EXIT_AFTER_EMPTY && (await prompt.askConfirm('¿Salir del asistente sin guardar?'))) {
      return null;
    }
    console.log('  Campo obligatorio.');
    value = await prompt.askPassword(`${message} (obligatorio): `);
  }
  return value;
};

// En modo edición, Enter mantiene el valor actual.
const askEdit = async (message, current) => {
  const value = (await prompt.ask(`${message} (actual: ${current || 'vacío'}): `)).trim();
  return value || current;
};

// Mini-flujo de IA (mismo patrón que el menú "6. Configuración").
const runAIConfig = async () => {
  const provider = await prompt.askSelect({
    message: '¿Qué provider de IA querés usar?',
    choices: [
      { name: 'OpenCode Zen (modelos gratis)', value: 'opencode' },
      { name: 'Gemini', value: 'gemini' }
    ]
  });
  if (!provider) return false;

  if (provider === 'opencode') {
    const detected = ai.detectOpenCodeKey();
    if (detected) {
      console.log(`  ✓ Detectada key de opencode desde:\n    ${detected.source}`);
      if (await prompt.askConfirm('¿Usar esta key?')) {
        ai.saveOpenCodeKey(detected.key, detected.source);
      } else {
        console.log('  IA no configurada.');
        return false;
      }
    } else {
      console.log('\n  No se encontró el auth.json de opencode en esta máquina.');
      console.log(`  Creá tu API key en ${ai.ZEN_SIGNUP_URL} (cuenta gratuita, modelos gratis).`);
      ai.openBrowser(ai.ZEN_SIGNUP_URL);
      const key = (await prompt.ask('Pegá tu API key de OpenCode Zen (Enter para cancelar): ')).trim();
      if (!key) {
        console.log('  IA no configurada.');
        return false;
      }
      ai.saveOpenCodeKey(key, 'manual');
    }
  } else {
    const key = (await prompt.ask('Pegá tu API key de Google Gemini (Enter para cancelar): ')).trim();
    if (!key) {
      console.log('  IA no configurada.');
      return false;
    }
    ai.setGeminiKey(key);
  }

  ai.setActiveProvider(provider);
  console.log(`  ✓ IA configurada con ${provider}.`);
  return true;
};

// Devuelve true si la configuración quedó completa y guardada; false si se
// canceló (el programa no continúa).
const runSetupWizard = async ({ edit = false } = {}) => {
  const current = appConfig.getDaybeat();
  const git = appConfig.getGit();

  console.log('\n========================================');
  console.log(edit ? 'RECONFIGURACIÓN DE LA APLICACIÓN' : 'CONFIGURACIÓN INICIAL');
  console.log('========================================');
  if (!edit) {
    console.log('Completá los datos de Daybeat (obligatorios).');
    console.log('Git, Jira, Clockify e IA son opcionales: podés omitirlos.');
  }

  // 1. Daybeat (obligatorio)
  let link;
  let company;
  let username;
  let password;
  if (edit) {
    link = await askEdit('URL de Daybeat', current.link);
    company = await askEdit('Compañía', current.company);
    username = await askEdit('Usuario de Daybeat', current.username);
    password = await prompt.askPassword('Contraseña de Daybeat (Enter para mantener la actual): ');
    if (!password) password = current.password;
    if (!password) {
      console.log('  Cancelado.');
      return false;
    }
  } else {
    link = await askRequired('URL de Daybeat');
    if (link === null) return false;
    company = await askRequired('Compañía');
    if (company === null) return false;
    username = await askRequired('Usuario de Daybeat');
    if (username === null) return false;
    password = await askRequiredPassword('Contraseña de Daybeat');
    if (password === null) return false;
  }

  // 2. Git (opcional)
  const wantGit = await prompt.askConfirm('¿Querés configurar repositorios Git para los commits?', Boolean(git.rootDir));
  let rootDir = '';
  let authorEmail = '';
  if (wantGit) {
    if (edit) {
      rootDir = await askEdit('Ruta donde buscar repositorios Git', git.rootDir);
      authorEmail = await askEdit('Email del autor de commits (opcional)', git.authorEmail);
    } else {
      rootDir = (await prompt.ask('Ruta donde buscar repositorios Git: ')).trim();
      if (!rootDir) console.log('  Sin ruta Git: no se usarán commits (podés configurarlo después).');
      authorEmail = (await prompt.ask('Email del autor de commits (Enter para omitir): ')).trim();
    }
  }

  // 3. Jira (opcional)
  const wantJira = await prompt.askConfirm('¿Querés conectar Jira (incidencias/comentarios del día)?', appConfig.isJiraEnabled());
  if (wantJira) {
    appConfig.setJiraEnabled(true);
    await connectJiraFlow();
  } else {
    appConfig.setJiraEnabled(false);
  }

  // 4. Clockify (opcional)
  const wantClockify = await prompt.askConfirm('¿Querés conectar Clockify (actividades con horario)?', false);
  if (wantClockify) await connectClockifyFlow();

  // 5. IA (opcional)
  const wantAI = await prompt.askConfirm('¿Querés configurar la generación de resúmenes con IA?', false);
  if (wantAI) await runAIConfig();

  // 6. Preferencias
  const headless = await prompt.askConfirm('¿Ocultar la ventana del navegador (modo silencioso)?', appConfig.getHeadless());

  // 7. Resumen y guardado
  console.log('\n--------------------------------');
  console.log('RESUMEN DE CONFIGURACIÓN');
  console.log('--------------------------------');
  console.log(`  URL Daybeat:  ${link}`);
  console.log(`  Compañía:     ${company}`);
  console.log(`  Usuario:      ${username}`);
  console.log(`  Contraseña:   ${password ? '••••••' : '(vacía)'}`);
  console.log(`  Git:          ${rootDir || 'no configurado'}`);
  console.log(`  Jira:         ${wantJira ? 'activado' : 'desactivado'}`);
  console.log(`  Clockify:     ${wantClockify ? 'activado' : 'desactivado'}`);
  console.log(`  IA:           ${wantAI ? 'activado' : 'desactivado'}`);
  console.log(`  Navegador:    ${headless ? 'oculto' : 'visible'}`);

  const confirmed = await prompt.askConfirm('¿Guardar configuración?', true);
  if (!confirmed) {
    console.log('  Cancelado.');
    return false;
  }

  appConfig.setDaybeat({ link, company, username, password });
  appConfig.setGit({ rootDir, authorEmail });
  appConfig.setHeadless(headless);

  console.log('  ✓ Configuración guardada.');
  if (edit) {
    console.log('  Los cambios de Daybeat y navegador aplican desde la próxima ejecución.');
  }
  return true;
};

module.exports = { runSetupWizard };
