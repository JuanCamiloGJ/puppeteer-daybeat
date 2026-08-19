// Flujo: corregir / mover un registro existente (menú principal, opción 4).
// Daybeat no expone borrado; la única mutación es el UPDATE del formulario
// transaccionesint_actualizar.asp.

const prompt = require('../prompt.js');
const { closeConnection } = require('../jira-report.js');
const {
  delay, navigateFrameRobust, getCurrentUser, listElements,
  whriteAndNavigateElementSelect, collectAllItems, selectItemAndNavigate,
  parseTransactionTable, readTransactionForm, updateTransaction, normalizeText
} = require('../daybeat.js');
const { loadPathCache } = require('../persistence.js');
const { questionUserResponse } = require('./common.js');

// Opción de menú: corregir / mover un registro existente. Daybeat NO expone
// borrado de transacciones (verificado en la app real); la única mutación es
// el UPDATE del formulario transaccionesint_actualizar.asp. "Eliminar" un
// registro = corregirlo o moverlo (p.ej. cambiar la fecha para liberar un
// día mal registrado). Reutiliza parseTransactionTable (listado) y
// updateTransaction (edición).
const correctRegistration = async (session) => {
  const { page, browser, company, usernameDaybeat, password, holidays } = session;
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

module.exports = {
  correctRegistration
};
