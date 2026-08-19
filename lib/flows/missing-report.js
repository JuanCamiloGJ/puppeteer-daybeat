// Flujo: reporte de días hábiles sin registro (menú principal, opción 2).

const prompt = require('../prompt.js');
const {
  delay, findElementHandle, navigateFrameRobust, getCurrentUser, collectAllItems,
  extractRegistrations
} = require('../daybeat.js');
const {
  getBusinessDays, getMissingRegistrations, dateDDMMYYYYToTimestamp,
  formatDateFromISO
} = require('../time.js');
const { loadRegistrationsCache, getCachedUser, mergeDatesForUser } = require('../persistence.js');
const { askPeriod } = require('./common.js');

const showMissingRegistrations = async (session) => {
  const { page, browser, company, usernameDaybeat, password, holidays } = session;
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
  const divHandle = await findElementHandle(frameOne, () => {
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
  } else {
    console.log('[WARN] Menú "Requerimientos" no encontrado en el frame uno; se omite el hover.');
  }
  
  await frameTree.waitForSelector('div');
  const divHandleConsulta = await findElementHandle(frameTree, () => {
    const elements = Array.from(document.querySelectorAll('div'));
    return elements.find(el => el.textContent.trim() === 'Consultar');
  });
  
  if (divHandleConsulta) {
    await navigateFrameRobust(page, async (ft) => {
      await ft.evaluate(el => el.click(), divHandleConsulta);
    }, (u) => u.includes('requerimientos.asp') && !u.includes('flag=resp'));
  } else {
    console.log('[WARN] Menú "Consultar" no encontrado en el frame tres; se omite la navegación.');
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

module.exports = {
  showMissingRegistrations
};
