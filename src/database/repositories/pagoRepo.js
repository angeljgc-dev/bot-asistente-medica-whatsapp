'use strict';
const { getDb } = require('../db');

/**
 * Repositorio de pagos.
 * Estados: 'pendiente' → 'exitoso' | 'fallido' | 'expirado'.
 */

function crear({ citaId, telefono, sessionId, montoCentavos, moneda, metadata }) {
  const info = getDb().prepare(
    `INSERT INTO pagos (cita_id, telefono, stripe_session_id, monto_centavos, moneda, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    citaId ?? null,
    telefono,
    sessionId,
    montoCentavos,
    moneda || 'mxn',
    metadata ? JSON.stringify(metadata) : null
  );
  return info.lastInsertRowid;
}

function findBySessionId(sessionId) {
  return getDb().prepare(`SELECT * FROM pagos WHERE stripe_session_id = ?`).get(sessionId) || null;
}

function findPendienteByTelefono(telefono) {
  return getDb().prepare(
    `SELECT * FROM pagos WHERE telefono = ? AND estado = 'pendiente' ORDER BY id DESC LIMIT 1`
  ).get(telefono) || null;
}

function marcarEstado(sessionId, estado) {
  getDb().prepare(
    `UPDATE pagos
        SET estado = ?, actualizado_en = datetime('now','localtime')
      WHERE stripe_session_id = ?`
  ).run(estado, sessionId);
}

function vincularCita(sessionId, citaId) {
  getDb().prepare(
    `UPDATE pagos SET cita_id = ? WHERE stripe_session_id = ?`
  ).run(citaId, sessionId);
}

/**
 * Lista pagos pendientes que ya expiraron (más viejos que `minutosTimeout`).
 * Se usa en el cron para liberar slots de citas sin pago.
 */
function listarPendientesExpirados(minutosTimeout) {
  return getDb().prepare(
    `SELECT * FROM pagos
      WHERE estado = 'pendiente'
        AND datetime(creado_en) < datetime('now','localtime','-${minutosTimeout} minutes')`
  ).all();
}

module.exports = {
  crear,
  findBySessionId,
  findPendienteByTelefono,
  marcarEstado,
  vincularCita,
  listarPendientesExpirados,
};
