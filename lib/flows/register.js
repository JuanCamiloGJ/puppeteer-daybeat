// Flujo de registro de actividad (modos 1-5, un solo bloque o varios
// bloques según la actividad del día).

const prompt = require('../prompt.js');
const { isConfigured, getDailyActivity, formatActivityForReport, closeConnection } = require('../jira-report.js');
const clockify = require('../clockify.js');
const ai = require('../ai-config.js');
const {
  listElements, selectOptionSelector, whriteInput, navigateFrameRobust,
  getCurrentUser, getExistingRanges, delay, collectAllItems,
  selectItemAndNavigate, setFieldValue
} = require('../daybeat.js');
const {
  getReposWithCache, getGitAuthor, getTodayCommits, getRecentCommits,
  getCommitsWithTime
} = require('../git.js');
const {
  generateWithGemini, generateFakeSummary, generateDetail, summarizeCommits,
  smartTruncate
} = require('../summary.js');
const { resolveRootDir } = require('../path.js');
const { getLastUsedHours, saveHours, savePathCache } = require('../persistence.js');
const {
  isoToLocalHHMM, parseTimeSpentHours, toMinutes, buildDayBlocks,
  intersectBlocksWithFree
} = require('../time.js');
const { questionUserResponse, selectJiraActivityMulti, selectActivityMulti } = require('./common.js');
const { connectClockifyFlow } = require('./clockify-config.js');

const listAndNavigateNewTransaction = async (frameTree, page) => {
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  const items = await collectAllItems(frameTree, page);
  console.log(`[STAGE] Items encontrados: ${items.length}`);
  const selected = await selectItemAndNavigate(frameTree, page, items, false);
  return selected ? selected.text : null;
}

// Jornada estándar de la compañía (usada como default cuando no hay horario guardado).
const STANDARD_JORNADA = { start: '0730', end: '1630' };

// Resuelve la jornada de los modos automáticos: usa el horario guardado, salvo
// que difiera del estándar (0730-1630) — caso en que se confirma con el usuario
// para no reusar en silencio un horario raro de un registro anterior (p. ej.
// una media jornada). Enter acepta la jornada completa.
const resolveJornada = async () => {
  const hours = getLastUsedHours();
  if (hours.start !== STANDARD_JORNADA.start || hours.end !== STANDARD_JORNADA.end) {
    console.log(`  Horario guardado: ${hours.start} - ${hours.end}`);
    if (await prompt.askConfirm('¿Usar jornada completa 0730-1630?', true)) {
      return STANDARD_JORNADA;
    }
  }
  return hours;
}

// Título de respaldo desde la actividad Jira seleccionada (modo 6): usa la
// primera incidencia y, si no hay (Jira con SOLO comentarios/worklogs), el
// primer comentario o worklog. Devuelve null solo si no hay contenido Jira.
const jiraFallbackTitle = (jiraActivity) => {
  if (jiraActivity.issues.length > 0) {
    const firstIssue = jiraActivity.issues[0];
    return smartTruncate(`Actividad en Jira: ${firstIssue.key} ${firstIssue.summary || ''}`, 100);
  }
  if (jiraActivity.comments.length > 0) {
    const firstComment = jiraActivity.comments[0];
    return smartTruncate(`Actividad en Jira: ${firstComment.issueKey} (comentario)`, 100);
  }
  if (jiraActivity.worklogs.length > 0) {
    const firstWorklog = jiraActivity.worklogs[0];
    return smartTruncate(`Actividad en Jira: ${firstWorklog.issueKey} (worklog ${firstWorklog.timeSpent || ''})`, 100);
  }
  return null;
}

// Reconoce los mensajes de éxito del servidor sin importar mayúsculas ni
// acentos (p. ej. "Transacción ingresada éxitosamente").
const isSuccessDialogMessage = (message) => {
  const normalized = (message || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return normalized.includes('exitosamente');
};

// Envío determinístico del formulario de un solo bloque: instala el listener
// del diálogo ANTES del click (mismo patrón que el loop de bloques), espera un
// resultado acotado, acepta el diálogo, reconoce el éxito sin importar
// mayúsculas/acentos y restaura el handler global. Antes el envío dependía del
// handler global no-await de index.js y el flujo quedaba colgado sobre el
// formulario llenado sin confirmación; ahora nunca se detiene en silencio: si
// no llega confirmación (o llega un rechazo) se avisa y se vuelve al menú.
const submitSingleBlockForm = async (frameTree, page, browser) => {
  // El handler global es para un solo envío; durante el submit propio se retira
  // y se restaura al final (mismo patrón que el loop de bloques).
  page.removeAllListeners('dialog');

  const timeoutMs = Number(process.env.DAYBEAT_SUBMIT_DIALOG_TIMEOUT_MS) || 8000;
  const dialogPromise = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ handled: false, message: '' }), timeoutMs);
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

  // Restaurar el handler global de diálogos para el siguiente envío
  page.on('dialog', dialog => handleGlobalDialog(dialog, page, browser));

  if (!result.handled) {
    console.log('  ✗ No se recibió confirmación del servidor (tiempo de espera agotado). El registro pudo no haberse guardado.');
    await finishOrContinue(page, browser);
    return result;
  }

  if (isSuccessDialogMessage(result.message)) {
    console.log('  ✓ Registro confirmado por el servidor.');
  } else {
    console.log('  ✗ El servidor rechazó el registro.');
    if (result.message && result.message.includes('traslapa')) {
      console.log('    El periodo se traslapa con otra transacción del mismo día.');
    }
  }
  await finishOrContinue(page, browser);
  return result;
};

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
  console.log('6. Con toda la información (Git + Jira + Clockify)');
  console.log('-------------------------');

  let mode = await questionUserResponse(frameTree, 'Seleccione modo (1/2/3/4' + (isConfigured() ? '/5' : '') + '/6): ');

  // Guard del modo 6: necesita Clockify configurado. Si no lo está, se ofrece
  // el flujo guiado (pegar key → verificar → guardar) y solo continúa si la
  // verificación fue exitosa; si no, cae a modo manual.
  if (mode === '6' && !clockify.isConfigured()) {
    console.log('\n  El modo 6 incluye tu actividad de Clockify, que necesita una API key.');
    if (await prompt.askConfirm('¿Desea configurar Clockify ahora?')) {
      if (!(await connectClockifyFlow())) {
        console.log('  Sin Clockify configurado, se registra en modo manual.');
        mode = '4';
      }
    } else {
      console.log('  Sin Clockify configurado, se registra en modo manual.');
      mode = '4';
    }
  }

  // Opción de registro: un solo bloque (jornada completa) o varios bloques
  // según la actividad del día (solo en modos automáticos con horarios)
  let blockMode = '1';
  if (mode === '1' || mode === '2' || mode === '5' || mode === '6') {
    const resp = await questionUserResponse(frameTree, '¿Cómo desea registrar? (1: Un solo bloque / 2: Varios bloques según actividad): ');
    blockMode = resp.trim() === '2' ? '2' : '1';
  }

  let title = null;
  let formattedDate = null;
  let startTime = null;
  let endTime = null;
  let detail = null;
  let selectedJiraActivity = null; // actividad Jira elegida en modos 5/6 (para bloques)
  let selectedClockifyEntries = null; // entradas Clockify elegidas en modo 6 (para bloques)
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
      const hours = await resolveJornada();
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
        const hours = await resolveJornada();
        startTime = hours.start;
        endTime = hours.end;
        detail = generateDetail(recentCommits);
      } else {
        title = summarizeCommits(allCommits);
        const hours = await resolveJornada();
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
    
    const hours = await resolveJornada();
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
    
    const hours = await resolveJornada();
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
    if (ai.isAIEnabled() && (allCommits.length > 0 || jiraContext)) {
      console.log('  Generando con la IA...');
      const aiResult = await generateWithGemini(
        allCommits,
        allCommits.length > 0 ? 'same-day' : 'no-commits',
        null,
        jiraContext
      );
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
      
      // Agregar el bloque de Jira al detalle cuando no lo generó la IA (pero
      // no duplicarlo si ya es el detalle completo del contexto Jira).
      if (jiraContext && detail && detail !== jiraContext) {
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
  } else if (mode === '6') {
    // Modo Con toda la información (Git + Jira + Clockify)
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

    const hours = await resolveJornada();
    startTime = hours.start;
    endTime = hours.end;
    formattedDate = defaultDate;

    // Consultar actividad de Jira (issues + comentarios + worklogs)
    let activity = null;
    if (isConfigured()) {
      console.log('Consultando actividad en Jira...');
      try {
        activity = await getDailyActivity(today);
        if (activity.issues.length === 0 && activity.comments.length === 0 && activity.worklogs.length === 0) {
          console.log('  Sin actividad registrada en Jira para hoy.');
        }
      } catch (err) {
        console.log(`  ✗ Error consultando Jira: ${err.message}`);
      }
    }

    // Consultar actividad de Clockify (time entries del día)
    let clockifyData = null;
    if (clockify.isConfigured()) {
      console.log('Consultando actividad en Clockify...');
      try {
        clockifyData = await clockify.getDailyActivity(today);
        if (clockifyData.entries.length === 0) {
          console.log('  Sin entradas en Clockify para hoy.');
        }
      } catch (err) {
        console.log(`  ✗ Error consultando Clockify: ${err.message}`);
      }
    }

    // Mostrar y seleccionar qué entra al reporte (Jira + Clockify juntos)
    let selected = { jira: null, clockify: null };
    const hasAnyActivity =
      (activity && (activity.issues.length > 0 || activity.comments.length > 0 || activity.worklogs.length > 0)) ||
      (clockifyData && clockifyData.entries.length > 0);
    if (hasAnyActivity) {
      console.log('------------------------------------');
      console.log('ACTIVIDAD DETECTADA (Jira + Clockify):');
      if (activity && (activity.issues.length > 0 || activity.comments.length > 0 || activity.worklogs.length > 0)) {
        console.log(formatActivityForReport(activity));
      }
      if (clockifyData && clockifyData.entries.length > 0) {
        console.log(clockify.formatActivityForReport(clockifyData));
      }
      console.log('------------------------------------');
      selected = await selectActivityMulti(activity, clockifyData);
    }

    const hasJiraContent = selected.jira && (
      selected.jira.issues.length > 0 ||
      selected.jira.comments.length > 0 ||
      selected.jira.worklogs.length > 0
    );
    const hasClockifyContent = selected.clockify && selected.clockify.entries.length > 0;
    const jiraContext = hasJiraContent ? formatActivityForReport(selected.jira) : null;
    const clockifyContext = hasClockifyContent ? clockify.formatActivityForReport(selected.clockify) : null;
    const combinedContext = [jiraContext, clockifyContext].filter(Boolean).join('\n\n') || null;
    if (hasJiraContent) selectedJiraActivity = selected.jira;
    if (hasClockifyContent) selectedClockifyEntries = selected.clockify.entries;
    selected = null;

    // Generar reporte con IA o por defecto
    let geminiUsed = false;
    if (ai.isAIEnabled() && (allCommits.length > 0 || combinedContext)) {
      console.log('  Generando con la IA...');
      const aiResult = await generateWithGemini(
        allCommits,
        allCommits.length > 0 ? 'same-day' : 'no-commits',
        null,
        combinedContext
      );
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
      } else if (hasJiraContent) {
        // hasJiraContent es true con issues O comentarios O worklogs: el título
        // sale de la primera incidencia o, si no hay, del primer comentario o
        // worklog (nunca se asume issues[0] — TypeError cuando solo hay
        // comentarios/worklogs).
        title = jiraFallbackTitle(selectedJiraActivity);
        detail = combinedContext;
      } else if (hasClockifyContent) {
        const firstEntry = selectedClockifyEntries[0];
        const firstLabel = firstEntry.projectName
          ? (firstEntry.description ? `${firstEntry.projectName}: ${firstEntry.description}` : `${firstEntry.projectName}: Actividad`)
          : (firstEntry.description || 'Actividad en Clockify');
        title = smartTruncate(`Actividad: ${firstLabel}`, 100);
        detail = combinedContext;
      } else {
        title = generateFakeSummary(allCommits);
        detail = generateDetail(allCommits);
      }

      // Agregar el bloque combinado al detalle cuando no lo generó la IA (pero
      // no duplicarlo si ya es el detalle completo del contexto combinado).
      if (combinedContext && detail && detail !== combinedContext) {
        detail = `${detail}\n\n${combinedContext}`;
      }
    }

    console.log('-------------------------');
    console.log('RESUMEN CON TODA LA INFORMACIÓN:');
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
    const hours = await resolveJornada();
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
    console.log('  [STAGE] chequeando registros existentes del día (guard anti-duplicado)...');
    existingRanges = await getExistingRanges(
      frameTree, page, dayStr, currentUser,
      selectedCategoryValue, selectedTransactionValue
    );
    console.log('  [STAGE] guard anti-duplicado terminado.');
    // getExistingRanges navega el frame (detalle -> formulario): el frame del
    // caller queda obsoleto. Re-adquirir el frame tres fresco y esperar el
    // formulario antes de seguir llenándolo.
    frameTree = page.frames().find(frame => frame.name() === 'tres');
    if (!frameTree) {
      console.log('[STAGE] frame tres no disponible tras getExistingRanges.');
      await finishOrContinue(page, page.browser());
      return frameTree;
    }
    await frameTree.waitForSelector('select');
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
    // Las entradas de Clockify traen horario exacto: son la fuente más
    // confiable para repartir los bloques (las en curso solo anclan el inicio).
    if (selectedClockifyEntries && selectedClockifyEntries.length > 0) {
      for (const entry of selectedClockifyEntries) {
        if (!entry.startLocal) continue;
        const label = entry.projectName
          ? (entry.description ? `${entry.projectName}: ${entry.description}` : `${entry.projectName}: Actividad`)
          : (entry.description || 'Actividad');
        events.push({
          time: entry.startLocal,
          label: `Clockify: ${label}${entry.inProgress ? ' (en curso)' : ''}`,
          kind: 'clockify',
          weight: Math.max(0.5, (entry.durationMin || 30) / 60)
        });
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
        const clockifyLabels = block.events.filter(ev => ev.kind === 'clockify').map(ev => ev.label);

        // Contexto combinado: Jira + Clockify (labels e issues) y el contexto
        // extra del modo IA (solo en el primer bloque)
        const contextParts = [];
        if (jiraLabels.length > 0) {
          contextParts.push('Actividad en Jira:\n' + jiraLabels.map(l => `  - ${l}`).join('\n'));
        }
        if (clockifyLabels.length > 0) {
          contextParts.push('Actividad en Clockify:\n' + clockifyLabels.map(l => `  - ${l}`).join('\n'));
        }
        if (block.issues && block.issues.length > 0) {
          contextParts.push('Incidencias:\n' + block.issues.map(issue => `  - ${issue.key}: ${issue.summary || 'Sin resumen'}`).join('\n'));
        }
        const blockContext = contextParts.length > 0 ? contextParts.join('\n\n') : null;
        const extraContext = [blockContext, i === 0 ? userExtraContext : null].filter(Boolean).join('\n\n') || null;

        // Con IA: los labels Jira/Clockify se pasan como actividad cuando no hay commits
        if (useAI && (mode === '2' || mode === '5' || mode === '6') && (blockCommits.length > 0 || jiraLabels.length > 0 || clockifyLabels.length > 0)) {
          const activitySource = blockCommits.length > 0
            ? blockCommits
            : (jiraLabels.length > 0 ? jiraLabels : clockifyLabels);
          const aiResult = await generateWithGemini(activitySource, 'same-day', null, extraContext);
          if (aiResult) {
            block.title = aiResult.title;
            block.detail = aiResult.detail;
            continue;
          }
        }

        // Fallback sin IA (o si falló): reglas por commits, o actividad Jira/Clockify
        if (blockCommits.length > 0) {
          block.title = summarizeCommits(blockCommits);
          block.detail = generateDetail(blockCommits);
        } else if (jiraLabels.length > 0) {
          const firstLabel = jiraLabels[0];
          block.title = smartTruncate(`Actividad en Jira: ${firstLabel}`, 100);
          block.detail = jiraLabels.map(l => `- ${l}`).join('\n');
        } else if (clockifyLabels.length > 0) {
          const firstLabel = clockifyLabels[0];
          block.title = smartTruncate(`Actividad: ${firstLabel}`, 100);
          block.detail = clockifyLabels.map(l => `- ${l}`).join('\n');
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

      await setFieldValue(frameTree, 'input[name="descripcion_corta"]', blockTitle);
      await setFieldValue(frameTree, 'input[name="fechaini"]', formattedDate);
      await setFieldValue(frameTree, 'input[name="horaini"]', block.start);
      await setFieldValue(frameTree, 'input[name="horafin"]', block.end);
      await setFieldValue(frameTree, 'textarea[name="texto_largo"]', blockDetail);
      console.log(`  [STAGE] bloque ${i + 1} llenado: "${blockTitle.substring(0, 60)}..." ${formattedDate} ${block.start}-${block.end}, enviando...`);

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
            success: isSuccessDialogMessage(message),
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
    await setFieldValue(frameTree, 'input[name="descripcion_corta"]', title);
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
  await setFieldValue(frameTree, 'input[name="fechaini"]', formattedDate);

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
  await setFieldValue(frameTree, 'input[name="horaini"]', startTime);
  await setFieldValue(frameTree, 'input[name="horafin"]', endTime);

  // Guardar horario usado
  saveHours(startTime, endTime);

  // Escribir detalle de actividad.
  if (detail) {
    await setFieldValue(frameTree, 'textarea[name="texto_largo"]', detail);
  } else {
    await whriteInput(frameTree, 'textarea[name="texto_largo"]', "Digite el detalle de la actividad:");
  }

  // Enviar el formulario (submit determinístico: listener del diálogo antes del
  // click, espera acotada, reconocimiento del éxito y handler global restaurado)
  console.log('  [STAGE] formulario llenado, enviando...');
  await submitSingleBlockForm(frameTree, page, page.browser());

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
  const message = dialog.message();
  console.log(message);
  if (isSuccessDialogMessage(message)) {
    await dialog.accept();
    await finishOrContinue(page, browser);
  } else {
    await dialog.accept();
    if (message.includes('traslapa')) {
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

module.exports = {
  registerNewTransaction,
  listAndNavigateNewTransaction,
  finishOrContinue,
  handleGlobalDialog
};
