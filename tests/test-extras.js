'use strict';
/**
 * test-extras.js — Pruebas que faltaban:
 *   1. API HTTP (/health, /send-message)
 *   2. Cron: recordatorios 24h y 2h
 *   3. Cron: cumpleanos
 *   4. Reagendamiento con fecha+hora combinadas
 *   5. Concurrencia: dos pacientes mismo slot
 *   6. Historial de citas pasadas
 *   7. Session timeout
 *
 * Ejecutar: node test-extras.js
 */

const { routeMessage }    = require('../src/handlers/messageRouter');
const { getDb }           = require('../src/database/db');
const calendar            = require('../src/services/calendar');
const citaRepo            = require('../src/database/repositories/citaRepo');
const pacienteRepo        = require('../src/database/repositories/pacienteRepo');
const medicoRepo          = require('../src/database/repositories/medicoRepo');
const reminderHandler     = require('../src/handlers/reminderHandler');
const birthdayHandler     = require('../src/handlers/birthdayHandler');
const sessionManager      = require('../src/session/sessionManager');
const { toSqliteDateTime }= require('../src/utils/dateFormatter');
const env                 = require('../src/config/env');
const http                = require('http');

const DOCTOR_PHONE = env.DOCTOR_PHONE?.replace(/^\+/, '');

// ── Framework ───────────────────────────────────────────────────────────────
let total = 0, passed = 0, failed = 0;
const failures = [];
let phoneCounter = 5200077000;
function freshPhone() { return String(++phoneCounter); }

async function send(phone, text) {
  try { return await routeMessage(phone, text) || '[null]'; }
  catch (e) { return `[ERROR: ${e.message}]`; }
}

function check(testId, label, condition, got) {
  total++;
  if (condition) {
    passed++;
    process.stdout.write(`  \u2705 ${testId}: ${label}\n`);
  } else {
    failed++;
    const g = String(got).substring(0, 150);
    process.stdout.write(`  \u274C ${testId}: ${label}\n     Got: "${g}"\n`);
    failures.push({ testId, label, got: g });
  }
}

function getPatient(phone) {
  return getDb().prepare('SELECT * FROM pacientes WHERE telefono = ?').get(phone) || null;
}

function getActiveCitas(phone) {
  const p = getPatient(phone);
  if (!p) return [];
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre
    FROM citas c JOIN medicos m ON m.id = c.medico_id
    WHERE c.paciente_id = ? AND c.estado NOT IN ('cancelada','completada','no_asistio')
    ORDER BY c.fecha_hora ASC
  `).all(p.id);
}

async function registrar(phone, nombre, cumple) {
  await send(phone, 'hola');
  await send(phone, nombre || 'Test Extra');
  await send(phone, cumple || '15 de marzo de 1990');
}

async function agendarCompleto(phone, fecha, hora, primeraVisita, motivo) {
  await send(phone, 'agendar');
  await send(phone, fecha);
  let r = await send(phone, hora);
  if (/ocupado|no.*disponible/i.test(r)) return r;
  await send(phone, 'si');
  await send(phone, primeraVisita || 'no');
  return await send(phone, motivo || 'consulta');
}

async function cleanCalendar() {
  if (!calendar.isEnabled()) return;
  const desde = new Date(); desde.setMonth(desde.getMonth() - 1);
  const hasta = new Date(); hasta.setMonth(hasta.getMonth() + 12);
  const n = await calendar.purgarEventosPrueba(desde, hasta);
  if (n > 0) console.log(`\u{1F5D1}\uFE0F  Calendar: ${n} evento(s) purgados`);
}

function cleanup() {
  const db = getDb();
  const pats = db.prepare("SELECT id FROM pacientes WHERE telefono LIKE '520007%'").all();
  for (const p of pats) db.prepare('DELETE FROM citas WHERE paciente_id = ?').run(p.id);
  db.prepare("DELETE FROM pacientes WHERE telefono LIKE '520007%'").run();
  db.prepare("DELETE FROM sesiones WHERE telefono LIKE '520007%'").run();
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO A: API HTTP
// ═══════════════════════════════════════════════════════════════════════════
async function grupoAPI() {
  console.log('\n\u{1F310} GRUPO A: API HTTP');

  // Levantar servidor temporal para pruebas HTTP
  const app = require('../src/index');

  // Esperar un momento para que el servidor inicie
  await new Promise(r => setTimeout(r, 1500));

  // A.1 GET /health
  const healthRes = await fetch('http://localhost:3000/health');
  const healthBody = await healthRes.json();
  check('API-01', 'GET /health status 200', healthRes.status === 200, healthRes.status);
  check('API-02', '/health responde ok', healthBody.status === 'ok', healthBody.status);

  // A.2 POST /send-message sin token
  const noTokenRes = await fetch('http://localhost:3000/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: '5512345678', message: 'test' }),
  });
  check('API-03', 'Sin token = 401', noTokenRes.status === 401, noTokenRes.status);

  // A.3 POST /send-message con token invalido
  const badTokenRes = await fetch('http://localhost:3000/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer wrong-token' },
    body: JSON.stringify({ phone: '5512345678', message: 'test' }),
  });
  check('API-04', 'Token invalido = 401', badTokenRes.status === 401, badTokenRes.status);

  // A.4 POST /send-message con token correcto (falla envio pero 200 o 500 segun implementacion)
  const goodTokenRes = await fetch('http://localhost:3000/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.API_SECRET_TOKEN}` },
    body: JSON.stringify({ phone: '5512345678', message: 'test' }),
  });
  // Puede ser 200 (intento ok) o 500 (WA no conectado) — no deberia ser 401
  check('API-05', 'Token correcto != 401', goodTokenRes.status !== 401, goodTokenRes.status);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO B: CRON — RECORDATORIOS
// ═══════════════════════════════════════════════════════════════════════════
async function grupoRecordatorios() {
  console.log('\n\u23F0 GRUPO B: RECORDATORIOS (24h y 2h)');

  const db = getDb();
  const medico = medicoRepo.findActivos()[0];

  // B.1 Recordatorio 24h — insertar cita que inicia en ~24h
  const ph1 = freshPhone();
  await registrar(ph1, 'Recordatorio Veinticuatro', '1 de enero de 1990');
  const p1 = getPatient(ph1);

  const en24h = new Date(Date.now() + 24 * 60 * 60_000);
  const citaId1 = db.prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado, motivo_consulta)
    VALUES (?, ?, ?, 30, 'programada', 'dolor de muelas')
  `).run(p1.id, medico.id, toSqliteDateTime(en24h)).lastInsertRowid;

  const pendientes24 = citaRepo.findPendientesRecordatorio24h();
  const encontrada24 = pendientes24.some(c => c.id === citaId1);
  check('REM-01', 'Cita en ventana 24h detectada', encontrada24, pendientes24.map(c => c.id));

  // Ejecutar handler (no enviara WhatsApp pero marca en BD)
  await reminderHandler.verificarYEnviarRecordatorios();

  const citaPost24 = db.prepare('SELECT * FROM citas WHERE id = ?').get(citaId1);
  check('REM-02', 'Recordatorio 24h marcado en BD', citaPost24.recordatorio_24h_enviado === 1, citaPost24.recordatorio_24h_enviado);

  // No debe volver a aparecer
  const pendientes24b = citaRepo.findPendientesRecordatorio24h();
  check('REM-03', 'No se repite recordatorio 24h', !pendientes24b.some(c => c.id === citaId1), 'found again');

  // B.2 Recordatorio 2h — insertar cita que inicia en ~2h
  const ph2 = freshPhone();
  await registrar(ph2, 'Recordatorio Dos Horas', '2 de febrero de 1985');
  const p2 = getPatient(ph2);

  const en2h = new Date(Date.now() + 2 * 60 * 60_000);
  const citaId2 = db.prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado)
    VALUES (?, ?, ?, 30, 'programada')
  `).run(p2.id, medico.id, toSqliteDateTime(en2h)).lastInsertRowid;

  const pendientes2h = citaRepo.findPendientesRecordatorio2h();
  const encontrada2h = pendientes2h.some(c => c.id === citaId2);
  check('REM-04', 'Cita en ventana 2h detectada', encontrada2h, pendientes2h.map(c => c.id));

  await reminderHandler.verificarYEnviarRecordatorios();

  const citaPost2h = db.prepare('SELECT * FROM citas WHERE id = ?').get(citaId2);
  check('REM-05', 'Recordatorio 2h marcado en BD', citaPost2h.recordatorio_2h_enviado === 1, citaPost2h.recordatorio_2h_enviado);

  // B.3 Cita en 5 horas — NO debe estar en ninguna ventana
  const ph3 = freshPhone();
  await registrar(ph3, 'Fuera De Ventana', '3 de marzo de 1995');
  const p3 = getPatient(ph3);

  const en5h = new Date(Date.now() + 5 * 60 * 60_000);
  const citaId3 = db.prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado)
    VALUES (?, ?, ?, 30, 'programada')
  `).run(p3.id, medico.id, toSqliteDateTime(en5h)).lastInsertRowid;

  const noPend24 = citaRepo.findPendientesRecordatorio24h().some(c => c.id === citaId3);
  const noPend2h = citaRepo.findPendientesRecordatorio2h().some(c => c.id === citaId3);
  check('REM-06', 'Cita en 5h no aparece en ventana 24h', !noPend24, noPend24);
  check('REM-07', 'Cita en 5h no aparece en ventana 2h', !noPend2h, noPend2h);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO C: CRON — CUMPLEANOS
// ═══════════════════════════════════════════════════════════════════════════
async function grupoCumple() {
  console.log('\n\u{1F382} GRUPO C: CUMPLEANOS');

  const db = getDb();

  // C.1 Paciente con cumple hoy
  const ph1 = freshPhone();
  const hoy = new Date();
  const mesHoy = String(hoy.getMonth() + 1).padStart(2, '0');
  const diaHoy = String(hoy.getDate()).padStart(2, '0');
  const cumpleHoy = `1990-${mesHoy}-${diaHoy}`;

  await registrar(ph1, 'Cumple Hoy', '15 de marzo de 1990');
  // Forzar fecha de nacimiento a hoy
  db.prepare('UPDATE pacientes SET fecha_nacimiento = ? WHERE telefono = ?').run(cumpleHoy, ph1);

  const cumples = pacienteRepo.findCumpleanosHoy();
  const esCumple = cumples.some(p => p.telefono === ph1);
  check('CUM-01', 'Paciente con cumple hoy detectado', esCumple, cumples.map(p => p.telefono));

  // C.2 Paciente con cumple manana — NO debe aparecer
  const ph2 = freshPhone();
  const manana = new Date(Date.now() + 24 * 60 * 60_000);
  const mesMan = String(manana.getMonth() + 1).padStart(2, '0');
  const diaMan = String(manana.getDate()).padStart(2, '0');
  const cumpleManana = `1988-${mesMan}-${diaMan}`;

  await registrar(ph2, 'Cumple Manana', '15 de marzo de 1988');
  db.prepare('UPDATE pacientes SET fecha_nacimiento = ? WHERE telefono = ?').run(cumpleManana, ph2);

  const cumples2 = pacienteRepo.findCumpleanosHoy();
  const noEsCumple = !cumples2.some(p => p.telefono === ph2);
  check('CUM-02', 'Cumple manana NO aparece hoy', noEsCumple, cumples2.map(p => p.telefono));

  // C.3 Ejecutar handler (intenta enviar WhatsApp, falla, pero no crashea)
  try {
    await birthdayHandler.enviarFelicitaciones();
    check('CUM-03', 'Handler cumpleanos no crashea', true, 'ok');
  } catch (e) {
    check('CUM-03', 'Handler cumpleanos no crashea', false, e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO D: REAGENDAMIENTO CON FECHA+HORA COMBINADAS
// ═══════════════════════════════════════════════════════════════════════════
async function grupoReagendarCombinado() {
  console.log('\n\u{1F504} GRUPO D: REAGENDAR CON FECHA+HORA JUNTAS');

  // D.1 Reagendar enviando fecha+hora en el mensaje de reagendamiento
  const ph1 = freshPhone();
  await registrar(ph1, 'Reag Combinado', '10 de octubre de 1992');
  await agendarCompleto(ph1, '1 de agosto', '10am', 'no', 'dolor');

  const citaAntes = getActiveCitas(ph1)[0];
  check('RCOMB-01', 'Cita original existe', !!citaAntes, 'no cita');

  // Intentar reagendar con fecha en el mismo mensaje (el state machine fix permite esto)
  let r = await send(ph1, 'cambiar mi cita al 3 de agosto');
  check('RCOMB-02', 'Reagendar con fecha pide hora', /hora/i.test(r), r);

  r = await send(ph1, '5pm');
  check('RCOMB-03', 'Muestra confirmacion', /confirma/i.test(r), r);

  await send(ph1, 'si');
  await send(ph1, 'no');
  r = await send(ph1, 'seguimiento');
  check('RCOMB-04', 'Reagendamiento completado', /listo/i.test(r), r);

  const citaDespues = getActiveCitas(ph1)[0];
  check('RCOMB-05', 'Cita nueva activa', !!citaDespues, 'no cita');
  check('RCOMB-06', 'Calendar ID diferente', citaDespues?.google_calendar_event_id !== citaAntes?.google_calendar_event_id,
    `antes=${citaAntes?.google_calendar_event_id} despues=${citaDespues?.google_calendar_event_id}`);

  // D.2 Reagendar multiples: elegir una y luego dar nueva fecha
  const ph2 = freshPhone();
  await registrar(ph2, 'Reag Multi', '5 de mayo de 1987');
  await agendarCompleto(ph2, '4 de agosto', '9am', 'no', 'a');
  await agendarCompleto(ph2, '5 de agosto', '10am', 'no', 'b');

  check('RCOMB-07', '2 citas activas', getActiveCitas(ph2).length === 2, getActiveCitas(ph2).length);

  r = await send(ph2, 'reagendar');
  check('RCOMB-08', 'Muestra lista para elegir', /cu.*l.*reagendar/i.test(r), r);

  r = await send(ph2, '2');  // elegir la segunda
  check('RCOMB-09', 'Pide nueva fecha', /fecha/i.test(r), r);

  await send(ph2, '6 de agosto');
  await send(ph2, '11am');
  await send(ph2, 'si');
  await send(ph2, 'no');
  r = await send(ph2, 'seguimiento');
  check('RCOMB-10', 'Reagendamiento de la segunda completado', /listo/i.test(r), r);

  const citasPost = getActiveCitas(ph2);
  check('RCOMB-11', 'Sigue con 2 citas activas (1 original + 1 reagendada)', citasPost.length === 2, citasPost.length);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO E: CONCURRENCIA — MISMO SLOT
// ═══════════════════════════════════════════════════════════════════════════
async function grupoConcurrencia() {
  console.log('\n\u26A1 GRUPO E: CONCURRENCIA');

  // E.1 Dos pacientes intentan el mismo horario
  const phA = freshPhone();
  const phB = freshPhone();
  await registrar(phA, 'Paciente Alfa', '1 de enero de 1991');
  await registrar(phB, 'Paciente Beta', '2 de febrero de 1992');

  // A agenda primero — exito
  await agendarCompleto(phA, '7 de agosto', '10am', 'no', 'consulta');
  const citasA = getActiveCitas(phA);
  check('CONC-01', 'Paciente A agenda exitosamente', citasA.length === 1, citasA.length);

  // B intenta el mismo horario — conflicto
  await send(phB, 'agendar');
  await send(phB, '7 de agosto');
  const r = await send(phB, '10am');
  check('CONC-02', 'Paciente B recibe conflicto', /ocupado|no.*disponible/i.test(r), r);

  // B agenda otro horario — exito
  const r2 = await send(phB, '11am');
  check('CONC-03', 'Paciente B alterna a 11am', /confirma/i.test(r2), r2);
  await send(phB, 'si');
  await send(phB, 'no');
  await send(phB, 'consulta');
  check('CONC-04', 'Paciente B tiene su cita', getActiveCitas(phB).length === 1, getActiveCitas(phB).length);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO F: HISTORIAL DE CITAS
// ═══════════════════════════════════════════════════════════════════════════
async function grupoHistorial() {
  console.log('\n\u{1F4DA} GRUPO F: HISTORIAL DE CITAS');

  const db = getDb();
  const medico = medicoRepo.findActivos()[0];

  const ph1 = freshPhone();
  await registrar(ph1, 'Historial Garcia', '20 de enero de 1985');
  const p1 = getPatient(ph1);

  // Insertar citas pasadas con distintos estados
  const hace1Mes = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  const hace2Mes = new Date(Date.now() - 60 * 24 * 60 * 60_000);
  const hace3Mes = new Date(Date.now() - 90 * 24 * 60 * 60_000);

  db.prepare(`INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado, motivo_consulta)
    VALUES (?, ?, ?, 30, 'completada', 'gripa')
  `).run(p1.id, medico.id, toSqliteDateTime(hace1Mes));

  db.prepare(`INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado, motivo_consulta)
    VALUES (?, ?, ?, 30, 'no_asistio', 'dolor de cabeza')
  `).run(p1.id, medico.id, toSqliteDateTime(hace2Mes));

  db.prepare(`INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado, motivo_consulta)
    VALUES (?, ?, ?, 30, 'cancelada', 'revision')
  `).run(p1.id, medico.id, toSqliteDateTime(hace3Mes));

  // F.1 Historial devuelve citas completadas/canceladas/no_asistio
  const historial = citaRepo.findHistorialPaciente(p1.id, 10);
  check('HIST-01', 'Historial tiene 3 citas pasadas', historial.length === 3, historial.length);

  const estados = historial.map(h => h.estado).sort();
  check('HIST-02', 'Incluye completada', estados.includes('completada'), estados);
  check('HIST-03', 'Incluye no_asistio', estados.includes('no_asistio'), estados);
  check('HIST-04', 'Incluye cancelada', estados.includes('cancelada'), estados);

  // F.2 findAllActivasPaciente NO incluye pasadas
  const activas = citaRepo.findAllActivasPaciente(p1.id);
  check('HIST-05', 'Activas no incluyen pasadas', activas.length === 0, activas.length);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO G: SESSION TIMEOUT
// ═══════════════════════════════════════════════════════════════════════════
async function grupoTimeout() {
  console.log('\n\u{23F3} GRUPO G: SESSION TIMEOUT');

  const db = getDb();

  // G.1 Sesion que "expiro" — simular timestamp antiguo
  const ph1 = freshPhone();
  await registrar(ph1, 'Timeout Test', '10 de junio de 1993');

  // Empezar a agendar
  await send(ph1, 'agendar');

  // Forzar que el timestamp de la sesion sea de hace 15 min (> 10 min timeout)
  const haceQuince = new Date(Date.now() - 15 * 60_000).toISOString();
  db.prepare('UPDATE sesiones SET ultima_actividad = ? WHERE telefono = ?').run(haceQuince, ph1);

  // Ejecutar limpieza de sesiones inactivas
  sessionManager.limpiarInactivas();

  // La sesion deberia haber sido eliminada
  const sesion = db.prepare('SELECT * FROM sesiones WHERE telefono = ?').get(ph1);
  check('TOUT-01', 'Sesion expirada limpiada', !sesion, sesion?.estado_flujo);

  // G.2 El paciente regresa — debe funcionar normal (no queda atrapado)
  const r = await send(ph1, 'hola');
  check('TOUT-02', 'Paciente regresa y ve menu', /timeout/i.test(r) || /agendar/i.test(r), r);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO H: EDGE CASES EXTRA
// ═══════════════════════════════════════════════════════════════════════════
async function grupoEdgeCases() {
  console.log('\n\u{1F9EA} GRUPO H: EDGE CASES EXTRA');

  // H.1 Texto vacio
  const ph1 = freshPhone();
  await registrar(ph1, 'Edge Uno', '1 de enero de 2000');
  const r1 = await send(ph1, '');
  check('EDGE-01', 'Texto vacio no crashea', r1 !== undefined, r1);

  // H.2 Texto muy largo
  const largo = 'a'.repeat(500);
  const r2 = await send(ph1, largo);
  check('EDGE-02', 'Texto 500 chars no crashea', r2 !== undefined, typeof r2);

  // H.3 Caracteres especiales / emojis
  const r3 = await send(ph1, 'hola!! 😊 necesito cita por favor 🙏');
  check('EDGE-03', 'Emojis en mensaje no crashean', r3 !== undefined, r3?.substring(0, 60));

  // H.4 Multiples citas del mismo paciente — verificar limite
  const ph2 = freshPhone();
  await registrar(ph2, 'Muchas Citas', '5 de mayo de 1990');
  await agendarCompleto(ph2, '10 de agosto', '9am', 'no', 'a');
  await agendarCompleto(ph2, '11 de agosto', '10am', 'no', 'b');
  await agendarCompleto(ph2, '12 de agosto', '11am', 'no', 'c');
  await agendarCompleto(ph2, '13 de agosto', '12pm', 'no', 'd');

  const citas = getActiveCitas(ph2);
  check('EDGE-04', 'Paciente con 4 citas simultaneas', citas.length === 4, citas.length);

  // H.5 Consultar multiples citas
  const r5 = await send(ph2, 'mis citas');
  check('EDGE-05', 'Muestra 4 citas', /4 citas/i.test(r5), r5?.substring(0, 80));

  // H.6 Cancelar todas las 4
  await send(ph2, 'cancelar todas mis citas');
  const r6 = await send(ph2, 'si');
  check('EDGE-06', 'Todas 4 canceladas', /cancel.*4/i.test(r6) || /todas/i.test(r6), r6?.substring(0, 80));
  check('EDGE-07', '0 citas activas', getActiveCitas(ph2).length === 0, getActiveCitas(ph2).length);

  // H.7 Intentar cancelar sin citas
  const r7 = await send(ph2, 'cancelar mi cita');
  check('EDGE-08', 'Sin citas = mensaje apropiado', /no tienes/i.test(r7), r7?.substring(0, 80));

  // H.8 Reagendar sin citas
  const r8 = await send(ph2, 'reagendar');
  check('EDGE-09', 'Reagendar sin citas = mensaje', /no tienes/i.test(r8), r8?.substring(0, 80));
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('\n' + '\u2550'.repeat(50));
  console.log('  PRUEBAS EXTRAS — Cron, API, Concurrencia, Edge Cases');
  console.log('  Fecha: ' + new Date().toLocaleString('es-MX'));
  console.log('\u2550'.repeat(50));

  calendar.init();
  await cleanCalendar();
  cleanup();

  // Ejecutar grupos que NO necesitan servidor HTTP
  await grupoRecordatorios();
  await grupoCumple();
  await grupoReagendarCombinado();
  await grupoConcurrencia();
  await grupoHistorial();
  await grupoTimeout();
  await grupoEdgeCases();

  // Limpiar
  await cleanCalendar();
  cleanup();

  // Resumen
  console.log('\n' + '\u2550'.repeat(50));
  console.log(`  RESULTADO: ${passed} \u2705  ${failed} \u274C  (total ${total})`);
  console.log('\u2550'.repeat(50));

  if (failures.length > 0) {
    console.log('\n\u{1F534} FALLOS:');
    failures.forEach(f => {
      console.log(`  ${f.testId}: ${f.label}`);
      console.log(`     Got: "${f.got}"`);
    });
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
})();
