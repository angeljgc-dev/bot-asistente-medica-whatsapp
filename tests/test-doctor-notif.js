'use strict';
/**
 * test-doctor-notif.js — Verifica notificaciones al médico
 *
 * Intercepta whatsapp.sendMessage (monkey-patch) para capturar mensajes
 * sin enviar nada real por WhatsApp ni requerir conexión Baileys.
 *
 * Cubre:
 *   A: Nueva cita  → médico recibe NUEVA CITA AGENDADA
 *   B: Motivo      → médico recibe REPORTE PRE-CONSULTA
 *   C: Reagenda    → médico recibe CITA REAGENDADA
 *   D: Cancelación → médico recibe CITA CANCELADA
 *   E: Cron        → médico recibe pregunta de asistencia
 *   F: Doctor "sí" → cita estado = completada
 *   G: Doctor "no" → cita estado = no_asistio
 *   H: Ininteligible → bot repregunta, cita no cambia
 *   I: Encadenamiento 2 citas pendientes
 *   J: Recordatorio 24h → solo paciente, médico NO recibe nada
 *   K: Recordatorio 2h  → paciente + médico reciben reporte
 *
 * Uso: node test-doctor-notif.js
 */

// ── Monkey-patch ANTES de cargar cualquier handler ────────────────────────
const whatsapp = require('../src/services/whatsapp');
const capturados = [];
whatsapp.sendMessage = async (telefono, texto) => { capturados.push({ telefono, texto }); };

// ── Dependencias ──────────────────────────────────────────────────────────
const { routeMessage }     = require('../src/handlers/messageRouter');
const attendanceHandler    = require('../src/handlers/attendanceHandler');
const reminderHandler      = require('../src/handlers/reminderHandler');
const { getDb, closeDb }   = require('../src/database/db');
const { toSqliteDateTime } = require('../src/utils/dateFormatter');
const env                  = require('../src/config/env');

const DOCTOR = (env.DOCTOR_PHONE || '5219211358856').replace(/^\+/, '');

// ── Helpers de mensajes ───────────────────────────────────────────────────
function limpiar()           { capturados.length = 0; }
function docMsgs()           { return capturados.filter(m => m.telefono === DOCTOR); }
function pacMsgs(tel)        { return capturados.filter(m => m.telefono === tel); }

async function enviar(phone, text) {
  try   { return await routeMessage(phone, text) || '[null]'; }
  catch (e) { return `[ERROR: ${e.message}]`; }
}

// ── Framework minimalista ─────────────────────────────────────────────────
let total = 0, ok = 0;
const fallos = [];

function chk(id, desc, cond, got = '') {
  total++;
  if (cond) { ok++; process.stdout.write(`  ✅ ${id}: ${desc}\n`); return true; }
  fallos.push({ id, desc, got: String(got).slice(0, 200) });
  process.stdout.write(`  ❌ ${id}: ${desc}\n`);
  if (got) process.stdout.write(`     → ${String(got).slice(0, 200)}\n`);
  return false;
}

// ── Utilidades BD ─────────────────────────────────────────────────────────
function cleanPhone(phone) {
  const db = getDb();
  const p  = db.prepare('SELECT id FROM pacientes WHERE telefono = ?').get(phone);
  if (p) {
    db.prepare('DELETE FROM citas WHERE paciente_id = ?').run(p.id);
    db.prepare('DELETE FROM pacientes WHERE id = ?').run(p.id);
  }
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(phone);
}

const getP    = phone => getDb().prepare('SELECT * FROM pacientes WHERE telefono = ?').get(phone) || null;
const getCita = id    => getDb().prepare(`
  SELECT c.*, p.nombre AS paciente_nombre, p.telefono AS paciente_telefono, m.nombre AS medico_nombre
  FROM citas c JOIN pacientes p ON p.id=c.paciente_id JOIN medicos m ON m.id=c.medico_id WHERE c.id=?
`).get(id) || null;

function insertarCitaPasada(pacienteId, medicoId, minAtras = 30) {
  const fh = toSqliteDateTime(new Date(Date.now() - minAtras * 60_000));
  return getDb().prepare(
    `INSERT INTO citas (paciente_id,medico_id,fecha_hora,duracion_min,estado,asistencia_preguntada)
     VALUES (?,?,?,30,'programada',0)`
  ).run(pacienteId, medicoId, fh).lastInsertRowid;
}

function insertarCitaFutura(pacienteId, medicoId, minAdelante) {
  const fh = toSqliteDateTime(new Date(Date.now() + minAdelante * 60_000));
  return getDb().prepare(
    `INSERT INTO citas (paciente_id,medico_id,fecha_hora,duracion_min,estado,recordatorio_24h_enviado,recordatorio_2h_enviado)
     VALUES (?,?,?,30,'programada',0,0)`
  ).run(pacienteId, medicoId, fh).lastInsertRowid;
}

const getMedicoId = () => getDb().prepare('SELECT id FROM medicos WHERE activo=1 LIMIT 1').get()?.id || 1;

async function registrar(phone, nombre, cumple) {
  await enviar(phone, 'hola');
  await enviar(phone, nombre);
  await enviar(phone, cumple);
}

// ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🔬 test-doctor-notif.js — Notificaciones al médico y asistencia\n');
  console.log(`📱 Doctor phone: ${DOCTOR}\n`);

  const P = {
    p1: '5299000001', p2: '5299000002', p3: '5299000003', p4: '5299000004',
    p5: '5299000005', p6: '5299000006', p7: '5299000007', p8: '5299000008',
  };
  Object.values(P).forEach(cleanPhone);
  const medicoId = getMedicoId();
  const db = getDb();

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO A: Nueva cita → NUEVA CITA AGENDADA al médico
  // ══════════════════════════════════════════════════════════════════════════
  console.log('── GRUPO A: Nueva cita ──');
  await registrar(P.p1, 'María González', '15 de marzo de 1990');
  chk('A-01', 'Paciente registrado (activo)', getP(P.p1)?.estado === 'activo');

  limpiar();
  await enviar(P.p1, 'quiero una cita el 7 de septiembre a las 10am');
  chk('A-02', 'Al proponer: médico NO recibe nada aún', docMsgs().length === 0);

  limpiar();
  await enviar(P.p1, 'sí');
  const dA = docMsgs();
  chk('A-03', 'Médico recibe NUEVA CITA AGENDADA',
      dA.some(m => /NUEVA CITA AGENDADA/i.test(m.texto)),
      dA.map(m => m.texto.slice(0, 80)).join(' | '));
  chk('A-04', 'Notificación incluye nombre del paciente',    dA.some(m => /María González/i.test(m.texto)));
  chk('A-05', 'Notificación incluye teléfono del paciente',  dA.some(m => new RegExp(P.p1).test(m.texto)));

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO B: Motivo → REPORTE PRE-CONSULTA al médico
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── GRUPO B: Motivo de consulta ──');
  limpiar();
  await enviar(P.p1, 'no');                          // primera visita: no
  await enviar(P.p1, 'dolor de cabeza frecuente');   // motivo
  const dB = docMsgs();
  chk('B-01', 'Médico recibe REPORTE PRE-CONSULTA',
      dB.some(m => /REPORTE PRE-CONSULTA/i.test(m.texto)),
      dB.map(m => m.texto.slice(0, 80)).join(' | '));
  chk('B-02', 'Reporte incluye motivo',   dB.some(m => /dolor de cabeza/i.test(m.texto)));
  chk('B-03', 'Reporte incluye paciente', dB.some(m => /María González/i.test(m.texto)));

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO C: Reagendamiento → CITA REAGENDADA al médico
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── GRUPO C: Reagendamiento ──');
  limpiar();
  await enviar(P.p1, 'quiero cambiar mi cita');
  await enviar(P.p1, '14 de septiembre a las 11am');
  await enviar(P.p1, 'sí');
  const dC = docMsgs();
  chk('C-01', 'Médico recibe CITA REAGENDADA',
      dC.some(m => /CITA REAGENDADA/i.test(m.texto)),
      dC.map(m => m.texto.slice(0, 80)).join(' | '));
  chk('C-02', 'Notificación incluye nueva fecha',  dC.some(m => /septiembre/i.test(m.texto)));

  limpiar();
  await enviar(P.p1, 'no');
  await enviar(P.p1, 'mareos y náuseas');
  chk('C-03', 'Médico recibe reporte tras reagendamiento',
      docMsgs().some(m => /REPORTE PRE-CONSULTA/i.test(m.texto)));

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO D: Cancelación → CITA CANCELADA al médico
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── GRUPO D: Cancelación ──');
  limpiar();
  await enviar(P.p1, 'cancelar mi cita');
  await enviar(P.p1, 'sí');
  const dD = docMsgs();
  chk('D-01', 'Médico recibe CITA CANCELADA',
      dD.some(m => /CITA CANCELADA/i.test(m.texto)),
      dD.map(m => m.texto.slice(0, 80)).join(' | '));
  chk('D-02', 'Notificación incluye nombre del paciente', dD.some(m => /María González/i.test(m.texto)));

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO E: Cron asistencia → médico recibe pregunta ¿llegó?
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── GRUPO E: Pregunta de asistencia (cron) ──');
  await registrar(P.p2, 'Carlos Ramírez', '20 de junio de 1985');
  const pac2 = getP(P.p2);
  chk('E-01', 'Paciente 2 registrado', pac2?.estado === 'activo');
  const citaE = insertarCitaPasada(pac2.id, medicoId, 30);

  limpiar();
  await attendanceHandler.verificarYPreguntar();
  const dE = docMsgs();
  chk('E-02', 'Cron envía pregunta de asistencia al médico',
      dE.some(m => /asistencia|llegó|asistió/i.test(m.texto)),
      dE.map(m => m.texto.slice(0, 100)).join(' | '));
  chk('E-03', 'Pregunta incluye nombre del paciente',  dE.some(m => /Carlos Ramírez/i.test(m.texto)));
  chk('E-04', 'BD: asistencia_preguntada = 1',
      db.prepare('SELECT asistencia_preguntada FROM citas WHERE id=?').get(citaE)?.asistencia_preguntada === 1);

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO F: Doctor responde "sí" → cita completada
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── GRUPO F: Doctor responde "sí" ──');
  const rF = await enviar(DOCTOR, 'sí');
  chk('F-01', 'Bot responde al doctor',           rF !== '[null]' && !/ERROR/.test(rF), rF);
  chk('F-02', 'Respuesta confirma asistencia sí', /asistió|asistio|registrado/i.test(rF), rF);
  chk('F-03', 'BD: cita estado = completada',
      db.prepare('SELECT estado FROM citas WHERE id=?').get(citaE)?.estado === 'completada');

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO G: Doctor responde "no" → cita no_asistio
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── GRUPO G: Doctor responde "no" ──');
  await registrar(P.p3, 'Sofía Hernández', '3 de diciembre de 1992');
  const pac3  = getP(P.p3);
  const citaG = insertarCitaPasada(pac3.id, medicoId, 25);
  db.prepare('UPDATE citas SET asistencia_preguntada=1 WHERE id=?').run(citaG);

  const rG = await enviar(DOCTOR, 'no');
  chk('G-01', 'Bot responde al doctor',             rG !== '[null]' && !/ERROR/.test(rG), rG);
  chk('G-02', 'Respuesta confirma no asistencia',   /no asistió|no asistio|registrado/i.test(rG), rG);
  chk('G-03', 'BD: cita estado = no_asistio',
      db.prepare('SELECT estado FROM citas WHERE id=?').get(citaG)?.estado === 'no_asistio');

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO H: Doctor responde ininteligible → bot repregunta, estado no cambia
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── GRUPO H: Doctor responde ininteligible ──');
  await registrar(P.p4, 'Roberto Sánchez', '10 de enero de 1975');
  const pac4  = getP(P.p4);
  const citaH = insertarCitaPasada(pac4.id, medicoId, 20);
  db.prepare('UPDATE citas SET asistencia_preguntada=1 WHERE id=?').run(citaH);

  // "quizás" no contiene "sí"/"no" → detectarIntencion devuelve 'desconocido'
  const rH = await enviar(DOCTOR, 'quizás');
  chk('H-01', 'Bot repregunta cuando no entiende', /sí|Responde/i.test(rH), rH);
  chk('H-02', 'BD: cita sigue en estado programada',
      db.prepare('SELECT estado FROM citas WHERE id=?').get(citaH)?.estado === 'programada');

  // Resolver para limpiar la cola
  await enviar(DOCTOR, 'sí');

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO I: Comportamiento cron + encadenamiento
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── GRUPO I: Encadenamiento de asistencia ──');
  await registrar(P.p5, 'Ana Torres',  '5 de mayo de 1988');
  await registrar(P.p6, 'Luis Medina', '12 de agosto de 1980');
  const pac5  = getP(P.p5);
  const pac6  = getP(P.p6);

  // Parte 1: verificarYPreguntar con 2 citas — solo marca y envía la primera
  const citaI1 = insertarCitaPasada(pac5.id, medicoId, 45);
  const citaI2 = insertarCitaPasada(pac6.id, medicoId, 35);

  limpiar();
  await attendanceHandler.verificarYPreguntar();
  const dI = docMsgs();
  chk('I-01', 'Con 2 citas: solo 1 mensaje enviado al médico', dI.length === 1, `msgs: ${dI.length}`);
  chk('I-02', 'Solo la primera cita marcada asistencia_preguntada=1 (la segunda espera al próximo cron)',
      db.prepare('SELECT asistencia_preguntada FROM citas WHERE id=?').get(citaI1)?.asistencia_preguntada === 1 &&
      db.prepare('SELECT asistencia_preguntada FROM citas WHERE id=?').get(citaI2)?.asistencia_preguntada === 0);

  // Resolver citaI1 → siguiente es null (citaI2 no está en cola aún)
  const rI1 = await enviar(DOCTOR, 'sí');
  chk('I-03', 'Sin cita pre-cola: respuesta simple sin encadenamiento',
      /registrado|asistió/i.test(rI1) && !/¿Y el paciente/i.test(rI1), rI1.slice(0, 200));

  // Parte 2: chaining cuando AMBAS citas ya están pre-marcadas en la cola
  // (simula el caso donde verificarYPreguntar corrió con yaHayPendiente=true)
  const citaI3 = insertarCitaPasada(pac5.id, medicoId, 50);
  const citaI4 = insertarCitaPasada(pac6.id, medicoId, 40);
  db.prepare('UPDATE citas SET asistencia_preguntada=1 WHERE id=?').run(citaI3);
  db.prepare('UPDATE citas SET asistencia_preguntada=1 WHERE id=?').run(citaI4);

  // Doctor "sí" para la primera (citaI3, más antigua) → respuesta encadena citaI4
  const rI3 = await enviar(DOCTOR, 'sí');
  chk('I-04', 'Con 2 citas pre-encoladas: respuesta encadenada incluye siguiente',
      /¿Y el paciente|llegó/i.test(rI3), rI3.slice(0, 200));

  // Doctor "no" para la segunda (citaI4)
  await enviar(DOCTOR, 'no');
  chk('I-05', 'Segunda cita marcada no_asistio tras encadenamiento',
      db.prepare('SELECT estado FROM citas WHERE id=?').get(citaI4)?.estado === 'no_asistio');

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO J: Recordatorio 24h → solo paciente, médico NO recibe nada
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── GRUPO J: Recordatorio 24h ──');
  await registrar(P.p7, 'Gabriela López', '8 de febrero de 1995');
  const pac7   = getP(P.p7);
  const citaJ  = insertarCitaFutura(pac7.id, medicoId, 24 * 60);  // +24h exacto

  limpiar();
  await reminderHandler.verificarYEnviarRecordatorios();
  const pJ = pacMsgs(P.p7);
  const dJ = docMsgs();

  chk('J-01', 'Paciente recibe recordatorio 24h',
      pJ.some(m => /mañana|recordatorio|día antes|cita/i.test(m.texto)),
      pJ.map(m => m.texto.slice(0, 80)).join(' | '));
  chk('J-02', 'Médico NO recibe nada en recordatorio 24h', dJ.length === 0, `msgs médico: ${dJ.length}`);
  chk('J-03', 'BD: recordatorio_24h_enviado = 1',
      db.prepare('SELECT recordatorio_24h_enviado FROM citas WHERE id=?').get(citaJ)?.recordatorio_24h_enviado === 1);

  // ══════════════════════════════════════════════════════════════════════════
  // GRUPO K: Recordatorio 2h → paciente + médico reciben mensaje
  // ══════════════════════════════════════════════════════════════════════════
  console.log('\n── GRUPO K: Recordatorio 2h ──');
  await registrar(P.p8, 'Fernando Díaz', '25 de octubre de 1982');
  const pac8  = getP(P.p8);
  const citaK = insertarCitaFutura(pac8.id, medicoId, 120);  // +120min (ventana: 115-125min)

  limpiar();
  await reminderHandler.verificarYEnviarRecordatorios();
  const pK = pacMsgs(P.p8);
  const dK = docMsgs();

  chk('K-01', 'Paciente recibe recordatorio 2h',
      pK.some(m => /2 horas|dos horas/i.test(m.texto)),
      pK.map(m => m.texto.slice(0, 80)).join(' | '));
  chk('K-02', 'Médico recibe REPORTE PRE-CONSULTA en recordatorio 2h',
      dK.some(m => /REPORTE PRE-CONSULTA/i.test(m.texto)),
      dK.map(m => m.texto.slice(0, 80)).join(' | '));
  chk('K-03', 'Reporte incluye nombre del paciente', dK.some(m => /Fernando Díaz/i.test(m.texto)));
  chk('K-04', 'BD: recordatorio_2h_enviado = 1',
      db.prepare('SELECT recordatorio_2h_enviado FROM citas WHERE id=?').get(citaK)?.recordatorio_2h_enviado === 1);

  // ══════════════════════════════════════════════════════════════════════════
  // RESUMEN
  // ══════════════════════════════════════════════════════════════════════════
  Object.values(P).forEach(cleanPhone);

  console.log('\n' + '═'.repeat(60));
  console.log(`📊 ${ok}/${total} pruebas pasaron`);
  if (fallos.length > 0) {
    console.log(`\n❌ Fallos (${fallos.length}):`);
    fallos.forEach(f => {
      console.log(`  ${f.id}: ${f.desc}`);
      if (f.got) console.log(`     → ${f.got}`);
    });
    process.exitCode = 1;
  } else {
    console.log('✅ Todas las pruebas pasaron\n');
  }

  closeDb();
}

main().catch(err => { console.error('Error fatal:', err); process.exit(1); });
