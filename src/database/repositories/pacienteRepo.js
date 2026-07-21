'use strict';
const { getDb } = require('../db');

function findByTelefono(telefono) {
  return getDb()
    .prepare('SELECT * FROM pacientes WHERE telefono = ?')
    .get(telefono) || null;
}

function findById(id) {
  return getDb()
    .prepare('SELECT * FROM pacientes WHERE id = ?')
    .get(id) || null;
}

function create(telefono) {
  const info = getDb()
    .prepare('INSERT OR IGNORE INTO pacientes (telefono, estado) VALUES (?, ?)')
    .run(telefono, 'nuevo');
  return info.lastInsertRowid;
}

function update(telefono, campos) {
  const sets  = Object.keys(campos).map(k => `${k} = ?`).join(', ');
  const vals  = [...Object.values(campos), telefono];
  getDb()
    .prepare(`UPDATE pacientes SET ${sets} WHERE telefono = ?`)
    .run(...vals);
}

function setNombre(telefono, nombre) {
  update(telefono, { nombre, estado: 'registrando_cumple' });
}

function setFechaNacimiento(telefono, fecha) {
  const fechaStr = fecha instanceof Date
    ? `${fecha.getFullYear()}-${String(fecha.getMonth()+1).padStart(2,'0')}-${String(fecha.getDate()).padStart(2,'0')}`
    : fecha;
  update(telefono, { fecha_nacimiento: fechaStr, estado: 'activo' });
}

function setEstado(telefono, estado) {
  update(telefono, { estado });
}

function findCumpleanosHoy() {
  return getDb()
    .prepare(`
      SELECT * FROM pacientes
      WHERE estado = 'activo'
        AND fecha_nacimiento IS NOT NULL
        AND strftime('%m-%d', fecha_nacimiento) = strftime('%m-%d', 'now','localtime')
    `)
    .all();
}

function updateNombreSolo(telefono, nombre) {
  getDb().prepare('UPDATE pacientes SET nombre = ? WHERE telefono = ?').run(nombre, telefono);
}

function setFechaNacimientoSolo(telefono, fecha) {
  const fechaStr = fecha instanceof Date
    ? `${fecha.getFullYear()}-${String(fecha.getMonth()+1).padStart(2,'0')}-${String(fecha.getDate()).padStart(2,'0')}`
    : fecha;
  getDb().prepare('UPDATE pacientes SET fecha_nacimiento = ? WHERE telefono = ?').run(fechaStr, telefono);
}

// ── LFPDPPP — Consentimiento y derecho ARCO ──────────────────────────────────

/**
 * Registra el consentimiento expreso para el tratamiento de datos personales.
 * La versión permite detectar cuándo un paciente necesita re-consentir (fase posterior).
 */
function setConsentimiento(telefono, fecha, version) {
  const fechaStr = fecha instanceof Date ? fecha.toISOString() : fecha;
  update(telefono, {
    consentimiento_fecha:   fechaStr,
    consentimiento_version: version,
  });
}

/**
 * Elimina el registro del paciente SOLO si nunca dio consentimiento.
 * Pacientes con consentimiento deben usar darDeBaja (soft delete) para conservar
 * la trazabilidad ARCO — no se puede borrar de forma oculta.
 */
function deleteByTelefono(telefono) {
  const p = findByTelefono(telefono);
  if (!p) return false;
  if (p.consentimiento_fecha) return false;  // Ya consintió → usar darDeBaja
  getDb().prepare('DELETE FROM pacientes WHERE telefono = ?').run(telefono);
  return true;
}

/**
 * Soft delete (ejercicio del derecho ARCO de Cancelación).
 * Borra PII identificable dejando el id para reportes de cumplimiento.
 */
function darDeBaja(telefono, motivo) {
  update(telefono, {
    baja_fecha:       new Date().toISOString(),
    baja_motivo:      motivo || 'Solicitud del usuario',
    estado:           'inactivo',
    nombre:           '[BAJA]',
    fecha_nacimiento: null,
  });
}

/**
 * Lista pacientes por segmento para broadcasts.
 * Excluye siempre a quienes ejercieron baja (ARCO) y a los estados no activos.
 *
 * Segmentos soportados:
 *   - todos_activos       — pacientes con estado 'activo' y sin baja.
 *   - inactivos_90d       — última cita (cualquier estado salvo cancelada) > 90d.
 *   - cumpleaneros_mes    — cumpleaños en el mes actual.
 *   - asistio_reciente    — cita 'completada' en últimos 7 días.
 */
function listarPorSegmento(segmento) {
  const base = `
    SELECT p.id, p.telefono, p.nombre
      FROM pacientes p
     WHERE p.baja_fecha IS NULL
       AND p.estado = 'activo'
       AND p.telefono IS NOT NULL
  `;
  let sql;
  if (segmento === 'todos_activos') {
    sql = base;
  } else if (segmento === 'cumpleaneros_mes') {
    sql = base + ` AND strftime('%m', p.fecha_nacimiento) = strftime('%m','now','localtime')`;
  } else if (segmento === 'inactivos_90d') {
    sql = base + `
      AND NOT EXISTS (
        SELECT 1 FROM citas c
         WHERE c.paciente_id = p.id
           AND c.estado <> 'cancelada'
           AND datetime(c.fecha_hora) >= datetime('now','localtime','-90 days')
      )`;
  } else if (segmento === 'asistio_reciente') {
    sql = base + `
      AND EXISTS (
        SELECT 1 FROM citas c
         WHERE c.paciente_id = p.id
           AND c.estado = 'completada'
           AND datetime(c.fecha_hora) >= datetime('now','localtime','-7 days')
      )`;
  } else {
    throw new Error(`Segmento desconocido: ${segmento}`);
  }
  return getDb().prepare(sql).all();
}

module.exports = {
  findByTelefono,
  findById,
  create,
  update,
  setNombre,
  setFechaNacimiento,
  setEstado,
  findCumpleanosHoy,
  updateNombreSolo,
  setFechaNacimientoSolo,
  setConsentimiento,
  deleteByTelefono,
  darDeBaja,
  listarPorSegmento,
};
