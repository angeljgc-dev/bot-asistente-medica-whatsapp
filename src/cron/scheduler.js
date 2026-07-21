'use strict';
const cron              = require('node-cron');
const reminderHandler   = require('../handlers/reminderHandler');
const birthdayHandler   = require('../handlers/birthdayHandler');
const attendanceHandler = require('../handlers/attendanceHandler');
const npsHandler        = require('../handlers/npsHandler');
const sessionManager    = require('../session/sessionManager');
const { cleanupResolved } = require('../queue/messageQueue');
const logger            = require('../utils/logger');

// Umbrales para la alerta de  (extraídos para poder probarlos/ajustarlos).
const FALLBACK_MIN_SAMPLE   = 10;   // muestra mínima para no gritar con ruido
const FALLBACK_ALERT_PCT    = 20;   // porcentaje a partir del cual alertamos
const FALLBACK_WINDOW_HOURS = 1;    // ventana de observación

/**
 * Alerta por fallback_rate elevado.
 * Compara intents detectados vs fallbacks a Groq en la última hora.
 * Si el total es muy chico, no dice nada (evita ruido nocturno).
 * Si el pct supera el umbral, logea WARN (opcionalmente avisa al doctor).
 */
async function jobAlertaFallback() {
  try {
    const metricas = require('../database/repositories/metricasRepo');
    const { getDb } = require('../database/db');
    const desdeRow = getDb()
      .prepare(`SELECT datetime('now','localtime','-${FALLBACK_WINDOW_HOURS} hour') AS d`)
      .get();
    const intents   = metricas.contarPorTipo('intent_detectado', desdeRow.d);
    const fallbacks = metricas.contarPorTipo('fallback_groq', desdeRow.d);
    const total = intents + fallbacks;
    if (total < FALLBACK_MIN_SAMPLE) return;
    const pct = (fallbacks / total) * 100;
    if (pct > FALLBACK_ALERT_PCT) {
      logger.warn(
        `[ALERTA] fallback_rate=${pct.toFixed(1)}% en última ${FALLBACK_WINDOW_HOURS}h ` +
        `(${fallbacks}/${total}) — el parser está perdiendo intents`
      );
    }
  } catch (e) {
    logger.warn(`jobAlertaFallback error: ${e.message}`);
  }
}

function iniciarScheduler() {
  // Recordatorios + verificación de asistencia: cada 5 minutos
  cron.schedule('*/5 * * * *', async () => {
    logger.debug('Cron: verificando recordatorios y asistencia...');
    await reminderHandler.verificarYEnviarRecordatorios();
    await attendanceHandler.verificarYPreguntar();
  });

  // Cumpleaños: cada día a las 9:00 AM
  cron.schedule('0 9 * * *', async () => {
    logger.info('Cron: verificando cumpleaños...');
    await birthdayHandler.enviarFelicitaciones();
  });

  // Limpiar sesiones inactivas: cada 5 minutos
  cron.schedule('*/5 * * * *', () => {
    sessionManager.limpiarInactivas();
    cleanupResolved();
  });

  // Alerta por fallback_rate cada 15 minutos
  cron.schedule('*/15 * * * *', jobAlertaFallback);

  // Encuesta NPS post-consulta, diariamente a las 19:00
  cron.schedule('0 19 * * *', async () => {
    logger.info('Cron: enviando encuestas NPS pendientes...');
    await npsHandler.enviarEncuestasPendientes();
  });

  logger.info('Scheduler iniciado: recordatorios 5min, cumpleaños 9am, alerta fallback 15min, NPS 19:00');
}

module.exports = { iniciarScheduler, jobAlertaFallback };
