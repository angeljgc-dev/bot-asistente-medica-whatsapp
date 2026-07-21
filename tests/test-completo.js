'use strict';
/**
 * test-completo.js — Pruebas exhaustivas simulando pacientes reales de un
 * consultorio mexicano. Verifica flujos completos, BD, y Google Calendar.
 *
 * Ejecutar: node test-completo.js
 */

const { routeMessage }  = require('../src/handlers/messageRouter');
const { getDb }         = require('../src/database/db');
const calendar          = require('../src/services/calendar');
const citaRepo          = require('../src/database/repositories/citaRepo');
const medicoRepo        = require('../src/database/repositories/medicoRepo');
const attendanceHandler = require('../src/handlers/attendanceHandler');
const { toSqliteDateTime } = require('../src/utils/dateFormatter');
const env               = require('../src/config/env');

const DOCTOR_PHONE = env.DOCTOR_PHONE?.replace(/^\+/, '');

// ── Framework de pruebas ────────────────────────────────────────────────────
let total = 0, passed = 0, failed = 0;
const failures = [];

let phoneCounter = 5200090000;
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
    const gotStr = String(got).substring(0, 150);
    process.stdout.write(`  \u274C ${testId}: ${label}\n     Got: "${gotStr}"\n`);
    failures.push({ testId, label, got: gotStr });
  }
}

function getPatient(phone) {
  return getDb().prepare('SELECT * FROM pacientes WHERE telefono = ?').get(phone) || null;
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

function getActiveCitas(phone) {
  const p = getPatient(phone);
  if (!p) return [];
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre
    FROM citas c JOIN medicos m ON m.id = c.medico_id
    WHERE c.paciente_id = ?
      AND c.estado NOT IN ('cancelada','completada','no_asistio')
    ORDER BY c.fecha_hora ASC
  `).all(p.id);
}

function getSession(phone) {
  return getDb().prepare('SELECT * FROM sesiones WHERE telefono = ?').get(phone) || null;
}

function cleanPhone(phone) {
  const db = getDb();
  const p = db.prepare('SELECT id FROM pacientes WHERE telefono = ?').get(phone);
  if (p) db.prepare('DELETE FROM citas WHERE paciente_id = ?').run(p.id);
  db.prepare('DELETE FROM pacientes WHERE telefono = ?').run(phone);
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(phone);
}

async function cleanCalendar() {
  if (!calendar.isEnabled()) return;
  const desde = new Date(); desde.setMonth(desde.getMonth() - 1);
  const hasta = new Date(); hasta.setMonth(hasta.getMonth() + 6);
  const n = await calendar.purgarEventosPrueba(desde, hasta);
  if (n > 0) console.log(`\u{1F5D1}\uFE0F  Calendar: ${n} evento(s) de prueba purgados`);
}

// Registra paciente completo, regresa phone
async function registrar(phone, nombre, cumple) {
  await send(phone, 'hola');
  await send(phone, nombre || 'Test Paciente');
  await send(phone, cumple || '15 de marzo de 1990');
}

// Agenda una cita completa y regresa la respuesta final
async function agendarCompleto(phone, fecha, hora, primeraVisita, motivo) {
  await send(phone, 'agendar');
  await send(phone, fecha);
  let r = await send(phone, hora);
  if (/ocupado|no est/i.test(r)) return r; // conflict
  await send(phone, 'si');
  await send(phone, primeraVisita || 'no, ya he venido');
  return await send(phone, motivo || 'dolor de cabeza');
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 1: REGISTRO DE PACIENTES
// ═══════════════════════════════════════════════════════════════════════════
async function grupoRegistro() {
  console.log('\n\u{1F4CB} GRUPO 1: REGISTRO DE PACIENTES');

  // 1.1 Registro completo happy path
  let ph = freshPhone();
  let r = await send(ph, 'Hola buenas tardes');
  check('REG-01', 'Saludo inicia registro (pide nombre)', /llamas/i.test(r), r);

  r = await send(ph, 'Maria Guadalupe Hernandez');
  check('REG-02', 'Acepta nombre completo', /mucho gusto.*maria/i.test(r), r);
  check('REG-03', 'Pide cumpleanos', /cumplea/i.test(r), r);

  r = await send(ph, '5 de mayo de 1988');
  check('REG-04', 'Registro completo', /registrad/i.test(r), r);
  const p1 = getPatient(ph);
  check('REG-05', 'Paciente en BD con estado activo', p1?.estado === 'activo', p1?.estado);
  check('REG-06', 'Nombre capitalizado correctamente', p1?.nombre === 'Maria Guadalupe Hernandez', p1?.nombre);

  // 1.2 Registro con "me llamo"
  ph = freshPhone();
  await send(ph, 'buenas');
  r = await send(ph, 'me llamo Juan Carlos Ramirez');
  check('REG-07', '"me llamo" acepta nombre', /mucho gusto.*juan/i.test(r), r);

  // 1.3 Registro con "soy"
  ph = freshPhone();
  await send(ph, 'hey');
  r = await send(ph, 'soy Pedro Lopez');
  check('REG-08', '"soy" acepta nombre', /mucho gusto.*pedro/i.test(r), r);

  // 1.4 Rechaza saludos como nombre
  ph = freshPhone();
  await send(ph, 'hola');
  r = await send(ph, 'hola');
  check('REG-09', 'Rechaza "hola" como nombre', !/mucho gusto/i.test(r), r);

  r = await send(ph, 'buenas tardes');
  check('REG-10', 'Rechaza "buenas tardes" como nombre', !/mucho gusto/i.test(r), r);

  r = await send(ph, 'quiero una cita');
  check('REG-11', 'Rechaza frase de accion como nombre', !/mucho gusto/i.test(r), r);

  r = await send(ph, 'Ana Garcia');
  check('REG-12', 'Acepta nombre despues de rechazos', /mucho gusto.*ana/i.test(r), r);

  // 1.5 Cumpleanos en diferentes formatos
  // DD/MM/YYYY
  ph = freshPhone();
  await send(ph, 'hola');
  await send(ph, 'Roberto Martinez');
  r = await send(ph, '15/03/1985');
  check('REG-13', 'Cumple DD/MM/YYYY', /registrad/i.test(r), r);

  // DD-MM-YYYY
  ph = freshPhone();
  await send(ph, 'hola');
  await send(ph, 'Laura Sanchez');
  r = await send(ph, '20-11-1992');
  check('REG-14', 'Cumple DD-MM-YYYY', /registrad/i.test(r), r);

  // Lenguaje natural con "naci el"
  ph = freshPhone();
  await send(ph, 'hola');
  await send(ph, 'Sofia Morales');
  r = await send(ph, 'naci el 3 de enero de 1995');
  check('REG-15', 'Cumple con "naci el..."', /registrad/i.test(r), r);

  // Fecha invalida
  ph = freshPhone();
  await send(ph, 'hola');
  await send(ph, 'Carlos Vega');
  r = await send(ph, 'no me acuerdo');
  check('REG-16', 'Cumple invalido pide de nuevo', /no me qued/i.test(r), r);

  // Despues de error, acepta fecha correcta
  r = await send(ph, '25 de diciembre de 1990');
  check('REG-17', 'Acepta cumple despues de error', /registrad/i.test(r), r);

  // 1.6 Paciente que regresa (ya registrado)
  ph = freshPhone();
  await registrar(ph, 'Lupita Flores', '10 de agosto de 1987');
  r = await send(ph, 'hola');
  check('REG-18', 'Paciente existente ve menu', /lupita/i.test(r) && /agendar/i.test(r), r);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 2: AGENDAMIENTO DE CITAS + CALENDAR
// ═══════════════════════════════════════════════════════════════════════════
async function grupoAgendamiento() {
  console.log('\n\u{1F4C5} GRUPO 2: AGENDAMIENTO DE CITAS + CALENDAR');

  // 2.1 Agendar cita completa — happy path
  const ph1 = freshPhone();
  await registrar(ph1, 'Andrea Torres', '12 de junio de 1993');

  let r = await send(ph1, 'quiero una cita');
  check('AGE-01', '"quiero una cita" pide fecha', /fecha/i.test(r), r);

  r = await send(ph1, '1 de junio');
  check('AGE-02', 'Acepta fecha, pide hora', /hora/i.test(r), r);

  r = await send(ph1, '10 am');
  check('AGE-03', 'Muestra confirmacion con datos', /confirma/i.test(r) && /cabrera/i.test(r), r);

  r = await send(ph1, 'si');
  check('AGE-04', 'Cita agendada, pide primera visita', /primera visita/i.test(r), r);

  r = await send(ph1, 'no');
  check('AGE-05', 'Pregunta motivo de consulta', /motivo/i.test(r), r);

  r = await send(ph1, 'me duele la cabeza desde hace 3 dias');
  check('AGE-06', 'Cita registrada completa', /listo.*andrea/i.test(r), r);

  // Verificar BD
  const citas1 = getActiveCitas(ph1);
  check('AGE-07', 'Cita en BD con estado programada', citas1.length === 1 && citas1[0].estado === 'programada', citas1[0]?.estado);
  check('AGE-08', 'Motivo guardado', /duele la cabeza/i.test(citas1[0]?.motivo_consulta || ''), citas1[0]?.motivo_consulta);
  check('AGE-09', 'Calendar event ID guardado', !!citas1[0]?.google_calendar_event_id, citas1[0]?.google_calendar_event_id);

  // 2.2 Agendar con fecha+hora en un solo mensaje
  const ph2 = freshPhone();
  await registrar(ph2, 'Miguel Angel Ruiz', '20 de febrero de 1980');

  r = await send(ph2, 'quiero cita el 2 de junio a las 11 am');
  check('AGE-10', 'Fecha+hora juntas, muestra confirmacion', /confirma/i.test(r) && /cabrera/i.test(r), r);

  r = await send(ph2, 'sii');
  check('AGE-11', '"sii" se acepta como confirmacion', /primera visita/i.test(r), r);
  await send(ph2, 'si es mi primera vez');
  r = await send(ph2, 'chequeo general');
  check('AGE-12', 'Cita con primera visita + motivo completada', /listo/i.test(r), r);

  const citas2 = getActiveCitas(ph2);
  check('AGE-13', 'Primera visita marcada en BD', citas2[0]?.primera_visita === 1, citas2[0]?.primera_visita);

  // 2.3 Agendar con "manana" (dia siguiente)
  const ph3 = freshPhone();
  await registrar(ph3, 'Fernanda Lopez', '1 de marzo de 1999');

  r = await send(ph3, 'necesito cita para manana');
  check('AGE-14', '"manana" reconocida como fecha', /hora/i.test(r), r);

  r = await send(ph3, '4 de la tarde');
  check('AGE-15', '"4 de la tarde" reconocida', /confirma/i.test(r), r);

  await send(ph3, 'si');
  await send(ph3, 'no');
  r = await send(ph3, 'dolor de estomago');
  check('AGE-16', 'Cita para manana registrada', /listo/i.test(r), r);

  // 2.4 Omitir motivo
  const ph4 = freshPhone();
  await registrar(ph4, 'Diego Moreno', '7 de julio de 1991');

  await send(ph4, 'agendar');
  await send(ph4, '3 de junio');
  await send(ph4, '9am');
  await send(ph4, 'si');
  await send(ph4, 'no');
  r = await send(ph4, 'omitir');
  check('AGE-17', 'Omitir motivo aceptado', /listo/i.test(r), r);

  const citas4 = getActiveCitas(ph4);
  check('AGE-18', 'Motivo queda null al omitir', !citas4[0]?.motivo_consulta, citas4[0]?.motivo_consulta);

  // 2.5 Rechazar confirmacion
  const ph5 = freshPhone();
  await registrar(ph5, 'Valentina Cruz', '14 de febrero de 1996');

  await send(ph5, 'agendar');
  await send(ph5, '4 de junio');
  await send(ph5, '12pm');
  r = await send(ph5, 'no');
  check('AGE-19', 'Cancelar antes de confirmar', /no se agend/i.test(r), r);

  const citas5 = getActiveCitas(ph5);
  check('AGE-20', 'No se creo cita en BD', citas5.length === 0, citas5.length);

  // 2.6 Conflicto de horario
  const ph6 = freshPhone();
  await registrar(ph6, 'Arturo Castillo', '30 de septiembre de 1985');

  await send(ph6, 'agendar');
  await send(ph6, '1 de junio');  // mismo dia que ph1
  r = await send(ph6, '10am');    // misma hora que ph1
  check('AGE-21', 'Conflicto de horario detectado', /ocupado|no.*disponible/i.test(r), r);

  // 2.7 Fecha en el pasado (usar una fecha de hace meses para evitar wrap a proximo ano)
  const ph7 = freshPhone();
  await registrar(ph7, 'Patricia Mendez', '22 de abril de 1988');

  await send(ph7, 'agendar');
  r = await send(ph7, '1 de enero de 2025');
  check('AGE-22', 'Fecha pasada rechazada', /pas[oó]/i.test(r), r);

  // 2.8 Domingo (dia no laboral) — 12 de abril 2026 es domingo
  r = await send(ph7, 'domingo');
  check('AGE-23', 'Domingo rechazado', /no trabaja/i.test(r), r);

  // 2.9 Hora fuera de horario
  r = await send(ph7, '8 de junio');  // lunes
  check('AGE-24', 'Lunes aceptado', /hora/i.test(r), r);

  r = await send(ph7, '7am');
  check('AGE-25', 'Hora antes de apertura rechazada', /horario/i.test(r), r);

  r = await send(ph7, '3pm');  // hora de comida (14-16)
  check('AGE-26', 'Hora de comida rechazada', /horario/i.test(r), r);

  r = await send(ph7, '10am');
  check('AGE-27', 'Hora valida aceptada', /confirma/i.test(r), r);
  await send(ph7, 'no');  // cancel

  // 2.10 Sabado con horario especial
  const ph8 = freshPhone();
  await registrar(ph8, 'Carmen Reyes', '8 de noviembre de 1975');

  await send(ph8, 'agendar');
  r = await send(ph8, '6 de junio');  // sabado
  check('AGE-28', 'Sabado aceptado', /hora/i.test(r), r);

  r = await send(ph8, '2pm');  // sabado solo hasta 1pm
  check('AGE-29', 'Sabado despues de 1pm rechazado', /horario/i.test(r), r);

  r = await send(ph8, '11am');
  check('AGE-30', 'Sabado 11am aceptado', /confirma/i.test(r), r);
  await send(ph8, 'si');
  await send(ph8, 'si, primera vez');
  r = await send(ph8, 'revision general');
  check('AGE-31', 'Cita sabado completa', /listo/i.test(r), r);

  // 2.11 "ocupo una cita" (mexicanismo)
  const ph9 = freshPhone();
  await registrar(ph9, 'Ricardo Juarez', '17 de enero de 1994');

  r = await send(ph9, 'ocupo una cita');
  check('AGE-32', '"ocupo una cita" reconocido como agendar', /fecha/i.test(r), r);
  await send(ph9, 'salir');

  // 2.12 "ando mala" (coloquial mexicano)
  r = await send(ph9, 'ando malo y quiero ir a consulta');
  check('AGE-33', '"ando malo...consulta" reconocido', /fecha/i.test(r), r);
  await send(ph9, 'salir');

  // 2.13 Elegir "otro dia" en confirmacion
  const ph10 = freshPhone();
  await registrar(ph10, 'Gabriela Nava', '5 de abril de 2000');

  await send(ph10, 'agendar');
  await send(ph10, '9 de junio');
  await send(ph10, '10am');
  r = await send(ph10, 'mejor otro dia');
  check('AGE-34', '"mejor otro dia" regresa a elegir fecha', /fecha/i.test(r), r);

  // Verificar que se libro el tentativo en calendar
  const session10 = getSession(ph10);
  const datos10 = session10 ? JSON.parse(session10.datos_temporales || '{}') : {};
  check('AGE-35', 'Tentativo liberado', !datos10.tentativo_calendar_id, datos10.tentativo_calendar_id);
  await send(ph10, 'salir');
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 3: CONSULTAR CITAS
// ═══════════════════════════════════════════════════════════════════════════
async function grupoConsultar() {
  console.log('\n\u{1F50D} GRUPO 3: CONSULTAR CITAS');

  // 3.1 Sin citas
  const ph1 = freshPhone();
  await registrar(ph1, 'Elena Rojas', '9 de junio de 1997');

  let r = await send(ph1, 'cuando es mi cita');
  check('CON-01', 'Sin citas programadas', /no tienes citas/i.test(r), r);

  // 3.2 Con 1 cita
  await agendarCompleto(ph1, '10 de junio', '10am', 'no', 'gripa');

  r = await send(ph1, 'mis citas');
  check('CON-02', 'Muestra cita unica', /cabrera/i.test(r) && /junio/i.test(r), r);

  // 3.3 Con multiples citas
  await agendarCompleto(ph1, '11 de junio', '11am', 'no', 'seguimiento');

  r = await send(ph1, 'que citas tengo');
  check('CON-03', 'Muestra 2 citas', /2 citas/i.test(r), r);

  // 3.4 Menu opcion 2
  const ph2 = freshPhone();
  await registrar(ph2, 'Oscar Navarro', '3 de octubre de 1989');
  await agendarCompleto(ph2, '12 de junio', '9am', 'no', 'dolor lumbar');

  r = await send(ph2, 'hola');
  check('CON-04', 'Menu principal visible', /1.*agendar/i.test(r), r);

  r = await send(ph2, '2');
  check('CON-05', 'Opcion 2 muestra cita', /cabrera/i.test(r), r);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 4: REAGENDAMIENTO + CALENDAR
// ═══════════════════════════════════════════════════════════════════════════
async function grupoReagendar() {
  console.log('\n\u{1F504} GRUPO 4: REAGENDAMIENTO + CALENDAR');

  // 4.1 Reagendar cita unica
  const ph1 = freshPhone();
  await registrar(ph1, 'Sandra Gutierrez', '20 de mayo de 1986');
  await agendarCompleto(ph1, '15 de junio', '10am', 'no', 'consulta');

  const citaAntes = getActiveCitas(ph1)[0];
  const calendarIdAntes = citaAntes?.google_calendar_event_id;
  check('REA-01', 'Cita original tiene Calendar ID', !!calendarIdAntes, calendarIdAntes);

  let r = await send(ph1, 'quiero cambiar mi cita');
  check('REA-02', 'Inicia reagendamiento', /reagend/i.test(r) && /fecha/i.test(r), r);

  r = await send(ph1, '16 de junio');
  check('REA-03', 'Pide hora para nueva fecha', /hora/i.test(r), r);

  r = await send(ph1, '4pm');
  check('REA-04', 'Muestra confirmacion nueva cita', /confirma/i.test(r), r);

  await send(ph1, 'si');
  await send(ph1, 'no');
  r = await send(ph1, 'seguimiento');
  check('REA-05', 'Reagendamiento completado', /listo/i.test(r), r);

  const citaDespues = getActiveCitas(ph1)[0];
  check('REA-06', 'Nueva cita en BD', !!citaDespues, 'no cita');
  check('REA-07', 'Calendar ID cambiado', citaDespues?.google_calendar_event_id !== calendarIdAntes, citaDespues?.google_calendar_event_id);

  // Verificar cita anterior esta cancelada
  const citaVieja = getCitas(ph1).find(c => c.id === citaAntes.id);
  check('REA-08', 'Cita anterior cancelada en BD', citaVieja?.estado === 'cancelada', citaVieja?.estado);

  // 4.2 "le puedo mover" (mexicanismo)
  const ph2 = freshPhone();
  await registrar(ph2, 'Roberto Diaz', '15 de julio de 1990');
  await agendarCompleto(ph2, '17 de junio', '11am', 'no', 'dolor');

  r = await send(ph2, 'le puedo mover a mi cita');
  check('REA-09', '"le puedo mover" = reagendar', /reagend/i.test(r), r);
  await send(ph2, 'salir');

  // 4.3 "se me complico" (mexicanismo)
  r = await send(ph2, 'se me complico, puedo ir otro dia');
  check('REA-10', '"se me complico" = reagendar', /reagend/i.test(r), r);
  await send(ph2, 'salir');
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 5: CANCELACION + CALENDAR
// ═══════════════════════════════════════════════════════════════════════════
async function grupoCancelar() {
  console.log('\n\u274C GRUPO 5: CANCELACION + CALENDAR');

  // 5.1 Cancelar cita unica
  const ph1 = freshPhone();
  await registrar(ph1, 'Monica Delgado', '28 de agosto de 1991');
  await agendarCompleto(ph1, '18 de junio', '10am', 'no', 'fiebre');

  const citaPre = getActiveCitas(ph1)[0];
  check('CAN-01', 'Cita tiene Calendar ID', !!citaPre?.google_calendar_event_id, citaPre?.google_calendar_event_id);

  let r = await send(ph1, 'cancelar mi cita');
  check('CAN-02', 'Pide confirmacion cancelacion', /confirmas/i.test(r) && /cabrera/i.test(r), r);

  r = await send(ph1, 'si');
  check('CAN-03', 'Cita cancelada', /cancelada/i.test(r), r);

  const citaPost = getCitas(ph1).find(c => c.id === citaPre.id);
  check('CAN-04', 'Estado cancelada en BD', citaPost?.estado === 'cancelada', citaPost?.estado);

  // 5.2 Cancelar — decir "no" para abortar
  const ph2 = freshPhone();
  await registrar(ph2, 'Alejandro Fuentes', '12 de marzo de 1984');
  await agendarCompleto(ph2, '19 de junio', '11am', 'no', 'tos');

  await send(ph2, 'quiero cancelar');
  r = await send(ph2, 'no');
  check('CAN-05', 'Cancelacion abortada', /sigue en pie/i.test(r), r);

  check('CAN-06', 'Cita sigue activa en BD', getActiveCitas(ph2).length === 1, getActiveCitas(ph2).length);

  // 5.3 "ya no voy a poder ir" — deteccion de cancelacion
  r = await send(ph2, 'ya no voy a poder ir');
  check('CAN-07', '"ya no voy a poder ir" = cancelar', /confirmas/i.test(r), r);
  await send(ph2, 'si');
  check('CAN-08', 'Cita cancelada con frase coloquial', getActiveCitas(ph2).length === 0, getActiveCitas(ph2).length);

  // 5.4 Cancelar sin citas
  const ph3 = freshPhone();
  await registrar(ph3, 'Daniela Vargas', '9 de septiembre de 1998');
  r = await send(ph3, 'cancelar mi cita');
  check('CAN-09', 'Sin citas para cancelar', /no tienes citas/i.test(r), r);

  // 5.5 Cancelar todas (multiples citas)
  const ph4 = freshPhone();
  await registrar(ph4, 'Francisco Ramos', '4 de abril de 1979');
  await agendarCompleto(ph4, '22 de junio', '9am', 'no', 'consulta 1');
  await agendarCompleto(ph4, '23 de junio', '10am', 'no', 'consulta 2');
  await agendarCompleto(ph4, '24 de junio', '11am', 'no', 'consulta 3');

  const citasAntes = getActiveCitas(ph4);
  check('CAN-10', '3 citas activas', citasAntes.length === 3, citasAntes.length);

  const calIds = citasAntes.map(c => c.google_calendar_event_id).filter(Boolean);
  check('CAN-11', '3 Calendar events', calIds.length === 3, calIds.length);

  r = await send(ph4, 'cancelar todas mis citas');
  check('CAN-12', 'Pide confirmacion para cancelar todas', /todas.*\d+.*citas/i.test(r), r);

  r = await send(ph4, 'si');
  check('CAN-13', 'Todas canceladas', /cancel.*todas/i.test(r) || /listo.*cancel/i.test(r), r);

  check('CAN-14', '0 citas activas en BD', getActiveCitas(ph4).length === 0, getActiveCitas(ph4).length);

  // Verificar que las citas en BD estan como canceladas
  const allCitas = getCitas(ph4);
  const todasCanceladas = allCitas.every(c => c.estado === 'cancelada');
  check('CAN-15', 'Todas en estado cancelada', todasCanceladas, allCitas.map(c => c.estado).join(','));

  // 5.6 Cancelar multiples — elegir una por numero
  const ph5 = freshPhone();
  await registrar(ph5, 'Isabel Ortiz', '17 de diciembre de 1993');
  await agendarCompleto(ph5, '25 de junio', '12pm', 'no', 'revision');
  await agendarCompleto(ph5, '26 de junio', '12pm', 'no', 'revision 2');

  r = await send(ph5, 'cancelar mi cita');
  check('CAN-16', 'Muestra lista para elegir', /cu.*l.*cancelar/i.test(r), r);
  check('CAN-17', 'Muestra opcion cancelar todas', /cancelar todas/i.test(r), r);

  r = await send(ph5, '1');  // cancelar la primera
  check('CAN-18', 'Pide confirmacion de la seleccionada', /confirmas/i.test(r), r);

  r = await send(ph5, 'si');
  check('CAN-19', 'Primera cita cancelada', /cancelada/i.test(r), r);
  check('CAN-20', 'Solo 1 cita activa', getActiveCitas(ph5).length === 1, getActiveCitas(ph5).length);

  // 5.7 Cancelar multiples — opcion 0
  const ph6 = freshPhone();
  await registrar(ph6, 'Tomas Aguilar', '5 de mayo de 1982');
  await agendarCompleto(ph6, '29 de junio', '4pm', 'no', 'a');
  await agendarCompleto(ph6, '30 de junio', '4pm', 'no', 'b');

  await send(ph6, 'cancelar');
  r = await send(ph6, '0');
  check('CAN-21', 'Opcion 0 = cancelar todas', /todas.*citas/i.test(r), r);

  r = await send(ph6, 'si');
  check('CAN-22', 'Cancelacion masiva con opcion 0', getActiveCitas(ph6).length === 0, getActiveCitas(ph6).length);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 6: LENGUAJE MEXICANO / COLOQUIAL
// ═══════════════════════════════════════════════════════════════════════════
async function grupoLenguaje() {
  console.log('\n\u{1F1F2}\u{1F1FD} GRUPO 6: LENGUAJE MEXICANO / COLOQUIAL');

  const ph1 = freshPhone();
  await registrar(ph1, 'Rosa Luna', '3 de marzo de 1990');

  // 6.1 Saludos mexicanos
  let r = await send(ph1, 'que onda');
  check('MEX-01', '"que onda" = saludo', /rosa/i.test(r), r);

  r = await send(ph1, 'buenos dias');
  check('MEX-02', '"buenos dias" = saludo', /rosa/i.test(r), r);

  // 6.2 Confirmaciones coloquiales
  await send(ph1, 'agendar');
  await send(ph1, '1 de julio');
  await send(ph1, '10am');

  r = await send(ph1, 'dale');
  check('MEX-03', '"dale" = confirmacion si', /primera visita/i.test(r), r);
  await send(ph1, 'no');
  await send(ph1, 'gripa');

  // 6.3 Negaciones coloquiales
  const ph2 = freshPhone();
  await registrar(ph2, 'Mario Lara', '15 de agosto de 1987');
  await agendarCompleto(ph2, '2 de julio', '4pm', 'no', 'tos');

  await send(ph2, 'cancelar mi cita');
  r = await send(ph2, 'nel');
  check('MEX-04', '"nel" = negacion', /sigue en pie/i.test(r), r);

  // 6.4 Agradecimiento
  r = await send(ph2, 'gracias');
  check('MEX-05', '"gracias" reconocido', /gusto/i.test(r), r);

  // 6.5 Despedida
  r = await send(ph2, 'hasta luego');
  check('MEX-06', '"hasta luego" reconocido', /luego|d[ií]a/i.test(r), r);

  // 6.6 "chale ya no puedo" — cancelar
  const ph3 = freshPhone();
  await registrar(ph3, 'Lucia Espinoza', '7 de febrero de 1995');
  await agendarCompleto(ph3, '3 de julio', '5pm', 'no', 'x');

  r = await send(ph3, 'chale ya no puedo ir');
  check('MEX-07', '"chale ya no puedo ir" = cancelar', /confirmas/i.test(r), r);
  await send(ph3, 'si');

  // 6.7 "simon" como confirmacion
  const ph4 = freshPhone();
  await registrar(ph4, 'Eduardo Paz', '19 de octubre de 1992');
  await send(ph4, 'agendar');
  await send(ph4, '6 de julio');
  await send(ph4, '11am');
  r = await send(ph4, 'va');
  check('MEX-08', '"va" = confirmacion', /primera visita/i.test(r), r);
  await send(ph4, 'no');
  await send(ph4, 'omitir');
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 7: ESCALACION A HUMANO
// ═══════════════════════════════════════════════════════════════════════════
async function grupoEscalacion() {
  console.log('\n\u{1F6A8} GRUPO 7: ESCALACION A HUMANO');

  // 7.1 "emergencia" escala directo
  const ph1 = freshPhone();
  await registrar(ph1, 'Jorge Medina', '10 de enero de 1988');

  let r = await send(ph1, 'emergencia');
  check('ESC-01', '"emergencia" escala a humano', /paso con alguien/i.test(r) || /atienda/i.test(r), r);

  // 7.2 Despues de escalacion, no responde (modo humano)
  r = await send(ph1, 'hola, siguen ahi?');
  check('ESC-02', 'En modo humano no responde', r === '[null]', r);

  // 7.3 "hablar con alguien" escala
  const ph2 = freshPhone();
  await registrar(ph2, 'Leticia Campos', '25 de noviembre de 1985');

  r = await send(ph2, 'quiero hablar con alguien');
  check('ESC-03', '"hablar con alguien" = escalacion', /paso con alguien/i.test(r) || /atienda/i.test(r), r);

  // 7.4 "necesito un humano" — frustracion
  const ph3 = freshPhone();
  await registrar(ph3, 'Ivan Soto', '13 de abril de 1993');

  r = await send(ph3, 'necesito un humano, esto no funciona');
  check('ESC-04', 'Frustracion detectada, escala', /paso con alguien/i.test(r) || /atienda/i.test(r), r);

  // 7.5 Menu opcion 4
  const ph4 = freshPhone();
  await registrar(ph4, 'Karla Mendoza', '6 de junio de 1990');

  await send(ph4, 'hola');
  r = await send(ph4, '4');
  check('ESC-05', 'Menu 4 = hablar con alguien', /paso con alguien/i.test(r) || /atienda/i.test(r), r);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 8: DATOS DEL PACIENTE
// ═══════════════════════════════════════════════════════════════════════════
async function grupoDatos() {
  console.log('\n\u{1F464} GRUPO 8: DATOS DEL PACIENTE');

  const ph1 = freshPhone();
  await registrar(ph1, 'Norma Acosta', '8 de agosto de 1983');

  // 8.1 Ver datos
  let r = await send(ph1, 'mis datos');
  check('DAT-01', 'Muestra nombre', /norma/i.test(r), r);
  check('DAT-02', 'Muestra telefono', new RegExp(ph1).test(r), r);
  check('DAT-03', 'Muestra cumpleanos', /agosto/i.test(r), r);

  // 8.2 Cambiar nombre
  r = await send(ph1, 'cambiar mi nombre');
  check('DAT-04', 'Inicia flujo de cambio de nombre', /nombre correcto/i.test(r), r);

  r = await send(ph1, 'Norma Patricia Acosta Garcia');
  check('DAT-05', 'Nombre actualizado', /actualic.*norma patricia/i.test(r), r);

  const p1 = getPatient(ph1);
  check('DAT-06', 'Nombre en BD actualizado', p1?.nombre === 'Norma Patricia Acosta Garcia', p1?.nombre);

  // 8.3 Cambiar cumpleanos
  r = await send(ph1, 'cambiar mi cumpleanos');
  check('DAT-07', 'Inicia flujo de cambio de cumple', /fecha de nacimiento/i.test(r), r);

  r = await send(ph1, '15 de agosto de 1983');
  check('DAT-08', 'Cumple actualizado', /actualic/i.test(r), r);

  // 8.4 Correccion de nombre inline
  r = await send(ph1, 'mi nombre es Norma Acosta Perez');
  check('DAT-09', 'Correccion inline de nombre', /actualic/i.test(r), r);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 9: ESCAPE / SALIR DE FLUJOS
// ═══════════════════════════════════════════════════════════════════════════
async function grupoEscape() {
  console.log('\n\u{1F6AA} GRUPO 9: ESCAPE DE FLUJOS');

  const ph1 = freshPhone();
  await registrar(ph1, 'Pablo Rios', '20 de febrero de 1991');

  // 9.1 Salir de agendar
  await send(ph1, 'agendar');
  let r = await send(ph1, 'salir');
  check('ESC2-01', 'Salir de agendar regresa a menu', /agendar/i.test(r) && /pablo/i.test(r), r);

  // 9.2 Salir con "cancelar" (sin estar en flujo de cancelacion)
  await send(ph1, 'agendar');
  await send(ph1, '14 de abril');
  r = await send(ph1, 'menu');
  check('ESC2-02', '"menu" sale del flujo', /pablo/i.test(r), r);

  // 9.3 Salir con "dejalo"
  await send(ph1, 'agendar');
  r = await send(ph1, 'dejalo');
  check('ESC2-03', '"dejalo" sale del flujo', /pablo/i.test(r), r);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 10: ASISTENCIA (DOCTOR)
// ═══════════════════════════════════════════════════════════════════════════
async function grupoAsistencia() {
  console.log('\n\u{1F3E5} GRUPO 10: VERIFICACION DE ASISTENCIA');

  const ph1 = freshPhone();
  await registrar(ph1, 'Mariana Olvera', '14 de julio de 1992');

  // Insertar cita que "inicio hace 20 min" directamente en BD
  const p1 = getPatient(ph1);
  const medico = medicoRepo.findActivos()[0];
  const hace20 = new Date(Date.now() - 20 * 60_000);

  const citaId = getDb().prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado)
    VALUES (?, ?, ?, 30, 'programada')
  `).run(p1.id, medico.id, toSqliteDateTime(hace20)).lastInsertRowid;

  // 10.1 findPendientesAsistencia detecta la cita
  const pendientes = citaRepo.findPendientesAsistencia();
  const detectada = pendientes.some(c => c.id === citaId);
  check('ASI-01', 'Cita en ventana detectada', detectada, pendientes.map(c => c.id));

  // 10.2 Marcar como preguntada
  citaRepo.marcarAsistenciaPreguntada(citaId);

  const ya = citaRepo.findPendientesAsistencia().some(c => c.id === citaId);
  check('ASI-02', 'Ya no aparece en pendientes', !ya, ya);

  // 10.3 findPendienteRespuestaDoctor la encuentra
  const pendienteDoc = citaRepo.findPendienteRespuestaDoctor();
  check('ASI-03', 'Pendiente de respuesta doctor', pendienteDoc?.id === citaId, pendienteDoc?.id);

  // 10.4 Doctor responde "si"
  // Limpiar sesion del doctor primero
  getDb().prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);

  let r = await send(DOCTOR_PHONE, 'si');
  check('ASI-04', 'Doctor confirma asistencia', /asisti[oó]|registrado/i.test(r), r);

  const citaAsistio = getDb().prepare('SELECT * FROM citas WHERE id = ?').get(citaId);
  check('ASI-05', 'Estado = completada', citaAsistio.estado === 'completada', citaAsistio.estado);

  // 10.5 Doctor responde "no" a otra cita
  const ph2 = freshPhone();
  await registrar(ph2, 'Luis Herrera', '3 de noviembre de 1985');
  const p2 = getPatient(ph2);

  const hace25 = new Date(Date.now() - 25 * 60_000);
  const citaId2 = getDb().prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado)
    VALUES (?, ?, ?, 30, 'programada')
  `).run(p2.id, medico.id, toSqliteDateTime(hace25)).lastInsertRowid;

  citaRepo.marcarAsistenciaPreguntada(citaId2);
  getDb().prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);

  r = await send(DOCTOR_PHONE, 'no');
  check('ASI-06', 'Doctor registra no asistencia', /no asisti|registrado/i.test(r), r);

  const citaNoAsistio = getDb().prepare('SELECT * FROM citas WHERE id = ?').get(citaId2);
  check('ASI-07', 'Estado = no_asistio', citaNoAsistio.estado === 'no_asistio', citaNoAsistio.estado);

  // 10.6 Doctor responde algo ininteligible
  const ph3 = freshPhone();
  await registrar(ph3, 'Ana Belen', '1 de enero de 2000');
  const p3 = getPatient(ph3);

  const hace15 = new Date(Date.now() - 15 * 60_000);
  const citaId3 = getDb().prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado)
    VALUES (?, ?, ?, 30, 'programada')
  `).run(p3.id, medico.id, toSqliteDateTime(hace15)).lastInsertRowid;

  citaRepo.marcarAsistenciaPreguntada(citaId3);
  getDb().prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);

  r = await send(DOCTOR_PHONE, 'ahorita checo');
  check('ASI-08', 'Respuesta ininteligible re-pregunta', /s[ií].*no|lleg[oó]/i.test(r), r);

  const citaSigue = getDb().prepare('SELECT * FROM citas WHERE id = ?').get(citaId3);
  check('ASI-09', 'Estado sin cambiar', citaSigue.estado === 'programada', citaSigue.estado);

  // Limpieza: responder correctamente para no bloquear otros tests
  r = await send(DOCTOR_PHONE, 'si');
  check('ASI-10', 'Finalmente registrada', /registrado|asisti/i.test(r), r);

  // 10.7 Doctor sin citas pendientes — mensaje ignorado
  getDb().prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);
  r = await send(DOCTOR_PHONE, 'hola');
  check('ASI-11', 'Sin pendientes = ignorado', r === '[null]', r);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 11: MULTIMEDIA Y ERRORES
// ═══════════════════════════════════════════════════════════════════════════
async function grupoMultimedia() {
  console.log('\n\u{1F4F1} GRUPO 11: MULTIMEDIA Y EDGE CASES');

  const ph1 = freshPhone();
  await registrar(ph1, 'Camila Rios', '5 de mayo de 1995');

  // 11.1 Mensaje multimedia
  let r = await send(ph1, '__MEDIA_NO_SOPORTADO__');
  check('MUL-01', 'Multimedia rechazado amablemente', /solo.*texto/i.test(r), r);

  // 11.2 Paciente nuevo envia multimedia
  const ph2 = freshPhone();
  r = await send(ph2, '__MEDIA_NO_SOPORTADO__');
  check('MUL-02', 'Multimedia de nuevo pide texto', /solo.*texto/i.test(r), r);

  // 11.3 Info de la clinica
  r = await send(ph1, 'que horario tienen');
  check('MUL-03', 'Pregunta horario responde info', /horario/i.test(r) && /lunes/i.test(r), r);

  // 11.4 Pregunta sobre ubicacion
  r = await send(ph1, 'donde queda la clinica');
  check('MUL-04', 'Pregunta ubicacion responde', /direcci/i.test(r) || /clinica/i.test(r), r);
}

// ═══════════════════════════════════════════════════════════════════════════
// GRUPO 12: FLUJO COMPLETO END-TO-END CON CALENDAR
// ═══════════════════════════════════════════════════════════════════════════
async function grupoE2E() {
  console.log('\n\u{1F3AF} GRUPO 12: FLUJO END-TO-END CON CALENDAR');

  const ph = freshPhone();

  // Paciente llega por primera vez
  let r = await send(ph, 'hola buenas');
  check('E2E-01', 'Primer contacto: pide nombre', /llamas/i.test(r), r);

  r = await send(ph, 'me llamo Alejandra Cabrera Gomez');
  check('E2E-02', 'Nombre aceptado', /mucho gusto.*alejandra/i.test(r), r);

  r = await send(ph, '22 de septiembre de 1990');
  check('E2E-03', 'Registro completo', /registrad/i.test(r), r);

  // Agenda su primera cita
  r = await send(ph, 'quiero agendar una cita');
  check('E2E-04', 'Inicia agendamiento', /fecha/i.test(r), r);

  r = await send(ph, '7 de julio');
  check('E2E-05', 'Fecha aceptada', /hora/i.test(r), r);

  r = await send(ph, '5 de la tarde');
  check('E2E-06', 'Hora aceptada, confirmacion', /confirma/i.test(r) && /5:00\s*PM/i.test(r), r);

  r = await send(ph, 'si');
  check('E2E-07', 'Cita agendada, pide primera visita', /primera visita/i.test(r), r);

  r = await send(ph, 'si, es mi primera vez');
  check('E2E-08', 'Pide motivo', /motivo/i.test(r), r);

  r = await send(ph, 'tengo dolores de cabeza muy fuertes desde hace 2 semanas');
  check('E2E-09', 'Cita completa', /listo.*alejandra/i.test(r), r);

  // Verificar en BD
  let citas = getActiveCitas(ph);
  check('E2E-10', '1 cita en BD', citas.length === 1, citas.length);
  check('E2E-11', 'Motivo guardado', /dolores de cabeza/i.test(citas[0].motivo_consulta || ''), citas[0].motivo_consulta);
  check('E2E-12', 'Primera visita = 1', citas[0].primera_visita === 1, citas[0].primera_visita);
  check('E2E-13', 'Calendar ID presente', !!citas[0].google_calendar_event_id, citas[0].google_calendar_event_id);

  const calendarId1 = citas[0].google_calendar_event_id;

  // Consulta su cita
  r = await send(ph, 'cuando es mi cita');
  check('E2E-14', 'Consulta muestra cita', /cabrera/i.test(r) && /julio/i.test(r), r);

  // Reagenda
  r = await send(ph, 'puedo cambiar mi cita a otro dia?');
  check('E2E-15', 'Inicia reagendamiento', /reagend/i.test(r), r);

  r = await send(ph, '8 de julio');
  check('E2E-16', 'Nueva fecha aceptada', /hora/i.test(r), r);

  r = await send(ph, '6 de la tarde');
  check('E2E-17', 'Nueva hora, confirmacion', /confirma/i.test(r), r);

  r = await send(ph, 'si');
  check('E2E-18', 'Reagendamiento confirmado', /reagendada/i.test(r) || /primera visita/i.test(r), r);
  await send(ph, 'no');
  r = await send(ph, 'lo mismo, dolores de cabeza');
  check('E2E-19', 'Motivo actualizado', /listo/i.test(r), r);

  // Verificar que cita vieja cancelada y nueva creada
  citas = getActiveCitas(ph);
  check('E2E-20', '1 cita activa (reagendada)', citas.length === 1, citas.length);
  check('E2E-21', 'Nuevo Calendar ID (distinto)', citas[0].google_calendar_event_id !== calendarId1, citas[0].google_calendar_event_id);

  const calendarId2 = citas[0].google_calendar_event_id;

  // Agenda otra cita adicional
  r = await send(ph, 'quiero otra cita');
  check('E2E-22', 'Inicia segundo agendamiento', /fecha/i.test(r), r);

  await send(ph, '9 de julio');
  await send(ph, '10am');
  await send(ph, 'si');
  await send(ph, 'no');
  r = await send(ph, 'seguimiento');

  citas = getActiveCitas(ph);
  check('E2E-23', '2 citas activas', citas.length === 2, citas.length);

  // Cancelar todas
  r = await send(ph, 'cancelar todas mis citas');
  check('E2E-24', 'Confirmacion para cancelar todas', /todas.*2.*citas/i.test(r), r);

  r = await send(ph, 'si');
  check('E2E-25', 'Todas canceladas', /cancel/i.test(r) && /2/i.test(r), r);

  check('E2E-26', '0 citas activas', getActiveCitas(ph).length === 0, getActiveCitas(ph).length);

  // Verificar en Calendar que eventos fueron eliminados
  // (si el calendar esta habilitado, los eventos con esos IDs ya no deberian existir)
  if (calendar.isEnabled() && calendarId2) {
    try {
      const google = require('googleapis').google;
      const auth = new google.auth.GoogleAuth({
        keyFile: env.GOOGLE_CREDENTIALS_PATH,
        scopes: ['https://www.googleapis.com/auth/calendar'],
      });
      const cal = google.calendar({ version: 'v3', auth });
      try {
        const { data } = await cal.events.get({
          calendarId: env.GOOGLE_CALENDAR_ID,
          eventId: calendarId2,
        });
        // Google Calendar marca como "cancelled" en vez de 404
        check('E2E-27', 'Evento Calendar eliminado/cancelled', data.status === 'cancelled', data.status);
      } catch (e) {
        const status = e.code || e.response?.status;
        check('E2E-27', 'Evento Calendar eliminado (404/410)', status === 404 || status === 410, status);
      }
    } catch (e) {
      check('E2E-27', 'Verificacion Calendar', false, e.message);
    }
  } else {
    check('E2E-27', 'Calendar verificacion (skip - no habilitado)', true, 'skipped');
  }

  // Despedida
  r = await send(ph, 'muchas gracias');
  check('E2E-28', 'Agradecimiento reconocido', /gusto/i.test(r), r);

  r = await send(ph, 'adios');
  check('E2E-29', 'Despedida reconocida', /luego|d[ií]a/i.test(r), r);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('\n\u2550'.repeat(50));
  console.log('  PRUEBAS EXHAUSTIVAS — Consultorio Mexicano');
  console.log('  Fecha: ' + new Date().toLocaleString('es-MX'));
  console.log('\u2550'.repeat(50));

  // Inicializar Calendar
  calendar.init();

  // Limpiar datos de pruebas anteriores
  await cleanCalendar();
  const db = getDb();
  const testPatients = db.prepare("SELECT id FROM pacientes WHERE telefono LIKE '520009%'").all();
  for (const p of testPatients) db.prepare('DELETE FROM citas WHERE paciente_id = ?').run(p.id);
  db.prepare("DELETE FROM pacientes WHERE telefono LIKE '520009%'").run();
  db.prepare("DELETE FROM sesiones WHERE telefono LIKE '520009%'").run();
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);

  // Ejecutar grupos
  await grupoRegistro();
  await grupoAgendamiento();
  await grupoConsultar();
  await grupoReagendar();
  await grupoCancelar();
  await grupoLenguaje();
  await grupoEscalacion();
  await grupoDatos();
  await grupoEscape();
  await grupoAsistencia();
  await grupoMultimedia();
  await grupoE2E();

  // Limpiar al final
  await cleanCalendar();
  for (const p of db.prepare("SELECT id FROM pacientes WHERE telefono LIKE '520009%'").all())
    db.prepare('DELETE FROM citas WHERE paciente_id = ?').run(p.id);
  db.prepare("DELETE FROM pacientes WHERE telefono LIKE '520009%'").run();
  db.prepare("DELETE FROM sesiones WHERE telefono LIKE '520009%'").run();
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);

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
