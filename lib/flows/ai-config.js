// Flujo: configuración (menú principal, opción 6): IA y Clockify. No requiere login.

const prompt = require('../prompt.js');
const ai = require('../ai-config.js');
const clockify = require('../clockify.js');
const { connectClockifyFlow } = require('./clockify-config.js');

// ---------------------------------------------------------------------------
// Configuración (menú principal, opción 6): providers de IA, credenciales y
// modelos, y la conexión de Clockify (API key guiada). No requiere login.
// ---------------------------------------------------------------------------

const showAIConfigMenu = async () => {
  let keepRunning = true;
  while (keepRunning) {
    console.log(ai.getStatus());
    console.log(clockify.getStatus());
    console.log('------------------------------------');

    const option = await prompt.askSelect({
      message: 'Configuración',
      choices: [
        { name: 'Cambiar provider IA activo', value: '1' },
        { name: 'Conectar OpenCode Zen (modelos gratis)', value: '2' },
        { name: 'Configurar Gemini (API key)', value: '3' },
        { name: 'Cambiar modelo', value: '4' },
        { name: 'Probar conexión IA', value: '5' },
        { name: 'Conectar Clockify (actividades con horario)', value: '6' },
        { name: 'Volver', value: '7' }
      ]
    });

    if (option === '7') {
      keepRunning = false;
      continue;
    }

    if (option === '1') {
      const names = ai.getProviderNames();
      const choice = await prompt.askSelect({
        message: 'Seleccione provider:',
        choices: names.map((name) => ({
          name: name === 'opencode' ? 'OpenCode Zen (modelos gratis)' : 'Gemini',
          value: name
        }))
      });
      if (choice) {
        ai.setActiveProvider(choice);
        console.log(`  ✓ Provider activo: ${choice}`);
      } else {
        console.log('  Opción inválida.');
      }
    }

    if (option === '2') {
      const detected = ai.detectOpenCodeKey();
      if (detected) {
        console.log(`  ✓ Detectada key de opencode desde:\n    ${detected.source}`);
        const useIt = await prompt.askConfirm('¿Usar esta key?');
        if (useIt) {
          ai.saveOpenCodeKey(detected.key, detected.source);
          ai.setActiveProvider('opencode');
          console.log('  ✓ OpenCode Zen conectado y activo.');
        } else {
          console.log('  Cancelado.');
        }
      } else {
        console.log('\n  No se encontró el auth.json de opencode en esta máquina.');
        console.log(`  Creá tu API key en ${ai.ZEN_SIGNUP_URL} (cuenta gratuita, modelos gratis).`);
        ai.openBrowser(ai.ZEN_SIGNUP_URL);
        const key = (await prompt.ask('Pegá tu API key de OpenCode Zen (o Enter para cancelar): ')).trim();
        if (key) {
          ai.saveOpenCodeKey(key, 'manual');
          ai.setActiveProvider('opencode');
          console.log('  ✓ OpenCode Zen conectado y activo.');
        } else {
          console.log('  Cancelado.');
        }
      }
    }

    if (option === '3') {
      const key = (await prompt.ask('Pegá tu API key de Google Gemini (o Enter para cancelar): ')).trim();
      if (key) {
        ai.setGeminiKey(key);
        console.log('  ✓ API key de Gemini guardada.');
      } else {
        console.log('  Cancelado.');
      }
    }

    if (option === '4') {
      const active = ai.getActiveProvider();
      console.log(`Provider actual: ${active}`);
      let model = null;
      if (active === 'opencode') {
        const zenModels = await ai.getZenModels();
        const freeModels = zenModels.filter(ai.isFreeModel);
        const paidModels = zenModels.filter(m => !ai.isFreeModel(m));
        const choice = await prompt.askSelect({
          message: 'Seleccione modelo:',
          choices: [
            ...freeModels.map((m) => ({ name: m, value: m })),
            ...(paidModels.length > 0 ? [{ name: 'Ver todos los modelos (incluye pagos)', value: '__ALL__' }] : []),
            { name: 'Otro (escribir ID)', value: '__OTHER__' }
          ]
        });
        if (choice === '__ALL__') {
          const choice2 = await prompt.askSelect({
            message: 'Seleccione modelo:',
            choices: paidModels.map((m) => ({ name: m, value: m }))
          });
          if (choice2) model = choice2;
        } else if (choice === '__OTHER__') {
          model = (await prompt.ask('ID del modelo (ej. gpt-5.4-mini): ')).trim();
        } else if (choice) {
          model = choice;
        }
      } else {
        model = (await prompt.ask(`ID del modelo Gemini (actual: ${ai.getModel('gemini')}, Enter para no cambiar): `)).trim();
      }
      if (model) {
        ai.setModel(active, model);
        console.log(`  ✓ Modelo de ${active}: ${model}`);
      } else {
        console.log('  No se cambió el modelo.');
      }
    }

    if (option === '5') {
      console.log('  Probando conexión con la IA...');
      const result = await ai.testConnection();
      if (result.ok) {
        console.log(`  ✓ Conexión OK (${result.provider} · ${result.model}):`);
        console.log(`    ${result.text}`);
      } else {
        console.log(`  ✗ ${result.error}`);
      }
    }

    if (option === '6') {
      await connectClockifyFlow();
    }
  }
};

module.exports = {
  showAIConfigMenu
};
