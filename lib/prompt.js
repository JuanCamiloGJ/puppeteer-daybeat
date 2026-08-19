// Capa de interacción con el usuario (DIP): todos los prompts del proyecto
// pasan por acá, nunca por readline directo. La implementación actual usa
// readline (comportamiento idéntico al original); las de @inquirer se suman
// por tipo (select/confirm/input/date) sin tocar los flujos que las consumen.

const readline = require('readline');

// Configurar readline para leer la entrada del usuario
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// @inquirer/checkbox toma control de stdin y al terminar lo deja PAUSADO:
// sin resume() el stream no emite 'data' y rl.question queda colgado.
// No recrear el readline: el listener 'data' del interface existente sigue
// registrado y recrearlo reactiva raw mode innecesariamente.
const restoreReadline = () => {
  try { process.stdin.setRawMode(false); } catch (err) { /* no TTY */ }
  process.stdin.resume();
};

// Pregunta de texto libre. Devuelve exactamente lo que tipea el usuario (sin
// trim): comportamiento idéntico al rl.question original.
const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

// Cierra la interfaz de lectura (equivalente al rl.close() original). Se usa
// para terminar el programa sin dejar el stdin escuchando.
const close = () => rl.close();

module.exports = { ask, restoreReadline, close };
