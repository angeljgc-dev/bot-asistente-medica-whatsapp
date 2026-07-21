'use strict';
const pacienteRepo = require('../database/repositories/pacienteRepo');
const whatsapp     = require('../services/whatsapp');
const T            = require('../utils/messageTemplates');
const { calcularEdad } = require('../utils/dateFormatter');
const logger       = require('../utils/logger');

/**
 * Verifica cumpleaños del día y envía felicitaciones.
 * Llamado por node-cron a las 9:00 AM.
 */
async function enviarFelicitaciones() {
  if (!whatsapp.getIsReady()) return;
  const pacientes = pacienteRepo.findCumpleanosHoy();

  if (pacientes.length === 0) {
    logger.debug('Cumpleaños: sin pacientes hoy');
    return;
  }

  logger.info(`Cumpleaños: enviando felicitaciones a ${pacientes.length} paciente(s)`);

  for (const p of pacientes) {
    try {
      const edad = p.fecha_nacimiento ? calcularEdad(p.fecha_nacimiento) : null;
      const msg  = T.felizCumpleanos(p.nombre || 'amigo/a', edad);
      await whatsapp.sendMessage(p.telefono, msg);
      logger.info(`Felicitación enviada a ${p.nombre} (${p.telefono})`);
    } catch (e) {
      logger.error(`Error enviando felicitación a ${p.telefono}: ${e.message}`);
    }
  }
}

module.exports = { enviarFelicitaciones };
