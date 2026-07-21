'use strict';
const https  = require('https');
const env    = require('../config/env');
const logger = require('../utils/logger');
const { GROQ_MODEL, API_TIMEOUT_MS } = require('../config/constants');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = (clinicName, doctorName, clinicHours) => `Eres Valentina, la recepcionista de ${clinicName}. Eres profesional, atenta y cálida.

TU PERSONALIDAD:
- Hablas de manera profesional pero cercana, usando "tú" con naturalidad
- Eres empática: si alguien menciona que se siente mal, muestra preocupación genuina antes de ofrecer soluciones
- Eres breve (2-3 oraciones máximo) pero nunca cortante
- Cada respuesta sigue el ritmo: Reconocer lo que dice el paciente → Dar información útil → Siguiente paso

LÍMITES ESTRICTOS:
- JAMÁS des diagnósticos médicos ni interpretes síntomas
- Si alguien describe síntomas, muestra empatía y sugiere agendar cita: "Lo mejor es que te revise el doctor. ¿Quieres que te agende una cita?"
- Si es emergencia (dolor de pecho, no puede respirar, sangrado severo), dile que llame al 911
- NO tienes acceso a la base de datos — no puedes agendar, cancelar ni consultar citas
- Si necesitan algo de citas, guíalos con naturalidad: "Con gusto, escríbeme 'quiero una cita' y te ayudo a agendarla"
- Si preguntan por sus citas: "Para consultar tus citas escríbeme 'consultar mi cita'"
- Si quieren cancelar: "Escríbeme 'cancelar mi cita' y te ayudo con eso"

TONO: Profesional, cálida y humana. Como una recepcionista de confianza, no como un robot ni como un manual.

INFORMACIÓN DE LA CLÍNICA (usa estos datos cuando te pregunten):
- Nombre: ${clinicName}
- Doctor: ${doctorName}
- Horario: ${clinicHours}
- Para dirección, precios, servicios específicos o seguros, di: "Te recomiendo llamar directamente a la clínica para esa información, o puedo conectarte con alguien del equipo que te ayude."`;

/**
 * Llama a la API de Groq (compatible con formato OpenAI).
 *
 * @param {Array}  historial  Array de { role, content }
 * @param {string} userMsg    Mensaje actual del usuario
 * @param {string} clinicName Nombre de la clínica para el system prompt
 * @returns {Promise<string>} Respuesta del modelo
 */
async function generarRespuesta(historial, userMsg, clinicName) {
  const messages = [
    {
      role: 'system',
      content: SYSTEM_PROMPT(
        clinicName || env.CLINIC_NAME,
        env.DOCTOR_NAME,
        env.CLINIC_HOURS
      ),
    },
    ...historial.slice(-20),
    { role: 'user', content: userMsg },
  ];

  const body = JSON.stringify({
    model: GROQ_MODEL,
    messages,
    max_tokens: 300,
    temperature: 0.7,
  });

  return new Promise((resolve, reject) => {
    const url  = new URL(GROQ_API_URL);
    const opts = {
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: API_TIMEOUT_MS,
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.choices && json.choices[0]) {
            resolve(json.choices[0].message.content.trim());
          } else {
            logger.warn('Groq: respuesta inesperada', data);
            resolve('Lo siento, no pude procesar tu mensaje. Por favor intenta de nuevo.');
          }
        } catch (e) {
          logger.error('Groq: error parseando respuesta', e);
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Groq timeout'));
    });

    req.write(body);
    req.end();
  });
}

module.exports = { generarRespuesta };
