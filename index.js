require('dotenv').config();
const puppeteer = require('puppeteer');
const prompt = require('./lib/prompt.js');

const { createSession } = require('./lib/session.js');
const daybeat = require('./lib/daybeat.js');
const { checkHolidaysYear } = require('./lib/flows/common.js');
const { showAIConfigMenu } = require('./lib/flows/ai-config.js');
const { showMissingRegistrations } = require('./lib/flows/missing-report.js');
const { registerBulkMissingDays } = require('./lib/flows/bulk.js');
const { correctRegistration } = require('./lib/flows/correct.js');
const {
  registerNewTransaction,
  listAndNavigateNewTransaction,
  handleGlobalDialog
} = require('./lib/flows/register.js');
const { resolveRootDir } = require('./lib/path.js');
const { getReposWithCache } = require('./lib/git.js');
const { loadPathCache } = require('./lib/persistence.js');
const { closeConnection } = require('./lib/jira-report.js');

// Funciones de lib/daybeat.js usadas en el composition root (login y menú).
const {
  delay,
  navigateFrameRobust,
  logStage,
  listElements,
  normalizeText,
  whriteAndNavigateElementSelect,
  collectAllItems,
  selectItemAndNavigate
} = daybeat;
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
  const session = createSession({ page, browser, company, usernameDaybeat, password, holidays });

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
      await showMissingRegistrations(session);
      return;
    }

    if (mainOption === '3') {
      await registerBulkMissingDays(session);
      return;
    }

    if (mainOption === '4') {
      await correctRegistration(session);
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
