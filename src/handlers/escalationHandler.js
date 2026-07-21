'use strict';
const whatsapp     = require('../services/whatsapp');
const sessionManager = require('../session/sessionManager');
const T            = require('../utils/messageTemplates');
const { ESTADOS }  = require('../config/constants');
const env          = require('../config/env');
const logger       = require('../utils/logger');

const TIMEOUT_ESCALACION_MS = 30 * 60 * 1000;  // 30 minutos

/**
 * Inicia el flujo de escalación al médico/admin.
 */
async function escalar(sesion, paciente, ultimoMensaje) {
  sessionManager.cambiarEstado(sesion, ESTADOS.ESCALADO_HUMANO);
  sesion.datos_temporales.escalado_en = Date.now();
  sessionManager.guardar(sesion);

  // Alertar al médico/admin
  try {
    const msg = T.alertaEscalacion(
      paciente?.nombre || 'Paciente desconocido',
      sesion.telefono,
      ultimoMensaje
    );
    await whatsapp.sendMessage(env.DOCTOR_PHONE, msg);
    logger.info(`Escalación: paciente ${sesion.telefono} transferido al médico`);
  } catch (e) {
    logger.error(`Error notificando médico en escalación: ${e.message}`);
  }

  return T.escaladoHumano();
}

/**
 * Verifica si el timeout de escalación expiró y regresa al bot.
 */
function verificarTimeoutEscalacion(sesion) {
  if (sesion.estado_flujo !== ESTADOS.ESCALADO_HUMANO) return false;

  const escaladoEn = sesion.datos_temporales.escalado_en;
  if (!escaladoEn) return true;

  const elapsed = Date.now() - escaladoEn;
  return elapsed >= TIMEOUT_ESCALACION_MS;
}

/**
 * Escalación por triage de urgencia clínica alta.
 * Alerta al médico con prefijo destacado y retorna mensaje con 911.
 */
async function escalarUrgencia(sesion, paciente, ultimoMensaje) {
  sessionManager.cambiarEstado(sesion, ESTADOS.ESCALADO_HUMANO);
  sesion.datos_temporales.escalado_en = Date.now();
  sesion.datos_temporales.motivo_escalacion = 'triage_urgencia_alta';
  sessionManager.guardar(sesion);

  try {
    const msg = T.alertaUrgenciaAlta(
      paciente?.nombre,
      sesion.telefono,
      ultimoMensaje
    );
    await whatsapp.sendMessage(env.DOCTOR_PHONE, msg);
    logger.warn(`[URGENCIA] paciente ${sesion.telefono} reporta sintomas de urgencia alta`);
  } catch (e) {
    logger.error(`Error notificando médico en urgencia: ${e.message}`);
  }

  return T.urgenciaAlta();
}

module.exports = { escalar, escalarUrgencia, verificarTimeoutEscalacion };
