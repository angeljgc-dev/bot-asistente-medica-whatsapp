'use strict';
const { getDb } = require('../db');

function get(telefono) {
  const row = getDb()
    .prepare('SELECT * FROM sesiones WHERE telefono = ?')
    .get(telefono);

  if (!row) return null;

  return {
    ...row,
    datos_temporales:   JSON.parse(row.datos_temporales   || '{}'),
    historial_mensajes: JSON.parse(row.historial_mensajes || '[]'),
  };
}

function upsert(telefono, { estadoFlujo, datosTemporales, historialMensajes }) {
  const dt = JSON.stringify(datosTemporales   || {});
  const hm = JSON.stringify(historialMensajes || []);

  getDb().prepare(`
    INSERT INTO sesiones (telefono, estado_flujo, datos_temporales, historial_mensajes, ultima_actividad)
    VALUES (?, ?, ?, ?, datetime('now','localtime'))
    ON CONFLICT(telefono) DO UPDATE SET
      estado_flujo       = excluded.estado_flujo,
      datos_temporales   = excluded.datos_temporales,
      historial_mensajes = excluded.historial_mensajes,
      ultima_actividad   = datetime('now','localtime')
  `).run(telefono, estadoFlujo || 'idle', dt, hm);
}

function reset(telefono) {
  upsert(telefono, { estadoFlujo: 'idle', datosTemporales: {}, historialMensajes: [] });
}

function limpiarInactivas(timeoutMs) {
  const limiteSecs = Math.floor(timeoutMs / 1000);
  // Sólo resetea el estado a 'idle' — preserva datos_temporales para poder
  // recuperar contexto (ej: cita_id_creada) si el paciente retoma la conversación.
  getDb().prepare(`
    UPDATE sesiones
    SET estado_flujo = 'idle', ultima_actividad = datetime('now','localtime')
    WHERE estado_flujo != 'idle'
      AND (UNIXEPOCH('now') - UNIXEPOCH(ultima_actividad)) > ?
  `).run(limiteSecs);
}

module.exports = { get, upsert, reset, limpiarInactivas };
