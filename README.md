# puppeteer-daybeat

Proyecto ejecutable para diligenciar tareas diarias en Daybeat de forma automática, basado en commits de git y con soporte para generación de resúmenes con IA (Gemini).

## Requisitos

- **Node.js** v18 o superior (requerido para `fetch` nativo y `AbortSignal.timeout`)
- **Git** instalado y disponible en el PATH
- **Navegador Chrome** (Puppeteer lo descarga automáticamente al instalar)

## Instalación

1. Clonar el repositorio.
2. Instalar las dependencias:
   ```bash
   npm install
   ```
3. Crear un archivo `.env` en la raíz del proyecto (ver sección de configuración).
4. Ejecutar el proyecto:
   ```bash
   node index.js
   ```

## Configuración

Crear un archivo `.env` en la raíz del proyecto con las siguientes variables:

### Variables requeridas

```env
LINK_DAYBEAT='link de acceso a daybeat'
COMPANY='compañia'
USERNAME_DAYBEAT='usuario daybeat'
PASSWORD='contraseña'
ROOT_DIR='ruta raiz donde buscar repositorios git'
```

### Variables opcionales

```env
GIT_AUTHOR_EMAIL='email del autor para filtrar commits'
GEMINI_API_KEY='tu api key de google gemini'
GEMINI_MODEL='gemini-3.1-flash-lite'
ATLASSIAN_ENABLED='true'
ATLASSIAN_EMAIL='tu email de atlassian (solo si usás API token)'
ATLASSIAN_API_TOKEN='tu token de API de atlassian (opcional)'
```

| Variable | Descripción | Por defecto |
|----------|-------------|-------------|
| `GIT_AUTHOR_EMAIL` | Filtra commits por este autor. Si no se define, usa `git config user.email` del primer repositorio encontrado. | - |
| `GEMINI_API_KEY` | API key de Google Gemini para generar títulos y descripciones con IA. Si no se define, se usa el método por defecto basado en reglas. | - |
| `GEMINI_MODEL` | Modelo de Gemini a usar. | `gemini-3.1-flash-lite` |
| `ATLASSIAN_ENABLED` | `true` activa el modo "Con información de Jira" con **OAuth 2.1**: la primera ejecución abre el navegador para autorizar (una sola vez; el navegador trae la identidad, no hace falta email ni token; tokens persistidos con refresh automático, sin depender del admin de la org). | - |
| `ATLASSIAN_EMAIL` | Solo para la alternativa silenciosa con API token (ver abajo). | - |
| `ATLASSIAN_API_TOKEN` | Opcional. API token personal (https://id.atlassian.com/manage-profile/security/api-tokens). Si se define junto con `ATLASSIAN_EMAIL`, usa autenticación silenciosa en vez de OAuth. El MCP oficial requiere que la org habilite el API token, pero REST (comentarios/worklogs) funciona igual. | - |
| `ATLASSIAN_CLOUD_ID` | Opcional. Si se omite, se autodetecta el sitio Atlassian. | autodetección |
| `ATLASSIAN_SITE_URL` | Opcional. Base REST (ej: `https://tu-sitio.atlassian.net`). Solo si se define `ATLASSIAN_CLOUD_ID` manualmente. | - |

## Uso

Al ejecutar `node index.js` se muestra un menú principal con las siguientes opciones:

### 1. Registrar actividad

Registra una actividad en Daybeat. Después de seleccionar sección, item, categoría y tipo de transacción, se puede elegir el modo de registro:

| Modo | Descripción |
|------|-------------|
| **1. Automático** | Usa commits de hoy. Si no hay, usa commits de los últimos 7 días. |
| **2. Con IA (Gemini)** | Usa Gemini AI para generar título y descripción. Si no hay API key o falla, usa método por defecto. Si no hay commits del día, usa commits de los últimos 3 días. |
| **3. Automático fake** | Usa commits de los últimos 7 días para generar un resumen estructurado. |
| **4. Manual** | Ingresa título, fecha, horario y detalle manualmente. |
| **5. Con información de Jira** | Consulta incidencias asignadas **en progreso** (siempre, el estado es la señal) o **terminadas hoy**, más comentarios propios y worklogs del día (MCP oficial de Atlassian + REST). Las "por hacer" se excluyen. Muestra la actividad y deja **seleccionar interactivamente** (casillas: espacio marca, `a` todos, enter confirma) qué incidencias/comentarios/worklogs entran al reporte (con Gemini si está configurado). Solo aparece si `ATLASSIAN_ENABLED=true`. |

Todos los modos automáticos muestran una vista previa y piden confirmación antes de registrar. Si se rechaza, cambia a modo manual.

**Validación anti-duplicado** (todos los modos individuales): antes de registrar, el script consulta las transacciones ya registradas del día en ese item (columna "Fecha Transacción" = hora final, "Tiempo" = duración → deduce el rango). Si el día ya tiene registros tuyos, muestra los rangos ocupados y pregunta "¿Desea registrar de todos modos? (si/no): " — no bloquea, porque Daybeat solapa por fecha Y hora (registrar otro bloque con horas distintas es válido). En el modo de bloques, la propuesta se ajusta automáticamente a los horarios libres del día. Si un bloque falla por traslape u otro motivo, ya no se cierra el programa: vuelve al menú.

En los modos **1, 2 y 5** se pregunta además cómo registrar el día:

| Opción | Descripción |
|--------|-------------|
| **1. Un solo bloque** | Comportamiento original: una transacción con el horario completo de la jornada. |
| **2. Varios bloques según actividad** | Divide el día en hasta 4 bloques contiguos según la hora de la actividad (commits y, en modo 5, comentarios/worklogs de Jira). La suma de los bloques es exactamente el mismo total del bloque único (nunca horas incompletas). Genera un resumen por bloque y registra una transacción por bloque. Requiere al menos 2 actividades con horario; si no, usa un solo bloque. El registro masivo siempre usa un solo bloque por día. Con esta opción la confirmación del bloque único se difiere: primero se muestra la propuesta de bloques, y la pregunta de "¿Desea continuar?" solo aparece si se rechazan los bloques o no hay actividad suficiente. Con `GEMINI_API_KEY`, cada bloque recibe su propia llamada a la IA (commits y/o actividad de Jira del bloque como contexto); el preview de bloques muestra el título y detalle exactos que se van a registrar. |

### 2. Ver días sin registro

Navega por todos los proyectos e items de Daybeat y muestra los días hábiles sin registro dentro del período seleccionado (1, 2 o 3 meses).

### 3. Registro masivo de días sin registro

Registra automáticamente todos los días hábiles sin registro. El proceso:

1. Selecciona el período: último mes, últimos 2 meses o últimos 3 meses.
2. Escanea todos los proyectos e items para encontrar días sin registro.
3. Pide seleccionar una sola vez: sección, item, categoría y tipo de transacción.
4. Si Jira está configurado (`ATLASSIAN_ENABLED=true`, con OAuth o API token), pregunta si se desea incluir información de Jira (issues, comentarios y worklogs del día) en los reportes.
5. Para cada día sin registro:
   - Obtiene commits de ese día específico.
   - Si no hay commits, usa commits de los últimos 3 días antes de esa fecha.
   - Si se habilitó Jira, consulta la actividad de ese día (incidencias, comentarios y worklogs).
   - Si hay `GEMINI_API_KEY`, usa Gemini AI para generar título y descripción (incluyendo el contexto de Jira).
   - Si no hay API key o falla, usa método por defecto.
   - Registra la transacción con el horario guardado en `.daybeat-history.json`.
6. Muestra resumen final con días exitosos, días ya registrados y días con error.

### 4. Re-escanear repositorios

Fuerza un re-escaneo completo de los repositorios git en `ROOT_DIR`. Actualiza el cache en `.daybeat-repos.json`. Muestra la lista de repositorios encontrados.

### 5. Salir

Cierra el script.

## Ejecución con bat

Dentro de la raíz hay una carpeta llamada `bat` con un archivo `testBatDaybeat.bat` que ejecuta el proyecto y se puede programar para que se ejecute en un horario específico. Para que funcione:

1. Abre el archivo `testBatDaybeat.bat` con un editor de texto.
2. Reemplaza la ruta `D:\PYT\apps\node\puppeteer-daybeat` por la ubicación del proyecto donde lo hayas clonado.
3. Guarda los cambios.

## Ejecución con Task Scheduler (Programador de tareas de Windows)

Para programar la ejecución del archivo `.bat`:

1. Abre el programador de tareas escribiendo en el explorador de Windows `programador de tareas`.
2. Selecciona `Importar tarea` en el panel derecho.
3. Busca el archivo `tarea_programada_windows.xml` dentro de la carpeta `bat` y selecciónalo.
4. Selecciona `Importar`.
5. En la ventana de `Acción` selecciona `Editar`.
6. En el apartado `Programa o script` agrega la ruta de tu archivo `.bat`.
7. Selecciona `Aceptar` y guarda los cambios.

Con esto ya tienes programada la ejecución del proyecto todos los días a las 5:10pm.

## Ejecución en Linux

### Instalación de Node.js

**Ubuntu/Debian:**
```bash
# Usando nvm (recomendado)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 18
nvm use 18

# O usando apt
sudo apt update
sudo apt install nodejs npm
```

**CentOS/RHEL:**
```bash
# Usando nvm (recomendado)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 18
nvm use 18

# O usando yum
sudo yum install nodejs npm
```

### Ejecución manual

```bash
cd puppeteer-daybeat
npm install
node index.js
```

### Programación con cron

Para ejecutar el script automáticamente en Linux usando cron:

```bash
# Editar crontab
crontab -e

# Agregar línea para ejecutar todos los días a las 5:10pm
10 17 * * * cd /ruta/al/proyecto/puppeteer-daybeat && /usr/bin/node index.js >> /var/log/daybeat.log 2>&1
```

**Nota:** El script es interactivo y requiere intervención del usuario, por lo que la programación automática con cron no es recomendada para este caso de uso.

## Guía de uso manual paso a paso

### Opción 1: Registrar actividad

1. **Selecciona opción 1** en el menú principal
2. **Selecciona la sección** donde registrar (ej: "Desarrollo Inttegrio rest")
3. **Selecciona el item** dentro de la sección (ej: "Microsevicios InttegrioRest Java 21")
4. **Selecciona la categoría** (ej: "Técnico (Desar-Mante-Sopor)")
5. **Selecciona el tipo de transacción** (ej: "PRI/NE - 15-Ejecución Desarrollo y mantenimiento")
6. **Selecciona el modo de registro:**
   - **1. Automático**: El script busca commits de hoy en `ROOT_DIR`
     - Si hay commits: genera título y descripción automáticamente
     - Si no hay commits: usa commits de los últimos 7 días
     - Muestra vista previa y pide confirmación
   - **2. Con IA (Gemini)**: Usa Gemini AI para generar contenido
     - Requiere `GEMINI_API_KEY` configurado
     - Si no hay commits del día: usa commits de los últimos 3 días
     - Si falla la IA: usa método por defecto
     - Muestra "✓ Generado con Gemini AI" o "✗ IA falló, usando método por defecto"
   - **3. Automático fake**: Usa commits de los últimos 7 días
     - Genera resumen estructurado basado en commits recientes
     - Muestra vista previa y pide confirmación
   - **4. Manual**: Ingresa todos los datos manualmente
     - Título de la actividad
     - Fecha (formato ddmmyyyy)
     - Hora de inicio y fin (formato sin puntos, ej: 0730)
     - Detalle de la actividad
7. **Confirma o rechaza** los datos generados
   - Si confirmas: se registra la actividad
   - Si rechazas: cambia a modo manual para ingresar datos

### Opción 2: Ver días sin registro

1. **Selecciona opción 2** en el menú principal
2. **Selecciona el período** a consultar:
   - 1. Último mes
   - 2. Últimos 2 meses
   - 3. Últimos 3 meses
3. **El script escanea automáticamente** todos los proyectos e items de Daybeat
4. **Muestra la lista** de días hábiles sin registro en el período seleccionado
5. **El script termina** y cierra el navegador

### Opción 3: Registro masivo de días sin registro

1. **Selecciona opción 3** en el menú principal
2. **Selecciona el período** a registrar:
   - 1. Último mes
   - 2. Últimos 2 meses
   - 3. Últimos 3 meses
3. **El script escanea** todos los proyectos e items para encontrar días sin registro
4. **Muestra la lista** de días hábiles sin registro
5. **Selecciona la sección** donde registrar (una sola vez para todos los días)
6. **Selecciona el item** dentro de la sección
7. **Selecciona la categoría**
8. **Selecciona el tipo de transacción**
9. **Confirma** que deseas continuar con el registro masivo
10. **El script registra automáticamente** cada día sin registro:
    - Para cada día:
      - Busca commits de ese día específico
      - Si no hay commits: usa commits de los últimos 3 días antes de esa fecha
      - Si hay `GEMINI_API_KEY`: usa Gemini AI para generar título y descripción
      - Si no hay API key o falla: usa método por defecto
      - Registra la transacción con el horario guardado
      - Muestra progreso: "✓ Día 15/07/2026 registrado exitosamente" o "✗ Día 15/07/2026 falló"
11. **Muestra resumen final** con:
    - Total de días sin registro encontrados
    - Días registrados exitosamente
    - Días ya registrados (saltados)
    - Días con error (si los hay)

## Archivos generados

| Archivo | Descripción |
|---------|-------------|
| `.daybeat-history.json` | Guarda el último horario usado (inicio/fin) para reutilizarlo en siguientes ejecuciones. Se crea automáticamente. |
| `.daybeat-repos.json` | Cache de repositorios git descubiertos (se actualiza automáticamente después de 7 días). Se puede forzar re-escaneo con `--rescan`. |
| `.daybeat-path.json` | Cache de la ruta de registro (sección, item, categoría, tipo de transacción). Se actualiza después de cada registro exitoso. |
| `holidays.json` | Festivos del año actual. Se crea automáticamente al primer inicio de año. Se puede editar manualmente o desde el prompt del script. |
| `diagnostic-commits.js` | Script independiente para diagnosticar commits disponibles en los repositorios de `ROOT_DIR`. Soporta `--rescan` para forzar re-escaneo. |
| `test-gemini.js` | Script independiente para probar la API de Gemini y verificar qué modelo funciona con tu API key. |

## Comandos

```bash
# Ejecutar el script principal
node index.js

# Forzar re-escaneo de repositorios
node index.js --rescan
node diagnostic-commits.js --rescan

# Diagnosticar commits disponibles
node diagnostic-commits.js
```

## Notas

- Puppeteer se ejecuta en modo headed (`headless: false`, ventana visible) por defecto para que puedas ver y controlar el navegador. Para ocultarla, pon `HEADLESS=true` en el `.env`. Con `HEADLESS=true` tampoco se abre la ventana del navegador al autorizar Jira (la URL se muestra en la consola).
- Daybeat usa iframes nombrados (`uno`, `tres`). La mayoría de la interacción ocurre en el frame `tres`.
- El script es interactivo y requiere intervención del usuario para seleccionar opciones. No puede ejecutarse en CI o de forma no interactiva.
- La paginación en Daybeat se maneja automáticamente (límite de 5 páginas por item).
- Los commits se filtran por autor usando `GIT_AUTHOR_EMAIL` o `git config user.email`.
