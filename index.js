require('dotenv').config();
const puppeteer = require('puppeteer');
const prompt = require('./lib/prompt.js');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { isConfigured, getDailyActivity, formatActivityForReport, closeConnection } = require('./lib/jira-report.js');
const ai = require('./lib/ai-config.js');
const {
  toMinutes,
  toHHMM,
  isoToLocalHHMM,
  parseTimeSpentHours,
  dateDDMMYYYYToTimestamp,
  formatDateFromISO,
  buildDayBlocks,
  intersectBlocksWithFree,
  getBusinessDays,
  getMissingRegistrations
} = require('./lib/time.js');
const {
  getContextPrefix,
  generateGenericText,
  categorizeCommits,
  generateStructuredSummary,
  generateDetail,
  summarizeCommits,
  generateFakeSummary,
  smartTruncate,
  generateWithGemini
} = require('./lib/summary.js');
const { resolveRootDir } = require('./lib/path.js');
const {
  loadRegistrationsCache,
  getCachedUser,
  mergeDatesForUser,
  getLastUsedHours,
  saveHours,
  loadPathCache,
  savePathCache,
  loadHolidays,
  saveHolidays
} = require('./lib/persistence.js');
const {
  getReposWithCache,
  getGitAuthor,
  getTodayCommits,
  getRecentCommits,
  getCommitsForDate,
  getCommitsWithTime,
  getRecentCommitsBeforeDate,
  getRotatedCommits
} = require('./lib/git.js');



// Funciones auxiliares.

const listElements = async (frame, selector, filterHref = null, silent = false) => {
  // Cuando filtramos por href (ej. secciones), esperar el DOM específico:
  // el URL del frame puede cambiar ANTES de que carguen los enlaces reales.
  if (filterHref) {
    const ready = await frame.waitForSelector(`a[href*="${filterHref}"]`, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      console.log(`No se encontraron elementos con href *${filterHref} en la página.`);
      return [];
    }
  } else {
    await frame.waitForSelector(selector);
  }
  // Listar todos los links dentro del frame
  const links = await frame.$$eval(selector, (elements, fhref) =>
    elements
      .map(el => ({
        href: el.href,
        text: el.textContent.trim(),
        value: el.value
      }))
      .filter(l => l.text.length > 0)
      .filter(l => !fhref || (l.href && l.href.includes(fhref)))
  , filterHref);
  // Mostrar opciones al usuario (se omite cuando el selector visual es
  // @inquirer/select, que renderiza su propia lista).
  if (!silent) {
    console.log('---------------------');
    console.log('OPCIONES DISPONIBLES:');
    console.log('---------------------');
    links.forEach((item, index) => {
      console.log(`${index + 1}. ${item.text}`);
    });
    console.log('---------------------');
  }

  return links;
}

// La lista de items (itemsint.asp) pagina de a ~15 con el parámetro `page`
// (0, 1, 2, ...) y los controles de imagen 3dw.gif (siguiente) / 3up.gif
// (anterior). Este helper recorre TODAS las páginas y devuelve por cada item
// su nombre, el href del detalle (itemsint_actualizar.asp) y el href del link
// "crear transacción" (transaccionesint_crear.asp — el penúltimo de la fila),
// que es el que los flujos de registro usan para abrir el formulario.
const ITEM_MAX_PAGES = 20;

const collectAllItems = async (frameTree, page) => {
  const items = [];
  const seen = new Set();
  for (let i = 0; i < ITEM_MAX_PAGES; i++) {
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) break;
    // La navegación resuelve cuando el URL del frame cambia, pero el DOM del
    // iframe carga DESPUÉS: leer la tabla antes de que exista devuelve [] y
    // el menú aparece vacío. Esperar la tabla de items de esta página antes
    // de evaluar (fail-soft: si no aparece, devolver lo recolectado).
    const itemsReady = await frameTree.waitForSelector('a[href*="itemsint_actualizar.asp"]', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!itemsReady) {
      console.log('No se encontraron items en esta sección.');
      break;
    }
    const pageItems = await frameTree.evaluate(() => {
      return Array.from(document.querySelectorAll('tr'))
        .map(tr => {
          const nameLink = Array.from(tr.querySelectorAll('a'))
            .find(a => a.href.includes('itemsint_actualizar.asp') && a.textContent.trim() !== '');
          if (!nameLink) return null;
          const rowLinks = Array.from(tr.querySelectorAll('a'));
          const createLink = rowLinks[rowLinks.length - 2];
          return {
            text: nameLink.textContent.trim(),
            href: nameLink.href,
            createHref: createLink ? createLink.href : nameLink.href
          };
        })
        .filter(Boolean);
    });
    for (const item of pageItems) {
      if (!seen.has(item.href)) {
        seen.add(item.href);
        items.push(item);
      }
    }

    // Buscar el enlace de "siguiente página" (solo 3dw.gif: 3up.gif es anterior)
    const nextHref = await frameTree.evaluate(() => {
      for (const link of Array.from(document.querySelectorAll('a'))) {
        const img = link.querySelector('img');
        if (!img) continue;
        const src = img.src.toLowerCase();
        if (src.includes('regresar') || src.includes('back') || src.includes('return')) continue;
        if (src.includes('3dw.gif')) return link.href;
      }
      return null;
    });

    if (!nextHref) break;
    await navigateFrameRobust(page, async (ft) => {
      await ft.evaluate((href) => {
        window.location.href = href;
      }, nextHref);
    }, (u) => u.includes(`page=${i + 1}`));
    await delay(1500);
  }
  return items;
};

// Muestra el menú numerado de items recolectados y navega directamente al
// elegido: detail = href del detalle (itemsint_actualizar.asp), de lo
// contrario href del formulario de creación (transaccionesint_crear.asp).
const selectItemAndNavigate = async (frameTree, page, items, navigateToDetail = false) => {
  if (!items || items.length === 0) {
    console.log('No se encontraron items en esta sección.');
    return null;
  }

  const index = await prompt.askSelect({
    message: 'Seleccione el item:',
    choices: items.map((item, i) => ({ name: item.text, value: i }))
  });
  if (index === null || index === undefined || index < 0 || index >= items.length) {
    console.log('Opción inválida.');
    return null;
  }

  const selected = items[index];
  const target = navigateToDetail ? selected.href : selected.createHref;
  await navigateFrameRobust(page, async (ft) => {
    await ft.evaluate((href) => {
      window.location.href = href;
    }, target);
  }, (u) => u.includes(navigateToDetail ? 'itemsint_actualizar.asp' : 'transaccionesint_crear.asp'));
  return selected;
}

// Navegación robusta de un frame. El patrón clásico `click(); waitForNavigation();`
// es frágil en LAN rápida: la página carga tan rápido que el evento de navegación
// se pierde y waitForNavigation cae en TimeoutError (o el frame se desmonta y
// la promesa nunca resuelve). Este helper se suscribe ANTES de disparar la
// navegación y, como respaldo, sondea el URL del frame hasta que cumple el
// predicado esperado (independiente de eventos de navegación).
// `triggerFn` puede ser null si la navegación ya fue disparada (solo sondea).
const navigateFrameRobust = async (page, triggerFn, urlPredicate, timeoutMs = 20000) => {
  if (triggerFn) {
    const frameTree = page.frames().find(frame => frame.name() === 'tres');
    try {
      await Promise.all([
        frameTree ? frameTree.waitForNavigation({ timeout: 10000 }) : Promise.resolve(),
        triggerFn(frameTree || page)
      ]);
    } catch (err) {
      // Race (nav demasiado rápida) o frame desmontado: el sondeo de respaldo
      // debajo resuelve igual; aquí no es un error real.
    }
  }
  const deadline = Date.now() + timeoutMs;
  let lastUrl = '';
  while (Date.now() < deadline) {
    const f = page.frames().find(frame => frame.name() === 'tres');
    if (f) {
      const url = await f.evaluate(() => window.location.href).catch(() => '');
      if (url) lastUrl = url;
      if (url && urlPredicate(url)) return f;
    }
    await delay(250);
  }
  throw new Error(`navigateFrameRobust: timeout esperando la navegación (${timeoutMs}ms) | última URL frame tres: ${lastUrl || 'sin frame tres'}`);
}

// Diagnóstico de etapas del flujo: imprime en qué punto estamos y la URL
// actual del frame tres, para detectar dónde se detiene la ejecución sin
// llegar a listar las secciones.
const logStage = async (page, label) => {
  const f = page.frames().find(frame => frame.name() === 'tres');
  const url = f ? await f.evaluate(() => window.location.href).catch(() => '?') : 'SIN FRAME tres';
  console.log(`[STAGE] ${label} | frame tres: ${url}`);
  return f;
};

const normalizeText = (s) => s ? s.replace(/\s+/g, ' ').trim() : '';

const whriteAndNavigateElementSelect = async (frame, selector, links) => {
  try {
    const index = await prompt.askSelect({
      message: 'Por favor, elige una opción (número):',
      choices: links.map((l, i) => ({ name: l.text, value: i }))
    });
    if (index === null || index === undefined || index < 0 || index >= links.length) {
      console.log('Opción inválida.');
      return null;
    }
    const selectedItem = links[index];
    // Find + click en un solo evaluate: evita el handle huérfano si el
    // frame navega entre medio (el click dispara la navegación).
    const clicked = await frame.evaluate((text, sel) => {
      const elements = Array.from(document.querySelectorAll(sel));
      const el = elements.find(e => e.textContent.trim() === text);
      if (el) el.click();
      return !!el;
    }, selectedItem.text, selector);
    if (!clicked) {
      console.log(`No se encontró la opción "${selectedItem.text}" en la página.`);
      return null;
    }
    return selectedItem.text;
  } catch (err) {
    console.log('Error seleccionando la opción:', err.message);
    return null;
  }
}

const selectOptionSelector = async (frame, selector, links) => {
  const index = await prompt.askSelect({
    message: 'Por favor, elige una opción (número):',
    choices: links.map((l, i) => ({ name: l.text, value: i }))
  });
  if (index !== null && index !== undefined && index >= 0 && index < links.length) {
    const selectedItem = links[index];
    await frame.select(selector, selectedItem.value); // Selecciona la opción
  } else {
    console.log('Opción inválida.');
  }
};

const whriteInput = async (frame, selector, title) => {
  console.log("-------------------------");
  console.log(title);
  console.log("-------------------------");
  const choice = await prompt.ask("");
  // escribir el input con lo diligenciado por el usuario.
  await frame.type(selector, choice);
}

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

// Funciones de automatización basadas en commits



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

const getCurrentUser = async (page) => {
  try {
    // Buscar en todos los frames para mayor robustez
    const frames = page.frames();
    
    for (const frame of frames) {
      const userName = await frame.evaluate(() => {
        // Buscar el td que contiene "Usuario:" y tomar el siguiente td hermano
        const allLabels = document.querySelectorAll('td.titcliente');
        
        for (const label of allLabels) {
          const text = label.textContent.replace(/&nbsp;/g, '').trim();
          if (text === 'Usuario:') {
            // Tomar el siguiente td hermano
            const nextTd = label.nextElementSibling;
            if (nextTd && nextTd.tagName === 'TD') {
              return nextTd.textContent.replace(/&nbsp;/g, '').trim();
            }
          }
        }
        
        // Fallback: buscar cualquier td.titclientev con formato de nombre
        const allTd = document.querySelectorAll('td.titclientev');
        for (const el of allTd) {
          const text = el.textContent.replace(/&nbsp;/g, '').trim();
          // El nombre del usuario típicamente tiene formato "Nombre Apellido" o "Nombre A. Apellido"
          // Excluir textos como "Corporación" que son una sola palabra
          if (text.match(/^[A-Z][a-záéíóú]+\s+[A-Z]/)) {
            return text;
          }
        }
        
        return null;
      });
      
      if (userName) {
        console.log(`[DEBUG] Usuario detectado en frame: "${frame.name()}"`);
        console.log(`[DEBUG] Usuario logueado: "${userName}"`);
        return userName;
      }
    }
    
    console.log('[DEBUG] No se encontró el usuario en ningún frame');
    
    // Fallback: preguntar al usuario
    console.log('\nNo se pudo detectar el usuario automáticamente.');
    const manualUser = (await prompt.ask('Ingresa el nombre exacto que aparece en la columna "Usuario Transacción" (o presiona Enter para omitir): ')).trim() || null;

    if (manualUser) {
      console.log(`[DEBUG] Usuario ingresado manualmente: "${manualUser}"`);
    } else {
      console.log('[DEBUG] Usuario omitido, mostrando todos los registros');
    }

    return manualUser;
  } catch (err) {
    console.log('[DEBUG] Error extrayendo usuario:', err.message);
    return null;
  }
};

const extractRegistrations = async (frameTree, page, startDate = null, currentUser = null) => {
  try {
    const allDates = [];
    let currentPage = 1;
    let hasNextPage = true;
    const MAX_PAGES = 5;
    
    let startTimestamp = null;
    if (startDate) {
      const [dd, mm, yyyy] = startDate.split('/');
      startTimestamp = new Date(`${yyyy}-${mm}-${dd}`).getTime();
    }
    
    while (hasNextPage && currentPage <= MAX_PAGES) {
      console.log(`      [DEBUG] Extrayendo página ${currentPage}...`);
      const registrations = await frameTree.evaluate((currentUser) => {
        const dates = [];
        const tables = document.querySelectorAll('table');
        
        for (const table of tables) {
          const headerRow = table.querySelector('tr');
          if (!headerRow) continue;
          
          const headers = Array.from(headerRow.querySelectorAll('td, th')).map(h => h.textContent.trim());
          const fechaIndex = headers.findIndex(h => h.includes('Fecha Transacción'));
          const usuarioIndex = headers.findIndex(h => h.includes('Usuario Transacción'));
          
          if (fechaIndex === -1) continue;
          
          const rows = table.querySelectorAll('tr');
          for (let i = 1; i < rows.length; i++) {
            const cells = rows[i].querySelectorAll('td');
            if (cells.length > fechaIndex) {
              // Si hay currentUser y columna de usuario, filtrar
              if (currentUser && usuarioIndex !== -1 && cells.length > usuarioIndex) {
                const usuarioText = cells[usuarioIndex].textContent.trim();
                if (usuarioText !== currentUser) {
                  continue; // Saltar si no es el usuario logueado
                }
              }
              
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
      }, currentUser);
      
      console.log(`      [DEBUG] Página ${currentPage}: ${registrations.length} fechas encontradas`);
      if (registrations.length > 0) {
        console.log(`      [DEBUG] Fechas: ${registrations.join(', ')}`);
      }
      
      let allDatesOutOfRange = true;
      
      for (const dateStr of registrations) {
        const [dd, mm, yyyy] = dateStr.split('/');
        const dateTimestamp = new Date(`${yyyy}-${mm}-${dd}`).getTime();
        
        if (!startTimestamp) {
          allDates.push(dateStr);
          allDatesOutOfRange = false;
        } else {
          if (dateTimestamp >= startTimestamp) {
            allDates.push(dateStr);
            allDatesOutOfRange = false;
          }
        }
      }
      
      if (startTimestamp && registrations.length > 0 && allDatesOutOfRange) {
        console.log(`      [DEBUG] Todas las fechas están fuera del rango, deteniendo paginación`);
        break;
      }
      
      // Optimización: si la página 1 no trajo ninguna fecha del usuario, las
      // páginas siguientes (más antiguas) tampoco traerán en la práctica — cortar
      // la paginación evita navegaciones inútiles en items compartidos con mucho
      // tráfico (donde la página 1 está llena de transacciones de otros usuarios).
      if (currentPage === 1 && registrations.length === 0) {
        console.log(`      [DEBUG] Sin fechas del usuario en la página 1, deteniendo paginación`);
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
        await navigateFrameRobust(page, null, (u) => /page_trans=[1-9]\d*/.test(u));
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

// Parsea la tabla de transacciones de la página de detalle del item
// (itemsint_actualizar.asp). Devuelve [{ start, end, desc, id2, updateHref }]
// para la fecha objetivo (targetDate en formato YYYY-MM-DD): la columna
// "Fecha Transacción" expone la hora FINAL y "Tiempo" los minutos ->
// inicio = fin - duración. id2 y updateHref provienen del link de
// actualización de cada fila (transaccionesint_actualizar.asp...upd_trans=1).
const parseTransactionTable = async (frameTree, targetDate, currentUser = null) => {
  const rows = await frameTree.evaluate((targetDate, currentUser) => {
    const ranges = [];
    const tables = document.querySelectorAll('table');
    for (const table of tables) {
      const headerRow = table.querySelector('tr');
      if (!headerRow) continue;
      const headers = Array.from(headerRow.querySelectorAll('td, th')).map(h => h.textContent.trim());
      const fechaIndex = headers.findIndex(h => h.includes('Fecha Transacción'));
      const usuarioIndex = headers.findIndex(h => h.includes('Usuario Transacción'));
      const tiempoIndex = headers.findIndex(h => h.includes('Tiempo'));
      const descIndex = headers.findIndex(h => h.includes('Descripción'));
      if (fechaIndex === -1) continue;

      const trs = table.querySelectorAll('tr');
      for (let i = 1; i < trs.length; i++) {
        const cells = trs[i].querySelectorAll('td');
        if (cells.length <= fechaIndex) continue;
        if (currentUser && usuarioIndex !== -1 && cells.length > usuarioIndex) {
          const usuarioText = cells[usuarioIndex].textContent.trim();
          if (usuarioText !== currentUser) continue;
        }
        const fechaText = cells[fechaIndex].textContent.trim();
        const match = fechaText.match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})/);
        if (!match) continue;
        const fechaDate = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
        if (fechaDate !== targetDate) continue;

        const endMin = parseInt(match[4], 10) * 60 + parseInt(match[5], 10);
        let durationMin = 0;
        if (tiempoIndex !== -1 && cells.length > tiempoIndex) {
          const tMatch = cells[tiempoIndex].textContent.trim().match(/(\d+)\s*min/);
          if (tMatch) durationMin = parseInt(tMatch[1], 10);
        }
        const startMin = endMin - durationMin;
        const start = `${String(Math.floor(startMin / 60)).padStart(2, '0')}${String(startMin % 60).padStart(2, '0')}`;
        const end = `${String(Math.floor(endMin / 60)).padStart(2, '0')}${String(endMin % 60).padStart(2, '0')}`;
        const desc = (descIndex !== -1 && cells.length > descIndex)
          ? cells[descIndex].textContent.trim().substring(0, 60)
          : '';

        // id2 (id de la transacción) y href del link de actualización (UPD)
        let id2 = null;
        let updateHref = null;
        for (const link of trs[i].querySelectorAll('a')) {
          const href = link.href || '';
          const id2Match = href.match(/transaccionesint_actualizar\.asp[^'"]*id2=(\d+)/);
          if (id2Match) {
            id2 = id2Match[1];
            if (!updateHref || href.includes('upd_trans=1')) updateHref = href;
          }
        }
        ranges.push({ start, end, desc, id2, updateHref });
      }
    }
    return ranges;
  }, targetDate, currentUser);
  return rows;
};

// Lee los rangos horarios ya registrados por el usuario en el item para una
// fecha dada. Navega al detalle del item (itemsint_actualizar.asp) desde el
// formulario de creación (mismos query params, cambia solo el script), lee la
// tabla de transacciones (página 1; la de la fecha objetivo es la primera fila
// por orden descendente) y deduce el rango: la columna "Fecha Transacción"
// expone la hora FINAL y "Tiempo" los minutos -> inicio = fin - duración.
// Devuelve { ranges: [{start, end, desc}], count } o null si no pudo leer
// (fail-open: no bloquea el registro).
const getExistingRanges = async (frameTree, page, dateStr, currentUser = null, catValue = null, transValue = null) => {
  try {
    const formUrl = await frameTree.evaluate(() => window.location.href);
    const detailUrl = formUrl.replace('transaccionesint_crear.asp', 'itemsint_actualizar.asp');
    if (detailUrl === formUrl) return null; // no es el formulario de creación

    await navigateFrameRobust(page, async (ft) => {
      await ft.evaluate((href) => { window.location.href = href; }, detailUrl);
    }, (u) => u.includes('itemsint_actualizar.asp'));
    await delay(1200);
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) return null;

    const [dd, mm, yyyy] = dateStr.split('/');
    const targetDate = `${yyyy}-${mm}-${dd}`;

    const rows = await parseTransactionTable(frameTree, targetDate, currentUser);

    // Volver al formulario de creación
    await navigateFrameRobust(page, async (ft) => {
      await ft.evaluate((href) => { window.location.href = href; }, formUrl);
    }, (u) => u.includes('transaccionesint_crear.asp'));
    await delay(1500);
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) return null;
    await frameTree.waitForSelector('select');

    // La recarga resetea los selects obligatorios: re-seleccionar
    if (catValue) {
      await frameTree.select('select[name="id_categoria"]', catValue);
      await delay(1500);
    }
    if (transValue) {
      await frameTree.select('select[name="cod_tipotransaccion"]', transValue);
    }

    return { ranges: rows, count: rows.length };
  } catch (err) {
    console.log('  ✗ Error leyendo registros existentes:', err.message);
    return null;
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

const showMissingRegistrations = async (page, browser, company, usernameDaybeat, password, holidays = []) => {
  console.log('====================================');
  console.log('CONSULTANDO DÍAS SIN REGISTRO');
  console.log('====================================');
  
  const { days: daysToCheck, label: periodLabel } = await askPeriod('consultar');
  
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
  await navigateFrameRobust(page, async (ft) => {
    await ft.click('input[type="submit"]');
  }, (u) => u.includes('requerimientos.asp'), 20000);
  
  console.log('Login completado, esperando carga de página...');
  await delay(3000);
  
  // Obtener el nombre del usuario logueado para filtrar registros
  const currentUser = await getCurrentUser(page);
  if (currentUser) {
    console.log(`\n[INFO] Filtrando registros del usuario: ${currentUser}`);
  } else {
    console.log('\n[WARN] No se especificó usuario, mostrando todos los registros');
  }
  
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
    await navigateFrameRobust(page, async (ft) => {
      await ft.evaluate(el => el.click(), divHandleConsulta);
    }, (u) => u.includes('requerimientos.asp') && !u.includes('flag=resp'));
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
  const startDate = new Date(today.getTime() - (daysToCheck * 24 * 60 * 60 * 1000));
  const startDateStr = `${String(startDate.getDate()).padStart(2, '0')}/${String(startDate.getMonth() + 1).padStart(2, '0')}/${startDate.getFullYear()}`;
  console.log(`[DEBUG] Rango de búsqueda: ${startDateStr} a ${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`);

  const businessDays = getBusinessDays(startDate, today, holidays);
   
  // Caché por usuario: si ya se escaneó y el período pedido está cubierto por la
  // ventana cacheada, se evita el recorrido completo de proyectos/items (lento).
  // Se pregunta cada vez: cache por defecto, "reescan" fuerza el recorrido.
  const registrationsCache = loadRegistrationsCache();
  const cachedUser = getCachedUser(registrationsCache, currentUser);
  let existingDates = null;

  if (cachedUser) {
    const cacheCoversPeriod = !cachedUser.scannedFrom || dateDDMMYYYYToTimestamp(cachedUser.scannedFrom) <= dateDDMMYYYYToTimestamp(startDateStr);
    if (!cacheCoversPeriod) {
      console.log(`La caché cubre desde ${cachedUser.scannedFrom} y el período pedido arranca antes. Re-escaneando...`);
    } else {
      const cacheDate = formatDateFromISO(cachedUser.lastScan);
      let cachePrompt = `\n¿Usar caché de registros del ${cacheDate} (${cachedUser.dates.length} días YA registrados`;
      if (cachedUser.dates.length > 0) {
        const missingFromCache = getMissingRegistrations(cachedUser.dates, businessDays);
        cachePrompt += `, ${missingFromCache.length} FALTANTES`;
      }
      cachePrompt += `) o re-escanear? (cache/reescan): `;
      const useCache = (await prompt.ask(cachePrompt)).trim().toLowerCase() !== 'reescan';

      if (useCache) {
        if (cachedUser.dates.length === 0) {
          console.log('La caché no tiene fechas registradas. Re-escaneando...');
        } else {
          console.log(`Usando caché: ${cachedUser.dates.length} fechas ya registradas (sin recorrer proyectos/items).`);
          existingDates = cachedUser.dates;
        }
      }
    }
  }

  if (!existingDates) {
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
      await navigateFrameRobust(page, null, (u) => u.includes('itemsint.asp'));
      await delay(1500);
      
      // Guardar URL de items para volver
      const itemsUrl = await frameTree.evaluate(() => window.location.href);
      
      // Buscar items en este proyecto (todas las páginas)
      const items = await collectAllItems(frameTree, page);
      
      console.log(`  Items encontrados: ${items.length}`);
      
      // Iterar por cada item
      for (const item of items) {
        console.log(`    Procesando item: ${item.text}`);
        
        // Navegar al item
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, item.href);
      await navigateFrameRobust(page, null, (u) => u.includes('itemsint_actualizar.asp'));
      await delay(1500);
        
        // Extraer fechas de las transacciones (con paginación limitada al rango y filtrado por usuario)
        const dates = await extractRegistrations(frameTree, page, startDateStr, currentUser);
        console.log(`    Transacciones encontradas: ${dates.length}`);
        allDates.push(...dates);
        
        // Volver a la lista de items navegando directamente
        await frameTree.evaluate((href) => {
          window.location.href = href;
        }, itemsUrl);
        await navigateFrameRobust(page, null, (u) => u.includes('itemsint.asp'));
        await delay(1000);
      }
      
      // Volver a la lista de proyectos navegando directamente
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, consultaUrl);
      await navigateFrameRobust(page, null, (u) => u.includes('requerimientos.asp'));
      await delay(1000);
    }
    
    existingDates = [...new Set(allDates)];
    if (currentUser) {
      mergeDatesForUser(registrationsCache, currentUser, existingDates, startDateStr);
      console.log('Caché de registros actualizada.');
    }
  }
  
console.log(`\n\nTotal de registros encontrados: ${existingDates.length}`);
  console.log('[DEBUG] Fechas encontradas:', existingDates.sort().join(', '));
   
  console.log('[DEBUG] Total días hábiles en el rango:', businessDays.length);
  console.log('[DEBUG] Días hábiles:', businessDays.join(', '));
   
  const missingDays = getMissingRegistrations(existingDates, businessDays);
   
  console.log('\n====================================');
  console.log(`DÍAS HÁBILES SIN REGISTRO (últimos ${periodLabel}): ${missingDays.length}`);
  console.log('====================================');
  
  if (missingDays.length === 0) {
    console.log('¡Todos los días hábiles tienen registro!');
  } else {
    missingDays.forEach(day => console.log(day));
  }
  
  console.log('====================================');
  
  prompt.close();
  browser.close();
};


const registerBulkMissingDays = async (page, browser, company, usernameDaybeat, password, holidays = []) => {
  console.log('====================================');
  console.log('REGISTRO MASIVO DE DÍAS SIN REGISTRO');
  console.log('====================================');
  
  const { days: daysToCheck, label: periodLabel } = await askPeriod('registrar');
  
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
  await navigateFrameRobust(page, async (ft) => {
    await ft.click('input[type="submit"]');
  }, (u) => u.includes('requerimientos.asp'), 20000);
  
  console.log('Login completado, esperando carga de página...');
  await delay(3000);
  
  // Obtener el nombre del usuario logueado para filtrar registros
  const currentUser = await getCurrentUser(page);
  if (currentUser) {
    console.log(`\n[INFO] Filtrando registros del usuario: ${currentUser}`);
  } else {
    console.log('\n[WARN] No se especificó usuario, mostrando todos los registros');
  }
  
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
    await navigateFrameRobust(page, async (ft) => {
      await ft.evaluate(el => el.click(), divHandleConsulta);
    }, (u) => u.includes('requerimientos.asp') && !u.includes('flag=resp'));
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
  const startDate = new Date(today.getTime() - (daysToCheck * 24 * 60 * 60 * 1000));
  const startDateStr = `${String(startDate.getDate()).padStart(2, '0')}/${String(startDate.getMonth() + 1).padStart(2, '0')}/${startDate.getFullYear()}`;
  console.log(`[DEBUG] Rango de búsqueda: ${startDateStr} a ${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`);

  const businessDays = getBusinessDays(startDate, today, holidays);
   
  // Caché por usuario: si ya se escaneó y el período pedido está cubierto por la
  // ventana cacheada, se evita el recorrido completo de proyectos/items (lento).
  // Se pregunta cada vez: cache por defecto, "reescan" fuerza el recorrido.
  const registrationsCache = loadRegistrationsCache();
  const cachedUser = getCachedUser(registrationsCache, currentUser);
  let existingDates = null;

  if (cachedUser) {
    const cacheCoversPeriod = !cachedUser.scannedFrom || dateDDMMYYYYToTimestamp(cachedUser.scannedFrom) <= dateDDMMYYYYToTimestamp(startDateStr);
    if (!cacheCoversPeriod) {
      console.log(`La caché cubre desde ${cachedUser.scannedFrom} y el período pedido arranca antes. Re-escaneando...`);
    } else {
      const cacheDate = formatDateFromISO(cachedUser.lastScan);
      let cachePrompt = `\n¿Usar caché de registros del ${cacheDate} (${cachedUser.dates.length} días YA registrados`;
      if (cachedUser.dates.length > 0) {
        const missingFromCache = getMissingRegistrations(cachedUser.dates, businessDays);
        cachePrompt += `, ${missingFromCache.length} FALTANTES`;
      }
      cachePrompt += `) o re-escanear? (cache/reescan): `;
      const useCache = (await prompt.ask(cachePrompt)).trim().toLowerCase() !== 'reescan';

      if (useCache) {
        if (cachedUser.dates.length === 0) {
          console.log('La caché no tiene fechas registradas. Re-escaneando...');
        } else {
          console.log(`Usando caché: ${cachedUser.dates.length} días ya registrados (sin recorrer proyectos/items).`);
          existingDates = cachedUser.dates;
        }
      }
    }
  }

  if (!existingDates) {
    const allDates = [];
    const consultaUrl = await frameTree.evaluate(() => window.location.href);
    
    for (const project of availableLinks) {
      console.log(`\nProcesando proyecto: ${project.text}`);
      
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, project.href);
      await navigateFrameRobust(page, null, (u) => u.includes('itemsint.asp'));
      await delay(1500);
      
      const itemsUrl = await frameTree.evaluate(() => window.location.href);
      
      const items = await collectAllItems(frameTree, page);
      
      console.log(`  Items encontrados: ${items.length}`);
      
      for (const item of items) {
        console.log(`    Procesando item: ${item.text}`);
        
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, item.href);
      await navigateFrameRobust(page, null, (u) => u.includes('itemsint_actualizar.asp'));
      await delay(1500);
        
        const dates = await extractRegistrations(frameTree, page, startDateStr, currentUser);
        console.log(`    Transacciones encontradas: ${dates.length}`);
        if (dates.length > 0) {
          console.log(`    Fechas: ${dates.join(', ')}`);
        }
        allDates.push(...dates);
        
        await frameTree.evaluate((href) => {
          window.location.href = href;
        }, itemsUrl);
        await navigateFrameRobust(page, null, (u) => u.includes('itemsint.asp'));
        await delay(1000);
      }
      
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, itemsUrl);
      await navigateFrameRobust(page, null, (u) => u.includes('itemsint.asp'));
      await delay(1000);
    }
    
    existingDates = [...new Set(allDates)];
    if (currentUser) {
      mergeDatesForUser(registrationsCache, currentUser, existingDates, startDateStr);
      console.log('Caché de registros actualizada.');
    }
  }
  
console.log(`\n\nTotal de registros encontrados: ${existingDates.length}`);
  console.log('[DEBUG] Fechas encontradas:', existingDates.sort().join(', '));
   
  console.log('[DEBUG] Total días hábiles en el rango:', businessDays.length);
  console.log('[DEBUG] Días hábiles:', businessDays.join(', '));
   
  const missingDays = getMissingRegistrations(existingDates, businessDays);
   
  console.log('\n====================================');
  console.log(`DÍAS HÁBILES SIN REGISTRO (últimos ${periodLabel}): ${missingDays.length}`);
  console.log('====================================');
  
  if (missingDays.length === 0) {
    console.log('¡Todos los días hábiles tienen registro!');
    prompt.close();
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
  await navigateFrameRobust(page, null, (u) => u.includes('requerimientos.asp'));
  await delay(1500);
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const links = await listElements(frameTree, 'a', 'itemsint.asp', true);

  const sectionIndex = await prompt.askSelect({
    message: 'Seleccione la sección donde registrar:',
    choices: links.map((l, i) => ({ name: l.text, value: i }))
  });
  
  if (sectionIndex < 0 || sectionIndex >= links.length) {
    console.log('Opción inválida');
    prompt.close();
    browser.close();
    return;
  }
  
  const selectedSection = links[sectionIndex];
  await frameTree.evaluate((href) => {
    window.location.href = href;
  }, selectedSection.href);
  await navigateFrameRobust(page, null, (u) => u.includes('itemsint.asp'));
  await delay(1500);
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const items = await collectAllItems(frameTree, page);

  console.log('Seleccione el item donde registrar:');
  const selectedItem = await selectItemAndNavigate(frameTree, page, items, false);

  if (!selectedItem) {
    console.log('Opción inválida');
    prompt.close();
    browser.close();
    return;
  }

  await delay(1500);
  
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const itemUrl = await frameTree.evaluate(() => window.location.href);
  await frameTree.waitForSelector('select');
  
  console.log('\nSELECCIONE LA CATEGORIA: ');
  const optionsCategory = await listElements(frameTree, 'select[name="id_categoria"]>option', null, true);
  const categoryIndex = await prompt.askSelect({
    message: 'Número de categoría:',
    choices: optionsCategory.map((o, i) => ({ name: o.text, value: i }))
  });
  
  if (categoryIndex < 0 || categoryIndex >= optionsCategory.length) {
    console.log('Opción inválida');
    prompt.close();
    browser.close();
    return;
  }
  
  const selectedCategory = optionsCategory[categoryIndex];
  
  // Seleccionar la categoría primero para que se carguen los tipos de transacción
  await frameTree.select('select[name="id_categoria"]', selectedCategory.value);
  await delay(1500); // Esperar a que se carguen las opciones dinámicas
  
  console.log('\nSELECCIONE TIPO DE TRANSACCION: ');
  const optionsTransaction = await listElements(frameTree, 'select[name="cod_tipotransaccion"]>option', null, true);
  const transactionIndex = await prompt.askSelect({
    message: 'Número de tipo de transacción:',
    choices: optionsTransaction.map((o, i) => ({ name: o.text, value: i }))
  });
  
  if (transactionIndex < 0 || transactionIndex >= optionsTransaction.length) {
    console.log('Opción inválida');
    prompt.close();
    browser.close();
    return;
  }
  
  const selectedTransaction = optionsTransaction[transactionIndex];
  
  const rootDir = resolveRootDir(process.env.ROOT_DIR);
  console.log('\nBuscando repositorios en:', rootDir);
  const repos = getReposWithCache(rootDir);
  console.log(`Repositorios encontrados: ${repos.length}`);
  
  const author = getGitAuthor(repos);
  if (author) {
    console.log(`Filtrando commits por autor: ${author}`);
  }
  
  const hours = getLastUsedHours();
  const startTime = hours.start;
  const endTime = hours.end;
  
  // Preguntar si se desea incluir información de Jira en los reportes
  let useJira = false;
  if (isConfigured()) {
    useJira = await prompt.askConfirm('¿Desea incluir información de Jira (issues/comentarios/worklogs) en los reportes?');
  }
  
  console.log(`\nHorario a usar: ${startTime} - ${endTime}`);
  console.log(`Categoría: ${selectedCategory.text}`);
  console.log(`Tipo de transacción: ${selectedTransaction.text}`);
  console.log(`Item: ${selectedItem.text}`);
  console.log(`Incluir info de Jira: ${useJira ? 'Sí' : 'No'}`);
  console.log(`Días a registrar: ${missingDays.length}`);
  
  if (!(await prompt.askConfirm('¿Desea continuar con el registro masivo?'))) {
    console.log('Registro masivo cancelado');
    prompt.close();
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
      let extraContext = null;
      let geminiUsed = false;
      
      // Consultar actividad de Jira para el día
      if (useJira) {
        console.log('  Consultando actividad en Jira...');
        try {
          const activity = await getDailyActivity(day);
          extraContext = formatActivityForReport(activity);
        } catch (err) {
          console.log(`  ✗ Error consultando Jira para ${day}: ${err.message}`);
        }
      }
      
      if (context === 'no-commits') {
        if (ai.isAIEnabled()) {
          console.log('  Generando texto variado con la IA...');
          const fakeCommits = ['Sin commits específicos'];
          const aiResult = await generateWithGemini(fakeCommits, 'no-commits', day, extraContext);
          
          if (aiResult) {
            title = aiResult.title;
            detail = aiResult.detail;
            geminiUsed = true;
            console.log('  ✓ Texto variado generado con la IA');
          } else {
            console.log('  ✗ IA falló, usando texto genérico por defecto');
            const genericText = generateGenericText(day);
            title = genericText.title;
            detail = genericText.detail;
          }
        } else {
          console.log('  Sin IA configurada, usando texto genérico variado');
          const genericText = generateGenericText(day);
          title = genericText.title;
          detail = genericText.detail;
        }
      } else if (ai.isAIEnabled() && commitsToUse.length > 0) {
        console.log(`  Generando con la IA (contexto: ${context})...`);
        const aiResult = await generateWithGemini(commitsToUse, context, day, extraContext);
        
        if (aiResult) {
          title = aiResult.title;
          detail = aiResult.detail;
          geminiUsed = true;
          console.log('  ✓ Generado con la IA');
        } else {
          console.log('  ✗ IA falló, usando método por defecto');
          const prefix = getContextPrefix(day, commitsWithDates);
          const summary = summarizeCommits(commitsToUse);
          title = prefix + summary;
          detail = generateDetail(commitsToUse);
        }
      } else {
        if (!ai.isAIEnabled() && commitsToUse.length > 0) {
          console.log('  Sin IA configurada, usando método por defecto');
        }
        const prefix = getContextPrefix(day, commitsWithDates);
        const summary = summarizeCommits(commitsToUse);
        title = prefix + summary;
        detail = generateDetail(commitsToUse);
      }
      
      // Agregar el bloque de Jira al detalle cuando no lo generó la IA
      if (extraContext && !geminiUsed) {
        detail = `${detail}\n\n${extraContext}`;
      }
      
      console.log(`  Título: ${title.substring(0, 50)}...`);
      
      // Navegar a la página del item (que es el formulario de nueva transacción)
      await frameTree.evaluate((href) => {
        window.location.href = href;
      }, itemUrl);
      await navigateFrameRobust(page, null, (u) => u.includes('transaccionesint_crear.asp'));
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
  
  if (successDays.length > 0 && currentUser) {
    mergeDatesForUser(registrationsCache, currentUser, successDays, null);
    console.log('Caché de registros actualizada con los días registrados.');
  }
  
  await closeConnection();
  prompt.close();
  browser.close();
};

// Lee el estado actual del formulario de actualización de transacción
// (transaccionesint_actualizar.asp): valores seleccionados y opciones de los
// selects, campos de texto y detalle. Útil para el flujo interactivo de
// corrección (Enter = conservar valor actual).
const readTransactionForm = async (frameTree) => {
  return frameTree.evaluate(() => {
    const getVal = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.value : '';
    };
    const getText = (sel) => {
      const el = document.querySelector(sel);
      return el && el.selectedIndex >= 0 ? el.options[el.selectedIndex].text.trim() : '';
    };
    const getOptions = (sel) => Array.from(document.querySelectorAll(sel))
      .map(o => ({ value: o.value, text: o.textContent.trim() }))
      .filter(o => o.value !== '');
    return {
      categoria: { value: getVal('select[name="id_categoria"]'), text: getText('select[name="id_categoria"]') },
      tipo: { value: getVal('select[name="cod_tipotransaccion"]'), text: getText('select[name="cod_tipotransaccion"]') },
      descripcion: getVal('input[name="descripcion_corta"]'),
      fecha: getVal('input[name="fechaini"]'),
      horaini: getVal('input[name="horaini"]'),
      horafin: getVal('input[name="horafin"]'),
      detalle: getVal('textarea[name="texto_largo"]'),
      optionsCategoria: getOptions('select[name="id_categoria"]>option'),
      optionsTipo: getOptions('select[name="cod_tipotransaccion"]>option')
    };
  });
};

// Núcleo reutilizable de corrección: aplica los campos indicados en `fields`
// al formulario de actualización de una transacción y lo envía con manejo de
// diálogo (patrón del registro por bloques). Si `updateHref` se omite se
// asume que el frame ya está en el formulario (caso del flujo interactivo).
// fields: { category, transactionType, descripcion, fecha, horaini, horafin,
// detalle } — valores undefined se ignoran (conservan el valor actual);
// fecha en formato DDMMYYYY. Devuelve { success, message } sin cerrar nada.
const updateTransaction = async (frameTree, page, updateHref = null, fields = {}) => {
  try {
    if (updateHref) {
      await navigateFrameRobust(page, async (ft) => {
        await ft.evaluate((href) => { window.location.href = href; }, updateHref);
      }, (u) => u.includes('transaccionesint_actualizar.asp'));
      await delay(1200);
    }
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) return { success: false, message: 'Frame no encontrado' };
    await frameTree.waitForSelector('select[name="id_categoria"]');

    const setInput = (selector, value) =>
      frameTree.$eval(selector, (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, value);

    // Mismo orden que el formulario de creación: categoría primero (carga
    // dependiente del tipo) y luego el resto.
    if (fields.category !== undefined) {
      await frameTree.select('select[name="id_categoria"]', String(fields.category));
      await delay(1500);
    }
    if (fields.transactionType !== undefined) {
      await frameTree.select('select[name="cod_tipotransaccion"]', String(fields.transactionType));
    }
    if (fields.descripcion !== undefined && fields.descripcion.trim() !== '') {
      await setInput('input[name="descripcion_corta"]', fields.descripcion.trim());
    }
    if (fields.fecha !== undefined) {
      await setInput('input[name="fechaini"]', fields.fecha);
    }
    if (fields.horaini !== undefined) {
      await setInput('input[name="horaini"]', fields.horaini);
    }
    if (fields.horafin !== undefined) {
      await setInput('input[name="horafin"]', fields.horafin);
    }
    if (fields.detalle !== undefined && fields.detalle.trim() !== '') {
      await setInput('textarea[name="texto_largo"]', fields.detalle.trim());
    }

    // Listener del dialog ANTES del click (evita race condition)
    const dialogPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ handled: false, message: '' }), 8000);
      page.once('dialog', async (dialog) => {
        clearTimeout(timeout);
        const message = dialog.message();
        console.log(`  Diálogo: ${message}`);
        await dialog.accept();
        resolve({ handled: true, message });
      });
    });
    await frameTree.click('input[type="submit"][class="bot"]');
    const result = await dialogPromise;

    if (!result.handled) return { success: false, message: 'Sin respuesta del servidor (timeout)' };
    return { success: /exitosamente/i.test(result.message), message: result.message };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

// Opción de menú: corregir / mover un registro existente. Daybeat NO expone
// borrado de transacciones (verificado en la app real); la única mutación es
// el UPDATE del formulario transaccionesint_actualizar.asp. "Eliminar" un
// registro = corregirlo o moverlo (p.ej. cambiar la fecha para liberar un
// día mal registrado). Reutiliza parseTransactionTable (listado) y
// updateTransaction (edición).
const correctRegistration = async (page, browser, company, usernameDaybeat, password, holidays = []) => {
  console.log('====================================');
  console.log('CORREGIR / MOVER REGISTRO');
  console.log('====================================');

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
  await navigateFrameRobust(page, async (ft) => {
    await ft.click('input[type="submit"]');
  }, (u) => u.includes('requerimientos.asp'), 20000);

  console.log('Login completado, esperando carga de página...');
  await delay(3000);

  const currentUser = await getCurrentUser(page);
  if (currentUser) {
    console.log(`\n[INFO] Filtrando registros del usuario: ${currentUser}`);
  }

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

  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('div');
  const divHandleConsulta = await frameTree.evaluateHandle(() => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Consultar');
  });
  if (divHandleConsulta) {
    await navigateFrameRobust(page, async (ft) => {
      await ft.evaluate(el => el.click(), divHandleConsulta);
    }, (u) => u.includes('requerimientos.asp') && !u.includes('flag=resp'));
  }

  // Mostrar todos los requerimientos (desde 01/01/2000)
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('input');
  const inputHandle = await frameTree.$('input[name="re_fechad"][type="text"]');
  if (inputHandle) {
    await frameTree.evaluate(el => el.focus(), inputHandle);
    await frameTree.evaluate((el, value) => {
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, inputHandle, '01012000');
    await navigateFrameRobust(page, async (ft) => {
      await ft.evaluate(() => {
        const btn = document.querySelector('input[type="image"]');
        if (btn) btn.click();
      });
    }, (u) => u.includes('requerimientos.asp?flag=') && !u.includes('flag=resp'));
  }

  // Seleccionar sección (reusando la ruta cacheada si existe)
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const links = await listElements(frameTree, 'a', 'itemsint.asp', true);

  const cachedPath = loadPathCache();
  let useCachedPath = false;

  if (cachedPath?.section?.text && cachedPath?.item?.text) {
    const sectionExists = links.some(l => normalizeText(l.text) === normalizeText(cachedPath.section.text));
    if (sectionExists) {
      console.log(`\nRuta anterior: ${cachedPath.section.text} > ${cachedPath.item.text}`);
      useCachedPath = await prompt.askConfirm('\n¿Usar la misma ruta?');
    } else {
      console.log('\nLa sección anterior ya no existe. Seleccione manualmente.');
    }
  }

  if (useCachedPath) {
    const selectedLink = links.find(l => l.text === cachedPath.section.text);
    const linkHandle = await frameTree.evaluateHandle((text, selector) => {
      const elements = Array.from(document.querySelectorAll(selector));
      return elements.find(el => el.textContent.trim() === text);
    }, selectedLink.text, 'a');
    if (linkHandle) await frameTree.evaluate(el => el.click(), linkHandle);
  } else {
    await whriteAndNavigateElementSelect(frameTree, 'a', links);
  }
  await navigateFrameRobust(page, null, (u) => u.includes('itemsint.asp'));

  // Seleccionar item: el link con el texto del item es el detalle
  // (itemsint_actualizar.asp), no el formulario de creación.
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const otherLinks = await collectAllItems(frameTree, page);
  if (useCachedPath) {
    const itemIdx = otherLinks.findIndex(l => normalizeText(l.text) === normalizeText(cachedPath.item.text));
    if (itemIdx >= 0) {
      await navigateFrameRobust(page, async (ft) => {
        await ft.evaluate((href) => {
          window.location.href = href;
        }, otherLinks[itemIdx].href);
      }, (u) => u.includes('itemsint_actualizar.asp'));
    } else {
      console.log('\nEl item anterior ya no existe. Seleccione manualmente.');
      await selectItemAndNavigate(frameTree, page, otherLinks, true);
    }
  } else {
    await selectItemAndNavigate(frameTree, page, otherLinks, true);
  }

  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('table');
  const itemDetailUrl = await frameTree.evaluate(() => window.location.href);

  const today = new Date();
  const defaultDateStr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;

  let keepCorrecting = true;
  while (keepCorrecting) {
    const dateAnswer = await questionUserResponse(frameTree, `\nFecha del registro a corregir (DD/MM/AAAA) [${defaultDateStr}]: `);
    const dateStr = dateAnswer.trim() === '' ? defaultDateStr : dateAnswer.trim();

    // Re-navegar al detalle para refrescar la tabla
    await frameTree.evaluate((href) => { window.location.href = href; }, itemDetailUrl);
    await navigateFrameRobust(page, null, (u) => u.includes('itemsint_actualizar.asp'));
    await delay(1200);
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) break;
    await frameTree.waitForSelector('table');

    const [dd, mm, yyyy] = dateStr.split('/');
    const targetDate = `${yyyy}-${mm}-${dd}`;
    const rows = await parseTransactionTable(frameTree, targetDate, currentUser);

    if (rows.length === 0) {
      console.log(`\nNo hay registros del usuario en ${dateStr}.`);
      if (!(await prompt.askConfirm('¿Desea probar con otra fecha?'))) keepCorrecting = false;
      continue;
    }

    console.log('\nRegistros encontrados:');
    rows.forEach((r, i) => console.log(`  ${i + 1}. ${r.start} - ${r.end}  ${r.desc || ''}`));
    const pick = await questionUserResponse(frameTree, `\nSeleccione el registro a corregir (1-${rows.length}) o Enter para volver: `);
    const pickIdx = parseInt(pick, 10) - 1;
    if (isNaN(pickIdx) || pickIdx < 0 || pickIdx >= rows.length) {
      continue; // vuelve a pedir la fecha
    }

    const row = rows[pickIdx];
    if (!row.updateHref) {
      console.log('  ✗ No se pudo obtener el link de actualización del registro.');
      continue;
    }

    // Navegar al formulario de actualización y leer el estado actual
    await frameTree.evaluate((href) => { window.location.href = href; }, row.updateHref);
    await navigateFrameRobust(page, null, (u) => u.includes('transaccionesint_actualizar.asp'));
    await delay(1200);
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) break;
    await frameTree.waitForSelector('select[name="id_categoria"]');
    const form = await readTransactionForm(frameTree);

    const fmtDate = (f) => f && f.length === 8 ? `${f.slice(0, 2)}/${f.slice(2, 4)}/${f.slice(4)}` : (f || '');
    console.log(`\nRegistro seleccionado: ${row.start} - ${row.end}  ${row.desc || ''}`);
    console.log(`  Categoría: ${form.categoria.text} | Tipo: ${form.tipo.text}`);
    console.log(`  Fecha: ${fmtDate(form.fecha)} | Horario: ${form.horaini} - ${form.horafin}`);
    console.log('\nIngrese el nuevo valor para cada campo (Enter = conservar el actual):');

    const fields = {};

    console.log('\nCATEGORÍA:');
    form.optionsCategoria.forEach((o, i) => console.log(`  ${i + 1}. ${o.text}`));
    const catAnswer = await questionUserResponse(frameTree, `Categoría actual: ${form.categoria.text}. Nueva (número, Enter = mantener): `);
    const catIdx = parseInt(catAnswer, 10) - 1;
    if (!isNaN(catIdx) && catIdx >= 0 && catIdx < form.optionsCategoria.length) {
      fields.category = form.optionsCategoria[catIdx].value;
    }

    console.log('\nTIPO DE TRANSACCIÓN:');
    form.optionsTipo.forEach((o, i) => console.log(`  ${i + 1}. ${o.text}`));
    const tipoAnswer = await questionUserResponse(frameTree, `Tipo actual: ${form.tipo.text}. Nuevo (número, Enter = mantener): `);
    const tipoIdx = parseInt(tipoAnswer, 10) - 1;
    if (!isNaN(tipoIdx) && tipoIdx >= 0 && tipoIdx < form.optionsTipo.length) {
      fields.transactionType = form.optionsTipo[tipoIdx].value;
    }

    const descAnswer = await questionUserResponse(frameTree, `\nDescripción actual: ${form.descripcion || '(vacía)'}\nNueva descripción (Enter = mantener): `);
    if (descAnswer.trim() !== '') fields.descripcion = descAnswer.trim();

    const fechaAnswer = await questionUserResponse(frameTree, `Fecha actual: ${fmtDate(form.fecha)}. Nueva (DD/MM/AAAA, Enter = mantener): `);
    if (fechaAnswer.trim() !== '') {
      const fd = fechaAnswer.trim().split('/');
      if (fd.length === 3 && fd[0].trim() && fd[1].trim() && fd[2].trim()) {
        fields.fecha = `${fd[0].trim().padStart(2, '0')}${fd[1].trim().padStart(2, '0')}${fd[2].trim()}`;
      } else {
        console.log('  Formato de fecha inválido, se mantiene la actual.');
      }
    }

    const hiAnswer = await questionUserResponse(frameTree, `Hora inicio actual: ${form.horaini}. Nueva (HHMM, Enter = mantener): `);
    if (/^\d{4}$/.test(hiAnswer.trim())) fields.horaini = hiAnswer.trim();
    const hfAnswer = await questionUserResponse(frameTree, `Hora fin actual: ${form.horafin}. Nueva (HHMM, Enter = mantener): `);
    if (/^\d{4}$/.test(hfAnswer.trim())) fields.horafin = hfAnswer.trim();

    const detAnswer = await questionUserResponse(frameTree, `\nDetalle actual: ${form.detalle || '(vacío)'}\nNuevo detalle (Enter = mantener): `);
    if (detAnswer.trim() !== '') fields.detalle = detAnswer.trim();

    if (Object.keys(fields).length === 0) {
      console.log('\nNo se modificó ningún campo.');
      if (!(await prompt.askConfirm('¿Desea corregir otro registro?'))) keepCorrecting = false;
      continue;
    }

    console.log('\nCAMBIOS A APLICAR:');
    if (fields.category !== undefined) {
      const newText = form.optionsCategoria.find(o => o.value === String(fields.category))?.text || fields.category;
      console.log(`  Categoría: ${form.categoria.text} -> ${newText}`);
    }
    if (fields.transactionType !== undefined) {
      const newText = form.optionsTipo.find(o => o.value === String(fields.transactionType))?.text || fields.transactionType;
      console.log(`  Tipo: ${form.tipo.text} -> ${newText}`);
    }
    if (fields.descripcion !== undefined) console.log(`  Descripción: ${form.descripcion || '(vacía)'} -> ${fields.descripcion}`);
    if (fields.fecha !== undefined) console.log(`  Fecha: ${fmtDate(form.fecha)} -> ${fmtDate(fields.fecha)}`);
    if (fields.horaini !== undefined) console.log(`  Hora inicio: ${form.horaini} -> ${fields.horaini}`);
    if (fields.horafin !== undefined) console.log(`  Hora fin: ${form.horafin} -> ${fields.horafin}`);
    if (fields.detalle !== undefined) console.log(`  Detalle: ${form.detalle || '(vacío)'} -> ${fields.detalle}`);

    if (!(await prompt.askConfirm('\n¿Desea actualizar el registro?'))) {
      console.log('Actualización cancelada.');
      continue;
    }

    const result = await updateTransaction(frameTree, page, null, fields);
    if (result.success) {
      console.log('  ✓ Registro actualizado.');
    } else {
      console.log(`  ✗ Error al actualizar: ${result.message}`);
      if (result.message.includes('traslapa')) {
        console.log('  El horario se traslapa con otra transacción del mismo día.');
      }
    }

    if (!(await prompt.askConfirm('\n¿Desea corregir otro registro?'))) keepCorrecting = false;
  }

  console.log('Proceso finalizado.');
  await closeConnection();
  prompt.close();
  browser.close();
};

const listAndNavigateNewTransaction = async (frameTree, page) => {
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const items = await collectAllItems(frameTree, page);
  console.log(`[STAGE] Items encontrados: ${items.length}`);
  const selected = await selectItemAndNavigate(frameTree, page, items, false);
  return selected ? selected.text : null;
}

const registerNewTransaction = async (frameTree, page, autoData = null, cachedCategory = null, cachedTransaction = null, sectionText = null, itemText = null) => {
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  await frameTree.waitForSelector('select');

  // CATEGORÍA
  console.log('SELECCIONE LA CATEGORIA: ');
  const optionsCategory = await listElements(frameTree, 'select[name="id_categoria"]>option', null, true);
  let selectedCategoryValue = null;
  let selectedCategoryText = null;
  
  if (cachedCategory?.value) {
    const found = optionsCategory.find(o => o.value === cachedCategory.value);
    if (found) {
      console.log(`  Usando: ${cachedCategory.text}`);
      selectedCategoryValue = cachedCategory.value;
      selectedCategoryText = cachedCategory.text;
      await frameTree.select('select[name="id_categoria"]', cachedCategory.value);
      await delay(1500);
    } else {
      console.log('  Categoría anterior no existe. Seleccione manualmente.');
      await selectOptionSelector(frameTree, 'select[name="id_categoria"]', optionsCategory);
    }
  } else {
    await selectOptionSelector(frameTree, 'select[name="id_categoria"]', optionsCategory);
  }
  
  // Capturar selección actual del dropdown
  if (!selectedCategoryValue) {
    const selectedIdx = await frameTree.$eval('select[name="id_categoria"]', el => el.selectedIndex);
    selectedCategoryValue = optionsCategory[selectedIdx]?.value;
    selectedCategoryText = optionsCategory[selectedIdx]?.text;
  }

  // TIPO DE TRANSACCIÓN
  console.log('SELECCIONE TIPO DE TRANSACCION: ');
  const optionsTransaction = await listElements(frameTree, 'select[name="cod_tipotransaccion"]>option', null, true);
  let selectedTransactionValue = null;
  let selectedTransactionText = null;
  
  if (cachedTransaction?.value) {
    const found = optionsTransaction.find(o => o.value === cachedTransaction.value);
    if (found) {
      console.log(`  Usando: ${cachedTransaction.text}`);
      selectedTransactionValue = cachedTransaction.value;
      selectedTransactionText = cachedTransaction.text;
      await frameTree.select('select[name="cod_tipotransaccion"]', cachedTransaction.value);
    } else {
      console.log('  Transacción anterior no existe. Seleccione manualmente.');
      await selectOptionSelector(frameTree, 'select[name="cod_tipotransaccion"]', optionsTransaction);
    }
  } else {
    await selectOptionSelector(frameTree, 'select[name="cod_tipotransaccion"]', optionsTransaction);
  }
  
  // Capturar selección actual del dropdown
  if (!selectedTransactionValue) {
    const selectedIdx = await frameTree.$eval('select[name="cod_tipotransaccion"]', el => el.selectedIndex);
    selectedTransactionValue = optionsTransaction[selectedIdx]?.value;
    selectedTransactionText = optionsTransaction[selectedIdx]?.text;
  }

  // Guardar ruta para próxima vez
  if (sectionText && itemText && selectedCategoryValue && selectedTransactionValue) {
    savePathCache({
      section: { text: sectionText },
      item: { text: itemText },
      category: { value: selectedCategoryValue, text: selectedCategoryText },
      transactionType: { value: selectedTransactionValue, text: selectedTransactionText }
    });
    console.log('\n✓ Ruta guardada para próxima vez');
  }

  // Mostrar menú de modo de registro
  console.log('-------------------------');
  console.log('MODO DE REGISTRO:');
  console.log('1. Automático (commits de hoy)');
  console.log('2. Con IA (Gemini)');
  console.log('3. Automático fake (basado en días anteriores)');
  console.log('4. Manual');
  if (isConfigured()) {
    console.log('5. Con información de Jira');
  }
  console.log('-------------------------');

  const mode = await questionUserResponse(frameTree, 'Seleccione modo (1/2/3/4' + (isConfigured() ? '/5' : '') + '): ');

  // Opción de registro: un solo bloque (jornada completa) o varios bloques
  // según la actividad del día (solo en modos automáticos con horarios)
  let blockMode = '1';
  if (mode === '1' || mode === '2' || mode === '5') {
    const resp = await questionUserResponse(frameTree, '¿Cómo desea registrar? (1: Un solo bloque / 2: Varios bloques según actividad): ');
    blockMode = resp.trim() === '2' ? '2' : '1';
  }

  let title = null;
  let formattedDate = null;
  let startTime = null;
  let endTime = null;
  let detail = null;
  let selectedJiraActivity = null; // actividad Jira elegida en modo 5 (para bloques)
  let userExtraContext = null;     // contexto adicional del modo IA (para bloques)
  let today = new Date();
  let dd = String(today.getDate()).padStart(2, '0');
  let mm = String(today.getMonth() + 1).padStart(2, '0');
  let yyyy = today.getFullYear();
  let defaultDate = dd + mm + yyyy;

  if (mode === '1') {
    const rootDir = resolveRootDir(process.env.ROOT_DIR);
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = getReposWithCache(rootDir);
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

    // Con bloques la confirmación se difiere hasta después de la propuesta
    if (!(blockMode === '2' || await prompt.askConfirm('¿Desea continuar con estos datos?'))) {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  } else if (mode === '2') {
    // Modo Con IA (Gemini)
    const rootDir = resolveRootDir(process.env.ROOT_DIR);
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = getReposWithCache(rootDir);
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
    
    // Preguntar por contexto adicional (solo registro diario con IA)
    let extraContext = null;
    if (ai.isAIEnabled() && allCommits.length > 0) {
      console.log('\nCommits encontrados:');
      for (const commit of allCommits.slice(0, 10)) {
        console.log(`  - ${commit.substring(0, 80)}`);
      }
      if (allCommits.length > 10) {
        console.log(`  ... y ${allCommits.length - 10} más`);
      }
      
      if (await prompt.askConfirm('\n¿Desea agregar contexto adicional para la IA?')) {
        extraContext = await questionUserResponse(frameTree, 
          'Describa qué más hizo hoy (reuniones, debugging, diseño, etc.): ');
      }
      userExtraContext = extraContext;
    }
    
    // Intentar generar con IA
    if (ai.isAIEnabled() && allCommits.length > 0) {
      console.log('  Generando con la IA...');
      const aiResult = await generateWithGemini(allCommits, 'same-day', null, extraContext);
      
      if (aiResult) {
        title = aiResult.title;
        detail = aiResult.detail;
        console.log('  ✓ Generado con la IA');
      } else {
        console.log('  ✗ IA falló, usando método por defecto');
        title = allCommits.length > 0 ? summarizeCommits(allCommits) : generateFakeSummary(allCommits);
        detail = generateDetail(allCommits);
      }
    } else {
      if (!ai.isAIEnabled()) {
        console.log('  Sin IA configurada, usando método por defecto');
      }
      title = allCommits.length > 0 ? summarizeCommits(allCommits) : generateFakeSummary(allCommits);
      detail = generateDetail(allCommits);
    }
    
    console.log('-------------------------');
    console.log('RESUMEN CON IA:');
    console.log(`Título: ${title}`);
    console.log(`Detalle: ${detail}`);
    if (extraContext) {
      console.log(`Contexto adicional: ${extraContext}`);
    }
    console.log(`Fecha: ${dd}/${mm}/${yyyy}`);
    console.log(`Horario: ${startTime} - ${endTime}`);
    console.log('-------------------------');
    
    // Con bloques la confirmación se difiere hasta después de la propuesta
    if (!(blockMode === '2' || await prompt.askConfirm('¿Desea continuar con estos datos?'))) {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  } else if (mode === '5') {
    // Modo Con información de Jira
    const rootDir = resolveRootDir(process.env.ROOT_DIR);
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = getReposWithCache(rootDir);
    console.log(`Repositorios encontrados: ${repos.length}`);
    
    const author = getGitAuthor(repos);
    if (author) {
      console.log(`Filtrando commits por autor: ${author}`);
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
    
    // Consultar actividad de Jira (issues + comentarios + worklogs)
    let activity = null;
    let jiraContext = null;
    if (isConfigured()) {
      console.log('Consultando actividad en Jira...');
      try {
        activity = await getDailyActivity(today);
        if (activity.issues.length === 0 && activity.comments.length === 0 && activity.worklogs.length === 0) {
          console.log('  Sin actividad registrada en Jira para hoy.');
        } else {
          console.log('------------------------------------');
          console.log('ACTIVIDAD EN JIRA:');
          console.log(formatActivityForReport(activity));
          console.log('------------------------------------');
          // Selección interactiva: marcar qué se incluye en el reporte
          selectedJiraActivity = await selectJiraActivityMulti(activity);
          const hasContent =
            selectedJiraActivity.issues.length > 0 ||
            selectedJiraActivity.comments.length > 0 ||
            selectedJiraActivity.worklogs.length > 0;
          jiraContext = hasContent ? formatActivityForReport(selectedJiraActivity) : null;
        }
      } catch (err) {
        console.log(`  ✗ Error consultando Jira: ${err.message}`);
      }
    } else {
      console.log('  No hay ATLASSIAN_API_TOKEN. Se usará solo commits.');
    }
    
    // Generar reporte con IA o por defecto
    let geminiUsed = false;
    if (ai.isAIEnabled() && allCommits.length > 0) {
      console.log('  Generando con la IA...');
      const aiResult = await generateWithGemini(allCommits, 'same-day', null, jiraContext);
      if (aiResult) {
        title = aiResult.title;
        detail = aiResult.detail;
        geminiUsed = true;
        console.log('  ✓ Generado con la IA');
      } else {
        console.log('  ✗ IA falló, usando método por defecto');
      }
    } else if (!ai.isAIEnabled()) {
      console.log('  Sin IA configurada, usando método por defecto');
    }
    
    if (!geminiUsed) {
      if (allCommits.length > 0) {
        title = summarizeCommits(allCommits);
        detail = generateDetail(allCommits);
      } else if (activity && activity.issues.length > 0) {
        const firstIssue = activity.issues[0];
        title = smartTruncate(`Actividad en Jira: ${firstIssue.key} ${firstIssue.summary || ''}`, 100);
        detail = jiraContext;
      } else {
        title = generateFakeSummary(allCommits);
        detail = generateDetail(allCommits);
      }
      
      // Agregar el bloque de Jira al detalle cuando no lo generó la IA
      if (jiraContext && detail) {
        detail = `${detail}\n\n${jiraContext}`;
      }
    }
    
    console.log('-------------------------');
    console.log('RESUMEN CON JIRA:');
    console.log(`Título: ${title}`);
    console.log(`Detalle: ${detail}`);
    console.log(`Fecha: ${dd}/${mm}/${yyyy}`);
    console.log(`Horario: ${startTime} - ${endTime}`);
    console.log('-------------------------');
    
    // Con bloques la confirmación se difiere hasta después de la propuesta
    if (!(blockMode === '2' || await prompt.askConfirm('¿Desea continuar con estos datos?'))) {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  } else if (mode === '3') {
    const rootDir = resolveRootDir(process.env.ROOT_DIR);
    console.log('-------------------------');
    console.log('Buscando repositorios en:', rootDir);
    const repos = getReposWithCache(rootDir);
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

    if (!(await prompt.askConfirm('¿Desea continuar con estos datos?'))) {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  }

  // Validación anti-duplicado: leer los rangos ya registrados del día en este
  // item y avisar. No bloquea: el solape de Daybeat es por fecha Y hora, así
  // que registrar otra cosa con horas distintas es válido.
  let existingRanges = null;
  if (title && formattedDate) {
    const currentUser = await getCurrentUser(page);
    const dayStr = `${dd}/${mm}/${yyyy}`;
    existingRanges = await getExistingRanges(
      frameTree, page, dayStr, currentUser,
      selectedCategoryValue, selectedTransactionValue
    );
    if (existingRanges && existingRanges.count > 0) {
      console.log('---------------------------------------------------');
      console.log(`⚠ El día ${dd}/${mm}/${yyyy} ya tiene transacciones registradas en este item:`);
      for (const r of existingRanges.ranges) {
        const desc = r.desc ? `  (${r.desc})` : '';
        console.log(`  ${r.start} - ${r.end}${desc}`);
      }
      console.log('---------------------------------------------------');
      if (!(await prompt.askConfirm('¿Desea registrar de todos modos?'))) {
        console.log('Registro cancelado (día ya registrado).');
        await finishOrContinue(page, page.browser());
        return frameTree;
      }
    }
  }

  // Registro por bloques (opcional): reparte el día en varios bloques según
  // la actividad con horario (commits, comentarios y worklogs de Jira).
  let blocks = null;
  if (blockMode === '2' && title && startTime && endTime) {
    const rootDirBlocks = resolveRootDir(process.env.ROOT_DIR);
    const reposBlocks = getReposWithCache(rootDirBlocks);
    const authorBlocks = getGitAuthor(reposBlocks);
    const dayStr = `${dd}/${mm}/${yyyy}`;
    const events = [];
    for (const repo of reposBlocks) {
      for (const c of getCommitsWithTime(repo, dayStr, authorBlocks)) {
        events.push({ time: c.time, label: c.message, kind: 'commit', weight: 1 });
      }
    }
    if (selectedJiraActivity) {
      for (const comment of selectedJiraActivity.comments) {
        const time = comment.created ? isoToLocalHHMM(comment.created) : null;
        if (time) {
          events.push({ time, label: `Comentario ${comment.issueKey}: ${comment.body}`, kind: 'jira', weight: 1 });
        }
      }
      for (const worklog of selectedJiraActivity.worklogs) {
        const time = worklog.started ? isoToLocalHHMM(worklog.started) : null;
        if (time) {
          events.push({
            time,
            label: `Worklog ${worklog.issueKey}: ${worklog.timeSpent}`,
            kind: 'jira',
            weight: parseTimeSpentHours(worklog.timeSpent)
          });
        }
      }
    }
    for (const ev of events) ev.minutes = toMinutes(ev.time.replace(':', ''));
    blocks = buildDayBlocks(events.filter(ev => !isNaN(ev.minutes)), startTime, endTime);

    // Ajustar los bloques a los horarios libres (día parcialmente registrado)
    if (blocks && existingRanges && existingRanges.count > 0) {
      const adjusted = intersectBlocksWithFree(blocks, existingRanges.ranges, startTime, endTime);
      if (adjusted) {
        console.log('  Bloques ajustados a los horarios libres del día:');
        blocks = adjusted;
      } else {
        console.log('  No hay horarios libres para los bloques propuestos.');
        console.log('  El día ya está completamente registrado.');
        console.log('  Ejecutá de nuevo y usá la opción 4 "Corregir / mover registro" del menú principal para modificar los registros existentes.');
        await closeConnection();
        prompt.close();
        page.browser().close();
        return frameTree;
      }
    }

    if (blocks) {
      // Las incidencias no tienen hora: se adjuntan al bloque con más actividad
      if (selectedJiraActivity && selectedJiraActivity.issues.length > 0) {
        let maxIdx = 0;
        for (let i = 1; i < blocks.length; i++) {
          if (blocks[i].events.length > blocks[maxIdx].events.length) maxIdx = i;
        }
        blocks[maxIdx].issues = selectedJiraActivity.issues;
      }

      // Generar título/detalle de CADA bloque antes del preview (con IA en
      // modos 2 y 5). Se guardan en block.title/block.detail: lo que muestra
      // el preview es exactamente lo que se registra.
      const useAI = ai.isAIEnabled();
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const blockCommits = block.events.filter(ev => ev.kind === 'commit').map(ev => ev.label);
        const jiraLabels = block.events.filter(ev => ev.kind === 'jira').map(ev => ev.label);

        // Contexto combinado: Jira (labels + issues) y el contexto extra del
        // modo IA (solo en el primer bloque)
        const contextParts = [];
        if (jiraLabels.length > 0) {
          contextParts.push('Actividad en Jira:\n' + jiraLabels.map(l => `  - ${l}`).join('\n'));
        }
        if (block.issues && block.issues.length > 0) {
          contextParts.push('Incidencias:\n' + block.issues.map(issue => `  - ${issue.key}: ${issue.summary || 'Sin resumen'}`).join('\n'));
        }
        const blockContext = contextParts.length > 0 ? contextParts.join('\n\n') : null;
        const extraContext = [blockContext, i === 0 ? userExtraContext : null].filter(Boolean).join('\n\n') || null;

        // Con IA: los labels Jira se pasan como actividad cuando no hay commits
        if (useAI && (mode === '2' || mode === '5') && (blockCommits.length > 0 || jiraLabels.length > 0)) {
          const activitySource = blockCommits.length > 0 ? blockCommits : jiraLabels;
          const aiResult = await generateWithGemini(activitySource, 'same-day', null, extraContext);
          if (aiResult) {
            block.title = aiResult.title;
            block.detail = aiResult.detail;
            continue;
          }
        }

        // Fallback sin IA (o si falló): reglas por commits, o actividad Jira
        if (blockCommits.length > 0) {
          block.title = summarizeCommits(blockCommits);
          block.detail = generateDetail(blockCommits);
        } else if (jiraLabels.length > 0) {
          const firstLabel = jiraLabels[0];
          block.title = smartTruncate(`Actividad en Jira: ${firstLabel}`, 100);
          block.detail = jiraLabels.map(l => `- ${l}`).join('\n');
        } else {
          block.title = 'Actividad registrada';
          block.detail = 'Actividad del día';
        }
        if (blockContext) {
          block.detail += `\n\n${blockContext}`;
        }
      }

      console.log('-------------------------');
      console.log('BLOQUES PROPUESTOS (según actividad del día):');
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        console.log(`  ${i + 1}. ${b.start} - ${b.end}  (${b.events.length} actividad(es))`);
        console.log(`     Título: ${(b.title || '').substring(0, 110)}`);
        console.log(`     Detalle: ${(b.detail || '').replace(/\n/g, ' ').substring(0, 150)}`);
      }
      console.log('-------------------------');
      if (!(await prompt.askConfirm('¿Desea registrar estos bloques?'))) blocks = null;
    } else {
      console.log('  No hay suficiente actividad con horario para dividir el día. Se usará un solo bloque.');
    }
  }

  // ---- Registro por bloques (multi-transacción del mismo día) ----
  if (blocks) {
    const browser = page.browser();
    const formUrl = await frameTree.evaluate(() => window.location.href);
    // El handler global de diálogos es para un solo envío; durante el loop
    // cada bloque maneja su propio diálogo y se restaura al final.
    page.removeAllListeners('dialog');

    let blocksOk = true;
    for (let i = 0; i < blocks.length && blocksOk; i++) {
      const block = blocks[i];
      // El contenido (título/detalle) ya se generó en la fase de preview
      const blockTitle = block.title || 'Actividad registrada';
      const blockDetail = block.detail || 'Actividad del día';

      if (i > 0) {
        // Re-navegar al formulario para dejarlo fresco
        await frameTree.evaluate((href) => {
          window.location.href = href;
        }, formUrl);
        await navigateFrameRobust(page, null, (u) => u.includes('transaccionesint_crear.asp'));
        await delay(1500);
        frameTree = page.frames().find(frame => frame.name() === 'tres');
        await frameTree.waitForSelector('select');

        // La recarga resetea los selects obligatorios: re-seleccionar
        // categoría (esperando la carga dependiente) y tipo de transacción.
        if (selectedCategoryValue) {
          await frameTree.select('select[name="id_categoria"]', selectedCategoryValue);
          await delay(1500);
        }
        if (selectedTransactionValue) {
          await frameTree.select('select[name="cod_tipotransaccion"]', selectedTransactionValue);
        }
      }

      await frameTree.type('input[name="descripcion_corta"]', blockTitle);
      await frameTree.type('input[name="fechaini"]', formattedDate);
      await frameTree.type('input[name="horaini"]', block.start);
      await frameTree.type('input[name="horafin"]', block.end);
      await frameTree.type('textarea[name="texto_largo"]', blockDetail);

      // Listener del dialog ANTES del click (evita race condition)
      const dialogPromise = new Promise((resolve) => {
        const timeout = setTimeout(() => resolve({ handled: false, message: '' }), 8000);
        page.once('dialog', async (dialog) => {
          clearTimeout(timeout);
          const message = dialog.message();
          console.log(`  Diálogo: ${message}`);
          await dialog.accept();
          resolve({
            handled: true,
            success: message.includes('éxitosamente') || message.includes('exitosamente'),
            message
          });
        });
      });
      await frameTree.click('input[type="submit"][class="bot"]');
      const result = await dialogPromise;

      if (!result.handled || !result.success) {
        blocksOk = false;
        if (result.message && result.message.includes('traslapa')) {
          console.log(`  ✗ El periodo de la transacción se traslapa con otra del mismo día (bloque ${i + 1}: ${block.start}-${block.end}).`);
        } else {
          console.log(`  ✗ Error registrando el bloque ${i + 1} (${block.start}-${block.end})`);
        }
      } else {
        console.log(`  ✓ Bloque ${i + 1}/${blocks.length} (${block.start} - ${block.end}) registrado`);
      }
    }

    // Restaurar el handler global de diálogos para el siguiente envío
    page.on('dialog', dialog => handleGlobalDialog(dialog, page, browser));
    saveHours(blocks[0].start, blocks[blocks.length - 1].end);

    if (blocksOk) {
      await finishOrContinue(page, browser);
    } else {
      // No matar la aplicación: avisar y volver al menú (pregunta si registrar
      // otra actividad o salir), igual que el flujo de éxito.
      console.log('No se pudieron registrar todos los bloques.');
      await finishOrContinue(page, browser);
    }
    return frameTree;
  }

  // Confirmación diferida del bloque único: con bloques habilitados, la
  // pregunta se hace después de la propuesta de bloques (si no se registraron)
  if (blockMode === '2' && title) {
    if (!(await prompt.askConfirm('¿Desea continuar con estos datos?'))) {
      console.log('Cambiando a modo manual...');
      title = null;
    }
  }

  // ---- Registro de un solo bloque (comportamiento original) ----

  // Escribir input descripcion corta.
  if (title) {
    await frameTree.type('input[name="descripcion_corta"]', title);
  } else {
    await whriteInput(frameTree, 'input[name="descripcion_corta"]', "Digite el titulo de la actividad:");
  }

  // Definir fecha
  if (!formattedDate) {
    if (await prompt.askConfirm(`¿La fecha que va registrar es ${dd}/${mm}/${yyyy}?`)) {
      formattedDate = defaultDate;
    } else {
      formattedDate = await questionUserResponse(frameTree, "Digite la fecha de la actividad formato ddmmyyyy: ");
    }
  }
  await frameTree.type('input[name="fechaini"]', formattedDate);

  // Definir horario
  if (!startTime) {
    if (await prompt.askConfirm('¿El horario a diligenciar es jornada completa de 7:30am a 5:30pm?')) {
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
  if (await prompt.askConfirm('¿Desea registrar otra actividad?')) {
    console.log('====================================');
    console.log('REGISTRANDO NUEVA ACTIVIDAD...');
    console.log('====================================');
    await listAndNavigateNewTransaction(frameTree, page);
    await registerNewTransaction(frameTree, page);
  } else {
    console.log('Proceso finalizado.');
    await closeConnection();
    prompt.close();
    browser.close();
  }
}

// Handler global de diálogos del formulario de transacción (un solo envío).
// Durante el registro por bloques se retira temporalmente y se restaura al
// final del loop (cada bloque maneja su propio diálogo).
const handleGlobalDialog = async (dialog, page, browser) => {
  console.log('-------------------------');
  console.log('ALERTA ENCONTRADA:');
  console.log('-------------------------');
  console.log(dialog.message());
  if (dialog.message().trim() === 'Transacción ingresada éxitosamente') {
    await dialog.accept();
    await finishOrContinue(page, browser);
  } else {
    await dialog.accept();
    if (dialog.message().includes('traslapa')) {
      console.log('\nEl periodo se traslapa con otra transacción del mismo día.');
      console.log('Ejecutá de nuevo y usá la opción 4 "Corregir / mover registro" del menú principal para modificar los registros existentes.');
    } else {
      console.log('ERROR AL REGISTRAR, EJECUTE NUEVAMENTE.');
    }
    await closeConnection();
    prompt.close();
    browser.close();
  }
};

const delay = (time) => {
  return new Promise(function (resolve) {
    setTimeout(resolve, time)
  });
}

// ---------------------------------------------------------------------------
// Configuración de IA (menú principal, opción 6): providers, credenciales y
// modelos. No requiere login a Daybeat.
// ---------------------------------------------------------------------------

const showAIConfigMenu = async () => {
  let keepRunning = true;
  while (keepRunning) {
    console.log(ai.getStatus());
    console.log('------------------------------------');

    const option = await prompt.askSelect({
      message: 'Configuración de IA',
      choices: [
        { name: 'Cambiar provider activo', value: '1' },
        { name: 'Conectar OpenCode Zen (modelos gratis)', value: '2' },
        { name: 'Configurar Gemini (API key)', value: '3' },
        { name: 'Cambiar modelo', value: '4' },
        { name: 'Probar conexión', value: '5' },
        { name: 'Volver', value: '6' }
      ]
    });

    if (option === '6') {
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
  }
};

(async () => {
  // HEADLESS: 'true' oculta el navegador (sin ventana); 'false' lo muestra.
  const browser = await puppeteer.launch({ headless: process.env.HEADLESS === 'true' });
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

  const holidays = await checkHolidaysYear();

  await page.goto(linkDaybeat);

  let keepRunning = true;
  while (keepRunning) {
    const mainOption = await prompt.askSelect({
      message: '¿Qué desea hacer?',
      choices: [
        { name: 'Registrar actividad', value: '1' },
        { name: 'Ver días sin registro', value: '2' },
        { name: 'Registro masivo de días sin registro', value: '3' },
        { name: 'Corregir / mover registro', value: '4' },
        { name: 'Re-escanear repositorios', value: '5' },
        { name: 'Config IA', value: '6' },
        { name: 'Salir', value: '7' }
      ]
    });

    if (mainOption === '7') {
      console.log('Saliendo...');
      await closeConnection();
      prompt.close();
      browser.close();
      return;
    }

    if (mainOption === '6') {
      await showAIConfigMenu();
      continue;
    }

    if (mainOption === '5') {
      const rootDir = resolveRootDir(process.env.ROOT_DIR);
      console.log('\nRe-escaneando repositorios...');
      const repos = getReposWithCache(rootDir, true);
      console.log(`Repositorios encontrados: ${repos.length}`);
      for (const repo of repos) {
        const display = repo.replace(rootDir, '.');
        console.log(`  - ${display}`);
      }
      console.log('\nPresione Enter para continuar...');
      await prompt.ask('');
      continue;
    }

    if (mainOption === '2') {
      await showMissingRegistrations(page, browser, company, usernameDaybeat, password, holidays);
      return;
    }

    if (mainOption === '3') {
      await registerBulkMissingDays(page, browser, company, usernameDaybeat, password, holidays);
      return;
    }

    if (mainOption === '4') {
      await correctRegistration(page, browser, company, usernameDaybeat, password, holidays);
      return;
    }

    if (mainOption === '1') {
      keepRunning = false;
      break;
    }

  } // end while (keepRunning)

  const cachedPath = loadPathCache();

  page.on('dialog', dialog => handleGlobalDialog(dialog, page, browser));


  // Obtener el frame con el nombre "tres"
  let frameTree = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (frameTree) break;
    console.log(`[STAGE] frame tres no disponible (intento ${attempt + 1}/10)`);
    await delay(2000);
  }
  if (!frameTree) {
    console.log('[STAGE] No se encontró el frame tres tras reintentos. Presione Enter para salir.');
    await prompt.ask('');
    await closeConnection();
    prompt.close();
    browser.close();
    return;
  }

  if (frameTree) {
    
    // Esperar a que los inputs dentro del frame estén cargados (con reintentos:
    // el login puede tardar en renderizar el formulario tras cargar el frame)
    let inputsReady = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await frameTree.waitForSelector('input', { timeout: 8000 });
        inputsReady = true;
        break;
      } catch (e) {
        console.log(`[STAGE] formulario login sin inputs (intento ${attempt + 1}/5)`);
        await delay(2000);
      }
    }
    if (!inputsReady) throw new Error('Formulario de login no disponible tras reintentos');

    // LOGIN.
    await frameTree.type('input[name="id_cliente"]', company);
    await frameTree.type('input[name="login"]', usernameDaybeat);
    await frameTree.type('input[name="password"]', password);

    await delay(1000)

    // Enviar el formulario.
    await navigateFrameRobust(page, async (ft) => {
      await ft.click('input[type="submit"]');
    }, (u) => u.includes('requerimientos.asp'), 20000);
    await logStage(page, 'login');

    /////////////////////////////////////////////////////////
    // INGRESAR AL MENU INICIAL UNO Y HACER HOVER.
    /////////////////////////////////////////////////////////
    // El frame uno a veces carga DESPUÉS de que el login resuelve el URL del
    // frame tres; reintentar en vez de fallar de inmediato.
    let frameOne = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      frameOne = page.frames().find(frame => frame.name() === 'uno');
      if (!frameOne) {
        console.log(`[STAGE] frame uno no disponible (intento ${attempt + 1}/5)`);
        await delay(2000);
        continue;
      }
      try {
        await frameOne.waitForSelector('div', { timeout: 8000 });
        break;
      } catch (e) {
        console.log(`[STAGE] frame uno sin divs (intento ${attempt + 1}/5)`);
        await delay(2000);
      }
    }
    if (!frameOne) throw new Error('Frame uno no disponible tras reintentos');
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
    await logStage(page, 'hover Requerimientos');

    /////////////////////////////////////////////////////////
    // NAVEGAR A CONSULTAR.    
    /////////////////////////////////////////////////////////
    // Re-adquirir el frame tres (el hover pudo recrearlo) y esperar su menú
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    await frameTree.waitForSelector('div');
    // Encontrar el div que contiene el texto específico usando evaluate
    const divHandleConsulta = await frameTree.evaluateHandle(() => {
      const elements = Array.from(document.querySelectorAll('div'));
      return elements.find(el => el.textContent.trim() === 'Consultar'); // Comparación exacta
    });

    if (divHandleConsulta) {
      // Hacer clic en el div encontrado
      await navigateFrameRobust(page, async (ft) => {
        await ft.evaluate(el => el.click(), divHandleConsulta);
      }, (u) => u.includes('requerimientos.asp') && !u.includes('flag=resp'));
    }
    ////////////////////////--END--/////////////////////////
    await logStage(page, 'consultar');

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

      // Buscar el formulario. Usar click JS en vez de ft.click: el click real de
      // Puppeteer sobre input[type="image"] no dispara el submit del form en
      // modo headed (solo el click sintético lo activa).
      await navigateFrameRobust(page, async (ft) => {
        await ft.evaluate(() => {
          const btn = document.querySelector('input[type="image"]');
          if (btn) btn.click();
        });
      }, (u) => u.includes('requerimientos.asp?flag=') && !u.includes('flag=resp'));
    }
    ////////////////////////--END--/////////////////////////
    await logStage(page, 'búsqueda');


    /////////////////////////////////////////////////////////
    /**          SELECCIONAR SECCIÓN A REGISTRAR.         **/
    /////////////////////////////////////////////////////////
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    console.log('[STAGE] listando secciones...');
    const links = await listElements(frameTree, 'a', 'itemsint.asp', true);
    console.log(`[STAGE] Secciones encontradas: ${links.length}`);
    
    let useCachedPath = false;
    let selectedSectionText = null;
    let selectedItemText = null;
    
    if (cachedPath?.section?.text && cachedPath?.item?.text && cachedPath?.category?.value && cachedPath?.transactionType?.value) {
      const sectionExists = links.some(l => normalizeText(l.text) === normalizeText(cachedPath.section.text));
      if (sectionExists) {
        console.log(`\nRuta anterior: ${cachedPath.section.text} > ${cachedPath.item.text} > ${cachedPath.category.text} > ${cachedPath.transactionType.text}`);
        if (await prompt.askConfirm('\n¿Usar la misma ruta?')) {
          useCachedPath = true;
          selectedSectionText = cachedPath.section.text;
          selectedItemText = cachedPath.item.text;
        }
      } else {
        console.log('\nLa sección anterior ya no existe. Seleccione manualmente.');
      }
    }
    
    if (useCachedPath) {
      // Seleccionar sección automáticamente
      const foundIdx = links.findIndex(l => l.text === cachedPath.section.text);
      const selectedLink = links[foundIdx];
      const linkHandle = await frameTree.evaluateHandle((text, selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.find(el => el.textContent.trim() === text);
      }, selectedLink.text, 'a');
      if (linkHandle) await frameTree.evaluate(el => el.click(), linkHandle);
    } else {
      // Selección manual de sección
      if (links.length === 0) {
        console.log('[STAGE] No hay secciones para seleccionar. Estado del frame tres:');
        await logStage(page, 'sin secciones');
        console.log('Se cancela el registro. Presione Enter para salir.');
        await prompt.ask('');
        await closeConnection();
        prompt.close();
        browser.close();
        return;
      }
      selectedSectionText = await whriteAndNavigateElementSelect(frameTree, 'a', links);
    }
    ////////////////////////--END--/////////////////////////

    /////////////////////////////////////////////////////////
    /**  LISTAR Y NAVEGAR A REGISTRAR NUEVA TRANSACCIÓN.  **/
    /////////////////////////////////////////////////////////
    await navigateFrameRobust(page, null, (u) => u.includes('itemsint.asp'));
    await logStage(page, 'sección seleccionada');
    
    if (useCachedPath) {
      // Navegar al item automáticamente (buscando en todas las páginas)
      frameTree = page.frames().find(frame => frame.name() === 'tres');
      const otherLinks = await collectAllItems(frameTree, page);
      const itemIdx = otherLinks.findIndex(l => normalizeText(l.text) === normalizeText(cachedPath.item.text));
      if (itemIdx >= 0) {
        const selectedItem = otherLinks[itemIdx];
        await navigateFrameRobust(page, async (ft) => {
          await ft.evaluate((href) => {
            window.location.href = href;
          }, selectedItem.createHref);
        }, (u) => u.includes('transaccionesint_crear.asp'));
      } else {
        console.log('\nEl item anterior ya no existe. Seleccione manualmente.');
        const selected = await selectItemAndNavigate(frameTree, page, otherLinks, false);
        if (selected) selectedItemText = selected.text;
        useCachedPath = false;
      }
    } else {
      console.log('[STAGE] listando items de la sección...');
      selectedItemText = await listAndNavigateNewTransaction(frameTree, page);
    }
    ////////////////////////--END--/////////////////////////

    /////////////////////////////////////////////////////////
    /**     DILIGENCIAR FORMULARIO PARA NUEVO REGISTRO.   **/
    /////////////////////////////////////////////////////////
    registerNewTransaction(frameTree, page, null, 
      useCachedPath ? cachedPath.category : null, 
      useCachedPath ? cachedPath.transactionType : null,
      selectedSectionText,
      selectedItemText);

  } else {
    console.log('Frame no encontrado');
  }


  // Cerrar el navegador
  // await browser.close();
})();
