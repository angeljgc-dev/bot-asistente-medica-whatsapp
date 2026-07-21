'use strict';
/**
 * test-asistencia.js — Prueba el flujo de verificación de asistencia.
 */

const { routeMessage }  = require('../src/handlers/messageRouter');
const { getDb }         = require('../src/database/db');
const citaRepo          = require('../src/database/repositories/citaRepo');
const medicoRepo        = require('../src/database/repositories/medicoRepo');
const attendanceHandler = require('../src/handlers/attendanceHandler');
const T                 = require('../src/utils/messageTemplates');
const env               = require('../src/config/env');

const PATIENT_PHONE = '5200088001';
const DOCTOR_PHONE  = env.DOCTOR_PHONE?.replace(/^\+/, '');

let passed = 0, failed = 0;

function cleanPatient(tel) {
  const db = getDb();
  const p  = db.prepare('SELECT id FROM pacientes WHERE telefono = ?').get(tel);
  if (p) db.prepare('DELETE FROM citas WHERE paciente_id = ?').run(p.id);
  db.prepare('DELETE FROM pacientes WHERE telefono = ?').run(tel);
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(tel);
}

function cleanDoctor() {
  getDb().prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);
}

async function send(phone, texto) {
  try { return await routeMessage(phone, texto) || '[null]'; }
  catch (e) { return `[ERROR: ${e.message}]`; }
}

function check(label, condition, got) {
  if (condition) { console.log(`  ✅ ${label}`); passed++; }
  else           { console.log(`  ❌ ${label}\n     Got: "${String(got).substring(0, 140)}"`); failed++; }
}

/** Registra un paciente y devuelve el objeto de BD */
async function registrarPaciente() {
  await send(PATIENT_PHONE, 'hola');
  await send(PATIENT_PHONE, 'Laura Mendez');
  await send(PATIENT_PHONE, '5 de mayo de 1988');
  return getDb().prepare('SELECT * FROM pacientes WHERE telefono = ?').get(PATIENT_PHONE);
}

/** Inserta una cita con fecha_hora arbitraria directamente en BD */
function insertarCitaConFecha(pacienteId, medicoId, fecha) {
  const db = getDb();
  const { toSqliteDateTime } = require('../src/utils/dateFormatter');
  const info = db.prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado)
    VALUES (?, ?, ?, 30, 'programada')
  `).run(pacienteId, medicoId, toSqliteDateTime(fecha));
  return info.lastInsertRowid;
}

// ════════════════════════════════════════════════════════════
// TEST 1 — findPendientesAsistencia detecta cita en ventana
// ════════════════════════════════════════════════════════════
async function test1() {
  console.log('\n[ TEST 1 ] findPendientesAsistencia detecta citas en ventana 10-60 min');
  cleanPatient(PATIENT_PHONE);

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  // Cita que inició hace 20 min → dentro de la ventana
  const hace20 = new Date(Date.now() - 20 * 60_000);
  const id1 = insertarCitaConFecha(paciente.id, medico.id, hace20);

  // Cita que inició hace 5 min → fuera de la ventana (muy reciente)
  const hace5 = new Date(Date.now() - 5 * 60_000);
  const id2 = insertarCitaConFecha(paciente.id, medico.id, hace5);

  // Cita que inició hace 70 min → fuera de la ventana (muy tardía)
  const hace70 = new Date(Date.now() - 70 * 60_000);
  const id3 = insertarCitaConFecha(paciente.id, medico.id, hace70);

  const pendientes = citaRepo.findPendientesAsistencia();
  const ids = pendientes.map(c => c.id);

  check('Detecta cita de hace 20 min',  ids.includes(id1), ids);
  check('No detecta cita de hace 5 min', !ids.includes(id2), ids);
  check('No detecta cita de hace 70 min', !ids.includes(id3), ids);

  // Cleanup
  getDb().prepare('DELETE FROM citas WHERE id IN (?,?,?)').run(id1, id2, id3);
}

// ════════════════════════════════════════════════════════════
// TEST 2 — verificarYPreguntar marca cita y simula envío
// ════════════════════════════════════════════════════════════
async function test2() {
  console.log('\n[ TEST 2 ] verificarYPreguntar marca asistencia_preguntada=1');
  cleanPatient(PATIENT_PHONE);

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  const hace15 = new Date(Date.now() - 15 * 60_000);
  const citaId = insertarCitaConFecha(paciente.id, medico.id, hace15);

  // Interceptar envío de WA para no necesitar conexión real
  const whatsapp = require('../src/services/whatsapp');
  const mensajesEnviados = [];
  const originalSend = whatsapp.sendMessage;
  whatsapp.sendMessage = async (tel, msg) => { mensajesEnviados.push({ tel, msg }); };

  await attendanceHandler.verificarYPreguntar();

  whatsapp.sendMessage = originalSend;

  const cita = getDb().prepare('SELECT * FROM citas WHERE id = ?').get(citaId);
  check('asistencia_preguntada = 1', cita.asistencia_preguntada === 1, cita.asistencia_preguntada);
  check('Envió mensaje al médico', mensajesEnviados.length === 1, mensajesEnviados.length);
  check('Mensaje menciona el nombre del paciente', /Laura/i.test(mensajesEnviados[0]?.msg || ''), mensajesEnviados[0]?.msg);
  check('findPendientesAsistencia ya no la incluye', citaRepo.findPendientesAsistencia().every(c => c.id !== citaId), '');

  getDb().prepare('DELETE FROM citas WHERE id = ?').run(citaId);
}

// ════════════════════════════════════════════════════════════
// TEST 3 — Médico responde "sí" → estado completada
// ════════════════════════════════════════════════════════════
async function test3() {
  console.log('\n[ TEST 3 ] Médico responde "sí" → cita.estado = completada');
  cleanPatient(PATIENT_PHONE);
  cleanDoctor();

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  const hace20 = new Date(Date.now() - 20 * 60_000);
  const citaId = insertarCitaConFecha(paciente.id, medico.id, hace20);

  // Simular que ya se preguntó
  citaRepo.marcarAsistenciaPreguntada(citaId);

  // Médico responde sí
  const resp = await send(DOCTOR_PHONE, 'sí');

  const cita = getDb().prepare('SELECT * FROM citas WHERE id = ?').get(citaId);
  check('Estado = completada', cita.estado === 'completada', cita.estado);
  check('Respuesta confirma asistencia', /asisti[oó]|registrado/i.test(resp), resp);

  getDb().prepare('DELETE FROM citas WHERE id = ?').run(citaId);
}

// ════════════════════════════════════════════════════════════
// TEST 4 — Médico responde "no" → estado no_asistio
// ════════════════════════════════════════════════════════════
async function test4() {
  console.log('\n[ TEST 4 ] Médico responde "no" → cita.estado = no_asistio');
  cleanPatient(PATIENT_PHONE);
  cleanDoctor();

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  const hace25 = new Date(Date.now() - 25 * 60_000);
  const citaId = insertarCitaConFecha(paciente.id, medico.id, hace25);

  citaRepo.marcarAsistenciaPreguntada(citaId);

  const resp = await send(DOCTOR_PHONE, 'no');

  const cita = getDb().prepare('SELECT * FROM citas WHERE id = ?').get(citaId);
  check('Estado = no_asistio', cita.estado === 'no_asistio', cita.estado);
  check('Respuesta confirma no asistencia', /no asisti[oó]|registrado/i.test(resp), resp);

  getDb().prepare('DELETE FROM citas WHERE id = ?').run(citaId);
}

// ════════════════════════════════════════════════════════════
// TEST 5 — Médico responde algo ininteligible → re-pregunta
// ════════════════════════════════════════════════════════════
async function test5() {
  console.log('\n[ TEST 5 ] Médico responde algo ininteligible → re-pregunta');
  cleanPatient(PATIENT_PHONE);
  cleanDoctor();

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  const hace30 = new Date(Date.now() - 30 * 60_000);
  const citaId = insertarCitaConFecha(paciente.id, medico.id, hace30);
  citaRepo.marcarAsistenciaPreguntada(citaId);

  const resp = await send(DOCTOR_PHONE, 'ahorita checó');

  const cita = getDb().prepare('SELECT * FROM citas WHERE id = ?').get(citaId);
  check('Estado sigue en programada (sin cambiar)', cita.estado === 'programada', cita.estado);
  check('Re-pregunta al médico', /sí.*no|llegó/i.test(resp), resp);

  getDb().prepare('DELETE FROM citas WHERE id = ?').run(citaId);
}

// ════════════════════════════════════════════════════════════
// TEST 6 — Cola: 2 citas pendientes, encadena la segunda
// ════════════════════════════════════════════════════════════
async function test6() {
  console.log('\n[ TEST 6 ] Cola: responde primera, encadena pregunta de la segunda');
  cleanPatient(PATIENT_PHONE);
  cleanDoctor();

  const paciente = await registrarPaciente();
  const medico   = medicoRepo.findActivos()[0];

  const hace20 = new Date(Date.now() - 20 * 60_000);
  const hace35 = new Date(Date.now() - 35 * 60_000);
  const id1 = insertarCitaConFecha(paciente.id, medico.id, hace35); // más antigua, responde primero
  const id2 = insertarCitaConFecha(paciente.id, medico.id, hace20);

  citaRepo.marcarAsistenciaPreguntada(id1);
  citaRepo.marcarAsistenciaPreguntada(id2);

  // Responder la primera (más antigua)
  const resp = await send(DOCTOR_PHONE, 'sí');

  const c1 = getDb().prepare('SELECT * FROM citas WHERE id = ?').get(id1);
  const c2 = getDb().prepare('SELECT * FROM citas WHERE id = ?').get(id2);

  check('Primera cita → completada', c1.estado === 'completada', c1.estado);
  check('Segunda cita sigue programada', c2.estado === 'programada', c2.estado);
  check('Respuesta pregunta por la segunda cita', /Laura|llegó/i.test(resp), resp);

  getDb().prepare('DELETE FROM citas WHERE id IN (?,?)').run(id1, id2);
}

// ════════════════════════════════════════════════════════════
// TEST 7 — Médico sin citas pendientes → mensaje ignorado
// ════════════════════════════════════════════════════════════
async function test7() {
  console.log('\n[ TEST 7 ] Médico sin citas pendientes → mensaje ignorado (null)');
  cleanDoctor();

  // Sin citas pendientes de respuesta
  const resp = await send(DOCTOR_PHONE, 'sí');
  check('Respuesta es null (ignorado)', resp === '[null]', resp);
}

// ════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════
(async () => {
  console.log('\n════════════════════════════════════════════');
  console.log('  PRUEBA: Verificación de Asistencia');
  console.log('════════════════════════════════════════════');

  await test1();
  await test2();
  await test3();
  await test4();
  await test5();
  await test6();
  await test7();

  cleanPatient(PATIENT_PHONE);
  cleanDoctor();

  console.log('\n════════════════════════════════════════════');
  console.log(`  Resultado: ${passed} ✅  ${failed} ❌  (total ${passed + failed})`);
  console.log('════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
})();
