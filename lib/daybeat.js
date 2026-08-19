// Cliente de automatización de Daybeat: navegación por frames y lectura/
// escritura del DOM (listas de secciones/items, transacciones, formularios).
// Depende solo de lib/prompt.js para los selectores interactivos.

const prompt = require('./prompt.js');

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
const delay = (time) => {
  return new Promise(function (resolve) {
    setTimeout(resolve, time)
  });
}

module.exports = {
  delay,
  normalizeText,
  listElements,
  collectAllItems,
  selectItemAndNavigate,
  navigateFrameRobust,
  logStage,
  whriteAndNavigateElementSelect,
  selectOptionSelector,
  whriteInput,
  getCurrentUser,
  extractRegistrations,
  parseTransactionTable,
  getExistingRanges,
  readTransactionForm,
  updateTransaction,
  inspectTableStructure
};
