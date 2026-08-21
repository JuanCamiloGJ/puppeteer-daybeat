// Capa de interacción con el usuario (DIP): todos los prompts del proyecto
// pasan por acá, nunca por readline directo. Los menús usan @inquirer (flechas,
// filtro, look de app); si la TTY no lo soporta, caen en readline numerado.

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

// Carga dinámica de un paquete @inquirer (ESM-only) desde CommonJS.
const loadPrompt = async (name) => {
  const mod = await import(name);
  return mod.default;
};

// @inquirer requiere raw mode sobre una TTY real. Si no hay TTY (stdin
// redirigido, ej. CI o el planificador de Windows sin consola), falla: usamos
// readline como respaldo en lugar de colgar el proceso.
const isInteractiveTTY = () => !!process.stdin.isTTY;

// sí/no -> boolean. Con TTY usa @inquirer/confirm (flechas o y/n); sin TTY
// lee "si"/"no" y acepta variantes (s, sí, y, yes). Enter usa `fallback`.
const askConfirm = async (question, fallback = false) => {
  if (isInteractiveTTY()) {
    try {
      const confirm = await loadPrompt('@inquirer/confirm');
      const answer = await confirm({ message: question, default: fallback });
      restoreReadline();
      return answer;
    } catch (err) {
      restoreReadline();
    }
  }
  const raw = (await ask(question)).trim().toLowerCase();
  if (raw === '') return fallback;
  return ['si', 'sí', 's', 'y', 'yes'].includes(raw);
};

// Menú seleccionable. choices = [{ name, value }]; devuelve el `value` elegido
// o null si la opción es inválida. Con TTY usa @inquirer/select (flechas +
// filtro por texto); sin TTY, lista numerada + número (comportamiento original).
const askSelect = async ({ message, choices }) => {
  if (isInteractiveTTY()) {
    try {
      const select = await loadPrompt('@inquirer/select');
      const answer = await select({ message, choices, pageSize: 15 });
      restoreReadline();
      return answer;
    } catch (err) {
      restoreReadline();
    }
  }
  console.log('---------------------');
  console.log('OPCIONES DISPONIBLES:');
  console.log('---------------------');
  choices.forEach((item, index) => {
    const label = typeof item === 'object' && item !== null ? item.name : item;
    console.log(`${index + 1}. ${label}`);
  });
  console.log('---------------------');
  const choice = await ask(message || 'Por favor, elige una opción (número): ');
  const index = parseInt(choice) - 1;
  if (index < 0 || index >= choices.length) return null;
  const item = choices[index];
  return typeof item === 'object' && item !== null ? item.value : item;
};

// Selección múltiple (checkbox) con @inquirer, con agrupaciones separadas por
// títulos. groups = [{ title, items: [{name, value}] }]. La primera opción fija
// "Seleccionar todos" marca todo de una. Devuelve los `value` marcados.
const ALL = '__ALL__';

const askCheckbox = async ({ message, groups, pageSize = 12 }) => {
  const { default: checkbox, Separator } = await import('@inquirer/checkbox');
  const choices = [{ name: 'Seleccionar todos', value: ALL }];
  for (const group of groups) {
    if (!group.items || group.items.length === 0) continue;
    choices.push(new Separator(`-- ${group.title} --`));
    choices.push(...group.items);
  }
  const answer = await checkbox({ message, pageSize, choices });
  restoreReadline();
  return answer;
};

module.exports = { ask, askConfirm, askSelect, askCheckbox, ALL, restoreReadline, close };
