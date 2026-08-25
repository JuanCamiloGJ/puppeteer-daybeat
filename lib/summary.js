// Generación de resúmenes de actividad a partir de commits de git (con o sin
// IA). La parte "pura" (categorizar/sumarizar/truncar) no depende de nada
// externo; generateWithGemini delega en lib/ai-config.js.

const ai = require('./ai-config.js');

// Prefijo de contexto según la distancia entre la fecha objetivo y el commit
// más reciente disponible (0 = mismo día, 1 = ayer, etc.).
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

// Texto genérico por día de la semana (usado cuando no hay commits).
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

// Clasifica commits por prefijo conventional (feat/fix/refactor/docs/test/chore).
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

// Resumen estructurado: "Implementación de: X. Correcciones: Y. Refactorización: Z."
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

// Detalle largo (1-2 oraciones completas) a partir de los commits.
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

// Resumen corto (para títulos).
const summarizeCommits = (commits) => {
  if (commits.length === 0) return '';

  const unique = [...new Set(commits)];
  const categories = categorizeCommits(unique);
  return generateStructuredSummary(categories);
};

// Resumen para modo "fake" (sin commits reales del día).
const generateFakeSummary = (commits) => {
  if (commits.length === 0) return 'Actividad de desarrollo: revisión de código, pruebas y ajustes menores.';

  const unique = [...new Set(commits)];
  const categories = categorizeCommits(unique);
  return generateStructuredSummary(categories);
};

const smartTruncate = (text, maxLength) => {
  if (text.length <= maxLength) return text;
  const truncated = text.substring(0, maxLength);
  const lastPeriod = truncated.lastIndexOf('.');
  if (lastPeriod > maxLength * 0.6) {
    return truncated.substring(0, lastPeriod + 1);
  }
  const lastSpace = truncated.lastIndexOf(' ');
  return truncated.substring(0, lastSpace) + '.';
};

// Genera título + detalle con la IA configurada (o null si no hay IA ni
// información con la que trabajar). Con commits vacíos pero contexto adicional
// (p. ej. actividad de Jira/Clockify) genera a partir del contexto usando el
// prompt explícito 'no-commits'; sin contexto adicional devuelve null y el
// caller cae al método por defecto.
const generateWithGemini = async (commits, context = 'same-day', targetDate = null, extraContext = null) => {
  if (!ai.isAIEnabled()) {
    return null;
  }

  const noCommits = !commits || commits.length === 0;
  if (noCommits && !extraContext) {
    return null;
  }

  const commitsText = (commits || []).join('\n');

  let contextInstruction = '';
  if (context === 'continuation') {
    contextInstruction = '\n\nIMPORTANTE: Estos commits son de días anteriores (no del día que se está registrando). Genera la descripción indicando que se CONTINÚA con el trabajo de días previos, usando frases como "Continuación de...", "Seguimiento de...", "Avance en...". No digas que se hizo hoy, sino que se continúa trabajando en ello.';
  } else if (context === 'follow-up') {
    contextInstruction = '\n\nIMPORTANTE: Estos commits son de días anteriores. Genera la descripción indicando que se da SEGUIMIENTO a tareas recientes, usando frases como "Seguimiento de...", "Trabajo en...", "Continuación de tareas de...". No digas que se hizo hoy, sino que se da seguimiento.';
  } else if (context === 'no-commits' || noCommits) {
    contextInstruction = extraContext
      ? '\n\nIMPORTANTE: No hay commits disponibles. Basa la descripción ÚNICAMENTE en la información de actividad proporcionada (Jira, Clockify u otra). No inventes trabajo que no esté respaldado por esa información.'
      : '\n\nIMPORTANTE: No hay commits disponibles. Genera una descripción genérica pero variada de actividad de desarrollo según el día de la semana. Evita usar siempre el mismo texto.';
  }

  const dateInfo = targetDate ? `\nDía a registrar: ${targetDate}` : '';
  const sourceLabel = noCommits ? 'la siguiente información de actividad' : 'los siguientes commits de git';
  const contextLabel = noCommits ? '' : (extraContext ? ' y el contexto adicional proporcionado' : '');
  const activitySection = noCommits
    ? (extraContext ? `Información de actividad:\n"${extraContext}"` : '')
    : `Commits:\n${commitsText}${extraContext ? `\n\nContexto adicional del usuario:\n"${extraContext}"` : ''}`;

  const prompt = `Eres un asistente que ayuda a generar descripciones de actividades laborales para un sistema de registro de tiempo.

Basándote en ${sourceLabel}${contextLabel}, genera:
1. Un título corto (máximo 100 caracteres) que resuma la actividad
2. Una descripción detallada (1-2 oraciones completas, máximo 1000 caracteres) que explique el trabajo realizado
${dateInfo}
${activitySection}
${contextInstruction}

REGLAS IMPORTANTES:
- Completa TODAS las oraciones. NO termines con "..." ni dejes frases a medias.
- La descripción debe ser un párrafo completo con sentido.
- Si necesitas más espacio, prioriza completar la idea principal.

Responde SOLO en formato JSON válido, sin texto adicional:
{"title": "título corto aquí", "detail": "descripción detallada aquí"}`;

  const text = await ai.callAI(prompt);

  if (!text) {
    console.log('  [IA] Respuesta vacía o error del provider');
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

  title = smartTruncate(title, 100);
  detail = smartTruncate(detail, 1000);

  return { title, detail };
};

module.exports = {
  getContextPrefix,
  generateGenericText,
  categorizeCommits,
  generateStructuredSummary,
  generateDetail,
  summarizeCommits,
  generateFakeSummary,
  smartTruncate,
  generateWithGemini
};
