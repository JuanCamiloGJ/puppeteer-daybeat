require('dotenv').config();

const testGeminiAPI = async () => {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    console.log('ERROR: No se encontró GEMINI_API_KEY en .env');
    return;
  }
  
  console.log('====================================');
  console.log('PRUEBA DE API GEMINI');
  console.log('====================================');
  console.log(`API Key: ${apiKey.substring(0, 10)}...${apiKey.substring(apiKey.length - 5)}`);
  console.log('');
  
  // Mock de commits para prueba
  const mockCommits = [
    'feat: agregar autenticación de usuarios',
    'fix: corregir error en validación de formularios',
    'refactor: optimizar consultas a base de datos'
  ];
  
  const prompt = `Eres un asistente que ayuda a generar descripciones de actividades laborales para un sistema de registro de tiempo.

Basándote en los siguientes commits de git, genera:
1. Un título corto (máximo 100 caracteres) que resuma la actividad
2. Una descripción detallada (máximo 500 caracteres) que explique el trabajo realizado

Commits:
${mockCommits.join('\n')}

Responde SOLO en formato JSON válido, sin texto adicional:
{"title": "título corto aquí", "detail": "descripción detallada aquí"}`;
  
  // Modelos a probar (ordenados por probabilidad de ser gratuitos)
  const models = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-exp',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-flash-8b',
    'gemini-pro',
    'gemini-1.0-pro',
    'gemini-1.0-pro-latest'
  ];
  
  let workingModel = null;
  
  for (const model of models) {
    console.log(`\n------------------------------------`);
    console.log(`Probando modelo: ${model}`);
    console.log(`------------------------------------`);
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    console.log(`URL: ${url}`);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 1024
          }
        }),
        signal: AbortSignal.timeout(15000)
      });
      
      console.log(`Status: ${response.status} ${response.statusText}`);
      
      const data = await response.json();
      
      if (!response.ok) {
        console.log(`Error: ${JSON.stringify(data.error || data, null, 2)}`);
        continue;
      }
      
      // Intentar extraer el texto de la respuesta
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!text) {
        console.log('Respuesta completa:', JSON.stringify(data, null, 2));
        console.log('No se encontró texto en la respuesta');
        continue;
      }
      
      console.log(`\n✓ ÉXITO con modelo: ${model}`);
      console.log(`\nRespuesta de la IA:`);
      console.log(text);
      
      // Intentar parsear JSON
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const result = JSON.parse(jsonMatch[0]);
          console.log(`\nJSON parseado:`);
          console.log(`Title: ${result.title}`);
          console.log(`Detail: ${result.detail}`);
        }
      } catch (parseErr) {
        console.log(`\nNo se pudo parsear JSON: ${parseErr.message}`);
      }
      
      workingModel = model;
      break;
      
    } catch (err) {
      console.log(`Error de conexión: ${err.message}`);
      continue;
    }
  }
  
  console.log('\n====================================');
  console.log('RESULTADO FINAL');
  console.log('====================================');
  
  if (workingModel) {
    console.log(`✓ Modelo que funciona: ${workingModel}`);
    console.log(`\nAgrega esto a tu .env:`);
    console.log(`GEMINI_MODEL='${workingModel}'`);
  } else {
    console.log('✗ Ningún modelo funcionó');
    console.log('\nPosibles causas:');
    console.log('1. API key inválida o expirada');
    console.log('2. API key sin permisos para estos modelos');
    console.log('3. Problema de conexión o quota');
    console.log('\nVerifica tu API key en: https://aistudio.google.com/app/apikey');
  }
};

testGeminiAPI();
