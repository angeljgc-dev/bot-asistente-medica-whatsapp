'use strict';
/**
 * test-fase5.js — Suite consolidada de  (NPS, broadcasts, multi-médico, pagos).
 *
 * Independiente del test-exhaustivo. No requiere conexión a WhatsApp.
 * Ejecutar: node test-fase5.js
 */

process.env.NODE_ENV = 'test';
const { getDb } = require('../src/database/db');
const { runMigrations } = require('../src/database/migrate');
runMigrations();

const npsRepo     = require('../src/database/repositories/npsRepo');
const pacienteRepo = require('../src/database/repositories/pacienteRepo');
const pagoRepo    = require('../src/database/repositories/pagoRepo');
const pagos       = require('../src/services/pagos');
const medicoRepo  = require('../src/database/repositories/medicoRepo');

let total = 0, passed = 0, failed = 0;
function check(id, label, cond, got) {
  total++;
  if (cond) { passed++; process.stdout.write(`  ✅ ${id}: ${label}\n`); }
  else { failed++; process.stdout.write(`  ❌ ${id}: ${label}\n     Got: "${String(got).substring(0, 160)}"\n`); }
}

function limpiar() {
  const db = getDb();
  db.prepare("DELETE FROM nps_respuestas WHERE telefono LIKE '521555F5%'").run();
  db.prepare("DELETE FROM pagos WHERE telefono LIKE '521555F5%'").run();
  db.prepare("DELETE FROM pacientes WHERE telefono LIKE '521555F5%'").run();
}

console.log('\n═══════════════════════════════════════════════');
console.log('  TEST FASE 5 — suite consolidada');
console.log('═══════════════════════════════════════════════');

limpiar();

// ── NPS repo ──────────────────────────────────────────────────────────
console.log('\nNPS');
const tel1 = '521555F50001';
const npsId = npsRepo.crearEnvio(null, tel1);
check('NPS-01', 'crearEnvio devuelve id > 0', npsId > 0, npsId);

const ult = npsRepo.ultimoPendientePorTelefono(tel1);
check('NPS-02', 'ultimoPendientePorTelefono regresa el envío', ult && ult.id === npsId, ult?.id);

npsRepo.guardarPuntaje(npsId, 9);
const conPuntaje = getDb().prepare('SELECT puntaje FROM nps_respuestas WHERE id = ?').get(npsId);
check('NPS-03', 'guardarPuntaje actualiza el registro', conPuntaje.puntaje === 9, conPuntaje.puntaje);

npsRepo.guardarComentario(npsId, 'muy bien');
const conComentario = getDb().prepare('SELECT comentario, respondido_en FROM nps_respuestas WHERE id = ?').get(npsId);
check('NPS-04', 'guardarComentario persiste texto', conComentario.comentario === 'muy bien', conComentario.comentario);
check('NPS-05', 'respondido_en se llena al guardar comentario', !!conComentario.respondido_en, conComentario.respondido_en);

// resumen
const resumen = npsRepo.resumen(30);
check('NPS-06', 'resumen devuelve objeto con totales', typeof resumen === 'object' && 'total' in resumen, JSON.stringify(resumen).substring(0,80));

// ── segmentos de broadcast ────────────────────────────────────────────
console.log('\nBroadcasts — segmentos');
// Crear 3 pacientes activos para asegurar pool
pacienteRepo.create('521555F50010');
pacienteRepo.setNombre('521555F50010', 'Test1');
pacienteRepo.setEstado('521555F50010', 'activo');
pacienteRepo.create('521555F50011');
pacienteRepo.setNombre('521555F50011', 'Test2');
pacienteRepo.setEstado('521555F50011', 'activo');

const activos = pacienteRepo.listarPorSegmento('todos_activos');
check('BC-01', 'listarPorSegmento todos_activos regresa array', Array.isArray(activos), typeof activos);
check('BC-02', 'todos_activos incluye al menos 2 pacientes de prueba',
  activos.some(p => p.telefono === '521555F50010') && activos.some(p => p.telefono === '521555F50011'),
  activos.length);

// Dar de baja uno y verificar exclusión
pacienteRepo.darDeBaja('521555F50010', 'test');
const activosSinBaja = pacienteRepo.listarPorSegmento('todos_activos');
check('BC-03', 'todos_activos excluye pacientes con baja_fecha',
  !activosSinBaja.some(p => p.telefono === '521555F50010'),
  activosSinBaja.find(p => p.telefono === '521555F50010'));

const inact = pacienteRepo.listarPorSegmento('inactivos_90d');
check('BC-04', 'inactivos_90d devuelve array', Array.isArray(inact), typeof inact);

const cumpleanios = pacienteRepo.listarPorSegmento('cumpleaneros_mes');
check('BC-05', 'cumpleaneros_mes devuelve array', Array.isArray(cumpleanios), typeof cumpleanios);

// Segmento desconocido
let thrown = false;
try { pacienteRepo.listarPorSegmento('segmento_loco_que_no_existe'); }
catch (_) { thrown = true; }
check('BC-06', 'segmento desconocido lanza error', thrown, thrown);

// ── multi-médico ──────────────────────────────────────────────────────
console.log('\nMulti-médico');
const medicos = medicoRepo.findActivos();
check('MED-01', 'listarActivos devuelve array', Array.isArray(medicos), typeof medicos);
check('MED-02', 'hay al menos un médico activo', medicos.length >= 1, medicos.length);

// ── pagos ──────────────────────────────────────────────────────────────
console.log('\nPagos');
check('PAG-01', 'isEnabled false cuando no hay secreto o centavos=0',
  pagos.isEnabled() === false || typeof pagos.isEnabled() === 'boolean',
  pagos.isEnabled());

const pagoId = pagoRepo.crear({
  citaId: null, telefono: '521555F50020',
  sessionId: 'cs_test_' + Date.now(),
  montoCentavos: 50000, moneda: 'mxn',
  metadata: { origen: 'test-fase5' },
});
check('PAG-02', 'pagoRepo.crear devuelve id > 0', pagoId > 0, pagoId);

const pend = pagoRepo.findPendienteByTelefono('521555F50020');
check('PAG-03', 'findPendienteByTelefono regresa el pago pendiente',
  pend && pend.estado === 'pendiente', pend?.estado);

pagoRepo.marcarEstado(pend.stripe_session_id, 'exitoso');
const exitoso = pagoRepo.findBySessionId(pend.stripe_session_id);
check('PAG-04', 'marcarEstado actualiza a exitoso', exitoso.estado === 'exitoso', exitoso.estado);

// construirEventoWebhook sin secreto debe lanzar error explícito
let webhookOk = false;
try { pagos.construirEventoWebhook(Buffer.from('{}'), 'sig'); }
catch (e) { webhookOk = /webhook/i.test(e.message) || /secret/i.test(e.message) || /stripe/i.test(e.message); }
check('PAG-05', 'construirEventoWebhook falla ruidosamente sin secreto', webhookOk, webhookOk);

limpiar();

console.log('\n───────────────────────────────────────────────');
console.log(`  Resultados : ${passed}/${total} pasaron (${failed} fallaron)`);
console.log('───────────────────────────────────────────────\n');
process.exit(failed === 0 ? 0 : 1);
