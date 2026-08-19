// Helpers compartidos entre flujos: prompt de texto, menú de período,
// festivos del año y la selección interactiva de actividad de Jira.

const prompt = require('../prompt.js');
const { smartTruncate } = require('../summary.js');
const { loadHolidays, saveHolidays } = require('../persistence.js');

const questionUserResponse = async (frame, question) => {
  return prompt.ask(question);
}
// Selección múltiple interactiva de la actividad de Jira (@inquirer/checkbox):
// espacio marca/desmarca, "a" selecciona todos, enter confirma.
// La primera opción "Seleccionar todos" marca todo de una; si no, solo los
// marcados entran al contexto del reporte.
const selectJiraActivityMulti = async (activity) => {
  const groups = [];
  if (activity.issues.length > 0) {
    groups.push({
      title: 'Incidencias',
      items: activity.issues.slice(0, 15).map((issue, i) => ({
        name: `${issue.key}: ${issue.summary || 'Sin resumen'}${issue.status ? ` (${issue.status})` : ''}`,
        value: { kind: 'issue', i }
      }))
    });
  }
  if (activity.comments.length > 0) {
    groups.push({
      title: 'Comentarios',
      items: activity.comments.slice(0, 15).map((comment, i) => ({
        name: `${comment.issueKey}: "${smartTruncate(comment.body, 150)}"${comment.created ? ` (${comment.created.substring(0, 16).replace('T', ' ')})` : ''}`,
        value: { kind: 'comment', i }
      }))
    });
  }
  if (activity.worklogs.length > 0) {
    groups.push({
      title: 'Worklogs',
      items: activity.worklogs.slice(0, 15).map((worklog, i) => ({
        name: `${worklog.issueKey}: ${worklog.timeSpent}${worklog.comment ? ` — "${smartTruncate(worklog.comment, 150)}"` : ''}`,
        value: { kind: 'worklog', i }
      }))
    });
  }

  const answer = await prompt.askCheckbox({
    message: 'Seleccione la actividad de Jira a incluir (espacio: marcar, a: todos, enter: confirmar):',
    groups
  });

  if (answer.includes(prompt.ALL)) {
    return activity;
  }

  const filtered = { ...activity, issues: [], comments: [], worklogs: [] };
  for (const sel of answer) {
    if (sel.kind === 'issue') filtered.issues.push(activity.issues[sel.i]);
    else if (sel.kind === 'comment') filtered.comments.push(activity.comments[sel.i]);
    else filtered.worklogs.push(activity.worklogs[sel.i]);
  }
  return filtered;
}
// Menú de período compartido por "Ver días sin registro" y "Registro masivo".
const askPeriod = async (action) => {
  const periods = [
    { name: 'Último mes', value: { days: 30, label: '1 mes' } },
    { name: 'Últimos 2 meses', value: { days: 60, label: '2 meses' } },
    { name: 'Últimos 3 meses', value: { days: 90, label: '3 meses' } },
    { name: 'Últimos 15 días', value: { days: 15, label: '15 días' } },
    { name: 'Últimos 7 días', value: { days: 7, label: '7 días' } }
  ];
  const selected = (await prompt.askSelect({
    message: `Seleccione el período a ${action}:`,
    choices: periods
  })) || periods[0].value;
  console.log(`\nPeríodo seleccionado: ${selected.label}`);
  return selected;
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

  if (await prompt.askConfirm('¿Desea ingresar los festivos del año actual?')) {
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

module.exports = {
  questionUserResponse,
  selectJiraActivityMulti,
  askPeriod,
  checkHolidaysYear
};
