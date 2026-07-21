'use strict';
const citaRepo      = require('../database/repositories/citaRepo');
const whatsapp      = require('../services/whatsapp');
const reportHandler = require('./reportHandler');
const T             = require('../utils/messageTemplates');
const logger        = require('../utils/logger');

/**
 * Verifica y envía recordatorios pendientes.
 * Llamado por node-cron cada 5 minutos.
 */
async function verificarYEnviarRecordatorios() {
  if (!whatsapp.getIsReady()) return;
  await enviarRecordatorios24h();
  await enviarRecordatorios2h();
}

async function enviarRecordatorios24h() {
  const citas = citaRepo.findPendientesRecordatorio24h();

  for (const cita of citas) {
    try {
      const msg = T.recordatorio24h(
        cita.paciente_nombre,
        cita.medico_nombre,
        cita.fecha_hora,
        cita.motivo_consulta
      );

      await whatsapp.sendMessage(cita.paciente_telefono, msg);
      citaRepo.marcarRecordatorio24h(cita.id);

      logger.info(`Recordatorio 24h enviado a ${cita.paciente_telefono} para cita ${cita.id}`);
    } catch (e) {
      logger.error(`Error enviando recordatorio 24h cita ${cita.id}: ${e.message}`);
    }
  }
}

async function enviarRecordatorios2h() {
  const citas = citaRepo.findPendientesRecordatorio2h();

  for (const cita of citas) {
    try {
      // 1. Mensaje al paciente
      const msgPaciente = T.recordatorio2h(
        cita.paciente_nombre,
        cita.medico_nombre,
        cita.fecha_hora
      );
      await whatsapp.sendMessage(cita.paciente_telefono, msgPaciente);

      // 2. Reporte pre-consulta al médico
      await reportHandler.enviarReportePreConsulta(cita);

      citaRepo.marcarRecordatorio2h(cita.id);
      logger.info(`Recordatorio 2h enviado para cita ${cita.id}`);
    } catch (e) {
      logger.error(`Error enviando recordatorio 2h cita ${cita.id}: ${e.message}`);
    }
  }
}

module.exports = { verificarYEnviarRecordatorios };
