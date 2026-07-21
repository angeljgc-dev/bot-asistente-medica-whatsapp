'use strict';
/**
 * test-cancelar-todas.js — Prueba el flujo de cancelar todas las citas.
 */

const { routeMessage } = require('../src/handlers/messageRouter');
const { getDb }        = require('../src/database/db');
const citaRepo         = require('../src/database/repositories/citaRepo');
const pacienteRepo     = require('../src/database/repositories/pacienteRepo');
const medicoRepo       = require('../src/database/repositories/medicoRepo');

let phone = '5200099001';
let passed = 0, failed = 0;

function cleanPatient(tel) {
  const db = getDb();
  const p  = db.prepare('SELECT id FROM pacientes WHERE telefono = ?').get(tel);
  if (p) {
    db.prepare('DELETE FROM citas WHERE paciente_id = ?').run(p.id);
    db.prepare('DELETE FROM pacientes WHERE id = ?').run(p.id);
  }
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(tel);
}

async function send(texto) {
  try {
    return await routeMessage(phone, texto) || '[null]';
  } catch (e) {
    return `[ERROR: ${e.message}]`;
  }
}

function check(label, condition, got) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`     Got: "${got}"`);
    failed++;
  }
}

async function registrarPaciente() {
  let r;
  r = await send('hola');          // nuevo → pide nombre
  r = await send('Ana Torres');    // nombre
  r = await send('12 de marzo de 1990'); // cumple
  const p = getDb().prepare('SELECT * FROM pacientes WHERE telefono = ?').get(phone);
  return p;
}

function insertarCita(pacienteId, medicoId, offset_days) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + offset_days);
  fecha.setHours(10, 0, 0, 0);
  return citaRepo.create({ pacienteId, medicoId, fechaHora: fecha, duracionMin: 30 });
}

// ═══════════════════════════════════════════════════════════════════
// TEST 1 — "quiero cancelar todas mis citas" (detección directa)
// ═══════════════════════════════════════════════════════════════════
async function test1() {
  console.log('\n[ TEST 1 ] "quiero cancelar todas mis citas" — detección directa');
  cleanPatient(phone);

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  // Insertar 2 citas
  insertarCita(paciente.id, medico.id, 3);
  insertarCita(paciente.id, medico.id, 5);

  // Paso 1: mensaje con "todas"
  let r = await send('quiero cancelar todas mis citas');
  check('Muestra lista + pide confirmación', /confirmas|todas.*citas|cancelar.*todas/i.test(r), r);
  check('Lista las 2 citas', /1\./i.test(r) && /2\./i.test(r), r);

  // Paso 2: confirmar
  r = await send('sí');
  check('Responde cancelación exitosa', /listo|cancel[eé]|todas.*citas/i.test(r), r);

  // Verificar BD
  const citas = getDb().prepare(`
    SELECT * FROM citas WHERE paciente_id = ? AND estado != 'cancelada'
  `).all(paciente.id);
  check('0 citas activas en BD', citas.length === 0, `${citas.length} citas activas`);
}

// ═══════════════════════════════════════════════════════════════════
// TEST 2 — Seleccionar "0" en el menú de selección
// ═══════════════════════════════════════════════════════════════════
async function test2() {
  console.log('\n[ TEST 2 ] Cancelar todas via "0" en el menú de selección');
  cleanPatient(phone);

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  insertarCita(paciente.id, medico.id, 2);
  insertarCita(paciente.id, medico.id, 4);
  insertarCita(paciente.id, medico.id, 6);

  // Paso 1: cancelar (genérico, sin "todas")
  let r = await send('cancelar');
  check('Muestra menú de selección con opción 0', /0.*cancelar todas|cancelar todas/i.test(r), r);
  check('Lista las 3 citas', /1\./i.test(r) && /2\./i.test(r) && /3\./i.test(r), r);

  // Paso 2: elegir "0"
  r = await send('0');
  check('Pide confirmación de cancelar todas', /confirmas|todas.*citas/i.test(r), r);

  // Paso 3: confirmar
  r = await send('sí');
  check('Confirmación exitosa', /listo|cancel[eé]/i.test(r), r);

  const citas = getDb().prepare(`
    SELECT * FROM citas WHERE paciente_id = ? AND estado != 'cancelada'
  `).all(paciente.id);
  check('0 citas activas en BD', citas.length === 0, `${citas.length} citas activas`);
}

// ═══════════════════════════════════════════════════════════════════
// TEST 3 — Seleccionar "todas" (texto) en el menú de selección
// ═══════════════════════════════════════════════════════════════════
async function test3() {
  console.log('\n[ TEST 3 ] Cancelar todas via texto "todas" en el menú de selección');
  cleanPatient(phone);

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  insertarCita(paciente.id, medico.id, 3);
  insertarCita(paciente.id, medico.id, 7);

  let r = await send('cancelar mi cita');
  check('Muestra menú de selección', /cuál|cancelar todas/i.test(r), r);

  r = await send('todas');
  check('Pide confirmación de cancelar todas', /confirmas|todas.*citas/i.test(r), r);

  r = await send('sí');
  check('Cancelación exitosa', /listo|cancel[eé]/i.test(r), r);

  const citas = getDb().prepare(`
    SELECT * FROM citas WHERE paciente_id = ? AND estado != 'cancelada'
  `).all(paciente.id);
  check('0 citas activas en BD', citas.length === 0, `${citas.length} citas activas`);
}

// ═══════════════════════════════════════════════════════════════════
// TEST 4 — Abortar cancelación de todas ("no")
// ═══════════════════════════════════════════════════════════════════
async function test4() {
  console.log('\n[ TEST 4 ] Abortar "cancelar todas" con "no"');
  cleanPatient(phone);

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  insertarCita(paciente.id, medico.id, 2);
  insertarCita(paciente.id, medico.id, 4);

  let r = await send('quiero cancelar todas mis citas');
  check('Muestra confirmación', /confirmas|todas.*citas/i.test(r), r);

  r = await send('no');
  check('Aborta y regresa al menú', /cancel[óo]|dejalo|listo|ayud/i.test(r), r);

  const citas = getDb().prepare(`
    SELECT * FROM citas WHERE paciente_id = ? AND estado != 'cancelada'
  `).all(paciente.id);
  check('Citas siguen activas en BD', citas.length === 2, `${citas.length} citas activas`);
}

// ═══════════════════════════════════════════════════════════════════
// TEST 5 — Cancelar una sola con múltiples disponibles (no afecta las demás)
// ═══════════════════════════════════════════════════════════════════
async function test5() {
  console.log('\n[ TEST 5 ] Cancelar UNA cita (no "todas") deja las demás intactas');
  cleanPatient(phone);

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  insertarCita(paciente.id, medico.id, 2);
  insertarCita(paciente.id, medico.id, 5);

  let r = await send('cancelar');
  check('Muestra menú de selección', /cuál|número/i.test(r), r);

  r = await send('1');
  check('Pide confirmación de la cita 1', /confirmar|cancelar/i.test(r), r);

  r = await send('sí');
  check('Cancelación de una cita exitosa', /listo|cancel[óe]/i.test(r), r);

  const citas = getDb().prepare(`
    SELECT * FROM citas WHERE paciente_id = ? AND estado != 'cancelada'
  `).all(paciente.id);
  check('1 cita sigue activa (la segunda)', citas.length === 1, `${citas.length} citas activas`);
}

// ═══════════════════════════════════════════════════════════════════
// TEST 6 — Verifica que eliminarEvento de Calendar se llama por cada cita
// ═══════════════════════════════════════════════════════════════════
async function test6() {
  console.log('\n[ TEST 6 ] Verifica que calendar.eliminarEvento se llama por cada event ID');
  cleanPatient(phone);

  const calendar = require('../src/services/calendar');
  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  // Insertar 2 citas con event IDs falsos
  const id1 = insertarCita(paciente.id, medico.id, 2);
  const id2 = insertarCita(paciente.id, medico.id, 4);
  const db  = getDb();
  db.prepare("UPDATE citas SET google_calendar_event_id = ? WHERE id = ?").run('fake-event-aaa', id1);
  db.prepare("UPDATE citas SET google_calendar_event_id = ? WHERE id = ?").run('fake-event-bbb', id2);

  // Spy sobre calendar.eliminarEvento
  const eliminados = [];
  const originalEliminar = calendar.eliminarEvento;
  calendar.eliminarEvento = async (eventId) => {
    eliminados.push(eventId);
  };

  let r = await send('quiero cancelar todas mis citas');
  r = await send('sí');

  // Restaurar
  calendar.eliminarEvento = originalEliminar;

  check('Responde cancelación exitosa', /listo|cancel[eé]/i.test(r), r);
  check('Se llamó eliminarEvento para event-aaa', eliminados.includes('fake-event-aaa'),
        `Llamadas: ${eliminados.join(', ')}`);
  check('Se llamó eliminarEvento para event-bbb', eliminados.includes('fake-event-bbb'),
        `Llamadas: ${eliminados.join(', ')}`);
  check('Se hicieron exactamente 2 llamadas', eliminados.length === 2,
        `${eliminados.length} llamadas`);

  const citas = db.prepare(`SELECT * FROM citas WHERE paciente_id = ? AND estado != 'cancelada'`).all(paciente.id);
  check('0 citas activas en BD', citas.length === 0, `${citas.length} activas`);
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════
(async () => {
  console.log('\n══════════════════════════════════════════');
  console.log('  PRUEBA: Cancelar Todas las Citas');
  console.log('══════════════════════════════════════════');

  await test1();
  await test2();
  await test3();
  await test4();
  await test5();
  await test6();

  // Cleanup
  cleanPatient(phone);

  console.log('\n══════════════════════════════════════════');
  console.log(`  Resultado: ${passed} ✅  ${failed} ❌  (total ${passed + failed})`);
  console.log('══════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
})();
