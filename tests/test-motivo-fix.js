'use strict';
/**
 * Verifica el fix del bug: paciente en PIDIENDO_MOTIVO → bot pregunta
 * sobre citas en vez de registrar el motivo.
 *
 * Casos:
 *   M-1: Motivo normal en tiempo ("me duele mucho el estomago")
 *   M-2: Motivo que contiene "no" corto → antes escapaba, ahora no
 *   M-3: Sesión expirada (IDLE con cita_id_creada) → debe recuperar flujo
 *   M-4: "salir" en PIDIENDO_MOTIVO → sí debe escapar (escape explícito)
 */

// ── Mock de whatsapp ANTES de cargar cualquier otro módulo ──────────────────
const whatsapp = require('../src/services/whatsapp');
const capturados = [];
whatsapp.sendMessage = async (tel, txt) => { capturados.push({ tel, txt }); };

// ── Imports ──────────────────────────────────────────────────────────────────
const { getDb }        = require('../src/database/db');
const { runMigrations } = require('../src/database/migrate');
const pacienteRepo     = require('../src/database/repositories/pacienteRepo');
const citaRepo         = require('../src/database/repositories/citaRepo');
const medicoRepo       = require('../src/database/repositories/medicoRepo');
const sesionRepo       = require('../src/database/repositories/sesionRepo');
const { routeMessage } = require('../src/handlers/messageRouter');

// ── Setup DB ─────────────────────────────────────────────────────────────────
runMigrations();
const db = getDb();

let passed = 0;
let failed = 0;

function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.log(`  ❌ ${label}`); failed++; }
}

// ── Helper: crear paciente + cita + sesión en PIDIENDO_MOTIVO ───────────────
function setupPacienteCitaMotivo(tel) {
  db.prepare('DELETE FROM citas    WHERE paciente_id IN (SELECT id FROM pacientes WHERE telefono=?)').run(tel);
  db.prepare('DELETE FROM sesiones WHERE telefono=?').run(tel);
  db.prepare('DELETE FROM pacientes WHERE telefono=?').run(tel);

  const medico = medicoRepo.findActivos()[0];
  pacienteRepo.create(tel);
  pacienteRepo.setNombre(tel, 'Prueba Paciente');
  pacienteRepo.setFechaNacimiento(tel, new Date('1990-05-15'));

  const paciente = pacienteRepo.findByTelefono(tel);
  const fechaHora = new Date(Date.now() + 48 * 3600_000); // mañana pasado
  const citaId = citaRepo.create({
    pacienteId:  paciente.id,
    medicoId:    medico.id,
    fechaHora,
    duracionMin: medico.duracion_cita_min || 30,
  });

  // Sesión en PIDIENDO_MOTIVO con cita_id_creada
  sesionRepo.upsert(tel, {
    estadoFlujo:       'pidiendo_motivo',
    datosTemporales:   { cita_id_creada: citaId, medico_id: medico.id, medico_nombre: medico.nombre },
    historialMensajes: [],
  });

  return { paciente, citaId, medico };
}

// ── Helper: crear sesión IDLE con cita_id_creada (simula expiración) ────────
function setupSesionExpirada(tel) {
  const { citaId, medico } = setupPacienteCitaMotivo(tel);
  // Ahora resetear estado a idle (simula lo que hace limpiarInactivas tras el fix)
  sesionRepo.upsert(tel, {
    estadoFlujo:       'idle',
    datosTemporales:   { cita_id_creada: citaId, medico_id: medico.id, medico_nombre: medico.nombre },
    historialMensajes: [],
  });
  return citaId;
}

// ────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Test Fix: Bug Motivo de Consulta ===\n');

  // ── M-1: Motivo normal en PIDIENDO_MOTIVO ────────────────────────────────
  console.log('M-1: Motivo normal ("me duele mucho el estomago")');
  {
    const tel = '5299100001';
    const { citaId } = setupPacienteCitaMotivo(tel);
    capturados.length = 0;

    const respuesta = await routeMessage(tel, 'me duele mucho el estomago');

    const cita = citaRepo.findById(citaId);
    ok('Respuesta confirma cita registrada', respuesta && respuesta.includes('✅'));
    ok('motivo_consulta guardado en BD', cita && cita.motivo_consulta === 'me duele mucho el estomago');
    ok('Sesión reseteada a idle', sesionRepo.get(tel)?.estado_flujo === 'idle');
    ok('Médico recibió reporte', capturados.length > 0);
  }

  // ── M-2: Motivo con "no" corto (antes disparaba escape) ──────────────────
  console.log('\nM-2: Motivo corto con "no" ("no como bien")');
  {
    const tel = '5299100002';
    const { citaId } = setupPacienteCitaMotivo(tel);
    capturados.length = 0;

    const respuesta = await routeMessage(tel, 'no como bien');

    const cita = citaRepo.findById(citaId);
    ok('Respuesta confirma cita (no redirige a menú)', respuesta && respuesta.includes('✅'));
    ok('motivo_consulta guardado', cita && cita.motivo_consulta === 'no como bien');
    ok('Médico recibió reporte', capturados.length > 0);
  }

  // ── M-3: Sesión expirada (IDLE con cita_id_creada) → recupera flujo ──────
  console.log('\nM-3: Sesión expirada (idle + cita_id_creada) — debe recuperar motivo');
  {
    const tel = '5299100003';
    const citaId = setupSesionExpirada(tel);
    capturados.length = 0;

    const respuesta = await routeMessage(tel, 'me duele la cabeza');

    const cita = citaRepo.findById(citaId);
    ok('Respuesta confirma cita (no va a Groq)', respuesta && respuesta.includes('✅'));
    ok('motivo_consulta guardado tras expiración', cita && cita.motivo_consulta === 'me duele la cabeza');
    ok('Médico recibió reporte', capturados.length > 0);
  }

  // ── M-4: "salir" en PIDIENDO_MOTIVO → sí debe escapar ───────────────────
  console.log('\nM-4: "salir" en PIDIENDO_MOTIVO → escape legítimo');
  {
    const tel = '5299100004';
    setupPacienteCitaMotivo(tel);
    capturados.length = 0;

    const respuesta = await routeMessage(tel, 'salir');

    ok('Respuesta muestra menú principal', respuesta && (respuesta.includes('¿En qué') || respuesta.includes('Hola') || respuesta.includes('puedo ayudarte')));
    ok('Sesión reseteada a idle', sesionRepo.get(tel)?.estado_flujo === 'idle');
  }

  // ── M-5: Motivo "omitir" → no guarda texto pero confirma cita ───────────
  console.log('\nM-5: "omitir" → no guarda motivo pero confirma cita');
  {
    const tel = '5299100005';
    const { citaId } = setupPacienteCitaMotivo(tel);
    capturados.length = 0;

    const respuesta = await routeMessage(tel, 'omitir');

    const cita = citaRepo.findById(citaId);
    ok('Respuesta confirma cita', respuesta && respuesta.includes('✅'));
    ok('motivo_consulta queda null (omitido)', !cita?.motivo_consulta);
    ok('Médico recibió reporte', capturados.length > 0);
  }

  // ── Resumen ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Resultado: ${passed} ✅  ${failed} ❌  (total ${passed + failed})`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
