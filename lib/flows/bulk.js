// Flujo: registro masivo de días hábiles sin registro (menú principal,
// opción 3).

const prompt = require('../prompt.js');
const { isConfigured, getDailyActivity, formatActivityForReport, closeConnection } = require('../jira-report.js');
const ai = require('../ai-config.js');
const {
  delay, findElementHandle, navigateFrameRobust, getCurrentUser, collectAllItems,
  extractRegistrations, listElements, selectItemAndNavigate
} = require('../daybeat.js');
const {
  getBusinessDays, getMissingRegistrations, dateDDMMYYYYToTimestamp,
  formatDateFromISO
} = require('../time.js');
const {
  loadRegistrationsCache, getCachedUser, mergeDatesForUser, getLastUsedHours
} = require('../persistence.js');
const {
  getReposWithCache, getGitAuthor, getCommitsForDate,
  getRecentCommitsBeforeDate, getRotatedCommits
} = require('../git.js');
const {
  getContextPrefix, generateWithGemini, generateGenericText, summarizeCommits,
  generateDetail
} = require('../summary.js');
const { resolveRootDir } = require('../path.js');
const { askPeriod } = require('./common.js');

const registerBulkMissingDays = async (session) => {
  const { page, browser, company, usernameDaybeat, password, holidays } = session;
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

module.exports = {
  registerBulkMissingDays
};
