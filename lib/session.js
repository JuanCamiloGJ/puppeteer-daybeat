// Contexto compartido de una corrida (ISP). Reemplaza pasar 6 parámetros
// sueltos a cada flujo: los flujos reciben `session` y destructuren solo lo
// que usan.
const createSession = ({ page, browser, company, usernameDaybeat, password, holidays = [] }) => ({
  page,
  browser,
  company,
  usernameDaybeat,
  password,
  holidays
});

module.exports = { createSession };
