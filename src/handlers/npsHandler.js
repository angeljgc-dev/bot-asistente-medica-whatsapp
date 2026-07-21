'use strict';
const npsRepo        = require('../database/repositories/npsRepo');
const sessionManager = require('../session/sessionManager');
const whatsapp       = require('../services/whatsapp');
const metricas       = require('../database/repositories/metricasRepo');
const logger         = require('../utils/logger');
const { ESTADOS }    = require('../config/constants');

function _trackMetric(tipo, telefono, payload) {
  try { metricas.registrar(tipo, telefono, payload); }
  catch (e) { logger.warn(`metricas.registrar fallo: ${e.message}`); }
}

/**
 * Job diario (cron scheduler). Envía la encuesta NPS a los pacientes cuya
 * cita fue `completada` hace 24..26 h y no han recibido encuesta aún.
 *
 * Disparar respuesta del paciente coloca la sesión en ESPERANDO_NPS_PUNTAJE,
 * y el router la rutea aquí.
 */
async function enviarEncuestasPendientes() {
  if (!whatsapp.getIsReady()) return;
  const citas = npsRepo.citasPendientesNPS();
  if (citas.length === 0) {
    logger.debug('NPS: sin encuestas pendientes');
    return;
  }

  logger.info(`NPS: enviando ${citas.length} encuesta(s) post-consulta`);

  for (const cita of citas) {
    try {
      if (npsRepo.yaEnviadaParaCita(cita.id)) continue;
      const id = npsRepo.crearEnvio(cita.id, cita.paciente_telefono);

      const mensaje =
        `Hola ${cita.paciente_nombre?.split(' ')[0] || ''} 👋\n\n` +
        `Gracias por venir a tu consulta con ${cita.medico_nombre}. ` +
        `¿Cómo calificarías la atención del *0 al 10*?\n` +
        `_(0 = muy mala, 10 = excelente)_`;

      await whatsapp.sendMessage(cita.paciente_telefono, mensaje);

      // Preparamos la sesión del paciente para que el próximo mensaje lo
      // interpretemos como puntaje NPS.
      const sesion = sessionManager.cargar(cita.paciente_telefono);
      sesion.datos_temporales = sesion.datos_temporales || {};
      sesion.datos_temporales.nps_envio_id = id;
      sesion.datos_temporales.nps_cita_id  = cita.id;
      sessionManager.cambiarEstado(sesion, ESTADOS.ESPERANDO_NPS_PUNTAJE);

      _trackMetric('nps_enviada', cita.paciente_telefono, { cita_id: cita.id });
    } catch (e) {
      logger.error(`NPS: error enviando a ${cita.paciente_telefono} (cita ${cita.id}): ${e.message}`);
    }
  }
}

/**
 * Llamado desde el router cuando la sesión está en ESPERANDO_NPS_PUNTAJE o
 * ESPERANDO_NPS_COMENTARIO. Devuelve el texto de respuesta al paciente.
 */
async function manejarRespuesta(sesion, paciente, texto) {
  const estado = sesion.estado_flujo;

  if (estado === ESTADOS.ESPERANDO_NPS_PUNTAJE) {
    // Extraer primer número 0..10 del texto.
    const match = (texto || '').match(/\b(10|[0-9])\b/);
    if (!match) {
      return `🙏 ¿Me podrías dar un número del *0 al 10*?\n_(0 = muy mala, 10 = excelente)_`;
    }
    const puntaje = parseInt(match[1], 10);
    const envioId = sesion.datos_temporales?.nps_envio_id;
    if (!envioId) {
      // No deberíamos llegar aquí, pero si la sesión está corrupta, no romper.
      sessionManager.resetear(sesion);
      return null;
    }

    npsRepo.guardarPuntaje(envioId, puntaje);
    _trackMetric('nps_puntaje', paciente?.telefono, { envio_id: envioId, puntaje });

    sessionManager.cambiarEstado(sesion, ESTADOS.ESPERANDO_NPS_COMENTARIO);
    return `¡Gracias! 🙏 ¿Algún comentario que nos quieras dejar?\n_(Escribe *no* para omitir)_`;
  }

  if (estado === ESTADOS.ESPERANDO_NPS_COMENTARIO) {
    const envioId = sesion.datos_temporales?.nps_envio_id;
    const limpio  = (texto || '').trim();
    const omite   = /^(no|ninguno|ninguna|nada|omitir|skip|gracias)$/i.test(limpio);
    const comentario = omite ? null : limpio.slice(0, 500);

    if (envioId) {
      npsRepo.guardarComentario(envioId, comentario);
      _trackMetric('nps_comentario', paciente?.telefono, { envio_id: envioId, tiene_comentario: !!comentario });
    }

    sessionManager.resetear(sesion);
    return `¡Gracias por tu opinión! 💙 Nos ayuda a mejorar.`;
  }

  return null;
}

module.exports = {
  enviarEncuestasPendientes,
  manejarRespuesta,
};
