'use strict';
const { getDb }                = require('../db');
const { toSqliteDateTime }     = require('../../utils/dateFormatter');
const { BUFFER_ENTRE_CITAS_MIN } = require('../../config/constants');

/**
 * Verifica si existe conflicto de horario para el médico en la fecha/hora,
 * incluyendo el buffer de limpieza entre citas.
 */
function verificarConflicto(medicoId, fechaHora, duracionMin = 30, excluirCitaId = null) {
  const inicio = new Date(fechaHora);
  const fin    = new Date(inicio.getTime() + duracionMin * 60_000);

  // Citas existentes bloquean duracion_min + BUFFER_ENTRE_CITAS_MIN
  let sql = `
    SELECT id FROM citas
    WHERE medico_id = ?
      AND estado NOT IN ('cancelada','no_asistio')
      AND datetime(fecha_hora) < datetime(?)
      AND datetime(fecha_hora, '+' || (duracion_min + ${BUFFER_ENTRE_CITAS_MIN}) || ' minutes') > datetime(?)
  `;
  const params = [medicoId, toSqliteDateTime(fin), toSqliteDateTime(inicio)];

  if (excluirCitaId) {
    sql += ' AND id != ?';
    params.push(excluirCitaId);
  }

  const row = getDb().prepare(sql).get(...params);
  return !!row;
}

function create({ pacienteId, medicoId, fechaHora, duracionMin = 30, motivoConsulta = null, primeraVisita = 0 }) {
  const info = getDb().prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, motivo_consulta, primera_visita, estado)
    VALUES (?, ?, ?, ?, ?, ?, 'programada')
  `).run(pacienteId, medicoId, toSqliteDateTime(fechaHora), duracionMin, motivoConsulta, primeraVisita ? 1 : 0);
  return info.lastInsertRowid;
}

function findProximaActivaPaciente(pacienteId) {
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre, p.nombre AS paciente_nombre, p.telefono AS paciente_telefono
    FROM citas c
    JOIN medicos m ON m.id = c.medico_id
    JOIN pacientes p ON p.id = c.paciente_id
    WHERE c.paciente_id = ?
      AND c.estado NOT IN ('cancelada','completada','no_asistio')
      AND c.fecha_hora >= datetime('now','localtime')
    ORDER BY c.fecha_hora ASC
    LIMIT 1
  `).get(pacienteId) || null;
}

function findAllActivasPaciente(pacienteId) {
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre, p.nombre AS paciente_nombre, p.telefono AS paciente_telefono
    FROM citas c
    JOIN medicos m ON m.id = c.medico_id
    JOIN pacientes p ON p.id = c.paciente_id
    WHERE c.paciente_id = ?
      AND c.estado NOT IN ('cancelada','completada','no_asistio')
      AND c.fecha_hora >= datetime('now','localtime')
    ORDER BY c.fecha_hora ASC
  `).all(pacienteId);
}

function findById(id) {
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre, p.nombre AS paciente_nombre, p.telefono AS paciente_telefono
    FROM citas c
    JOIN medicos m ON m.id = c.medico_id
    JOIN pacientes p ON p.id = c.paciente_id
    WHERE c.id = ?
  `).get(id) || null;
}

function cancelar(citaId) {
  getDb().prepare(`UPDATE citas SET estado = 'cancelada' WHERE id = ?`).run(citaId);
}

function setMotivo(citaId, motivo) {
  getDb().prepare(`UPDATE citas SET motivo_consulta = ? WHERE id = ?`).run(motivo, citaId);
}

function setPrimeraVisita(citaId, esPrimera) {
  getDb().prepare(`UPDATE citas SET primera_visita = ? WHERE id = ?`).run(esPrimera ? 1 : 0, citaId);
}

function setCalendarEventId(citaId, eventId) {
  getDb().prepare(`UPDATE citas SET google_calendar_event_id = ? WHERE id = ?`).run(eventId, citaId);
}

/** Para recordatorios de 24h */
function findPendientesRecordatorio24h() {
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre, p.nombre AS paciente_nombre, p.telefono AS paciente_telefono
    FROM citas c
    JOIN medicos m ON m.id = c.medico_id
    JOIN pacientes p ON p.id = c.paciente_id
    WHERE c.estado NOT IN ('cancelada','completada','no_asistio')
      AND c.recordatorio_24h_enviado = 0
      AND c.fecha_hora BETWEEN datetime('now','localtime','+23 hours') AND datetime('now','localtime','+25 hours')
  `).all();
}

/** Para recordatorios de 2h (reemplaza 1h) */
function findPendientesRecordatorio2h() {
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre, p.nombre AS paciente_nombre, p.telefono AS paciente_telefono
    FROM citas c
    JOIN medicos m ON m.id = c.medico_id
    JOIN pacientes p ON p.id = c.paciente_id
    WHERE c.estado NOT IN ('cancelada','completada','no_asistio')
      AND c.recordatorio_2h_enviado = 0
      AND c.fecha_hora BETWEEN datetime('now','localtime','+115 minutes') AND datetime('now','localtime','+125 minutes')
  `).all();
}

function marcarRecordatorio24h(citaId) {
  getDb().prepare(`UPDATE citas SET recordatorio_24h_enviado = 1 WHERE id = ?`).run(citaId);
}

function marcarRecordatorio2h(citaId) {
  getDb().prepare(`UPDATE citas SET recordatorio_2h_enviado = 1 WHERE id = ?`).run(citaId);
}

/** Historial de citas pasadas de un paciente (últimas N) */
function findHistorialPaciente(pacienteId, limite = 5) {
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre
    FROM citas c
    JOIN medicos m ON m.id = c.medico_id
    WHERE c.paciente_id = ?
      AND c.estado IN ('completada','cancelada','no_asistio')
    ORDER BY c.fecha_hora DESC
    LIMIT ?
  `).all(pacienteId, limite);
}

// ── Asistencia ────────────────────────────────────────────────────────────────

/**
 * Citas que iniciaron hace entre 10 y 60 min y aún no han sido consultadas.
 * El bot preguntará al médico si el paciente llegó.
 */
function findPendientesAsistencia() {
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre, m.telefono AS medico_telefono,
           p.nombre AS paciente_nombre, p.telefono AS paciente_telefono
    FROM citas c
    JOIN medicos m ON m.id = c.medico_id
    JOIN pacientes p ON p.id = c.paciente_id
    WHERE c.estado IN ('programada','confirmada')
      AND c.asistencia_preguntada = 0
      AND c.fecha_hora BETWEEN datetime('now','localtime','-60 minutes')
                           AND datetime('now','localtime','-10 minutes')
    ORDER BY c.fecha_hora ASC
  `).all();
}

/**
 * Primera cita que ya fue consultada pero el médico aún no ha respondido.
 * Se usa para procesar la respuesta del médico sin necesidad de sesión.
 */
function findPendienteRespuestaDoctor() {
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre, m.telefono AS medico_telefono,
           p.nombre AS paciente_nombre, p.telefono AS paciente_telefono
    FROM citas c
    JOIN medicos m ON m.id = c.medico_id
    JOIN pacientes p ON p.id = c.paciente_id
    WHERE c.asistencia_preguntada = 1
      AND c.estado IN ('programada','confirmada')
    ORDER BY c.fecha_hora ASC
    LIMIT 1
  `).get() || null;
}

function marcarAsistenciaPreguntada(citaId) {
  getDb().prepare(`UPDATE citas SET asistencia_preguntada = 1 WHERE id = ?`).run(citaId);
}

function marcarAsistio(citaId) {
  getDb().prepare(`UPDATE citas SET estado = 'completada' WHERE id = ?`).run(citaId);
}

function marcarNoAsistio(citaId) {
  getDb().prepare(`UPDATE citas SET estado = 'no_asistio' WHERE id = ?`).run(citaId);
}

module.exports = {
  verificarConflicto,
  create,
  findProximaActivaPaciente,
  findAllActivasPaciente,
  findById,
  cancelar,
  setMotivo,
  setPrimeraVisita,
  setCalendarEventId,
  findPendientesRecordatorio24h,
  findPendientesRecordatorio2h,
  marcarRecordatorio24h,
  marcarRecordatorio2h,
  findHistorialPaciente,
  findPendientesAsistencia,
  findPendienteRespuestaDoctor,
  marcarAsistenciaPreguntada,
  marcarAsistio,
  marcarNoAsistio,
};
