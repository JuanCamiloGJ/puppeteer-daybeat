require('dotenv').config();
const puppeteer = require('puppeteer');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');


// Configurar readline para leer la entrada del usuario
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Funciones auxiliares.

const listElements = async (frame, selector) => {
  await frame.waitForSelector(selector);
  // Listar todos los links dentro del frame
  const links = await frame.$$eval(selector, elements =>
    elements.map(el => ({
      href: el.href,
      text: el.textContent.trim(),
      value: el.value
    }))
  );
  // Mostrar opciones al usuario
  console.log('---------------------');
  console.log('OPCIONES DISPONIBLES:');
  console.log('---------------------');
  links.forEach((item, index) => {
    console.log(`${index + 1}. ${item.text}`);
  });
  console.log('---------------------');

  return links;
}

const whriteAndNavigateElementSelect = async (frame, selector, links) => {
  // Pedir al usuario que elija una opción
  return rl.question('Por favor, elige una opción (número): ', async (choice) => {
    const index = parseInt(choice) - 1;

    if (index >= 0 && index < links.length) {
      // Interactuar con la opción seleccionada
      const selectedItem = links[index];
      // Encontrar y hacer clic en el elemento seleccionado
      const linkHandle = await frame.evaluateHandle((text, selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.find(el => el.textContent.trim() === text); // Comparación exacta
      }, selectedItem.text, selector);  // Pasando `selectedItem.text` al contexto de `evaluateHandle`

      if (linkHandle) {
        await frame.evaluate(el => el.click(), linkHandle);
      }

    } else {
      console.log('Opción inválida.');
    }

    // Cerrar readline
    // rl.close();
  });
}

const whriteAndNavigateOtherElementSelect = async (frame, selector, links) => {
  // Pedir al usuario que elija una opción
  return rl.question('Por favor, elige una opción (número): ', async (choice) => {
    const index = parseInt(choice) - 1;

    if (index >= 0 && index < links.length) {
      // Interactuar con la opción seleccionada
      const selectedItem = links[index];

      // Encontrar y hacer clic en el elemento seleccionado
      const linkHandle = await frame.evaluateHandle((text, selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        const elementSelect = elements.find(el => el.textContent.trim() === text); // Comparación exacta

        if (elementSelect) {
          console.log("Primer <a> encontrado:", elementSelect.textContent);
          // Subir al abuelo (tr) del primer <a>
          const parentTd = elementSelect.parentElement;  // Subir al <td> padre
          const grandParentTr = parentTd.parentElement; // Subir al <tr> abuelo

          // Encontrar el último <a> en ese mismo <tr>
          const allLinksInRow = Array.from(grandParentTr.querySelectorAll('td > a'));

          // validar de que haya al menos dos enlaces para seleccionar el penúltimo
          if (allLinksInRow.length >= 2) {
            const penultimateLink = allLinksInRow[allLinksInRow.length - 2]; // Seleccionar el penúltimo <a>
            return penultimateLink;
          }
        }

        return null;  // Si no se encontró el primer <a> o no hay suficientes enlaces

      }, selectedItem.text, selector);  // Pasando `selectedItem.text` al contexto de `evaluateHandle`

      console.log('Haciendo clic en la opción seleccionada...');

      // Verifica si se encontró el penúltimo enlace para hacer clic
      if (linkHandle) {
        // console.log("Penúltimo <a> encontrado, haciendo clic...");
        await linkHandle.click();
      } else {
        console.log("No se encontró el <a> correspondiente o no hay suficientes enlaces.");
      }

    } else {
      console.log('Opción inválida.');
    }

    // Cerrar readline
    // rl.close();
  });
}

const selectOptionSelector = async (frame, selector, links) => {
  return new Promise((resolve) => {
    // Pedir al usuario que elija una opción
    rl.question('Por favor, elige una opción (número): ', async (choice) => {
      const index = parseInt(choice) - 1;

      if (index >= 0 && index < links.length) {
        // Interactuar con la opción seleccionada
        const selectedItem = links[index];
        // console.log(`Seleccionaste: `, selectedItem.text);
        // Encontrar y seleccionar el elemento seleccionado.
        await frame.select(selector, selectedItem.value); // Selecciona la opción
        resolve(); // Resuelve la promesa una vez que la selección se realiza
      } else {
        console.log('Opción inválida.');
        resolve(); // También resuelve aunque la opción sea inválida para continuar el flujo
      }
    });
  });
};

const whriteInput = async (frame, selector, title) => {
  return new Promise((resolve) => {
    // Pedir al usuario que elija una opción
    console.log("-------------------------");
    console.log(title);
    console.log("-------------------------");
    rl.question("", async (choice) => {
      // escribir el input con lo diligenciado por el usuario.
      await frame.type(selector, choice);
      resolve();
    });
  });
}

const questionUserResponse = async (frame, question) => {
  return new Promise((resolve) => {
    // Pedir al usuario que elija una opción
    rl.question(question, async (choice) => {
      resolve(choice);
    });
  });
}

// Funciones de automatización basadas en commits

const findGitRepos = (rootDir) => {
  const repos = [];
  if (!rootDir || !fs.existsSync(rootDir)) {
    console.log('ERROR: ROOT_DIR no existe o no está configurado.');
    return repos;
  }

  try {
    const items = fs.readdirSync(rootDir, { withFileTypes: true });
    
    const hasGit = items.some(item => item.isDirectory() && item.name === '.git');
    if (hasGit) {
      repos.push(rootDir);
    }
    
    for (const item of items) {
      const fullPath = path.join(rootDir, item.name);
      if (item.isDirectory() && item.name !== '.git') {
        const subRepos = findGitRepos(fullPath);
        repos.push(...subRepos);
      }
    }
  } catch (err) {
    console.log(`Error accediendo a ${rootDir}: ${err.message}`);
  }
  return repos;
};

const getGitAuthor = (repos) => {
  if (process.env.GIT_AUTHOR_EMAIL) {
    return process.env.GIT_AUTHOR_EMAIL;
  }
  
  for (const repo of repos) {
    try {
      const email = execSync('git config user.email', {
        cwd: repo,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      if (email) return email;
    } catch (err) {
      continue;
    }
  }
  
  return null;
};

const getTodayCommits = (repoPath, author = null) => {
  try {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day} 00:00:00`;
    
    const authorFilter = author ? `--author="${author}"` : '';
    const result = execSync(
      `git log --since="${dateStr}" --all ${authorFilter} --format="%s"`,
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const commits = result.trim().split('\n').filter(msg => msg.length > 0);
    console.log(`  ${repoPath}: ${commits.length} commits hoy (${dateStr})`);
    return commits;
  } catch (err) {
    console.log(`  ${repoPath}: Error al obtener commits de hoy`);
    return [];
  }
};

const getRecentCommits = (repoPath, days = 7, author = null) => {
  try {
    const today = new Date();
    const pastDate = new Date(today.getTime() - (days * 24 * 60 * 60 * 1000));
    const year = pastDate.getFullYear();
    const month = String(pastDate.getMonth() + 1).padStart(2, '0');
    const day = String(pastDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    
    const authorFilter = author ? `--author="${author}"` : '';
    const result = execSync(
      `git log --since="${dateStr}" --all ${authorFilter} --format="%s"`,
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const commits = result.trim().split('\n').filter(msg => msg.length > 0);
    console.log(`  ${repoPath}: ${commits.length} commits encontrados (${dateStr})`);
    return commits;
  } catch (err) {
    console.log(`  ${repoPath}: Error al obtener commits`);
    return [];
  }
};

const getCommitsForDate = (repoPath, dateStr, author = null) => {
  try {
    const [day, month, year] = dateStr.split('/');
    const targetDate = `${year}-${month}-${day}`;
    const nextDate = new Date(`${year}-${month}-${day}`);
    nextDate.setDate(nextDate.getDate() + 1);
    const nextDateStr = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
    
    const authorFilter = author ? `--author="${author}"` : '';
    const result = execSync(
      `git log --since="${targetDate}" --until="${nextDateStr}" --all ${authorFilter} --format="%s"`,
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const commits = result.trim().split('\n').filter(msg => msg.length > 0);
    console.log(`  ${repoPath}: ${commits.length} commits (${targetDate})`);
    return commits;
  } catch (err) {
    return [];
  }
};

const getRecentCommitsBeforeDate = (repoPath, dateStr, days = 5, author = null) => {
  try {
    const [day, month, year] = dateStr.split('/');
    const targetDate = new Date(`${year}-${month}-${day}`);
    const pastDate = new Date(targetDate.getTime() - (days * 24 * 60 * 60 * 1000));
    const pastDateStr = `${pastDate.getFullYear()}-${String(pastDate.getMonth() + 1).padStart(2, '0')}-${String(pastDate.getDate()).padStart(2, '0')}`;
    const targetDateStr = `${year}-${month}-${day}`;
    
    const authorFilter = author ? `--author="${author}"` : '';
    const result = execSync(
      `git log --since="${pastDateStr}" --until="${targetDateStr}" --all ${authorFilter} --format="%s|%ad" --date=short`,
      { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const commits = result.trim().split('\n').filter(msg => msg.length > 0).map(line => {
      const [message, date] = line.split('|');
      return { message, date };
    });
    console.log(`  ${repoPath}: ${commits.length} commits (${pastDateStr} a ${targetDateStr})`);
    return commits;
  } catch (err) {
    return [];
  }
};

const getRotatedCommits = (commitsWithDates, targetDateStr) => {
  if (commitsWithDates.length === 0) return [];
  
  const [day, month, year] = targetDateStr.split('/');
  const targetDate = new Date(`${year}-${month}-${day}`);
  const dayOfWeek = targetDate.getDay();
  
  const sortedCommits = [...commitsWithDates].sort((a, b) => {
    const dateA = new Date(a.date);
    const dateB = new Date(b.date);
    return dateB - dateA;
  });
  
  const uniqueDates = [...new Set(sortedCommits.map(c => c.date))];
  
  let selectedDate;
  switch (dayOfWeek) {
    case 1: selectedDate = uniqueDates[0]; break;
    case 2: selectedDate = uniqueDates[1] || uniqueDates[0]; break;
    case 3: selectedDate = uniqueDates[2] || uniqueDates[1] || uniqueDates[0]; break;
    case 4:
      const date1 = uniqueDates[0];
      const date2 = uniqueDates[1] || uniqueDates[0];
      return sortedCommits.filter(c => c.date === date1 || c.date === date2).map(c => c.message);
    case 5: selectedDate = uniqueDates[0]; break;
    default: selectedDate = uniqueDates[0]; break;
  }
  
  return sortedCommits.filter(c => c.date === selectedDate).map(c => c.message);
};

const getContextPrefix = (targetDateStr, commitsWithDates) => {
  if (commitsWithDates.length === 0) return '';
  
  const [day, month, year] = targetDateStr.split('/');
  const targetDate = new Date(`${year}-${month}-${day}`);
  
  const commitDates = commitsWithDates.map(c => new Date(c.date));
  const mostRecentCommit = new Date(Math.max(...commitDates));
  
  const daysDiff = Math.floor((targetDate - mostRecentCommit) / (1000 * 60 * 60 * 24));
  
  if (daysDiff === 0) return '';
  if (daysDiff === 1) return 'Continuación de: ';
  if (daysDiff <= 3) return 'Seguimiento de: ';
  if (daysDiff <= 5) return 'Avance en: ';
  return 'Trabajo en: ';
};

const generateGenericText = (targetDateStr) => {
  const [day, month, year] = targetDateStr.split('/');
  const targetDate = new Date(`${year}-${month}-${day}`);
  const dayOfWeek = targetDate.getDay();
  
  const genericTexts = {
    1: {
      titles: [
        "Inicio de semana: revisión de código y planificación",
        "Lunes: análisis de requerimientos y organización del sprint",
        "Revisión de pendientes y planificación de tareas de la semana"
      ],
      details: [
        "Inicio de semana laboral. Revisión de código pendiente, planificación de tareas para el sprint actual y organización de prioridades. Análisis de requerimientos pendientes y coordinación con el equipo.",
        "Lunes de planificación. Revisión de tareas pendientes del sprint anterior, análisis de nuevos requerimientos y organización del trabajo para la semana. Coordinación con el equipo de desarrollo.",
        "Inicio de semana enfocado en revisión y planificación. Análisis de código pendiente, actualización de documentación y organización de tareas prioritarias para el sprint actual."
      ]
    },
    2: {
      titles: [
        "Desarrollo de funcionalidades y pruebas unitarias",
        "Implementación de mejoras y correcciones menores",
        "Avance en tareas de desarrollo y refactorización"
      ],
      details: [
        "Martes de desarrollo activo. Implementación de funcionalidades pendientes, escritura de pruebas unitarias y corrección de errores menores. Refactorización de código para mejorar mantenibilidad.",
        "Continuación de desarrollo. Implementación de mejoras solicitadas, corrección de bugs reportados y avance en tareas del sprint. Pruebas unitarias para nuevas funcionalidades.",
        "Día enfocado en desarrollo y refactorización. Implementación de mejoras de código, optimización de consultas y avance en tareas pendientes. Revisión de calidad de código."
      ]
    },
    3: {
      titles: [
        "Continuación de desarrollo y pruebas de integración",
        "Avance en implementación y revisión de código",
        "Desarrollo de features y ajustes de rendimiento"
      ],
      details: [
        "Miércoles de desarrollo continuo. Avance en implementación de features, pruebas de integración y revisión de código con el equipo. Ajustes de rendimiento y optimización de consultas.",
        "Continuación de tareas de desarrollo. Implementación de funcionalidades complejas, pruebas de integración y revisión de pull requests. Ajustes menores basados en feedback del equipo.",
        "Día de avance significativo en desarrollo. Implementación de features críticas, pruebas de integración y optimización de rendimiento. Revisión de código y documentación técnica."
      ]
    },
    4: {
      titles: [
        "Finalización de features y pruebas de calidad",
        "Cierre de tareas pendientes y ajustes finales",
        "Desarrollo completado y preparación para deploy"
      ],
      details: [
        "Jueves de cierre de tareas. Finalización de features en desarrollo, pruebas de calidad y preparación para integración. Ajustes finales basados en revisión de código y feedback del equipo.",
        "Cierre de tareas pendientes. Completación de features, pruebas exhaustivas y ajustes finales. Preparación de código para deploy y actualización de documentación técnica.",
        "Día enfocado en finalizar tareas. Completación de desarrollo pendiente, pruebas de calidad y ajustes de último momento. Preparación para integración y deploy."
      ]
    },
    5: {
      titles: [
        "Cierre de semana: finalización y documentación",
        "Viernes: cierre de tareas y actualización de documentación",
        "Finalización de sprint y preparación para revisión"
      ],
      details: [
        "Cierre de semana laboral. Finalización de tareas pendientes, actualización de documentación técnica y preparación para revisión de sprint. Limpieza de código y organización para la próxima semana.",
        "Viernes de cierre. Completación de tareas del sprint, actualización de documentación y preparación para revisión semanal. Organización de pendientes para la próxima semana.",
        "Cierre de semana enfocado en finalización. Completación de features, actualización de documentación y preparación para revisión de sprint. Limpieza de código y organización de tareas."
      ]
    }
  };
  
  const dayTexts = genericTexts[dayOfWeek] || genericTexts[2];
  const randomIndex = Math.floor(Math.random() * dayTexts.titles.length);
  
  return {
    title: dayTexts.titles[randomIndex],
    detail: dayTexts.details[randomIndex]
  };
};

const categorizeCommits = (commits) => {
  const categories = {
    feat: [],
    fix: [],
    refactor: [],
    docs: [],
    test: [],
    chore: [],
    other: []
  };
  
  for (const commit of commits) {
    const match = commit.match(/^(feat|fix|refactor|docs|test|chore)(\(.*\))?:\s*(.*)/i);
    if (match) {
      const type = match[1].toLowerCase();
      const message = match[3] || commit;
      categories[type].push(message);
    } else {
      categories.other.push(commit);
    }
  }
  
  return categories;
};

const generateStructuredSummary = (categories) => {
  const parts = [];
  
  if (categories.feat.length > 0) {
    const items = categories.feat.slice(0, 2).join(', ');
    parts.push(`Implementación de: ${items}`);
  }
  
  if (categories.fix.length > 0) {
    const items = categories.fix.slice(0, 1).join(', ');
    parts.push(`Correcciones: ${items}`);
  }
  
  if (categories.refactor.length > 0) {
    const items = categories.refactor.slice(0, 1).join(', ');
    parts.push(`Refactorización: ${items}`);
  }
  
  if (categories.docs.length > 0) {
    const items = categories.docs.slice(0, 1).join(', ');
    parts.push(`Documentación: ${items}`);
  }
  
  if (categories.test.length > 0) {
    const items = categories.test.slice(0, 1).join(', ');
    parts.push(`Pruebas: ${items}`);
  }
  
  if (categories.chore.length > 0) {
    const items = categories.chore.slice(0, 1).join(', ');
    parts.push(`Mantenimiento: ${items}`);
  }
  
  if (categories.other.length > 0 && parts.length === 0) {
    const items = categories.other.slice(0, 3).join('. ');
    parts.push(items);
  }
  
  let summary = parts.join('. ');
  if (summary.length > 100) {
    summary = summary.substring(0, 97) + '...';
  }
  
  return summary;
};

const generateDetail = (commits) => {
  if (commits.length === 0) return 'Actividad de desarrollo: revisión de código, pruebas y ajustes menores.';
  
  const unique = [...new Set(commits)];
  const categories = categorizeCommits(unique);
  const parts = [];
  
  if (categories.feat.length > 0) {
    const items = categories.feat.slice(0, 3).join(', ');
    parts.push(`Desarrollo de funcionalidades: ${items}.`);
  }
  
  if (categories.fix.length > 0) {
    const items = categories.fix.slice(0, 2).join(', ');
    parts.push(`Corrección de errores: ${items}.`);
  }
  
  if (categories.refactor.length > 0) {
    const items = categories.refactor.slice(0, 2).join(', ');
    parts.push(`Mejoras de código: ${items}.`);
  }
  
  if (categories.docs.length > 0) {
    const items = categories.docs.slice(0, 2).join(', ');
    parts.push(`Actualización de documentación: ${items}.`);
  }
  
  if (categories.test.length > 0) {
    const items = categories.test.slice(0, 2).join(', ');
    parts.push(`Pruebas implementadas: ${items}.`);
  }
  
  if (categories.chore.length > 0) {
    const items = categories.chore.slice(0, 2).join(', ');
    parts.push(`Tareas de mantenimiento: ${items}.`);
  }
  
  if (categories.other.length > 0 && parts.length === 0) {
    const items = categories.other.slice(0, 5).join('. ');
    parts.push(items);
  }
  
  let detail = parts.join(' ');
  if (detail.length > 500) {
    detail = detail.substring(0, 497) + '...';
  }
  
  return detail;
};

const summarizeCommits = (commits) => {
  if (commits.length === 0) return '';
  
  const unique = [...new Set(commits)];
  const categories = categorizeCommits(unique);
  return generateStructuredSummary(categories);
};

const generateFakeSummary = (commits) => {
  if (commits.length === 0) return 'Actividad de desarrollo: revisión de código, pruebas y ajustes menores.';
  
  const unique = [...new Set(commits)];
  const categories = categorizeCommits(unique);
  return generateStructuredSummary(categories);
};

const generateWithGemini = async (commits, context = 'same-day', targetDate = null) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
  
  if (!apiKey) {
    return null;
  }
  
  if (!commits || commits.length === 0) {
    return null;
  }
  
  const commitsText = commits.join('\n');
  
  let contextInstruction = '';
  if (context === 'continuation') {
    contextInstruction = '\n\nIMPORTANTE: Estos commits son de días anteriores (no del día que se está registrando). Genera la descripción indicando que se CONTINÚA con el trabajo de días previos, usando frases como "Continuación de...", "Seguimiento de...", "Avance en...". No digas que se hizo hoy, sino que se continúa trabajando en ello.';
  } else if (context === 'follow-up') {
    contextInstruction = '\n\nIMPORTANTE: Estos commits son de días anteriores. Genera la descripción indicando que se da SEGUIMIENTO a tareas recientes, usando frases como "Seguimiento de...", "Trabajo en...", "Continuación de tareas de...". No digas que se hizo hoy, sino que se da seguimiento.';
  } else if (context === 'no-commits') {
    contextInstruction = '\n\nIMPORTANTE: No hay commits disponibles. Genera una descripción genérica pero variada de actividad de desarrollo según el día de la semana. Evita usar siempre el mismo texto.';
  }
  
  const dateInfo = targetDate ? `\nDía a registrar: ${targetDate}` : '';
  
  const prompt = `Eres un asistente que ayuda a generar descripciones de actividades laborales para un sistema de registro de tiempo.

Basándote en los siguientes commits de git, genera:
1. Un título corto (máximo 100 caracteres) que resuma la actividad
2. Una descripción detallada (máximo 500 caracteres) que explique el trabajo realizado
${dateInfo}
Commits:
${commitsText}
${contextInstruction}

Responde SOLO en formato JSON válido, sin texto adicional:
{"title": "título corto aquí", "detail": "descripción detallada aquí"}`;
  
  const maxRetries = 4;
  const baseDelay = 2000; // 2 segundos
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';
      console.log(`  [IA] Usando modelo: ${model}`);
      console.log(`  [IA] Intento ${attempt}/${maxRetries}...`);
      
      const startTime = Date.now();
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          model: model,
          input: prompt
        }),
        signal: AbortSignal.timeout(60000)
      });
      
      const responseTime = Date.now() - startTime;
      console.log(`  [IA] Respuesta recibida en ${responseTime}ms`);
      
      if (!response.ok) {
        const errorBody = await response.text();
        console.log(`  [IA] Error en API: ${response.status}`);
        console.log(`  [IA] Detalle: ${errorBody.substring(0, 200)}`);
        
        // Retry solo para errores 503 (Service Unavailable)
        if (response.status === 503 && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.log(`  [IA] Reintentando en ${delay/1000}s...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        
        return null;
      }
      
      const data = await response.json();
      
      // Buscar el step con type === "model_output"
      const outputStep = data.steps?.find(step => step.type === 'model_output');
      const text = outputStep?.content?.[0]?.text;
      
      if (!text) {
        console.log('  [IA] Respuesta vacía de Gemini');
        return null;
      }
      
      // Intentar parsear JSON de la respuesta
      let result;
      try {
        // Buscar JSON en la respuesta (puede tener texto adicional)
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[0]);
        } else {
          console.log('  [IA] No se encontró JSON válido en la respuesta');
          return null;
        }
      } catch (parseErr) {
        console.log('  [IA] Error parseando JSON:', parseErr.message);
        return null;
      }
      
      if (!result.title || !result.detail) {
        console.log('  [IA] Respuesta incompleta');
        return null;
      }
      
      // Limitar longitud
      let title = result.title;
      let detail = result.detail;
      
      if (title.length > 100) {
        title = title.substring(0, 97) + '...';
      }
      if (detail.length > 500) {
        detail = detail.substring(0, 497) + '...';
      }
      
      return { title, detail };
      
    } catch (err) {
      console.log(`  [IA] Error en intento ${attempt}: ${err.message}`);
      
      // Retry para errores de timeout o red
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`  [IA] Reintentando en ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      return null;
    }
  }
  
  return null;
};

const HISTORY_FILE = path.join(__dirname, '.daybeat-history.json');

const getLastUsedHours = () => {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      return { start: data.startTime || '0730', end: data.endTime || '1630' };
    }
  } catch (err) {
    // Si hay error, usar defaults
  }
  return { start: '0730', end: '1630' };
};

const saveHours = (startTime, endTime) => {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify({ startTime, endTime }, null, 2));
  } catch (err) {
    console.log('No se pudo guardar el horario.');
  }
};

const getBusinessDays = (startDate, endDate) => {
  const businessDays = [];
  const current = new Date(startDate);
  
  while (current <= endDate) {
    const dayOfWeek = current.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const dd = String(current.getDate()).padStart(2, '0');
      const mm = String(current.getMonth() + 1).padStart(2, '0');
      const yyyy = current.getFullYear();
      businessDays.push(`${dd}/${mm}/${yyyy}`);
    }
    current.setDate(current.getDate() + 1);
  }
  
  return businessDays;
};

const getMissingRegistrations = (existingDates, businessDays) => {
  return businessDays.filter(day => !existingDates.includes(day));
};

const extractRegistrations = async (frameTree, startDate = null) => {
  try {
    const allDates = [];
    let currentPage = 1;
    let hasNextPage = true;
    const MAX_PAGES = 5; // Límite de 5 páginas máximo
    
    // Convertir startDate a formato comparable (DD/MM/YYYY -> timestamp)
    let startTimestamp = null;
    if (startDate) {
      const [dd, mm, yyyy] = startDate.split('/');
      startTimestamp = new Date(`${yyyy}-${mm}-${dd}`).getTime();
    }
    
    while (hasNextPage && currentPage <= MAX_PAGES) {
      console.log(`      [DEBUG] Extrayendo página ${currentPage}...`);
      const registrations = await frameTree.evaluate(() => {
        const dates = [];
        const tables = document.querySelectorAll('table');
        
        for (const table of tables) {
          const headerRow = table.querySelector('tr');
          if (!headerRow) continue;
          
          const headers = Array.from(headerRow.querySelectorAll('td, th')).map(h => h.textContent.trim());
          const fechaIndex = headers.findIndex(h => h.includes('Fecha Transacción'));
          
          if (fechaIndex === -1) continue;
          
          const rows = table.querySelectorAll('tr');
          for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length > fechaIndex) {
              const fechaText = cells[fechaIndex].textContent.trim();
              const match = fechaText.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
              if (match) {
                const year = match[1];
                const month = match[2].padStart(2, '0');
                const day = match[3].padStart(2, '0');
                dates.push(`${day}/${month}/${year}`);
              }
            }
          }
        }
        
        return dates;
      });
      
      console.log(`      [DEBUG] Página ${currentPage}: ${registrations.length} fechas encontradas`);
      if (registrations.length > 0) {
        console.log(`      [DEBUG] Fechas: ${registrations.join(', ')}`);
      }
      
      // Filtrar fechas y verificar si debemos detener la paginación
      let allDatesOutOfRange = true;
      
      for (const dateStr of registrations) {
        const [dd, mm, yyyy] = dateStr.split('/');
        const dateTimestamp = new Date(`${yyyy}-${mm}-${dd}`).getTime();
        
        // Si no hay startDate, agregar todas las fechas
        if (!startTimestamp) {
          allDates.push(dateStr);
          allDatesOutOfRange = false;
        } else {
          // Solo agregar fechas dentro del rango
          if (dateTimestamp >= startTimestamp) {
            allDates.push(dateStr);
            allDatesOutOfRange = false;
          }
        }
      }
      
      // Si todas las fechas de esta página están fuera del rango, detener paginación
      if (startTimestamp && registrations.length > 0 && allDatesOutOfRange) {
        console.log(`      [DEBUG] Todas las fechas están fuera del rango, deteniendo paginación`);
        break;
      }
      
      // Buscar el enlace de "siguiente página" de transacciones
      // Daybeat usa imágenes: 3up.gif (siguiente), 3dw.gif (siguiente), 3regresar.gif (regresar)
      // El enlace correcto tiene page_trans=N donde N > 0 para páginas siguientes
      const nextPageLink = await frameTree.evaluate((currentPageNum) => {
        const links = Array.from(document.querySelectorAll('a'));
        
        // Primero: buscar enlaces con imágenes de paginación que NO sean "regresar"
        for (const link of links) {
          const img = link.querySelector('img');
          if (!img) continue;
          
          const imgSrc = img.src.toLowerCase();
          
          // Excluir imágenes de regresar/volver
          if (imgSrc.includes('regresar') || imgSrc.includes('back') || imgSrc.includes('return')) {
            continue;
          }
          
          // Buscar imágenes de paginación de transacciones (3up.gif, 3dw.gif, next, forward)
          const isPaginationImage = imgSrc.includes('3up.gif') || 
                                    imgSrc.includes('3dw.gif') ||
                                    imgSrc.includes('next') ||
                                    imgSrc.includes('forward');
          
          if (!isPaginationImage) continue;
          
          // Verificar que el enlace tenga page_trans=N donde N es la página siguiente
          const href = link.href;
          const pageTransMatch = href.match(/page_trans=(\d+)/);
          if (pageTransMatch) {
            const pageTransNum = parseInt(pageTransMatch[1]);
            // page_trans > 0 significa que hay más páginas
            if (pageTransNum > 0) {
              return { href: href, imgSrc: img.src, type: 'image_page_trans' };
            }
          }
        }
        
        // Segundo: buscar enlaces con texto de paginación
        for (const link of links) {
          const text = link.textContent.trim();
          if (text.includes('Siguiente') || text === '>>' || text === '>' || text.includes('Next')) {
            return { href: link.href, text: text, type: 'text' };
          }
        }
        
        return null;
      }, currentPage);
      
      if (nextPageLink) {
        console.log(`      [DEBUG] Siguiente página encontrada:`);
        console.log(`      [DEBUG]   Tipo: ${nextPageLink.type}`);
        console.log(`      [DEBUG]   Href: ${nextPageLink.href}`);
        if (nextPageLink.imgSrc) {
          console.log(`      [DEBUG]   Imagen: ${nextPageLink.imgSrc}`);
        }
        
        await frameTree.evaluate((href) => {
          window.location.href = href;
        }, nextPageLink.href);
        await frameTree.waitForNavigation();
        await delay(1500);
        currentPage++;
      } else {
        console.log(`      [DEBUG] No hay más páginas`);
        hasNextPage = false;
      }
    }
    
    if (currentPage > MAX_PAGES) {
      console.log(`      [DEBUG] ADVERTENCIA: Se alcanzó el límite de ${MAX_PAGES} páginas`);
    }
    
    const uniqueDates = [...new Set(allDates)];
    console.log(`      [DEBUG] Total fechas únicas extraídas: ${uniqueDates.length}`);
    return uniqueDates;
  } catch (err) {
    console.log('Error extrayendo registros:', err.message);
    return [];
  }
};

const inspectTableStructure = async (frameTree) => {
  try {
    const structure = await frameTree.evaluate(() => {
      const tables = document.querySelectorAll('table');
      if (tables.length === 0) return 'No se encontraron tablas';
      
      const result = [`Total de tablas encontradas: ${tables.length}\n`];
      
      for (let t = 0; t < tables.length; t++) {
        const table = tables[t];
        const rows = table.querySelectorAll('tr');
        result.push(`=== TABLA ${t} (${rows.length} filas) ===`);
        
        for (let i = 0; i < Math.min(10, rows.length); i++) {
          const cells = rows[i].querySelectorAll('td, th');
          const rowData = Array.from(cells).map(cell => {
            const text = cell.textContent.trim();
            return text.substring(0, 20) || '[vacío]';
          });
          result.push(`  Fila ${i}: ${rowData.join(' | ')}`);
        }
        result.push('');
      }
      
      return result.join('\n');
    });
    
    console.log('Estructura de las tablas:');
    console.log(structure);
  } catch (err) {
    console.log('Error inspeccionando tablas:', err.message);
  }
};

const showMissingRegistrations = async (page, browser, company, usernameDaybeat, password) => {
  console.log('====================================');
  console.log('CONSULTANDO DÍAS SIN REGISTRO');
  console.log('====================================');
  
  console.log('\nSeleccione el período a consultar:');
  console.log('1. Último mes');
  console.log('2. Últimos 2 meses');
  console.log('3. Últimos 3 meses');
  
  const periodOption = await new Promise((resolve) => {
    rl.question('Seleccione opción (1/2/3): ', (answer) => {
      resolve(answer);
    });
  });
  
  let monthsToCheck = 1;
  if (periodOption === '2') {
    monthsToCheck = 2;
  } else if (periodOption === '3') {
    monthsToCheck = 3;
  }
  
  console.log(`\nPeríodo seleccionado: ${monthsToCheck} mes(es)`);
  
  let frameTree = page.frames().find(frame => frame.name() === 'tres');
  
  if (!frameTree) {
    console.log('Frame no encontrado');
    browser.close();
    return;
  }
  
  await frameTree.waitForSelector('input');
  
  await frameTree.type('input[name="id_cliente"]', company);
  await frameTree.type('input[name="login"]', usernameDaybeat);
  await frameTree.type('input[name="password"]', password);
  
  await delay(1000);
  await frameTree.click('input[type="submit"]');
  await frameTree.waitForNavigation();
  
  console.log('Login completado, esperando carga de página...');
  await delay(3000);
  
  const frameOne = page.frames().find(frame => frame.name() === 'uno');
  if (!frameOne) {
    console.log('ERROR: Frame "uno" no encontrado');
    browser.close();
    return;
  }
  
  await frameOne.waitForSelector('div', { timeout: 5000 });
  const divHandle = await frameOne.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Requerimientos');
  });
  
  await delay(1000);
  
  if (divHandle) {
    await frameOne.evaluate(el => {
      const event = new MouseEvent('mouseover', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      el.dispatchEvent(event);
    }, divHandle);
  }
  
  await frameTree.waitForSelector('div');
  const divHandleConsulta = await frameTree.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Consultar');
  });
  
  if (divHandleConsulta) {
    await frameTree.evaluate(el => el.click(), divHandleConsulta);
    await frameTree.waitForNavigation();
  }
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('input');
  
  console.log('Buscando proyectos...');
  const availableLinks = await frameTree.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    return links.map(link => ({
      text: link.textContent.trim(),
      href: link.href
    })).filter(l => l.text.length > 0 && l.href.includes('itemsint.asp'));
  });
  
  console.log(`Proyectos encontrados: ${availableLinks.length}`);
  
  // Calcular startDate ANTES de extraer fechas para optimizar paginación
  const today = new Date();
  const startDate = new Date(today.getTime() - (monthsToCheck * 30 * 24 * 60 * 60 * 1000));
  const startDateStr = `${String(startDate.getDate()).padStart(2, '0')}/${String(startDate.getMonth() + 1).padStart(2, '0')}/${startDate.getFullYear()}`;
  console.log(`[DEBUG] Rango de búsqueda: ${startDateStr} a ${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`);
  
  const allDates = [];
  
  // Guardar la URL de la página de consulta para volver después
  const consultaUrl = await frameTree.evaluate(() => window.location.href);
  
  // Iterar por cada proyecto
  for (const project of availableLinks) {
    console.log(`\nProcesando proyecto: ${project.text}`);
    
    // Navegar al proyecto
    await frameTree.evaluate((href) => {
      window.location.href = href;
    }, project.href);
    await frameTree.waitForNavigation();
    await delay(1500);
    
    // Guardar URL de items para volver
    const itemsUrl = await frameTree.evaluate(() => window.location.href);
    
    // Buscar items en este proyecto
    const items = await frameTree.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .filter(link => link.href.includes('itemsint_actualizar.asp'))
        .map(link => ({
          text: link.textContent.trim(),
          href: link.href
        }));
    });
    
    console.log(`  Items encontrados: ${items.length}`);
    
    // Iterar por cada item
    for (const item of items) {
      console.log(`    Procesando item: ${item.text}`);
      
      // Navegar al item
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, item.href);
      await frameTree.waitForNavigation();
      await delay(1500);
      
      // Extraer fechas de las transacciones (con paginación limitada al rango)
      const dates = await extractRegistrations(frameTree, startDateStr);
      console.log(`    Transacciones encontradas: ${dates.length}`);
      allDates.push(...dates);
      
      // Volver a la lista de items navegando directamente
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, itemsUrl);
      await frameTree.waitForNavigation();
      await delay(1000);
    }
    
    // Volver a la lista de proyectos navegando directamente
    await frameTree.evaluate((href) => {
      window.location.href = href;
    }, consultaUrl);
    await frameTree.waitForNavigation();
    await delay(1000);
  }
  
  const existingDates = [...new Set(allDates)];
  console.log(`\n\nTotal de registros encontrados: ${existingDates.length}`);
  console.log('[DEBUG] Fechas encontradas:', existingDates.sort().join(', '));
  
  const businessDays = getBusinessDays(startDate, today);
  
  console.log('[DEBUG] Total días hábiles en el rango:', businessDays.length);
  console.log('[DEBUG] Días hábiles:', businessDays.join(', '));
  
  const missingDays = getMissingRegistrations(existingDates, businessDays);
  
  console.log('\n====================================');
  console.log(`DÍAS HÁBILES SIN REGISTRO (últimos ${monthsToCheck} mes(es)): ${missingDays.length}`);
  console.log('====================================');
  
  if (missingDays.length === 0) {
    console.log('¡Todos los días hábiles tienen registro!');
  } else {
    missingDays.forEach(day => console.log(day));
  }
  
  console.log('====================================');
  
  rl.close();
  browser.close();
};


const registerBulkMissingDays = async (page, browser, company, usernameDaybeat, password) => {
  console.log('====================================');
  console.log('REGISTRO MASIVO DE DÍAS SIN REGISTRO');
  console.log('====================================');
  
  console.log('\nSeleccione el período a registrar:');
  console.log('1. Último mes');
  console.log('2. Últimos 2 meses');
  console.log('3. Últimos 3 meses');
  
  const periodOption = await new Promise((resolve) => {
    rl.question('Seleccione opción (1/2/3): ', (answer) => {
      resolve(answer);
    });
  });
  
  let monthsToCheck = 1;
  if (periodOption === '2') {
    monthsToCheck = 2;
  } else if (periodOption === '3') {
    monthsToCheck = 3;
  }
  
  console.log(`\nPeríodo seleccionado: ${monthsToCheck} mes(es)`);
  
  let frameTree = page.frames().find(frame => frame.name() === 'tres');
  
  if (!frameTree) {
    console.log('Frame no encontrado');
    browser.close();
    return;
  }
  
  await frameTree.waitForSelector('input');
  
  await frameTree.type('input[name="id_cliente"]', company);
  await frameTree.type('input[name="login"]', usernameDaybeat);
  await frameTree.type('input[name="password"]', password);
  
  await delay(1000);
  await frameTree.click('input[type="submit"]');
  await frameTree.waitForNavigation();
  
  console.log('Login completado, esperando carga de página...');
  await delay(3000);
  
  const frameOne = page.frames().find(frame => frame.name() === 'uno');
  if (!frameOne) {
    console.log('ERROR: Frame "uno" no encontrado');
    browser.close();
    return;
  }
  
  await frameOne.waitForSelector('div', { timeout: 5000 });
  const divHandle = await frameOne.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Requerimientos');
  });
  
  await delay(1000);
  
  if (divHandle) {
    await frameOne.evaluate(el => {
      const event = new MouseEvent('mouseover', {
        bubbles: true,
        cancelable: true,
        view: window
      });
      el.dispatchEvent(event);
    }, divHandle);
  }
  
  await frameTree.waitForSelector('div');
  const divHandleConsulta = await frameTree.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Consultar');
  });
  
  if (divHandleConsulta) {
    await frameTree.evaluate(el => el.click(), divHandleConsulta);
    await frameTree.waitForNavigation();
  }
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('input');
  
  console.log('Buscando proyectos...');
  const availableLinks = await frameTree.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a'));
    return links.map(link => ({
      text: link.textContent.trim(),
      href: link.href
    })).filter(l => l.text.length > 0 && l.href.includes('itemsint.asp'));
  });
  
  console.log(`Proyectos encontrados: ${availableLinks.length}`);
  
  // Calcular startDate ANTES de extraer fechas para optimizar paginación
  const today = new Date();
  const startDate = new Date(today.getTime() - (monthsToCheck * 30 * 24 * 60 * 60 * 1000));
  const startDateStr = `${String(startDate.getDate()).padStart(2, '0')}/${String(startDate.getMonth() + 1).padStart(2, '0')}/${startDate.getFullYear()}`;
  console.log(`[DEBUG] Rango de búsqueda: ${startDateStr} a ${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`);
  
  const allDates = [];
  const consultaUrl = await frameTree.evaluate(() => window.location.href);
  
  for (const project of availableLinks) {
    console.log(`\nProcesando proyecto: ${project.text}`);
    
    await frameTree.evaluate((href) => {
      window.location.href = href;
    }, project.href);
    await frameTree.waitForNavigation();
    await delay(1500);
    
    const itemsUrl = await frameTree.evaluate(() => window.location.href);
    
    const items = await frameTree.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links
        .filter(link => link.href.includes('itemsint_actualizar.asp'))
        .map(link => ({
          text: link.textContent.trim(),
          href: link.href
        }));
    });
    
    console.log(`  Items encontrados: ${items.length}`);
    
    for (const item of items) {
      console.log(`    Procesando item: ${item.text}`);
      
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, item.href);
      await frameTree.waitForNavigation();
      await delay(1500);
      
      const dates = await extractRegistrations(frameTree, startDateStr);
      console.log(`    Transacciones encontradas: ${dates.length}`);
      if (dates.length > 0) {
        console.log(`    Fechas: ${dates.join(', ')}`);
      }
      allDates.push(...dates);
      
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, itemsUrl);
      await frameTree.waitForNavigation();
      await delay(1000);
    }
    
    await frameTree.evaluate((href) => {
      window.location.href = href;
    }, consultaUrl);
    await frameTree.waitForNavigation();
    await delay(1000);
  }
  
  const existingDates = [...new Set(allDates)];
  console.log(`\n\nTotal de registros encontrados: ${existingDates.length}`);
  console.log('[DEBUG] Fechas encontradas:', existingDates.sort().join(', '));
  
  const businessDays = getBusinessDays(startDate, today);
  
  console.log('[DEBUG] Total días hábiles en el rango:', businessDays.length);
  console.log('[DEBUG] Días hábiles:', businessDays.join(', '));
  
  const missingDays = getMissingRegistrations(existingDates, businessDays);
  
  console.log('\n====================================');
  console.log(`DÍAS HÁBILES SIN REGISTRO (últimos ${monthsToCheck} mes(es)): ${missingDays.length}`);
  console.log('====================================');
  
  if (missingDays.length === 0) {
    console.log('¡Todos los días hábiles tienen registro!');
    rl.close();
    browser.close();
    return;
  }
  
  missingDays.forEach(day => console.log(day));
  
  console.log('\n====================================');
  console.log('SELECCIONAR PARÁMETROS PARA REGISTRO MASIVO');
  console.log('====================================');
  
  await frameTree.evaluate((href) => {
    window.location.href = href;
  }, consultaUrl);
  await frameTree.waitForNavigation();
  await delay(1500);
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const links = await listElements(frameTree, 'a');
  
  console.log('Seleccione la sección donde registrar:');
  const sectionIndex = await new Promise((resolve) => {
    rl.question('Número de sección: ', (answer) => {
      resolve(parseInt(answer) - 1);
    });
  });
  
  if (sectionIndex < 0 || sectionIndex >= links.length) {
    console.log('Opción inválida');
    rl.close();
    browser.close();
    return;
  }
  
  const selectedSection = links[sectionIndex];
  await frameTree.evaluate((href) => {
    window.location.href = href;
  }, selectedSection.href);
  await frameTree.waitForNavigation();
  await delay(1500);
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const otherLinks = await listElements(frameTree, 'a');
  
  console.log('Seleccione el item donde registrar:');
  const itemIndex = await new Promise((resolve) => {
    rl.question('Número de item: ', (answer) => {
      resolve(parseInt(answer) - 1);
    });
  });
  
  if (itemIndex < 0 || itemIndex >= otherLinks.length) {
    console.log('Opción inválida');
    rl.close();
    browser.close();
    return;
  }
  
  const selectedItem = otherLinks[itemIndex];
  const itemHandle = await frameTree.evaluateHandle((text, selector) => {
    const elements = Array.from(document.querySelectorAll(selector));
    const elementSelect = elements.find(el => el.textContent.trim() === text);
    if (elementSelect) {
      const parentTd = elementSelect.parentElement;
      const grandParentTr = parentTd.parentElement;
      const allLinksInRow = Array.from(grandParentTr.querySelectorAll('td > a'));
      if (allLinksInRow.length >= 2) {
        return allLinksInRow[allLinksInRow.length - 2];
      }
    }
    return null;
  }, selectedItem.text, 'a');
  
  if (!itemHandle) {
    console.log('No se encontró el item');
    rl.close();
    browser.close();
    return;
  }
  
  await itemHandle.click();
  await frameTree.waitForNavigation();
  await delay(1500);
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const itemUrl = await frameTree.evaluate(() => window.location.href);
  await frameTree.waitForSelector('select');
  
  console.log('\nSELECCIONE LA CATEGORIA: ');
  const optionsCategory = await listElements(frameTree, 'select[name="id_categoria"]>option');
  const categoryIndex = await new Promise((resolve) => {
    rl.question('Número de categoría: ', (answer) => {
      resolve(parseInt(answer) - 1);
    });
  });
  
  if (categoryIndex < 0 || categoryIndex >= optionsCategory.length) {
    console.log('Opción inválida');
    rl.close();
    browser.close();
    return;
  }
  
  const selectedCategory = optionsCategory[categoryIndex];
  
  // Seleccionar la categoría primero para que se carguen los tipos de transacción
  await frameTree.select('select[name="id_categoria"]', selectedCategory.value);
  await delay(1500); // Esperar a que se carguen las opciones dinámicas
  
  console.log('\nSELECCIONE TIPO DE TRANSACCION: ');
  const optionsTransaction = await listElements(frameTree, 'select[name="cod_tipotransaccion"]>option');
  const transactionIndex = await new Promise((resolve) => {
    rl.question('Número de tipo de transacción: ', (answer) => {
      resolve(parseInt(answer) - 1);
    });
  });
  
  if (transactionIndex < 0 || transactionIndex >= optionsTransaction.length) {
    console.log('Opción inválida');
    rl.close();
    browser.close();
    return;
  }
  
  const selectedTransaction = optionsTransaction[transactionIndex];
  
  const rootDir = process.env.ROOT_DIR;
  console.log('\nBuscando repositorios en:', rootDir);
  const repos = findGitRepos(rootDir);
  console.log(`Repositorios encontrados: ${repos.length}`);
  
  const author = getGitAuthor(repos);
  if (author) {
    console.log(`Filtrando commits por autor: ${author}`);
  }
  
  const hours = getLastUsedHours();
  const startTime = hours.start;
  const endTime = hours.end;
  
  console.log(`\nHorario a usar: ${startTime} - ${endTime}`);
  console.log(`Categoría: ${selectedCategory.text}`);
  console.log(`Tipo de transacción: ${selectedTransaction.text}`);
  console.log(`Item: ${selectedItem.text}`);
  console.log(`Días a registrar: ${missingDays.length}`);
  
  const confirmBulk = await new Promise((resolve) => {
    rl.question('\n¿Desea continuar con el registro masivo? (si/no): ', (answer) => {
      resolve(answer);
    });
  });
  
  if (confirmBulk !== 'si') {
    console.log('Registro masivo cancelado');
    rl.close();
    browser.close();
    return;
  }
  
  const successDays = [];
  const errorDays = [];
  const alreadyRegisteredDays = [];
  
  console.log('\n====================================');
  console.log('INICIANDO REGISTRO MASIVO');
  console.log('====================================\n');
  
  for (let i = 0; i < missingDays.length; i++) {
    const day = missingDays[i];
    console.log(`\n[${i + 1}/${missingDays.length}] Procesando día: ${day}`);
    
    // Verificar si el día ya tiene registro en cualquier item
    console.log(`  Verificando si ya existe registro...`);
    const alreadyExists = existingDates.includes(day);
    
    if (alreadyExists) {
      console.log(`  ⚠ Día ${day} ya tiene registro, saltando...`);
      alreadyRegisteredDays.push(day);
      continue;
    }
    
    try {
      const allCommits = repos.flatMap(repo => getCommitsForDate(repo, day, author));
      console.log(`  Commits encontrados del día: ${allCommits.length}`);
      
      let commitsToUse = allCommits;
      let commitsWithDates = [];
      let context = 'same-day';
      
      if (allCommits.length === 0) {
        console.log('  No hay commits ese día, buscando últimos 5 días antes de la fecha');
        commitsWithDates = repos.flatMap(repo => getRecentCommitsBeforeDate(repo, day, 5, author));
        console.log(`  Commits encontrados en últimos 5 días: ${commitsWithDates.length}`);
        
        if (commitsWithDates.length === 0) {
          console.log('  No hay commits en últimos 5 días, buscando últimos 7 días');
          commitsWithDates = repos.flatMap(repo => getRecentCommitsBeforeDate(repo, day, 7, author));
          console.log(`  Commits encontrados en últimos 7 días: ${commitsWithDates.length}`);
        }
        
        if (commitsWithDates.length > 0) {
          commitsToUse = getRotatedCommits(commitsWithDates, day);
          console.log(`  Commits seleccionados (rotación): ${commitsToUse.length}`);
          
          const prefix = getContextPrefix(day, commitsWithDates);
          context = prefix.includes('Continuación') ? 'continuation' : 'follow-up';
        } else {
          console.log('  No hay commits disponibles, generando texto genérico variado');
          context = 'no-commits';
        }
      }
      
      let title, detail;
      
      if (context === 'no-commits') {
        if (process.env.GEMINI_API_KEY) {
          console.log('  Generando texto variado con Gemini AI...');
          const fakeCommits = ['Sin commits específicos'];
          const aiResult = await generateWithGemini(fakeCommits, 'no-commits', day);
          
          if (aiResult) {
            title = aiResult.title;
            detail = aiResult.detail;
            console.log('  ✓ Texto variado generado con Gemini AI');
          } else {
            console.log('  ✗ IA falló, usando texto genérico por defecto');
            const genericText = generateGenericText(day);
            title = genericText.title;
            detail = genericText.detail;
          }
        } else {
          console.log('  Sin GEMINI_API_KEY, usando texto genérico variado');
          const genericText = generateGenericText(day);
          title = genericText.title;
          detail = genericText.detail;
        }
      } else if (process.env.GEMINI_API_KEY && commitsToUse.length > 0) {
        console.log(`  Generando con Gemini AI (contexto: ${context})...`);
        const aiResult = await generateWithGemini(commitsToUse, context, day);
        
        if (aiResult) {
          title = aiResult.title;
          detail = aiResult.detail;
          console.log('  ✓ Generado con Gemini AI');
        } else {
          console.log('  ✗ IA falló, usando método por defecto');
          const prefix = getContextPrefix(day, commitsWithDates);
          const summary = summarizeCommits(commitsToUse);
          title = prefix + summary;
          detail = generateDetail(commitsToUse);
        }
      } else {
        if (!process.env.GEMINI_API_KEY && commitsToUse.length > 0) {
          console.log('  Sin GEMINI_API_KEY, usando método por defecto');
        }
        const prefix = getContextPrefix(day, commitsWithDates);
        const summary = summarizeCommits(commitsToUse);
        title = prefix + summary;
        detail = generateDetail(commitsToUse);
      }
      
      console.log(`  Título: ${title.substring(0, 50)}...`);
      
      // Navegar a la página del item (que es el formulario de nueva transacción)
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, itemUrl);
      await frameTree.waitForNavigation();
      await delay(1500);
      
      frameTree = page.frames().find(frame => frame.name() === 'tres');
      await frameTree.waitForSelector('select');
      
      // Seleccionar categoría y tipo de transacción
      await frameTree.select('select[name="id_categoria"]', selectedCategory.value);
      await delay(500);
      await frameTree.select('select[name="cod_tipotransaccion"]', selectedTransaction.value);
      
      await frameTree.type('input[name="descripcion_corta"]', title);
      
      const [dd, mm, yyyy] = day.split('/');
      const formattedDate = `${dd}${mm}${yyyy}`;
      await frameTree.type('input[name="fechaini"]', formattedDate);
      
      await frameTree.type('input[name="horaini"]', startTime);
      await frameTree.type('input[name="horafin"]', endTime);
      
      await frameTree.type('textarea[name="texto_largo"]', detail);
      
      // Registrar listener del dialog ANTES de hacer click
      const dialogPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ handled: false });
        }, 8000);
        
        page.once('dialog', async (dialog) => {
          clearTimeout(timeout);
          const message = dialog.message();
          console.log(`  Diálogo: ${message}`);
          await dialog.accept();
          resolve({ 
            handled: true, 
            success: message.includes('éxitosamente') || message.includes('exitosamente')
          });
        });
      });
      
      // Hacer click en submit
      await frameTree.click('input[type="submit"][class="bot"]');
      
      // Esperar resultado del dialog
      const result = await dialogPromise;
      
      if (result.handled && result.success) {
        console.log(`  ✓ Día ${day} registrado exitosamente`);
        successDays.push(day);
      } else {
        console.log(`  ✗ Día ${day} falló: no se confirmó el registro`);
        errorDays.push({ day, error: 'No se confirmó el registro' });
      }
      
      await delay(1500);
      
    } catch (err) {
      console.log(`  ✗ Error registrando ${day}: ${err.message}`);
      errorDays.push({ day, error: err.message });
    }
  }
  
  console.log('\n====================================');
  console.log('RESUMEN DE REGISTRO MASIVO');
  console.log('====================================');
  console.log(`Total días sin registro: ${missingDays.length}`);
  console.log(`Días registrados exitosamente: ${successDays.length}`);
  console.log(`Días ya registrados (saltados): ${alreadyRegisteredDays.length}`);
  console.log(`Días con error: ${errorDays.length}`);
  
  if (successDays.length > 0) {
    console.log('\nDías registrados:');
    successDays.forEach(day => console.log(`  ✓ ${day}`));
  }
  
  if (alreadyRegisteredDays.length > 0) {
    console.log('\nDías ya registrados (saltados):');
    alreadyRegisteredDays.forEach(day => console.log(`  ⚠ ${day}`));
  }
  
  if (errorDays.length > 0) {
    console.log('\nDías con error:');
    errorDays.forEach(({ day, error }) => console.log(`  ✗ ${day} - ${error}`));
  }
  
  console.log('====================================');
  
  rl.close();
  browser.close();
};

const listAndNavigateNewTransaction = async (frameTree, page) => {
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  // Esperar a que los links dentro del frame estén cargados
  const otherLinks = await listElements(frameTree, 'a');
  // Pedir al usuario que elija una opción
  await whriteAndNavigateOtherElementSelect(frameTree, 'a', otherLinks);
}

const registerNewTransaction = async (frameTree, page, autoData = null) => {
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  // Esperar a que los select dentro del frame estén cargados
  await frameTree.waitForSelector('select');

  // Listar todos las opciones de categoria.
  console.log('SELECCIONE LA CATEGORIA: ');
  const optionsCategory = await listElements(frameTree, 'select[name="id_categoria"]>option');
  // Pedir al usuario que elija una opción
  await selectOptionSelector(frameTree, 'select[name="id_categoria"]', optionsCategory);

  // Listar todos las opciones de transacción.
  console.log('SELECCIONE TIPO DE TRANSACCION: ');
  const optionsTransaction = await listElements(frameTree, 'select[name="cod_tipotransaccion"]>option');
  // Pedir al usuario que elija una opción
  await selectOptionSelector(frameTree, 'select[name="cod_tipotransaccion"]', optionsTransaction);

  // Mostrar menú de modo de registro
  console.log('-------------------------');
  console.log('MODO DE REGISTRO:');
  console.log('1. Automático (commits de hoy)');
  console.log('2. Con IA (Gemini)');
  console.log('3. Automático fake (basado en días anteriores)');
  console.log('4. Manual');
  console.log('-------------------------');

  const mode = await questionUserResponse(frameTree, 'Seleccione modo (1/2/3/4): ');

  let title = null;
  let formattedDate = null;
  let startTime = null;
  let endTime = null;
  let detail = null;
  let today = new Date();
  let dd = String(today.getDate()).padStart(2, '0');
  let mm = String(today.getMonth() + 1).padStart(2, '0');
  let yyyy = today.getFullYear();
  let defaultDate = dd + mm + yyyy;

  if (mode === '1') {
    const rootDir = process.env.ROOT_DIR;
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = findGitRepos(rootDir);
    console.log(`Repositorios encontrados: ${repos.length}`);
    
    const author = getGitAuthor(repos);
    if (author) {
      console.log(`Filtrando commits por autor: ${author}`);
    } else {
      console.log('No se pudo determinar el autor. Mostrando todos los commits.');
    }
    
    if (repos.length === 0) {
      console.log('No se encontraron repositorios. Cambiando a modo fake...');
      const recentCommits = repos.flatMap(repo => getRecentCommits(repo, 7, author));
      title = generateFakeSummary(recentCommits);
      const hours = getLastUsedHours();
      startTime = hours.start;
      endTime = hours.end;
      detail = generateDetail(recentCommits);
    } else {
      const allCommits = repos.flatMap(repo => getTodayCommits(repo, author));
      console.log(`Total de commits hoy: ${allCommits.length}`);

      if (allCommits.length === 0) {
        console.log('No hay commits hoy. Cambiando a modo fake...');
        const recentCommits = repos.flatMap(repo => getRecentCommits(repo, 7, author));
        console.log(`Total de commits en últimos 7 días: ${recentCommits.length}`);
        title = generateFakeSummary(recentCommits);
        const hours = getLastUsedHours();
        startTime = hours.start;
        endTime = hours.end;
        detail = generateDetail(recentCommits);
      } else {
        title = summarizeCommits(allCommits);
        const hours = getLastUsedHours();
        startTime = hours.start;
        endTime = hours.end;
        detail = generateDetail(allCommits);
      }
    }
    formattedDate = defaultDate;

    console.log('-------------------------');
    console.log('RESUMEN AUTOMÁTICO:');
    console.log(`Título: ${title}`);
    console.log(`Detalle: ${detail}`);
    console.log(`Fecha: ${dd}/${mm}/${yyyy}`);
    console.log(`Horario: ${startTime} - ${endTime}`);
    console.log('-------------------------');

    const confirm = await questionUserResponse(frameTree, '¿Desea continuar con estos datos? (si/no): ');
    if (confirm !== 'si') {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  } else if (mode === '2') {
    // Modo Con IA (Gemini)
    const rootDir = process.env.ROOT_DIR;
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = findGitRepos(rootDir);
    console.log(`Repositorios encontrados: ${repos.length}`);
    
    const author = getGitAuthor(repos);
    if (author) {
      console.log(`Filtrando commits por autor: ${author}`);
    } else {
      console.log('No se pudo determinar el autor. Mostrando todos los commits.');
    }
    
    let allCommits = [];
    if (repos.length > 0) {
      allCommits = repos.flatMap(repo => getTodayCommits(repo, author));
      console.log(`Total de commits hoy: ${allCommits.length}`);
      
      if (allCommits.length === 0) {
        console.log('No hay commits hoy, usando últimos 3 días...');
        allCommits = repos.flatMap(repo => getRecentCommits(repo, 3, author));
        console.log(`Total de commits en últimos 3 días: ${allCommits.length}`);
      }
    }
    
    const hours = getLastUsedHours();
    startTime = hours.start;
    endTime = hours.end;
    formattedDate = defaultDate;
    
    // Intentar generar con IA
    if (process.env.GEMINI_API_KEY && allCommits.length > 0) {
      console.log('  Generando con Gemini AI...');
      const aiResult = await generateWithGemini(allCommits);
      
      if (aiResult) {
        title = aiResult.title;
        detail = aiResult.detail;
        console.log('  ✓ Generado con Gemini AI');
      } else {
        console.log('  ✗ IA falló, usando método por defecto');
        title = allCommits.length > 0 ? summarizeCommits(allCommits) : generateFakeSummary(allCommits);
        detail = generateDetail(allCommits);
      }
    } else {
      if (!process.env.GEMINI_API_KEY) {
        console.log('  No hay GEMINI_API_KEY, usando método por defecto');
      }
      title = allCommits.length > 0 ? summarizeCommits(allCommits) : generateFakeSummary(allCommits);
      detail = generateDetail(allCommits);
    }
    
    console.log('-------------------------');
    console.log('RESUMEN CON IA:');
    console.log(`Título: ${title}`);
    console.log(`Detalle: ${detail}`);
    console.log(`Fecha: ${dd}/${mm}/${yyyy}`);
    console.log(`Horario: ${startTime} - ${endTime}`);
    console.log('-------------------------');
    
    const confirm = await questionUserResponse(frameTree, '¿Desea continuar con estos datos? (si/no): ');
    if (confirm !== 'si') {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  } else if (mode === '3') {
    const rootDir = process.env.ROOT_DIR;
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = findGitRepos(rootDir);
    console.log(`Repositorios encontrados: ${repos.length}`);
    
    const author = getGitAuthor(repos);
    if (author) {
      console.log(`Filtrando commits por autor: ${author}`);
    } else {
      console.log('No se pudo determinar el autor. Mostrando todos los commits.');
    }
    
    if (repos.length === 0) {
      console.log('No se encontraron repositorios. Usando resumen genérico.');
    }
    
    const recentCommits = repos.flatMap(repo => getRecentCommits(repo, 7, author));
    console.log(`Total de commits en últimos 7 días: ${recentCommits.length}`);
    
    title = generateFakeSummary(recentCommits);
    const hours = getLastUsedHours();
    startTime = hours.start;
    endTime = hours.end;
    detail = generateDetail(recentCommits);
    formattedDate = defaultDate;

    console.log('-------------------------');
    console.log('RESUMEN FAKE:');
    console.log(`Título: ${title}`);
    console.log(`Detalle: ${detail}`);
    console.log(`Fecha: ${dd}/${mm}/${yyyy}`);
    console.log(`Horario: ${startTime} - ${endTime}`);
    console.log('-------------------------');

    const confirm = await questionUserResponse(frameTree, '¿Desea continuar con estos datos? (si/no): ');
    if (confirm !== 'si') {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  }

  // Escribir input descripcion corta.
  if (title) {
    await frameTree.type('input[name="descripcion_corta"]', title);
  } else {
    await whriteInput(frameTree, 'input[name="descripcion_corta"]', "Digite el titulo de la actividad:");
  }

  // Definir fecha
  if (!formattedDate) {
    const responseDate = await questionUserResponse(frameTree, `¿La fecha que va registrar es ${dd}/${mm}/${yyyy} ? (si/no): `);
    if (responseDate === 'si') {
      formattedDate = defaultDate;
    } else {
      formattedDate = await questionUserResponse(frameTree, "Digite la fecha de la actividad formato ddmmyyyy: ");
    }
  }
  await frameTree.type('input[name="fechaini"]', formattedDate);

  // Definir horario
  if (!startTime) {
    const response = await questionUserResponse(frameTree, '¿El horario a diligenciar es jornada completa de 7:30am a 5:30pm? (si/no): ');
    if (response === 'si') {
      startTime = '0730';
      endTime = '1630';
    } else {
      startTime = await questionUserResponse(frameTree, "Digite la hora de inicio de la actividad sin puntos: ");
      endTime = await questionUserResponse(frameTree, "Digite la hora de finalización de la actividad sin puntos: ");
    }
  }
  await frameTree.type('input[name="horaini"]', startTime);
  await frameTree.type('input[name="horafin"]', endTime);

  // Guardar horario usado
  saveHours(startTime, endTime);

  // Escribir detalle de actividad.
  if (detail) {
    await frameTree.type('textarea[name="texto_largo"]', detail);
  } else {
    await whriteInput(frameTree, 'textarea[name="texto_largo"]', "Digite el detalle de la actividad:");
  }

  // Enviar el formulario
  await frameTree.click('input[type="submit"][class="bot"]');

  return frameTree;
}


const finishOrContinue = async (page, browser) => {
  let frameTree = page.frames().find(frame => frame.name() === 'tres');
  const response = await questionUserResponse(frameTree, '¿Deseas registrar otra actividad? (si/no): ');

  if (response === 'si') {
    console.log('====================================');
    console.log('REGISTRANDO NUEVA ACTIVIDAD...', response);
    console.log('====================================');
    await listAndNavigateNewTransaction(frameTree, page);
    await registerNewTransaction(frameTree, page);
  } else {
    console.log('Proceso finalizado.');
    rl.close();
    browser.close();
  }
}

const delay = (time) => {
  return new Promise(function (resolve) {
    setTimeout(resolve, time)
  });
}

(async () => {
  const browser = await puppeteer.launch({ headless: false, });
  const page = await browser.newPage();

  const linkDaybeat = process.env.LINK_DAYBEAT;
  const company = process.env.COMPANY;
  const usernameDaybeat = process.env.USERNAME_DAYBEAT;
  const password = process.env.PASSWORD;

  if (!linkDaybeat || !company || !usernameDaybeat || !password) {
    console.log("ERROR: Defina variables de entorno para continuar.");
    browser.close();
    return;
  }

  await page.goto(linkDaybeat);

  console.log('====================================');
  console.log('¿QUÉ DESEA HACER?');
  console.log('====================================');
  console.log('1. Registrar actividad');
  console.log('2. Ver días sin registro');
  console.log('3. Registro masivo de días sin registro');
  console.log('4. Salir');
  console.log('====================================');

  const mainOption = await new Promise((resolve) => {
    rl.question('Seleccione opción (1/2/3/4): ', (answer) => {
      resolve(answer);
    });
  });

  if (mainOption === '4') {
    console.log('Saliendo...');
    rl.close();
    browser.close();
    return;
  }

  if (mainOption === '2') {
    await showMissingRegistrations(page, browser, company, usernameDaybeat, password);
    return;
  }

  if (mainOption === '3') {
    await registerBulkMissingDays(page, browser, company, usernameDaybeat, password);
    return;
  }

  page.on('dialog', async dialog => {
    console.log("-------------------------");
    console.log('ALERTA ENCONTRADA:');
    console.log("-------------------------");
    console.log(dialog.message()); // Muestra el mensaje de la alerta
    if (dialog.message().trim() === 'Transacción ingresada éxitosamente') {
      await dialog.accept(); // Aceptar (cerrar) la alerta
      await finishOrContinue(page, browser);
    } else {
      await dialog.accept(); // Aceptar (cerrar) la alerta
      console.log('ERROR AL REGISTRAR, EJECUTE NUEVAMENTE.');
      rl.close();
      browser.close();
    }
  });


  // Obtener el frame con el nombre "tres"
  let frameTree = page.frames().find(frame => frame.name() === 'tres');

  if (frameTree) {
    
    // Esperar a que los inputs dentro del frame estén cargados
    await frameTree.waitForSelector('input');

    // LOGIN.
    await frameTree.type('input[name="id_cliente"]', company);
    await frameTree.type('input[name="login"]', usernameDaybeat);
    await frameTree.type('input[name="password"]', password);

    await delay(1000)

    // Enviar el formulario.
    await frameTree.click('input[type="submit"]');

    // Esperar a que la navegación termine (si redirige a otra página).
    await frameTree.waitForNavigation();

    /////////////////////////////////////////////////////////
    // INGRESAR AL MENU INICIAL UNO Y HACER HOVER.
    /////////////////////////////////////////////////////////
    const frameOne = page.frames().find(frame => frame.name() === 'uno');
    // Esperar a que los inputs dentro del frame estén cargados
    await frameOne.waitForSelector('div');
    // Encontrar el div que contiene el texto específico usando evaluate
    const divHandle = await frameOne.evaluateHandle(() => {
      const elements = Array.from(document.querySelectorAll('div'));
      return elements.find(el => el.textContent.trim() === 'Requerimientos'); // Comparación exacta
    });

    // Esperar 1 segundo
    await delay(1000);
    
    if (divHandle) {
      // Hacer hover sobre el div
      await frameOne.evaluate(el => {
        const event = new MouseEvent('mouseover', {
          bubbles: true,
          cancelable: true,
          view: window
        });
        el.dispatchEvent(event);
      }, divHandle);
    }
    ////////////////////////--END--/////////////////////////

    /////////////////////////////////////////////////////////
    // NAVEGAR A CONSULTAR.    
    /////////////////////////////////////////////////////////
    // Esperar a que los inputs dentro del frame estén cargados
    await frameTree.waitForSelector('div');
    // Encontrar el div que contiene el texto específico usando evaluate
    const divHandleConsulta = await frameTree.evaluateHandle(() => {
      const elements = Array.from(document.querySelectorAll('div'));
      return elements.find(el => el.textContent.trim() === 'Consultar'); // Comparación exacta
    });

    if (divHandleConsulta) {
      // Hacer clic en el div encontrado
      await frameTree.evaluate(el => el.click(), divHandleConsulta);
      // Esperar a que la navegación termine (si redirige a otra página).
      await frameTree.waitForNavigation();
    }
    ////////////////////////--END--/////////////////////////

    /////////////////////////////////////////////////////////
    // ACTUALIZAR LA CONSULTA.
    /////////////////////////////////////////////////////////

    // Actualizar frame 3
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    // // Esperar a que los inputs dentro del frame estén cargados
    await frameTree.waitForSelector('input');

    // Listar todos los inputs dentro del frame
    const inputs = await frameTree.$$eval('input', elements =>
      elements.map(el => ({
        type: el.type,
        name: el.name,
        id: el.id,
        class: el.className,
        placeholder: el.placeholder
      }))
    );

    // Obtener el input como un ElementHandle
    const inputHandle = await frameTree.$('input[name="re_fechad"][type="text"]');

    if (inputHandle) {
      // Enfocar el input
      await frameTree.evaluate(el => el.focus(), inputHandle);

      // Escribir el nuevo valor para ver todo el listado.
      await frameTree.evaluate((el, value) => {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, inputHandle, '01012000');

      // Buscar el formulario
      await frameTree.click('input[type="image"]');

      // Esperar a que la navegación termine (si redirige a otra página).
      await frameTree.waitForNavigation();
    }
    ////////////////////////--END--/////////////////////////


    /////////////////////////////////////////////////////////
    /**          SELECCIONAR SECCIÓN A REGISTRAR.         **/
    /////////////////////////////////////////////////////////
    // Actualizar frame 3
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    // Esperar a que los links dentro del frame estén cargados
    const links = await listElements(frameTree, 'a');
    // Pedir al usuario que elija una opción
    await whriteAndNavigateElementSelect(frameTree, 'a', links);
    ////////////////////////--END--/////////////////////////

    /////////////////////////////////////////////////////////
    /**  LISTAR Y NAVEGAR A REGISTRAR NUEVA TRANSACCIÓN.  **/
    /////////////////////////////////////////////////////////
    await frameTree.waitForNavigation();
    await listAndNavigateNewTransaction(frameTree, page);
    ////////////////////////--END--/////////////////////////

    /////////////////////////////////////////////////////////
    /**     DILIGENCIAR FORMULARIO PARA NUEVO REGISTRO.   **/
    /////////////////////////////////////////////////////////
    await frameTree.waitForNavigation();
    registerNewTransaction(frameTree, page);

  } else {
    console.log('Frame no encontrado');
  }


  // Cerrar el navegador
  // await browser.close();
})();
