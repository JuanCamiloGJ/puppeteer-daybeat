// Flujo de autenticación guiada de Jira desde el menú de configuración.

const prompt = require('../prompt.js');
const jira = require('../jira-report.js');

// Autentica y conecta Jira sin consultar actividad ni iniciar el registro.
const connectJiraFlow = async () => {
  console.log(`\n  Estado actual: ${jira.getStatus()}`);

  if (!jira.isConfigured()) {
    console.log('  Jira no está configurado. Agregue ATLASSIAN_ENABLED=true al .env');
    console.log('  o configure ATLASSIAN_EMAIL y ATLASSIAN_API_TOKEN para API token.');
    return false;
  }

  console.log('  Conectando con Jira...');
  const result = await jira.connectJira();
  console.log(result.ok ? `  ✓ ${result.message}` : `  ✗ ${result.message}`);
  return result.ok;
};

const disconnectJiraFlow = async () => {
  console.log(`\n  Estado actual: ${jira.getStatus()}`);
  const confirmed = await prompt.askConfirm('¿Desconectar Jira y limpiar la autorización local?');
  if (!confirmed) {
    console.log('  Cancelado.');
    return false;
  }

  const result = await jira.disconnectJira();
  console.log(result.ok ? `  ✓ ${result.message}` : `  ✗ ${result.message}`);
  return result.ok;
};

module.exports = {
  connectJiraFlow,
  disconnectJiraFlow
};
