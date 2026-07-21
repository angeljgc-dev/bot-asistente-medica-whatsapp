'use strict';
const pacienteRepo = require('../database/repositories/pacienteRepo');
const metricas     = require('../database/repositories/metricasRepo');
const whatsapp     = require('./whatsapp');
const logger       = require('../utils/logger');

// Rate-limit: 1 msg/segundo por defecto.
// Ajustable vía env.BROADCAST_DELAY_MS para pruebas (no se expone en README).
const DEFAULT_DELAY_MS = Number(process.env.BROADCAST_DELAY_MS || 1000);

// Umbral a partir del cual exigimos `force=true` para proteger la cuenta de WA.
const FORCE_THRESHOLD = 500;

const SEGMENTOS_VALIDOS = new Set([
  'todos_activos',
  'inactivos_90d',
  'cumpleaneros_mes',
  'asistio_reciente',
]);

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Personaliza placeholders básicos en la plantilla.
 * Soporta {{nombre}} con fallback a "" si el campo está vacío.
 */
function _personalizar(plantilla, paciente) {
  return String(plantilla).replace(/\{\{\s*nombre\s*\}\}/g, (paciente.nombre || '').split(' ')[0] || '');
}

/**
 * Envía el mismo mensaje a todos los pacientes del segmento indicado.
 * Respeta baja_fecha (opt-out ARCO), rate-limitea 1/s, y registra métricas.
 *
 * @param {string}  segmento    uno de SEGMENTOS_VALIDOS
 * @param {string}  mensaje     plantilla, acepta {{nombre}}
 * @param {object}  opts        { force: bool, delayMs: number }
 * @returns {{ enviados, fallos, total, segmento }}
 */
async function enviarBroadcast(segmento, mensaje, opts = {}) {
  if (!SEGMENTOS_VALIDOS.has(segmento)) {
    throw new Error(`Segmento inválido: ${segmento}`);
  }
  if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length === 0) {
    throw new Error('Mensaje vacío');
  }

  const pacientes = pacienteRepo.listarPorSegmento(segmento);

  if (pacientes.length > FORCE_THRESHOLD && !opts.force) {
    throw new Error(
      `Broadcast a ${pacientes.length} pacientes requiere { force: true } ` +
      `(umbral ${FORCE_THRESHOLD}).`
    );
  }

  if (!whatsapp.getIsReady()) {
    throw new Error('WhatsApp no conectado');
  }

  const delay = Number(opts.delayMs ?? DEFAULT_DELAY_MS);
  let enviados = 0, fallos = 0;

  logger.info(`Broadcast iniciado: segmento=${segmento} total=${pacientes.length}`);

  for (const p of pacientes) {
    try {
      const texto = _personalizar(mensaje, p);
      await whatsapp.sendMessage(p.telefono, texto);
      enviados++;
      try {
        metricas.registrar('broadcast_enviado', p.telefono, {
          segmento,
          paciente_id: p.id,
        });
      } catch (_) { /* métricas best-effort */ }
    } catch (e) {
      fallos++;
      logger.warn(`Broadcast fallo para ${p.telefono}: ${e.message}`);
    }
    if (delay > 0) await _sleep(delay);
  }

  logger.info(`Broadcast terminado: segmento=${segmento} enviados=${enviados} fallos=${fallos}`);

  return {
    segmento,
    total:    pacientes.length,
    enviados,
    fallos,
  };
}

module.exports = {
  enviarBroadcast,
  SEGMENTOS_VALIDOS: Array.from(SEGMENTOS_VALIDOS),
};
