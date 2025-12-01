require('dotenv').config();
const puppeteer = require('puppeteer');
const readline = require('readline');


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


const listAndNavigateNewTransaction = async (frameTree, page) => {
  frameTree = page.frames().find(frame => frame.name() === 'tres');
  // Esperar a que los links dentro del frame estén cargados
  const otherLinks = await listElements(frameTree, 'a');
  // Pedir al usuario que elija una opción
  await whriteAndNavigateOtherElementSelect(frameTree, 'a', otherLinks);
}

const registerNewTransaction = async (frameTree, page) => {
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

  // Escribir input descripcion corta.
  await whriteInput(frameTree, 'input[name="descripcion_corta"]', "Digite el titulo de la actividad:");

  // Definir fecha y hora de hoy.
  let today = new Date();
  let dd = String(today.getDate()).padStart(2, '0');
  let mm = String(today.getMonth() + 1).padStart(2, '0'); //January is 0!
  let yyyy = today.getFullYear();
  formattedDate = dd + mm + yyyy;
  const responseDate = await questionUserResponse(frameTree, `¿La fecha que va registrar es ${dd}/${mm}/${yyyy} ? (si/no): `);

  if (responseDate === 'si') {
    // Escribir input fecha.
    await frameTree.type('input[name="fechaini"]', formattedDate);
  } else {
    await whriteInput(frameTree, 'input[name="fechaini"]', "Digite la fecha de la actividad formato ddmmyyyy:");
  }


  // Validar si desea diligenciar hora de inicio y final.
  const response = await questionUserResponse(frameTree, '¿El horario a diligenciar es jornada completa de 7:30am a 5:30pm? (si/no): ');


  if (response === 'si') {
    // Escribir input hora inicio.
    await frameTree.type('input[name="horaini"]', '0730');
    // Escribir input hora final.
    await frameTree.type('input[name="horafin"]', '1630');
  } else {
    // Escribir input de hora de inicio
    await whriteInput(frameTree, 'input[name="horaini"]', "Digite la hora de inicio de la actividad sin puntos:");
    // Escribir input de hora final.
    await whriteInput(frameTree, 'input[name="horafin"]', "Digite la hora de finalización de la actividad sin puntos:");
  }

  // Escribir detalle de actividad.
  await whriteInput(frameTree, 'textarea[name="texto_largo"]', "Digite el detalle de la actividad:");

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
  // Lanzar un navegador
  const browser = await puppeteer.launch({ headless: false, }); // Headless:false para ver el navegador en acción
  const page = await browser.newPage();

  // Extraer  variables de entorno.
  const linkDaybeat = process.env.LINK_DAYBEAT;
  const company = process.env.COMPANY;
  const usernameDaybeat = process.env.USERNAME_DAYBEAT;
  const password = process.env.PASSWORD;

  if (!linkDaybeat || !company || !usernameDaybeat || !password) {
    console.log("ERROR: Defina variables de entorno para continuar.");
    browser.close()
  }

  // Ir a la página web
  await page.goto(linkDaybeat);

  // Escuchar el evento de diálogo
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

    // Esperar 1 segundo que se cargue. 
    delay(1000);

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
