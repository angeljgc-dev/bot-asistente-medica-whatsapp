'use strict';
const citaRepo     = require('../database/repositories/citaRepo');
const whatsapp     = require('../services/whatsapp');
const T            = require('../utils/messageTemplates');
const env          = require('../config/env');
const logger       = require('../utils/logger');

/**
 * Número canonico del médico (sin +).
 */
function doctorPhone() {
  return env.DOCTOR_PHONE?.replace(/^\+/, '');
}

/**
 * Llamado por el cron cada 5 min.
 * Busca citas que iniciaron hace 10-60 min y pregunta al médico si el paciente llegó.
 * Solo envía un mensaje a la vez: si ya hay una pregunta pendiente sin respuesta,
 * las nuevas citas quedan marcadas en BD y serán preguntadas cuando el médico responda.
 */
async function verificarYPreguntar() {
  if (!whatsapp.getIsReady()) return;
  const pendientes = citaRepo.findPendientesAsistencia();
  if (pendientes.length === 0) return;

  // Verificar si el médico ya tiene una pregunta sin responder
  const yaHayPendiente = citaRepo.findPendienteRespuestaDoctor();

  for (const cita of pendientes) {
    // Marcar en BD para no volver a preguntar
    citaRepo.marcarAsistenciaPreguntada(cita.id);
    logger.info(`Asistencia: marcada como preguntada cita ${cita.id} — ${cita.paciente_nombre}`);

    // Solo enviar mensaje si no hay otra pregunta activa
    if (!yaHayPendiente) {
      try {
        await whatsapp.sendMessage(doctorPhone(), T.preguntarAsistencia(cita));
        logger.info(`Asistencia: pregunta enviada al médico para cita ${cita.id} — ${cita.paciente_nombre}`);
      } catch (e) {
        logger.error(`Asistencia: error enviando pregunta al médico: ${e.message}`);
      }
      // Solo enviamos la primera; las demás esperarán en cola (BD)
      break;
    }
  }
}

/**
 * Procesa la respuesta del médico (sí / no).
 * Llamado desde messageRouter cuando el mensaje viene del DOCTOR_PHONE
 * y hay una cita con asistencia_preguntada=1 pendiente de respuesta.
 *
 * @param {object} cita  - La cita pendiente (ya cargada por el router)
 * @param {string} texto - Mensaje del médico
 * @returns {string}     - Respuesta a enviar de vuelta al médico
 */
async function procesarRespuestaDoctor(cita, texto) {
  const { detectarIntencion } = require('../parsers/intentParser');
  const intencion = detectarIntencion(texto);

  if (intencion !== 'confirmar_si' && intencion !== 'confirmar_no') {
    // No entendió — volver a preguntar
    return `No entendí 😅 ¿*${cita.paciente_nombre}* llegó a su cita de las *${require('../utils/dateFormatter').formatoSoloHora(cita.fecha_hora)}*?\n\nResponde *sí* o *no*.`;
  }

  const asistio = intencion === 'confirmar_si';

  if (asistio) {
    citaRepo.marcarAsistio(cita.id);
    logger.info(`Asistencia: cita ${cita.id} — ${cita.paciente_nombre} ASISTIÓ`);
  } else {
    citaRepo.marcarNoAsistio(cita.id);
    logger.info(`Asistencia: cita ${cita.id} — ${cita.paciente_nombre} NO ASISTIÓ`);
  }

  // Buscar la siguiente cita pendiente de respuesta (si la hay)
  const siguiente = citaRepo.findPendienteRespuestaDoctor();

  // Si hay siguiente, enviar pregunta encadenada dentro de la misma respuesta
  return T.asistenciaRegistrada(cita.paciente_nombre, asistio, siguiente || null);
}

module.exports = { verificarYPreguntar, procesarRespuestaDoctor };
