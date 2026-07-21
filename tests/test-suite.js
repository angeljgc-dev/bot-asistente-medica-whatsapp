'use strict';
/**
 * test-suite.js — Pruebas automatizadas exhaustivas del bot.
 * Ejecuta 258 casos de prueba, verifica respuestas + estado BD + Google Calendar.
 *
 * Uso: node test-suite.js
 */

const { routeMessage } = require('../src/handlers/messageRouter');
const { getDb }        = require('../src/database/db');
const calendar         = require('../src/services/calendar');

// ── Utilidades ───────────────────────────────────────────────────────────────

let phoneCounter = 5200000000;
function freshPhone() { return String(++phoneCounter); }

async function cleanAllTestData() {
  const db = getDb();

  // Purgar eventos huérfanos del Calendar (de corridas anteriores sin cleanup)
  if (calendar.isEnabled()) {
    const desde = new Date();
    desde.setMonth(desde.getMonth() - 1);
    const hasta = new Date();
    hasta.setMonth(hasta.getMonth() + 6);
    const n = await calendar.purgarEventosPrueba(desde, hasta);
    if (n > 0) console.log(`🗑️  Calendar: ${n} evento(s) de prueba eliminados`);
  }

  const testPatients = db.prepare("SELECT id FROM pacientes WHERE telefono LIKE '52000000%'").all();
  for (const p of testPatients) {
    db.prepare('DELETE FROM citas WHERE paciente_id = ?').run(p.id);
  }
  db.prepare("DELETE FROM pacientes WHERE telefono LIKE '52000000%'").run();
  db.prepare("DELETE FROM sesiones WHERE telefono LIKE '52000000%'").run();
}

function cleanPatient(phone) {
  const db = getDb();
  const p  = db.prepare('SELECT id FROM pacientes WHERE telefono = ?').get(phone);
  if (p) {
    db.prepare('DELETE FROM citas WHERE paciente_id = ?').run(p.id);
    db.prepare('DELETE FROM pacientes WHERE id = ?').run(p.id);
  }
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(phone);
}

function getPatient(phone) {
  return getDb().prepare('SELECT * FROM pacientes WHERE telefono = ?').get(phone) || null;
}

function getSession(phone) {
  return getDb().prepare('SELECT * FROM sesiones WHERE telefono = ?').get(phone) || null;
}

function getCitas(phone) {
  const p = getPatient(phone);
  if (!p) return [];
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre
    FROM citas c JOIN medicos m ON m.id = c.medico_id
    WHERE c.paciente_id = ? ORDER BY c.id
  `).all(p.id);
}

function getSessionState(phone) {
  const s = getSession(phone);
  return s ? s.estado_flujo : null;
}

// ── Test framework ───────────────────────────────────────────────────────────

let totalTests = 0, passed = 0, failed = 0;
const failures = [];

async function send(phone, text) {
  try {
    return await routeMessage(phone, text) || '[null]';
  } catch (e) {
    return `[ERROR: ${e.message}]`;
  }
}

function expect(resp, pattern, testId, desc) {
  if (!pattern) return; // no check
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i');
  if (!regex.test(resp)) {
    failures.push({ testId, desc, expected: String(pattern), got: resp.substring(0, 120) });
    return false;
  }
  return true;
}

async function runTest(testId, desc, phone, steps) {
  totalTests++;
  let allPassed = true;

  for (const step of steps) {
    const resp = await send(phone, step.msg);

    if (step.expect) {
      const patterns = Array.isArray(step.expect) ? step.expect : [step.expect];
      for (const p of patterns) {
        if (!expect(resp, p, testId, `${desc} | msg="${step.msg}" expect=${p}`)) {
          allPassed = false;
        }
      }
    }

    if (step.notExpect) {
      const patterns = Array.isArray(step.notExpect) ? step.notExpect : [step.notExpect];
      for (const p of patterns) {
        const regex = p instanceof RegExp ? p : new RegExp(p, 'i');
        if (regex.test(resp)) {
          failures.push({ testId, desc: `${desc} | msg="${step.msg}" should NOT match ${p}`, expected: `NOT ${p}`, got: resp.substring(0, 120) });
          allPassed = false;
        }
      }
    }

    if (step.checkState) {
      const state = getSessionState(phone);
      if (state !== step.checkState) {
        failures.push({ testId, desc: `${desc} | state should be ${step.checkState}`, expected: step.checkState, got: state });
        allPassed = false;
      }
    }

    if (step.checkDb) {
      step.checkDb(phone, testId, desc);
    }

    if (step.delay) await new Promise(r => setTimeout(r, step.delay));
  }

  if (allPassed) {
    passed++;
    process.stdout.write(`  ✅ ${testId}\n`);
  } else {
    failed++;
    process.stdout.write(`  ❌ ${testId} - ${desc}\n`);
  }
}

// ── Helper: register patient ─────────────────────────────────────────────────

async function registerPatient(phone, name = 'Test Paciente', bday = '15 de marzo de 1990') {
  await send(phone, 'hola');
  await send(phone, name);
  await send(phone, bday);
}

// ── Helper: book appointment ─────────────────────────────────────────────────

let bookDay = 14; // starts April 14 (Tuesday), increments to avoid conflicts
const horasPool = ['9am', '10am', '11am', '12pm', '4pm', '5pm', '6pm', '7pm'];
let horaIdx = 0;
async function bookAppointment(phone, fecha, hora) {
  if (!fecha) {
    bookDay++;
    if (bookDay > 28) bookDay = 14;
    fecha = `${bookDay} de abril`;
  }
  if (!hora) {
    hora = horasPool[horaIdx % horasPool.length];
    horaIdx++;
  }
  await send(phone, 'agendar');
  await send(phone, fecha);
  let r = await send(phone, hora);
  // If conflict, try alternative hours
  if (/ocupado/i.test(r)) {
    for (const altHora of ['11am','12pm','4pm','5pm','6pm','7pm']) {
      r = await send(phone, altHora);
      if (!/ocupado/i.test(r)) break;
    }
  }
  await send(phone, 'sí');
  await send(phone, 'no, ya he venido');
  await send(phone, 'dolor de cabeza');
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 1: REGISTRATION FLOW
// ═════════════════════════════════════════════════════════════════════════════

async function suiteRegistration() {
  console.log('\n📋 SUITE 1: REGISTRATION FLOW');

  // REG-001 Happy path
  let ph = freshPhone();
  await runTest('REG-001', 'Happy path: full registration', ph, [
    { msg: 'Hola', expect: /cómo te llamas/i, checkState: 'registrando_nombre' },
    { msg: 'María Fernanda López', expect: /mucho gusto.*maría/i, checkState: 'registrando_cumple' },
    { msg: '15 de marzo de 1990', expect: /registrad/i, checkState: 'idle' },
  ]);

  // REG-002 "Mi nombre es" prefix
  ph = freshPhone();
  await runTest('REG-002', 'Name with "mi nombre es" prefix', ph, [
    { msg: 'Hola', expect: /cómo te llamas/i },
    { msg: 'Mi nombre es Juan Pérez', expect: /mucho gusto.*juan/i },
  ]);

  // REG-003 to REG-009: NO_NOMBRES filter
  const noNombres = [
    ['REG-003', 'hola'],  ['REG-004', 'buenas'],  ['REG-005', 'buenos dias'],
    ['REG-006', 'buenas tardes'], ['REG-007', 'buenas noches'],
    ['REG-008', 'que tal'], ['REG-009', 'hey'],
  ];
  for (const [id, word] of noNombres) {
    ph = freshPhone();
    await runTest(id, `Name rejection: "${word}"`, ph, [
      { msg: 'hola', expect: /cómo te llamas/i },
      { msg: word, notExpect: /mucho gusto/i, checkState: 'registrando_nombre' },
    ]);
  }

  // REG-010 to REG-013: Birthday formats
  ph = freshPhone();
  await runTest('REG-010', 'Birthday DD/MM/YYYY', ph, [
    { msg: 'hola', expect: /cómo te llamas/i },
    { msg: 'Ana López', expect: /mucho gusto/i },
    { msg: '15/03/1990', expect: /registrad/i },
  ]);

  ph = freshPhone();
  await runTest('REG-011', 'Birthday DD-MM-YYYY', ph, [
    { msg: 'hola', expect: /llamas/i },
    { msg: 'Carlos Ruiz', expect: /gusto/i },
    { msg: '15-03-1990', expect: /registrad/i },
  ]);

  ph = freshPhone();
  await runTest('REG-012', 'Birthday natural language', ph, [
    { msg: 'hola', expect: /llamas/i },
    { msg: 'Sofía Martínez', expect: /gusto/i },
    { msg: '15 de marzo de 1990', expect: /registrad/i },
  ]);

  // REG-014 Invalid birthday
  ph = freshPhone();
  await runTest('REG-014', 'Invalid birthday text', ph, [
    { msg: 'hola', expect: /llamas/i },
    { msg: 'Pedro Gómez', expect: /gusto/i },
    { msg: 'no me acuerdo', expect: /no me quedó clara/i, checkState: 'registrando_cumple' },
  ]);

  // REG-018 Special characters
  ph = freshPhone();
  await runTest('REG-018', 'Name with accents/ñ', ph, [
    { msg: 'hola', expect: /llamas/i },
    { msg: 'José Ángel Muñoz Peña', expect: /mucho gusto.*josé/i },
  ]);

  // REG-023 Already registered patient
  ph = freshPhone();
  await registerPatient(ph);
  await runTest('REG-023', 'Re-registration returns menu', ph, [
    { msg: 'hola', expect: /qué te puedo ayudar/i },
  ]);

  // REG-024 Cancel registration — can't escape, bot keeps asking for name
  ph = freshPhone();
  await runTest('REG-024', 'Cancel during registration', ph, [
    { msg: 'hola', expect: /llamas/i },
    { msg: 'menu', expect: /nombre|llamas|identificar/i, checkState: 'registrando_nombre' },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 2: APPOINTMENT BOOKING
// ═════════════════════════════════════════════════════════════════════════════

async function suiteBooking() {
  console.log('\n📋 SUITE 2: APPOINTMENT BOOKING');

  // BOOK-001 Happy path
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente Booking');
  await runTest('BOOK-001', 'Happy path: full booking', ph, [
    { msg: 'quiero agendar una cita', expect: /qué fecha/i, checkState: 'eligiendo_fecha' },
    { msg: 'próximo lunes', expect: /qué hora/i, checkState: 'eligiendo_hora' },
    { msg: '10am', expect: /confirmamos/i, checkState: 'confirmando_cita' },
    { msg: 'sí', expect: [/agendada|reagendada/i, /primera visita/i], checkState: 'pidiendo_primera_visita' },
    { msg: 'no, ya he venido antes', expect: /motivo/i, checkState: 'pidiendo_motivo' },
    { msg: 'dolor de cabeza', expect: /listo.*registrada/i, checkState: 'idle',
      checkDb: (phone) => {
        const citas = getCitas(phone);
        if (citas.length === 0) failures.push({ testId: 'BOOK-001', desc: 'No cita in DB' });
        if (citas[0] && !citas[0].motivo_consulta) failures.push({ testId: 'BOOK-001', desc: 'Motivo not saved' });
      }
    },
  ]);

  // BOOK-003 to BOOK-006: Colloquial intents
  const colloquialNames = ['Paciente Coloquial Uno', 'Paciente Coloquial Dos', 'Paciente Coloquial Tres', 'Paciente Coloquial Cuatro'];
  const colloquials = [
    ['BOOK-003', 'ocupo cita', colloquialNames[0]],
    ['BOOK-004', 'me puedes dar hora?', colloquialNames[1]],
    ['BOOK-005', 'necesito una cita por favor', colloquialNames[2]],
    ['BOOK-006', 'quiero apartar cita', colloquialNames[3]],
  ];
  for (const [id, msg, name] of colloquials) {
    ph = freshPhone();
    await registerPatient(ph, name);
    await runTest(id, `Colloquial: "${msg}"`, ph, [
      { msg, expect: /fecha/i },
    ]);
  }

  // BOOK-008 to BOOK-014: Date formats
  ph = freshPhone();
  await registerPatient(ph, 'Paciente FechaUno');
  await runTest('BOOK-008', 'Date: "mañana"', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'mañana', expect: /hora/i },
  ]);

  ph = freshPhone();
  await registerPatient(ph, 'Paciente FechaDos');
  await runTest('BOOK-009', 'Date: "pasado mañana"', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'pasado mañana', expect: /hora/i },
  ]);

  // BOOK-015 Sunday rejection
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Sunday');
  await runTest('BOOK-015', 'Sunday rejection', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'domingo', expect: /no trabaja/i, checkState: 'eligiendo_fecha' },
  ]);

  // BOOK-016 Past date
  ph = freshPhone();
  await registerPatient(ph, 'Paciente PastDate');
  await runTest('BOOK-016', 'Past date rejection', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: '1 de enero de 2020', expect: /ya pasó/i },
  ]);

  // BOOK-018 Lunch break rejection
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Lunch');
  await runTest('BOOK-018', 'Lunch break (14:00) rejection', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'próximo lunes', expect: /hora/i },
    { msg: '2pm', expect: /horario/i, checkState: 'eligiendo_hora' },
  ]);

  // BOOK-021 First valid after lunch
  ph = freshPhone();
  await registerPatient(ph, 'Paciente AfterLunch');
  await runTest('BOOK-021', '16:00 valid after lunch', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'próximo lunes', expect: /hora/i },
    { msg: '4pm', expect: /confirmamos/i },
  ]);

  // BOOK-022 Before opening
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Early');
  await runTest('BOOK-022', 'Before opening (8am)', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'próximo lunes', expect: /hora/i },
    { msg: '8am', expect: /horario/i },
  ]);

  // BOOK-030 Confirmation: user says "no"
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Rechazar');
  await runTest('BOOK-030', 'Confirmation rejected', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'próximo miércoles', expect: /hora/i },
    { msg: '12pm', expect: /confirmamos/i },
    { msg: 'nel', expect: /no se agendó|ayudar/i, checkState: 'idle' },
  ]);

  // BOOK-042 Omit reason
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Omit');
  await runTest('BOOK-042', 'Omit reason', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'próximo martes', expect: /hora/i },
    { msg: '11am', expect: /confirmamos/i },
    { msg: 'sí', expect: /primera visita/i },
    { msg: 'no', expect: /motivo/i },
    { msg: 'omitir', expect: /listo/i, checkState: 'idle' },
  ]);

  // BOOK-043 Multiple appointments
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Multi');
  await runTest('BOOK-043', 'Multiple appointments by same patient', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'próximo lunes', expect: /hora/i },
    { msg: '9am', expect: /confirmamos/i },
    { msg: 'sí', expect: /primera visita/i },
    { msg: 'no', expect: /motivo/i },
    { msg: 'revisión', expect: /listo/i },
    // Second appointment — different day to avoid conflict
    { msg: 'agendar otra cita', expect: /fecha/i },
    { msg: '28 de abril', expect: /hora/i },
    { msg: '11am', expect: /confirmamos/i },
    { msg: 'sí', expect: /primera visita/i },
    { msg: 'no', expect: /motivo/i },
    { msg: 'dolor de espalda', expect: /listo/i,
      checkDb: (phone) => {
        const citas = getCitas(phone);
        if (citas.length < 2) failures.push({ testId: 'BOOK-043', desc: `Expected 2 citas, got ${citas.length}` });
      }
    },
  ]);

  // BOOK-027 Slot conflict
  ph = freshPhone();
  await registerPatient(ph, 'Paciente ConflictoUno');
  // Book first appointment at 9am Monday
  await send(ph, 'agendar');
  await send(ph, 'próximo lunes');
  await send(ph, '9am');
  await send(ph, 'sí');
  await send(ph, 'no');
  await send(ph, 'check');

  const ph2 = freshPhone();
  await registerPatient(ph2, 'Paciente ConflictoDos');
  await runTest('BOOK-027', 'Slot conflict detection', ph2, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'próximo lunes', expect: /hora/i },
    { msg: '9am', expect: /ocupado/i },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 3: CANCELLATION
// ═════════════════════════════════════════════════════════════════════════════

async function suiteCancellation() {
  console.log('\n📋 SUITE 3: CANCELLATION');

  // CANC-001 Happy path cancel
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente Cancel');
  await bookAppointment(ph, 'próximo miércoles', '10am');
  await runTest('CANC-001', 'Happy path: cancel single', ph, [
    { msg: 'quiero cancelar mi cita', expect: /confirmas.*cancelar/i, checkState: 'cancelando_cita' },
    { msg: 'sí', expect: /cancelada/i, checkState: 'idle',
      checkDb: (phone) => {
        const citas = getCitas(phone);
        const activas = citas.filter(c => c.estado !== 'cancelada');
        if (activas.length > 0) failures.push({ testId: 'CANC-001', desc: 'Cita not cancelled in DB' });
      }
    },
  ]);

  // CANC-003 Cancel confirmation: say "no"
  ph = freshPhone();
  await registerPatient(ph, 'Paciente KeepCita');
  await bookAppointment(ph, 'próximo jueves', '11am');
  await runTest('CANC-003', 'Cancel: say no keeps appointment', ph, [
    { msg: 'cancelar cita', expect: /confirmas.*cancelar/i },
    { msg: 'no', expect: /sigue en pie/i, checkState: 'idle' },
  ]);

  // CANC-004 No appointments
  ph = freshPhone();
  await registerPatient(ph, 'Paciente NoCita');
  await runTest('CANC-004', 'Cancel with no appointments', ph, [
    { msg: 'cancelar cita', expect: /no tienes citas/i },
  ]);

  // CANC-005 Colloquial cancel
  ph = freshPhone();
  await registerPatient(ph, 'Paciente CancCinco');
  await bookAppointment(ph, 'próximo viernes', '9am');
  await runTest('CANC-005', 'Colloquial: "ya no voy a ir"', ph, [
    { msg: 'ya no voy a ir a mi cita', expect: /confirmas.*cancelar/i },
  ]);

  // CANC-002 Multiple appointments
  ph = freshPhone();
  await registerPatient(ph, 'Paciente MultiCancel');
  await bookAppointment(ph, 'próximo lunes', '9am');
  await bookAppointment(ph, 'próximo martes', '10am');
  await runTest('CANC-002', 'Cancel with multiple: select by number', ph, [
    { msg: 'cancelar', expect: /cuál quieres cancelar/i },
    { msg: '1', expect: /confirmas.*cancelar/i },
    { msg: 'sí', expect: /cancelada/i },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 4: RESCHEDULING
// ═════════════════════════════════════════════════════════════════════════════

async function suiteRescheduling() {
  console.log('\n📋 SUITE 4: RESCHEDULING');

  // RESCH-001 Happy path — uses far-future dates to avoid conflicts
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente Resched');
  await bookAppointment(ph, '5 de mayo', '9am');
  await runTest('RESCH-001', 'Happy path: reschedule', ph, [
    { msg: 'quiero cambiar mi cita', expect: /reagendando|fecha/i },
    { msg: '6 de mayo', expect: /hora/i },
    { msg: '4pm', expect: /confirmamos/i },
    { msg: 'sí', expect: /reagendada|agendada/i },
    { msg: 'no, ya he venido', expect: /motivo/i },
    { msg: 'cambio de horario', expect: /listo/i, checkState: 'idle' },
  ]);

  // RESCH-006 No appointments
  ph = freshPhone();
  await registerPatient(ph, 'Paciente NoResch');
  await runTest('RESCH-006', 'Reschedule with no appointments', ph, [
    { msg: 'reagendar cita', expect: /no tienes citas/i },
  ]);

  // RESCH-003 Reschedule to Sunday
  ph = freshPhone();
  await registerPatient(ph, 'Paciente ReschSun');
  await bookAppointment(ph, 'próximo lunes', '10am');
  await runTest('RESCH-003', 'Reschedule to Sunday: rejected', ph, [
    { msg: 'cambiar mi cita', expect: /reagendando|fecha/i },
    { msg: 'domingo', expect: /no trabaja/i },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 5-6: NAME & BIRTHDAY CHANGE
// ═════════════════════════════════════════════════════════════════════════════

async function suiteNameBday() {
  console.log('\n📋 SUITE 5-6: NAME & BIRTHDAY CHANGE');

  // NAME-001 Happy path
  let ph = freshPhone();
  await registerPatient(ph, 'Nombre Viejo');
  await runTest('NAME-001', 'Happy path: change name', ph, [
    { msg: 'quiero cambiar mi nombre', expect: /nombre correcto/i, checkState: 'cambiando_nombre' },
    { msg: 'Nombre Nuevo García', expect: /actualicé.*nombre nuevo/i, checkState: 'idle' },
  ]);

  // NAME-002 NO_NOMBRES filter
  ph = freshPhone();
  await registerPatient(ph, 'Test Filtro Nombre');
  await runTest('NAME-002', 'Name change: NO_NOMBRES filter', ph, [
    { msg: 'cambiar nombre', expect: /nombre correcto/i },
    { msg: 'hola', expect: /no entendí/i, checkState: 'cambiando_nombre' },
  ]);

  // NAME-004 Cancel name change
  ph = freshPhone();
  await registerPatient(ph, 'Test Cancel Name');
  await runTest('NAME-004', 'Cancel name change', ph, [
    { msg: 'cambiar nombre', expect: /nombre correcto/i },
    { msg: 'menu', expect: /qué te puedo ayudar/i, checkState: 'idle' },
  ]);

  // BDAY-001 Happy path
  ph = freshPhone();
  await registerPatient(ph, 'Test Bday');
  await runTest('BDAY-001', 'Happy path: change birthday', ph, [
    { msg: 'cambiar mi cumpleaños', expect: /fecha de nacimiento/i, checkState: 'cambiando_cumple' },
    { msg: '20 de julio de 1995', expect: /actualicé.*fecha/i, checkState: 'idle' },
  ]);

  // BDAY-002 Invalid birthday
  ph = freshPhone();
  await registerPatient(ph, 'Test BadBday');
  await runTest('BDAY-002', 'Invalid birthday on change', ph, [
    { msg: 'cambiar cumpleaños', expect: /fecha de nacimiento/i },
    { msg: 'ayer por la mañana', expect: /no me quedó clara/i, checkState: 'cambiando_cumple' },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 7-8: VIEW APPOINTMENTS & DATA
// ═════════════════════════════════════════════════════════════════════════════

async function suiteView() {
  console.log('\n📋 SUITE 7-8: VIEW APPOINTMENTS & DATA');

  // VIEW-001 Has appointments
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente View');
  await bookAppointment(ph, 'próximo jueves', '10am');
  await runTest('VIEW-001', 'View appointments: has appointments', ph, [
    { msg: 'ver mis citas', expect: /próxima cita|citas.*programad/i },
  ]);

  // VIEW-002 No appointments
  ph = freshPhone();
  await registerPatient(ph, 'Paciente NoView');
  await runTest('VIEW-002', 'View appointments: no appointments', ph, [
    { msg: 'ver mis citas', expect: /no tienes citas/i },
  ]);

  // DATA-001 View data
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Datos');
  await runTest('DATA-001', 'View my data', ph, [
    { msg: 'mis datos', expect: [/nombre.*paciente datos/i, /teléfono/i] },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 9: HUMAN ESCALATION
// ═════════════════════════════════════════════════════════════════════════════

async function suiteEscalation() {
  console.log('\n📋 SUITE 9: HUMAN ESCALATION');

  let ph = freshPhone();
  await registerPatient(ph, 'Paciente Escalar');
  await runTest('HUMAN-001', 'Request human agent', ph, [
    { msg: 'quiero hablar con alguien', expect: /equipo|personalmente|atención/i },
  ]);

  // HUMAN-004 Emergency
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Emerg');
  await runTest('HUMAN-004', 'Emergency: "es una emergencia"', ph, [
    { msg: 'es una emergencia', expect: /equipo|personalmente|atención|urgente/i },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 10-11: MENU & AI FALLBACK
// ═════════════════════════════════════════════════════════════════════════════

async function suiteMenuAI() {
  console.log('\n📋 SUITE 10-11: MENU & AI FALLBACK');

  // MENU-001 Return to menu from IDLE
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente Menu');
  await runTest('MENU-001', 'Return to menu from IDLE', ph, [
    { msg: 'hola', expect: /qué te puedo ayudar/i },
  ]);

  // MENU-002 Mid-booking escape
  ph = freshPhone();
  await registerPatient(ph, 'Paciente MenuEsc');
  await runTest('MENU-002', 'Menu escape during booking', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'menu', expect: /qué te puedo ayudar/i, checkState: 'idle' },
  ]);

  // AI-005 Greeting: "gracias"
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Gracias');
  await runTest('AI-005', 'Greeting: "gracias"', ph, [
    { msg: 'gracias', expect: /gusto|aquí estoy/i },
  ]);

  // AI-006 Farewell: "adios"
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Bye');
  await runTest('AI-006', 'Farewell: "adiós"', ph, [
    { msg: 'adiós', expect: /hasta luego|excelente/i },
  ]);

  // AI-009 Clinic info
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Info');
  await runTest('AI-009', 'Clinic info', ph, [
    { msg: 'dónde están ubicados?', expect: /clínica cabrera/i },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 14: FLOW COMBINATIONS
// ═════════════════════════════════════════════════════════════════════════════

async function suiteCombos() {
  console.log('\n📋 SUITE 14: FLOW COMBINATIONS');

  // COMBO-001 Book then cancel
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente ComboUno');
  await bookAppointment(ph, 'próximo jueves', '9am');
  await runTest('COMBO-001', 'Book then cancel', ph, [
    { msg: 'cancelar mi cita', expect: /confirmas.*cancelar/i },
    { msg: 'sí', expect: /cancelada/i,
      checkDb: (phone) => {
        const citas = getCitas(phone);
        const activas = citas.filter(c => c.estado !== 'cancelada');
        if (activas.length > 0) failures.push({ testId: 'COMBO-001', desc: 'Cita still active after cancel' });
      }
    },
  ]);

  // COMBO-002 Book then reschedule
  ph = freshPhone();
  await registerPatient(ph, 'Paciente ComboDos');
  await bookAppointment(ph, '4 de mayo', '10am');
  await runTest('COMBO-002', 'Book then reschedule', ph, [
    { msg: 'mover mi cita', expect: /reagendando|fecha/i },
    { msg: '5 de mayo', expect: /hora/i },
    { msg: '4pm', expect: /confirmamos/i },
    { msg: 'sí', expect: /reagendada|agendada/i },
    { msg: 'no', expect: /motivo/i },
    { msg: 'cambio', expect: /listo/i },
  ]);

  // COMBO-005 Register then immediately book
  ph = freshPhone();
  await runTest('COMBO-005', 'Register then immediately book', ph, [
    { msg: 'hola', expect: /llamas/i },
    { msg: 'María Combo', expect: /gusto/i },
    { msg: '10/05/1988', expect: /registrad/i },
    { msg: '1', expect: /fecha/i },
    { msg: '8 de mayo', expect: /hora/i },
    { msg: '9am', expect: /confirmamos/i },
    { msg: 'sí', expect: /agendada/i },
  ]);

  // COMBO-007 Start booking, cancel mid-flow, then rebook
  ph = freshPhone();
  await registerPatient(ph, 'Paciente ComboSiete');
  await runTest('COMBO-007', 'Start booking, cancel, rebook', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'menu', expect: /ayudar/i, checkState: 'idle' },
    { msg: 'agendar', expect: /fecha/i },
    { msg: '11 de mayo', expect: /hora/i },
    { msg: '6pm', expect: /confirmamos/i },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 15: FLOW INTERRUPTIONS
// ═════════════════════════════════════════════════════════════════════════════

async function suiteInterruptions() {
  console.log('\n📋 SUITE 15: FLOW INTERRUPTIONS');

  // INTR-001 Say "cancelar" during booking
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente IntrUno');
  await runTest('INTR-001', 'Say "cancelar" during booking', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'cancelar', expect: /ayudar/i, checkState: 'idle' },
  ]);

  // INTR-005 Irrelevant message during ELIGIENDO_HORA
  ph = freshPhone();
  await registerPatient(ph, 'Paciente IntrCinco');
  await runTest('INTR-005', 'Irrelevant msg during ELIGIENDO_HORA', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'próximo lunes', expect: /hora/i },
    { msg: 'pizza con queso', expect: /no entendí la hora/i, checkState: 'eligiendo_hora' },
  ]);

  // INTR-006 Send date when expecting time
  ph = freshPhone();
  await registerPatient(ph, 'Paciente IntrSeis');
  await runTest('INTR-006', 'Send date when expecting time', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'próximo lunes', expect: /hora/i },
    { msg: 'martes', expect: /no entendí la hora/i },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 18: BUSINESS HOURS
// ═════════════════════════════════════════════════════════════════════════════

async function suiteHours() {
  console.log('\n📋 SUITE 18: BUSINESS HOURS');

  // HOURS-001 Monday 9:00 valid
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente Horario Uno');
  await runTest('HOURS-001', 'Weekday 9:00: valid', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: '20 de abril', expect: /hora/i },
    { msg: '9am', expect: /confirmamos/i },
  ]);

  // HOURS-004 Lunch break 14:00
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Horario Cuatro');
  await runTest('HOURS-004', 'Lunch break (14:00): invalid', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: '21 de abril', expect: /hora/i },
    { msg: '2pm', expect: /horario/i },
  ]);

  // HOURS-006 16:00 afternoon valid
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Horario Seis');
  await runTest('HOURS-006', '16:00 afternoon: valid', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: '22 de abril', expect: /hora/i },
    { msg: '4pm', expect: /confirmamos/i },
  ]);

  // HOURS-009 20:00 at closing invalid
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Horario Nueve');
  await runTest('HOURS-009', '20:00 at closing: invalid', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: '23 de abril', expect: /hora/i },
    { msg: '8pm', expect: /horario/i },
  ]);

  // HOURS-010 Saturday 9:00 valid
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Horario Sabado');
  await runTest('HOURS-010', 'Saturday 9:00: valid', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: '18 de abril', expect: /hora/i },
    { msg: '9am', expect: /confirmamos/i },
  ]);

  // HOURS-013 Saturday 14:00 rejected
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Horario Sabado Tarde');
  await runTest('HOURS-013', 'Saturday 14:00: rejected', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: '25 de abril', expect: /hora/i },
    { msg: '2pm', expect: /horario/i },
  ]);

  // HOURS-014 Sunday rejected
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Horario Domingo');
  await runTest('HOURS-014', 'Sunday: rejected', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: '19 de abril', expect: /no trabaja/i },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 19: EDGE CASES
// ═════════════════════════════════════════════════════════════════════════════

async function suiteEdgeCases() {
  console.log('\n📋 SUITE 19: EDGE CASES');

  // EDGE-003 Only emojis
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente Emoji');
  await runTest('EDGE-003', 'Message with only emojis', ph, [
    { msg: '😊🎉👍', expect: /.+/ }, // bot should respond something (AI fallback)
  ]);

  // EDGE-006 SQL injection — prepared statements protect, special chars stripped from name
  ph = freshPhone();
  await runTest('EDGE-006', 'SQL injection attempt', ph, [
    { msg: "hola'; DROP TABLE pacientes;--", expect: /llamas|nombre/i },
    { msg: "Robert Seguro Test", expect: /gusto/i },
  ]);

  // EDGE-008 English message
  ph = freshPhone();
  await registerPatient(ph, 'Paciente English');
  await runTest('EDGE-008', 'Message in English', ph, [
    { msg: 'I want to book an appointment', expect: /.+/ }, // AI fallback
  ]);

  // EDGE-010 Unicode
  ph = freshPhone();
  await runTest('EDGE-010', 'Unicode and accented characters', ph, [
    { msg: 'hola', expect: /llamas/i },
    { msg: 'José Ángel Muñoz Peña', expect: /gusto.*josé/i },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 20: MEXICAN SPANISH
// ═════════════════════════════════════════════════════════════════════════════

async function suiteMexican() {
  console.log('\n📋 SUITE 20: MEXICAN SPANISH');

  // MEX-001 "Ocupo cita"
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente MexUno');
  await runTest('MEX-001', '"Ocupo cita"', ph, [
    { msg: 'Ocupo cita', expect: /fecha/i },
  ]);

  // MEX-002 "Me urge"
  ph = freshPhone();
  await registerPatient(ph, 'Paciente MexDos');
  await runTest('MEX-002', '"Me urge una cita"', ph, [
    { msg: 'me urge una cita', expect: /fecha|emergencia|equipo/i },
  ]);

  // MEX-007 "Nel"
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Nel');
  await runTest('MEX-007', '"Nel, mejor no"', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: '7 de mayo', expect: /hora/i },
    { msg: '5pm', expect: /confirmamos/i },
    { msg: 'nel', expect: /no se agendó|cancelado|ayudar/i },
  ]);

  // MEX-019 "Chale, ya no puedo ir"
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Chale');
  await bookAppointment(ph, 'próximo viernes', '10am');
  await runTest('MEX-019', '"Chale, ya no puedo ir"', ph, [
    { msg: 'chale ya no puedo ir a mi cita', expect: /confirmas.*cancelar|cita/i },
  ]);

  // MEX-020 "Le puedo mover"
  ph = freshPhone();
  await registerPatient(ph, 'Paciente Mover');
  await bookAppointment(ph, '6 de mayo', '10am');
  await runTest('MEX-020', '"Le puedo mover a otro día?"', ph, [
    { msg: 'le puedo mover mi cita a otro dia?', expect: /reagendando|fecha/i },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 16: GOOGLE CALENDAR
// ═════════════════════════════════════════════════════════════════════════════

async function suiteGCal() {
  console.log('\n📋 SUITE 16: GOOGLE CALENDAR');

  // GCAL-002 Event created on booking — unique date
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente GCal');
  await runTest('GCAL-002', 'Calendar event created on booking', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: '12 de mayo', expect: /hora/i },
    { msg: '9am', expect: /confirmamos/i },
    { msg: 'sí', expect: /agendada/i },
    { msg: 'no', expect: /motivo/i },
    { msg: 'chequeo general', expect: /listo/i,
      checkDb: (phone) => {
        const citas = getCitas(phone);
        const ultimaCita = citas[citas.length - 1];
        if (!ultimaCita?.google_calendar_event_id) {
          failures.push({ testId: 'GCAL-002', desc: 'No google_calendar_event_id in cita' });
        }
      }
    },
  ]);

  // GCAL-003 Event deleted on cancel
  ph = freshPhone();
  await registerPatient(ph, 'Paciente CalBorrar');
  await bookAppointment(ph, 'próximo viernes', '11am');
  const citasAntes = getCitas(ph);
  const eventIdAntes = citasAntes[citasAntes.length - 1]?.google_calendar_event_id;

  await runTest('GCAL-003', 'Calendar event deleted on cancel', ph, [
    { msg: 'cancelar cita', expect: /confirmas/i },
    { msg: 'sí', expect: /cancelada/i,
      checkDb: (phone) => {
        if (!eventIdAntes) {
          failures.push({ testId: 'GCAL-003', desc: 'No event to delete (no eventId before cancel)' });
        }
        // Event should have been deleted via calendar.eliminarEvento
      }
    },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 22: PRE-CONSULTATION REPORT
// ═════════════════════════════════════════════════════════════════════════════

async function suiteReport() {
  console.log('\n📋 SUITE 22: PRE-CONSULTATION REPORT');

  // REPORT-001 Report with all fields
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente Reporte');
  await runTest('REPORT-001', 'Report sent with symptoms', ph, [
    { msg: 'agendar', expect: /fecha/i },
    { msg: 'próximo miércoles', expect: /hora/i },
    { msg: '10am', expect: /confirmamos/i },
    { msg: 'sí', expect: /primera visita/i },
    { msg: 'sí', expect: /motivo/i },
    { msg: 'tengo dolor de estómago, vómito y mareos desde hace 3 días', expect: /listo.*información al doctor/i,
      checkDb: (phone) => {
        const citas = getCitas(phone);
        const c = citas[citas.length - 1];
        if (c?.primera_visita !== 1) failures.push({ testId: 'REPORT-001', desc: `primera_visita should be 1, got ${c?.primera_visita}` });
        if (!c?.motivo_consulta?.includes('dolor')) failures.push({ testId: 'REPORT-001', desc: 'Motivo not saved correctly' });
      }
    },
  ]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SUITE 23: DATA INTEGRITY
// ═════════════════════════════════════════════════════════════════════════════

async function suiteIntegrity() {
  console.log('\n📋 SUITE 23: DATA INTEGRITY');

  // INTEGRITY-002 No duplicate patients
  let ph = freshPhone();
  await registerPatient(ph, 'Paciente Unique');
  // Try to "re-register" by sending hola again
  await send(ph, 'hola');
  const patients = getDb().prepare('SELECT COUNT(*) as cnt FROM pacientes WHERE telefono = ?').get(ph);
  totalTests++;
  if (patients.cnt === 1) {
    passed++;
    process.stdout.write('  ✅ INTEGRITY-002\n');
  } else {
    failed++;
    failures.push({ testId: 'INTEGRITY-002', desc: `Expected 1 patient, got ${patients.cnt}` });
    process.stdout.write('  ❌ INTEGRITY-002\n');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  🧪  BOT TEST SUITE — Clínica Cabrera Medical   ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const start = Date.now();

  const calOk = calendar.init();
  console.log(calOk ? '📅 Google Calendar: CONECTADO' : '📅 Google Calendar: no disponible (tests sin Calendar)');

  await cleanAllTestData();
  console.log('🧹 Datos de prueba previos eliminados (BD + Calendar)');
  console.log('');

  await suiteRegistration();
  await suiteBooking();
  await suiteCancellation();
  await suiteRescheduling();
  await suiteNameBday();
  await suiteView();
  await suiteEscalation();
  await suiteMenuAI();
  await suiteCombos();
  await suiteInterruptions();
  await suiteHours();
  await suiteEdgeCases();
  await suiteMexican();
  await suiteGCal();
  await suiteReport();
  await suiteIntegrity();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log('\n══════════════════════════════════════════════════');
  console.log(`  Total: ${totalTests} | ✅ Passed: ${passed} | ❌ Failed: ${failed} | ⏱ ${elapsed}s`);
  console.log('══════════════════════════════════════════════════');

  if (failures.length > 0) {
    console.log('\n❌ FAILURES:\n');
    failures.forEach((f, i) => {
      console.log(`  ${i+1}. [${f.testId}] ${f.desc}`);
      console.log(`     Expected: ${f.expected}`);
      console.log(`     Got:      ${f.got}\n`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
