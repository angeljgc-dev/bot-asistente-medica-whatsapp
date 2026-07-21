'use strict';
const { getDb } = require('../db');

/**
 * Repositorio NPS.
 *
 * `nps_respuestas` es una tabla append-only con un registro por envío.
 * Campo `puntaje` comienza NULL y se rellena cuando el paciente contesta.
 */

/**
 * Crea un registro de encuesta enviada. Devuelve el id generado.
 */
function crearEnvio(citaId, telefono) {
  const info = getDb().prepare(
    `INSERT INTO nps_respuestas (cita_id, telefono) VALUES (?, ?)`
  ).run(citaId, telefono);
  return info.lastInsertRowid;
}

/**
 * ¿Ya se envió NPS para esta cita?
 */
function yaEnviadaParaCita(citaId) {
  const row = getDb().prepare(
    `SELECT 1 AS ok FROM nps_respuestas WHERE cita_id = ? LIMIT 1`
  ).get(citaId);
  return !!row;
}

/**
 * Devuelve el último envío sin responder para un teléfono.
 * Se usa al recibir un mensaje mientras la sesión está en ESPERANDO_NPS_*.
 */
function ultimoPendientePorTelefono(telefono) {
  return getDb().prepare(
    `SELECT *
       FROM nps_respuestas
      WHERE telefono = ? AND puntaje IS NULL
   ORDER BY id DESC
      LIMIT 1`
  ).get(telefono);
}

function guardarPuntaje(id, puntaje) {
  getDb().prepare(
    `UPDATE nps_respuestas SET puntaje = ? WHERE id = ?`
  ).run(puntaje, id);
}

function guardarComentario(id, comentario) {
  getDb().prepare(
    `UPDATE nps_respuestas
        SET comentario = ?, respondido_en = datetime('now','localtime')
      WHERE id = ?`
  ).run(comentario, id);
}

/**
 * Citas elegibles para NPS: estado 'completada', hace 24..26h, sin NPS previo.
 * La ventana de 2h evita enviar dos veces si el cron corre con retraso.
 */
function citasPendientesNPS() {
  return getDb().prepare(
    `SELECT c.id,
            p.telefono AS paciente_telefono,
            p.nombre   AS paciente_nombre,
            m.nombre   AS medico_nombre,
            c.fecha_hora
       FROM citas c
       JOIN pacientes p ON p.id = c.paciente_id
       JOIN medicos   m ON m.id = c.medico_id
      WHERE c.estado = 'completada'
        AND datetime(c.fecha_hora) <= datetime('now','localtime','-24 hours')
        AND datetime(c.fecha_hora) >  datetime('now','localtime','-26 hours')
        AND p.baja_fecha IS NULL
        AND NOT EXISTS (SELECT 1 FROM nps_respuestas n WHERE n.cita_id = c.id)`
  ).all();
}

/**
 * KPI agregado: promedio de puntajes y clasificación Net Promoter Score clásica.
 * Usado por /panel y el reporte semanal.
 */
function resumen(dias = 30) {
  const filas = getDb().prepare(
    `SELECT puntaje FROM nps_respuestas
      WHERE puntaje IS NOT NULL
        AND respondido_en >= datetime('now','localtime','-${dias} days')`
  ).all();

  if (filas.length === 0) {
    return { total: 0, promedio: 0, promotores: 0, pasivos: 0, detractores: 0, nps: 0 };
  }

  let promotores = 0, pasivos = 0, detractores = 0, suma = 0;
  for (const f of filas) {
    suma += f.puntaje;
    if (f.puntaje >= 9) promotores++;
    else if (f.puntaje >= 7) pasivos++;
    else detractores++;
  }
  const total = filas.length;
  const nps = Math.round(((promotores - detractores) / total) * 100);
  return {
    total,
    promedio:    Number((suma / total).toFixed(2)),
    promotores,
    pasivos,
    detractores,
    nps,
  };
}

module.exports = {
  crearEnvio,
  yaEnviadaParaCita,
  ultimoPendientePorTelefono,
  guardarPuntaje,
  guardarComentario,
  citasPendientesNPS,
  resumen,
};
