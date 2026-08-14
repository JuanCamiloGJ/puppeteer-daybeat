require('dotenv').config();
const { isConfigured, getDailyActivity, formatActivityForReport, closeConnection } = require('./lib/jira-report.js');

const testJiraReport = async () => {
  console.log('====================================');
  console.log('PRUEBA DE REPORTE DIARIO JIRA');
  console.log('====================================');

  if (!isConfigured()) {
    console.log('ERROR: Falta ATLASSIAN_ENABLED en .env');
    console.log('\nPara configurar (modo OAuth, sin email ni token):');
    console.log('1. Agrega a tu .env:');
    console.log('   ATLASSIAN_ENABLED=true');
    console.log('\nLa primera ejecución abre el navegador para autorizar');
    console.log('(una sola vez, sin depender del admin). El navegador trae todo.');
    console.log('\nAlternativa silenciosa (opcional): sumá ATLASSIAN_EMAIL y');
    console.log('ATLASSIAN_API_TOKEN=<token de https://id.atlassian.com/manage-profile/security/api-tokens>');
    console.log('para usar Basic en vez de OAuth (el MCP oficial exige que la org');
    console.log('habilite el API token, pero REST sigue funcionando igual).');
    return;
  }

  const argDate = process.argv[2];
  const target = argDate || new Date();
  console.log(`Consultando actividad de Jira para: ${target instanceof Date ? target.toLocaleDateString() : target}`);
  console.log('');

  try {
    const activity = await getDailyActivity(target);
    console.log('------------------------------------');
    console.log('RESULTADO');
    console.log('------------------------------------');
    console.log(`JQL usado: ${activity.jql}`);
    console.log('');
    console.log(`Incidencias: ${activity.issues.length}`);
    for (const issue of activity.issues.slice(0, 15)) {
      console.log(`  - ${issue.key}: ${issue.summary || 'Sin resumen'}${issue.status ? ` (${issue.status})` : ''}`);
    }
    console.log(`Comentarios: ${activity.comments.length}`);
    for (const comment of activity.comments.slice(0, 15)) {
      console.log(`  - ${comment.issueKey}: "${comment.body}"`);
    }
    console.log(`Worklogs: ${activity.worklogs.length}`);
    for (const worklog of activity.worklogs.slice(0, 15)) {
      console.log(`  - ${worklog.issueKey}: ${worklog.timeSpent}${worklog.comment ? ` — "${worklog.comment}"` : ''}`);
    }

    console.log('');
    console.log('------------------------------------');
    console.log('TEXTO FORMATEADO PARA EL REPORTE');
    console.log('------------------------------------');
    console.log(formatActivityForReport(activity));
    console.log('');
    console.log('✓ Prueba completada');
  } catch (err) {
    console.log('✗ Error consultando Jira:');
    console.log(err.message);
    console.log('\nPosibles causas:');
    console.log('1. Autorización OAuth expirada (volvé a ejecutar: abre el navegador) o token inválido');
    console.log('2. En modo API token: el admin de la organización no habilitó la autenticación');
    console.log('   por API token en el Rovo MCP Server (los issues fallan pero REST puede funcionar)');
    console.log('3. Sin permisos sobre los proyectos consultados');
    console.log('4. Problema de red o endpoint MCP');
  } finally {
    await closeConnection();
  }
};

testJiraReport();
