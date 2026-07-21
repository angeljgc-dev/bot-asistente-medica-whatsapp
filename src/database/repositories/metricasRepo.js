'use strict';
/**
 * Repositorio de métricas y eventos.
 *
 * Registra eventos observables del bot (intents detectados, fallbacks a Groq,
 * ciclo de vida de citas, escalaciones, triage de urgencias) para alimentar
 * el endpoint /panel y jobs de alertas.
 *
 * Diseño:
 *  - Escritura nunca debe romper el flujo principal → callers envuelven en try/catch.
 *  - `payload` se guarda como JSON string, sin PII bruta si el caller lo puede evitar.
 *  - `better-sqlite3` es síncrono; el INSERT típico cuesta < 1 ms.
 */
const { getDb } = require('../db');

function registrar(tipo, telefono = null, payload = null) {
  const db = getDb();
  const stmt = db.prepare(
    'INSERT INTO metricas_eventos (tipo, telefono, payload) VALUES (?, ?, ?)'
  );
  stmt.run(tipo, telefono, payload ? JSON.stringify(payload) : null);
}

function contarPorTipo(tipo, desdeISO) {
  const db = getDb();
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM metricas_eventos WHERE tipo = ? AND creado_en >= ?'
  ).get(tipo, desdeISO);
  return row ? row.n : 0;
}

function listarPorTipo(tipo, desdeISO, limit = 100) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM metricas_eventos WHERE tipo = ? AND creado_en >= ? ORDER BY creado_en DESC LIMIT ?'
  ).all(tipo, desdeISO, limit);
}

function kpi7d() {
  // Usamos hora local (coincide con la columna DEFAULT `datetime('now','localtime')`)
  // para que los rangos sean comparables sin zona horaria mixta.
  const db = getDb();
  const desdeRow = db.prepare(`SELECT datetime('now','localtime','-7 days') AS d`).get();
  const desde = desdeRow.d;
  return {
    intents:          contarPorTipo('intent_detectado', desde),
    fallbacks:        contarPorTipo('fallback_groq', desde),
    citas_creadas:    contarPorTipo('cita_creada', desde),
    citas_canceladas: contarPorTipo('cita_cancelada', desde),
    reagendamientos:  contarPorTipo('cita_reagendada', desde),
    escalaciones:     contarPorTipo('escalacion', desde),
    urgencias:        contarPorTipo('triage_urgencia_alta', desde),
    desde,
  };
}

/**
 * Borra eventos antiguos (retención). Llamable desde cron semanal.
 * Útil para no inflar la BD en instalaciones con años de uso.
 */
function limpiarAntiguos(dias = 90) {
  const db = getDb();
  const res = db.prepare(
    `DELETE FROM metricas_eventos WHERE creado_en < datetime('now','localtime','-${Number(dias)} days')`
  ).run();
  return res.changes;
}

/**
 * Serie diaria agrupada por tipo, para graficar en el panel.
 * Devuelve arreglo de { fecha: 'YYYY-MM-DD', n: number }.
 */
function serieDiaria(tipo, dias = 30) {
  const db = getDb();
  return db.prepare(
    `SELECT date(creado_en) AS fecha, COUNT(*) AS n
       FROM metricas_eventos
      WHERE tipo = ?
        AND creado_en >= datetime('now','localtime','-${Number(dias)} days')
      GROUP BY date(creado_en)
      ORDER BY fecha ASC`
  ).all(tipo);
}

/**
 * Últimos N eventos de un tipo (ej: 20 últimas escalaciones).
 */
function ultimos(tipo, limit = 20) {
  const db = getDb();
  return db.prepare(
    `SELECT id, telefono, payload, creado_en
       FROM metricas_eventos
      WHERE tipo = ?
      ORDER BY id DESC
      LIMIT ?`
  ).all(tipo, limit);
}

module.exports = {
  registrar,
  contarPorTipo,
  listarPorTipo,
  kpi7d,
  limpiarAntiguos,
  serieDiaria,
  ultimos,
};
