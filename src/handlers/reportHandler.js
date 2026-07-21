'use strict';
const citaRepo     = require('../database/repositories/citaRepo');
const pacienteRepo = require('../database/repositories/pacienteRepo');
const medicoRepo   = require('../database/repositories/medicoRepo');
const whatsapp     = require('../services/whatsapp');
const T            = require('../utils/messageTemplates');
const logger       = require('../utils/logger');

/**
 * Genera y envía el reporte pre-consulta al médico, 1h antes de la cita.
 */
async function enviarReportePreConsulta(cita) {
  try {
    const paciente = pacienteRepo.findById(cita.paciente_id);
    const medico   = medicoRepo.findById(cita.medico_id);

    if (!paciente || !medico) return;

    const historial = citaRepo.findHistorialPaciente(paciente.id, 5);

    const msg = T.reportePreConsulta(paciente, cita, medico, historial);

    await whatsapp.sendMessage(medico.telefono, msg);
    logger.info(`Reporte pre-consulta enviado al médico ${medico.nombre} para cita ${cita.id}`);
  } catch (e) {
    logger.error(`Error enviando reporte pre-consulta cita ${cita.id}: ${e.message}`);
  }
}

module.exports = { enviarReportePreConsulta };
