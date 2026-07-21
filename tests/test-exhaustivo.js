'use strict';
/**
 * test-exhaustivo.js — Pruebas exhaustivas del bot WhatsApp médico
 * 16 grupos, ~170 assertions
 * Simula pacientes mexicanos reales: slang, typos, modismos, concurrencia
 *
 * Ejecutar: node test-exhaustivo.js
 */

// ── MOCK de WhatsApp — DEBE ir antes de requerir cualquier handler ────────────
const whatsapp = require('../src/services/whatsapp');
const notificaciones = []; // { tel, txt, ts }
whatsapp.sendMessage = async (tel, txt) => {
  notificaciones.push({ tel: String(tel), txt: String(txt), ts: Date.now() });
};

// ── MOCK de Groq — evita fallos transitorios de la API ───────────────────────
const groq = require('../src/services/groq');
groq.generarRespuesta = async (historial, texto, clinica) => {
  return `[mock: ${String(texto).substring(0, 30)}]`;
};

// ── MOCK de Google Calendar — elimina dependencia externa y conflictos ────────
const calendar = require('../src/services/calendar');
let _fakeEventCounter = 1000;
calendar.isEnabled       = () => true;
calendar.verificarDisponibilidad = async () => ({ disponible: true });
calendar.crearEventoTentativo    = async () => `fake-evt-${++_fakeEventCounter}`;
calendar.confirmarEvento         = async () => true;
calendar.eliminarEvento          = async () => true;
calendar.crearEvento             = async () => `fake-evt-${++_fakeEventCounter}`;
calendar.init                    = () => {};
function clearNotifs() { notificaciones.length = 0; }
function getNotifsByPattern(pat) { return notificaciones.filter(n => pat.test(n.txt)); }
function getNotifsByTel(tel) { return notificaciones.filter(n => n.tel === tel); }

// ── Imports ───────────────────────────────────────────────────────────────────
const { routeMessage }     = require('../src/handlers/messageRouter');
const { getDb }            = require('../src/database/db');
const citaRepo             = require('../src/database/repositories/citaRepo');
const medicoRepo           = require('../src/database/repositories/medicoRepo');
const sesionRepo           = require('../src/database/repositories/sesionRepo');
const { SESSION_TIMEOUT_MS } = require('../src/config/constants');
const { toSqliteDateTime } = require('../src/utils/dateFormatter');
const env                  = require('../src/config/env');

const DOCTOR_PHONE = env.DOCTOR_PHONE?.replace(/^\+/, '') || '';

// ── Framework de pruebas ──────────────────────────────────────────────────────
let total = 0, passed = 0, failed = 0;
const failures = [];

function check(id, label, cond, got) {
  total++;
  if (cond) {
    passed++;
    process.stdout.write(`  ✅ ${id}: ${label}\n`);
  } else {
    failed++;
    const g = String(got).substring(0, 160);
    process.stdout.write(`  ❌ ${id}: ${label}\n     Got: "${g}"\n`);
    failures.push({ id, label, got: g });
  }
}

// Aplanar respuesta interactiva a texto equivalente (para tests con regex).
// En producción los objetos { type: 'buttons'|'list' } van a sendButtons/sendList;
// aquí reproducimos el fallback textual para no romper aserciones existentes.
function _flatten(r) {
  if (!r) return '[null]';
  if (typeof r === 'string') return r;
  if (r.type === 'buttons') {
    const opts = (r.buttons || []).map((b, i) => `${i + 1}. ${b.text}`).join('\n');
    return `${r.text}\n\n${opts}`;
  }
  if (r.type === 'list') {
    let out = `${r.text}\n\n`;
    let idx = 1;
    (r.sections || []).forEach(s => {
      out += `*${s.title}*\n`;
      (s.rows || []).forEach(row => { out += `${idx++}. ${row.title}\n`; });
      out += '\n';
    });
    return out.trim();
  }
  return JSON.stringify(r);
}

async function send(phone, txt) {
  try { return _flatten(await routeMessage(phone, txt)); }
  catch (e) { return `[ERROR: ${e.message}]`; }
}

// ── Helpers de BD ─────────────────────────────────────────────────────────────
let phoneCounter = 5299900000;
function freshPhone() { return String(++phoneCounter); }

function getPatient(phone) {
  return getDb().prepare('SELECT * FROM pacientes WHERE telefono = ?').get(phone) || null;
}
function getSession(phone) {
  return getDb().prepare('SELECT * FROM sesiones WHERE telefono = ?').get(phone) || null;
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
function getAllCitas(phone) {
  const p = getPatient(phone);
  if (!p) return [];
  return getDb().prepare(`
    SELECT c.*, m.nombre AS medico_nombre
    FROM citas c JOIN medicos m ON m.id = c.medico_id
    WHERE c.paciente_id = ? ORDER BY c.id
  `).all(p.id);
}
function getSesionDatos(phone) {
  const s = getSession(phone);
  if (!s) return {};
  try { return JSON.parse(s.datos_temporales || '{}'); } catch { return {}; }
}

/** Simula que la sesión lleva 15 min inactiva para que limpiarInactivas la tome */
function simularExpiracion(phone) {
  getDb().prepare(
    `UPDATE sesiones
     SET ultima_actividad = datetime('now','-15 minutes','localtime')
     WHERE telefono = ?`
  ).run(phone);
}

/** Registra un paciente completo y espera a que quede en estado 'activo' */
async function registrar(phone, nombre, cumple) {
  await send(phone, 'hola');
  await send(phone, 'sí');  // LFPDPPP: aceptar aviso de privacidad
  await send(phone, nombre || 'Prueba Paciente');
  await send(phone, cumple || '15 de marzo de 1990');
}

/** Agenda cita completa; retorna la respuesta final */
async function agendarCompleto(phone, fecha, hora, primeraVisita, motivo) {
  await send(phone, 'agendar');
  await send(phone, fecha);
  const r = await send(phone, hora);
  if (/ocupado|no est/i.test(r)) return r; // conflicto
  await send(phone, 'si');
  await send(phone, primeraVisita || 'no ya he venido');
  return await send(phone, motivo || 'dolor de cabeza');
}

/** Limpia todos los datos de prueba (prefijo 52999), incluyendo eventos de Google Calendar */
async function limpiarTodoPrueba() {
  const db = getDb();
  const ps = db.prepare("SELECT id FROM pacientes WHERE telefono LIKE '52999%'").all();
  for (const p of ps) {
    // Eliminar eventos de Google Calendar antes de borrar citas del DB
    const citas = db.prepare(
      'SELECT google_calendar_event_id FROM citas WHERE paciente_id = ? AND google_calendar_event_id IS NOT NULL'
    ).all(p.id);
    for (const c of citas) {
      try { await calendar.eliminarEvento(c.google_calendar_event_id); } catch {}
    }
    db.prepare('DELETE FROM citas WHERE paciente_id = ?').run(p.id);
  }
  db.prepare("DELETE FROM pacientes WHERE telefono LIKE '52999%'").run();
  db.prepare("DELETE FROM sesiones WHERE telefono LIKE '52999%'").run();
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 1: REGISTRO CON LENGUAJE MEXICANO VARIADO
// ══════════════════════════════════════════════════════════════════════════════
async function grupoRegistroMexicano() {
  console.log('\n📋 GRUPO 1: REGISTRO CON LENGUAJE MEXICANO');

  // 1.1 "que onda" como primer contacto → LFPDPPP pide consentimiento
  let ph = freshPhone();
  let r = await send(ph, 'que onda');
  check('RMX-01', '"que onda" pide consentimiento LFPDPPP', /aceptas|aviso/i.test(r), r);

  // 1.2 "me llamo" funciona tras aceptar consentimiento
  await send(ph, 'sí');  // aceptar aviso
  r = await send(ph, 'me llamo Chuy Ramirez');
  check('RMX-02', '"me llamo" acepta nombre', /mucho gusto.*chuy/i.test(r), r);
  r = await send(ph, '15 de enero de 1995');
  check('RMX-03', 'Registro completo con "me llamo"', /registrad/i.test(r), r);

  // 1.3 "me llamo" + cumple DD/MM/YYYY
  ph = freshPhone();
  await send(ph, 'hola');
  await send(ph, 'sí');  // aceptar aviso
  r = await send(ph, 'me llamo Maria Guadalupe Torres');
  check('RMX-04', '"me llamo" acepta nombre completo', /mucho gusto.*maria/i.test(r), r);
  r = await send(ph, '05/05/1988');
  check('RMX-05', 'Cumple DD/MM/YYYY aceptado', /registrad/i.test(r), r);
  const p5 = getPatient(ph);
  check('RMX-06', 'Fecha de nacimiento guardada (1988-05-05)', p5?.fecha_nacimiento === '1988-05-05', p5?.fecha_nacimiento);

  // 1.4 Cumple con año de 2 dígitos
  ph = freshPhone();
  await send(ph, 'hola');
  await send(ph, 'sí');  // aceptar aviso
  await send(ph, 'Roberto Salazar');
  r = await send(ph, '15/03/90');
  check('RMX-07', 'Cumple DD/MM/YY (2 dígitos) aceptado', /registrad/i.test(r), r);
  const p7 = getPatient(ph);
  check('RMX-08', 'Año 90 interpretado como 1990', p7?.fecha_nacimiento === '1990-03-15', p7?.fecha_nacimiento);

  // 1.5 Múltiples rechazos → nombre válido en el 4to intento
  ph = freshPhone();
  await send(ph, 'hola');
  await send(ph, 'sí');  // aceptar aviso → ahora pide nombre
  r = await send(ph, 'hola');
  check('RMX-09', '"hola" rechazado como nombre', !/mucho gusto/i.test(r), r);
  r = await send(ph, 'si');
  check('RMX-10', '"si" rechazado como nombre', !/mucho gusto/i.test(r), r);
  r = await send(ph, 'quiero una cita');
  check('RMX-11', '"quiero una cita" rechazado como nombre', !/mucho gusto/i.test(r), r);
  r = await send(ph, 'Ana Garcia Flores');
  check('RMX-12', 'Nombre válido aceptado después de rechazos', /mucho gusto.*ana/i.test(r), r);

  // 1.6 Paciente ya registrado saluda → ve menú (no pide nombre)
  const phExist = freshPhone();
  await registrar(phExist, 'Lupita Mendoza', '10 de agosto de 1987');
  r = await send(phExist, 'buenos dias');
  check('RMX-13', 'Paciente existente ve menú con su nombre', /lupita/i.test(r) && /agendar/i.test(r), r);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 2: AGENDAMIENTO — FORMAS COLOQUIALES MEXICANAS
// ══════════════════════════════════════════════════════════════════════════════
async function grupoAgendamientoColoquial() {
  console.log('\n📅 GRUPO 2: AGENDAMIENTO COLOQUIAL MEXICANO');

  const ph1 = freshPhone();
  await registrar(ph1, 'Rosa Luna', '3 de marzo de 1990');

  // 2.1 "ocupo una cita" (mexicanismo)
  let r = await send(ph1, 'ocupo una cita');
  check('COL-01', '"ocupo una cita" = agendar', /fecha/i.test(r), r);
  await send(ph1, 'salir');

  // 2.2 "quiero ir a consulta"
  r = await send(ph1, 'quiero ir a consulta');
  check('COL-02', '"quiero ir a consulta" = agendar', /fecha/i.test(r), r);
  await send(ph1, 'salir');

  // 2.3 "ando mala y quiero consulta"
  r = await send(ph1, 'ando mala y quiero consulta');
  check('COL-03', '"ando mala" = agendar', /fecha/i.test(r), r);
  await send(ph1, 'salir');

  // 2.4 "quiero una cita" (basic agendar)
  r = await send(ph1, 'quiero una cita');
  check('COL-04', '"quiero una cita" inicia agendamiento', /fecha/i.test(r), r);
  await send(ph1, 'salir');

  // 2.5 Fecha+hora en un solo mensaje
  const ph2 = freshPhone();
  await registrar(ph2, 'Mario Lara', '15 de agosto de 1987');
  r = await send(ph2, 'quiero cita el 10 de junio a las 10am');
  check('COL-05', 'Fecha+hora juntas → confirmación directa', /confirma/i.test(r), r);
  await send(ph2, 'si');
  await send(ph2, 'no ya he venido');
  r = await send(ph2, 'gripa con tos');
  check('COL-06', 'Cita con fecha+hora completada', /listo/i.test(r), r);
  const citas2 = getActiveCitas(ph2);
  check('COL-07', 'Cita en BD', citas2.length === 1, citas2.length);
  check('COL-08', 'Motivo "gripa" guardado', /gripa/i.test(citas2[0]?.motivo_consulta || ''), citas2[0]?.motivo_consulta);

  // 2.6 Confirmación con "va" (mexicano)
  const ph3 = freshPhone();
  await registrar(ph3, 'Eduardo Paz', '19 de octubre de 1992');
  await send(ph3, 'agendar');
  await send(ph3, '11 de junio');
  await send(ph3, '9am');
  r = await send(ph3, 'va');
  check('COL-09', '"va" = confirmar_si → pide primera visita', /primera visita/i.test(r), r);
  await send(ph3, 'si primera vez');
  r = await send(ph3, 'dolor de cabeza');
  check('COL-10', 'Cita completada con confirmación "va"', /listo/i.test(r), r);
  const citas3 = getActiveCitas(ph3);
  check('COL-11', 'Primera visita = 1', citas3[0]?.primera_visita === 1, citas3[0]?.primera_visita);

  // 2.7 Primera visita "nel ya he venido" → NO primera visita
  const ph4 = freshPhone();
  await registrar(ph4, 'Lucia Espinoza', '7 de febrero de 1995');
  await send(ph4, 'agendar');
  await send(ph4, '12 de junio');
  await send(ph4, '11am');
  await send(ph4, 'si');
  r = await send(ph4, 'nel ya he venido');
  check('COL-12', '"nel ya he venido" pide motivo (= no primera visita)', /motivo/i.test(r), r);
  r = await send(ph4, 'revision de rutina');
  check('COL-13', 'Cita completada con "nel"', /listo/i.test(r), r);
  const citas4 = getActiveCitas(ph4);
  check('COL-14', 'primera_visita = 0 cuando se dice "nel"', citas4[0]?.primera_visita === 0, citas4[0]?.primera_visita);

  // 2.8 "pasado mañana" como fecha
  const ph5 = freshPhone();
  await registrar(ph5, 'Fernanda Rojas', '1 de marzo de 1999');
  await send(ph5, 'agendar');
  r = await send(ph5, 'pasado mañana');
  const pd = new Date(); pd.setDate(pd.getDate() + 2);
  const esFinde = pd.getDay() === 0 || pd.getDay() === 6;
  if (!esFinde) {
    check('COL-15', '"pasado mañana" pide hora', /hora/i.test(r), r);
  } else {
    check('COL-15', '"pasado mañana" (fin de semana) rechazado', /no trabaja/i.test(r), r);
  }
  await send(ph5, 'salir');
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 3: BUG DE MOTIVO — PRUEBAS DE REGRESIÓN
// ══════════════════════════════════════════════════════════════════════════════
async function grupoBugMotivo() {
  console.log('\n🔧 GRUPO 3: REGRESIÓN — BUG DEL MOTIVO');

  /** Lleva al paciente hasta PIDIENDO_MOTIVO */
  async function llegarAMotivo(phone, fecha, hora) {
    await send(phone, 'agendar');
    await send(phone, fecha);
    await send(phone, hora);
    await send(phone, 'si');  // confirmar cita
    await send(phone, 'no');  // no primera visita → pide motivo
  }

  // 3.1 Motivo normal largo — no escapa
  const ph1 = freshPhone();
  await registrar(ph1, 'Ana Bello', '1 de enero de 1990');
  await llegarAMotivo(ph1, '15 de junio', '10am');
  let r = await send(ph1, 'me duele mucho el estomago desde hace una semana');
  check('MOT-01', 'Motivo largo → cita completada (no escapa)', /listo/i.test(r), r);
  const c1 = getActiveCitas(ph1)[0];
  check('MOT-02', 'Motivo guardado en BD', /estomago/i.test(c1?.motivo_consulta || ''), c1?.motivo_consulta);

  // 3.2 Motivo con "no" al inicio — ANTES escapaba, ahora NO
  const ph2 = freshPhone();
  await registrar(ph2, 'Carlos Vega', '5 de mayo de 1985');
  await llegarAMotivo(ph2, '16 de junio', '10am');
  r = await send(ph2, 'no puedo dormir bien');
  check('MOT-03', '"no puedo dormir bien" → guarda motivo (NO escapa)', /listo/i.test(r), r);
  const c2 = getActiveCitas(ph2)[0];
  check('MOT-04', 'Motivo "no puedo dormir bien" guardado', /dormir/i.test(c2?.motivo_consulta || ''), c2?.motivo_consulta);

  // 3.3 "no como bien" — corto con "no" — antes escapaba
  const ph3 = freshPhone();
  await registrar(ph3, 'Elena Torres', '20 de agosto de 1993');
  await llegarAMotivo(ph3, '17 de junio', '10am');
  r = await send(ph3, 'no como bien');
  check('MOT-05', '"no como bien" → guarda motivo (NO escapa)', /listo/i.test(r), r);
  const c3 = getActiveCitas(ph3)[0];
  check('MOT-06', 'Motivo "no como bien" en BD', /como/i.test(c3?.motivo_consulta || ''), c3?.motivo_consulta);

  // 3.4 "salir" en PIDIENDO_MOTIVO → SÍ escapa (escape explícito válido)
  const ph4 = freshPhone();
  await registrar(ph4, 'Diego Moreno', '7 de julio de 1991');
  await llegarAMotivo(ph4, '18 de junio', '10am');
  r = await send(ph4, 'salir');
  check('MOT-07', '"salir" en PIDIENDO_MOTIVO → escapa al menú', /agendar/i.test(r), r);
  const s4 = getSession(ph4);
  check('MOT-08', 'Sesión en idle después de "salir"', s4?.estado_flujo === 'idle', s4?.estado_flujo);

  // 3.5 "omitir" → cita confirmada sin motivo
  const ph5 = freshPhone();
  await registrar(ph5, 'Patricia Ramos', '22 de abril de 1988');
  await llegarAMotivo(ph5, '22 de junio', '11am');
  r = await send(ph5, 'omitir');
  check('MOT-09', '"omitir" → cita confirmada sin motivo', /listo/i.test(r), r);
  const c5 = getActiveCitas(ph5)[0];
  check('MOT-10', 'motivo_consulta = null al omitir', !c5?.motivo_consulta, c5?.motivo_consulta);

  // 3.6 Motivo que parece fecha — no lo toma como reagendamiento
  const ph6 = freshPhone();
  await registrar(ph6, 'Sandra Lopez', '11 de noviembre de 1986');
  await llegarAMotivo(ph6, '23 de junio', '10am');
  r = await send(ph6, 'me duele desde el 15 de marzo');
  check('MOT-11', 'Motivo con fecha → guarda como motivo (no reagenda)', /listo/i.test(r), r);
  const c6 = getActiveCitas(ph6)[0];
  check('MOT-12', 'Motivo con fecha guardado', /duele/i.test(c6?.motivo_consulta || ''), c6?.motivo_consulta);

  // 3.7 Motivo muy corto "tos" (3 chars > 2) → se guarda
  const ph7 = freshPhone();
  await registrar(ph7, 'Jorge Meza', '14 de junio de 1994');
  await llegarAMotivo(ph7, '24 de junio', '11am');
  r = await send(ph7, 'tos');
  check('MOT-13', '"tos" (3 chars) → guarda como motivo', /listo/i.test(r), r);
  const c7 = getActiveCitas(ph7)[0];
  check('MOT-14', 'Motivo "tos" en BD', c7?.motivo_consulta === 'tos', c7?.motivo_consulta);

  // 3.8 Sesión expirada + cita_id_creada → recovery automático
  const ph8 = freshPhone();
  await registrar(ph8, 'Norma Pacheco', '8 de agosto de 1983');
  await llegarAMotivo(ph8, '25 de junio', '10am');
  // Simular expiración
  simularExpiracion(ph8);
  sesionRepo.limpiarInactivas(SESSION_TIMEOUT_MS);
  // Verificar: estado → idle, datos_temporales preservados
  const s8 = getSession(ph8);
  check('MOT-15', 'Estado → idle tras expiración', s8?.estado_flujo === 'idle', s8?.estado_flujo);
  const datos8 = getSesionDatos(ph8);
  check('MOT-16', 'cita_id_creada preservado tras expiración', !!datos8.cita_id_creada, JSON.stringify(datos8));
  // Paciente retoma: envía el motivo
  r = await send(ph8, 'me duele la cabeza');
  check('MOT-17', 'Recovery: motivo guardado tras timeout', /listo/i.test(r), r);
  const c8 = getActiveCitas(ph8)[0];
  check('MOT-18', 'Motivo en BD tras recovery', /cabeza/i.test(c8?.motivo_consulta || ''), c8?.motivo_consulta);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 4: NOTIFICACIONES AL MÉDICO
// ══════════════════════════════════════════════════════════════════════════════
async function grupoNotificaciones() {
  console.log('\n📬 GRUPO 4: NOTIFICACIONES AL MÉDICO');

  const ph1 = freshPhone();
  await registrar(ph1, 'Camila Rios', '5 de mayo de 1996');

  // 4.1 Nueva cita → médico recibe "NUEVA CITA AGENDADA"
  clearNotifs();
  await send(ph1, 'agendar');
  await send(ph1, '22 de junio');
  await send(ph1, '10am');
  await send(ph1, 'si');
  await send(ph1, 'no');
  await send(ph1, 'fiebre alta');

  const notifsNueva = getNotifsByPattern(/NUEVA CITA AGENDADA/);
  check('NOT-01', 'Médico recibe "NUEVA CITA AGENDADA"', notifsNueva.length >= 1, notifsNueva.length);
  if (notifsNueva.length > 0) {
    check('NOT-02', 'Notif incluye nombre del paciente', /camila/i.test(notifsNueva[0].txt), notifsNueva[0].txt.substring(0, 100));
    check('NOT-03', 'Notif va al teléfono del médico', notifsNueva[0].tel === DOCTOR_PHONE, `${notifsNueva[0].tel} vs ${DOCTOR_PHONE}`);
  }

  // 4.2 Reporte pre-consulta con motivo → segundo mensaje al médico
  const notifsReporte = getNotifsByPattern(/REPORTE PRE-CONSULTA/);
  check('NOT-04', 'Médico recibe reporte pre-consulta', notifsReporte.length >= 1, notifsReporte.length);
  if (notifsReporte.length > 0) {
    check('NOT-05', 'Reporte incluye motivo "fiebre"', /fiebre/i.test(notifsReporte[0].txt), notifsReporte[0].txt.substring(0, 200));
    check('NOT-06', 'Reporte incluye nombre paciente', /camila/i.test(notifsReporte[0].txt), notifsReporte[0].txt.substring(0, 100));
  }

  // 4.3 Reagendamiento → "CITA REAGENDADA"
  clearNotifs();
  await send(ph1, 'cambiar mi cita');
  await send(ph1, '23 de junio');
  await send(ph1, '4pm');
  await send(ph1, 'si');
  await send(ph1, 'no');
  await send(ph1, 'seguimiento');
  const notifsReagend = getNotifsByPattern(/CITA REAGENDADA/);
  check('NOT-07', 'Médico recibe "CITA REAGENDADA"', notifsReagend.length >= 1, notifsReagend.length);

  // 4.4 Cancelación → "CITA CANCELADA"
  clearNotifs();
  await send(ph1, 'cancelar mi cita');
  await send(ph1, 'si');
  const notifsCancel = getNotifsByPattern(/CITA CANCELADA/);
  check('NOT-08', 'Médico recibe "CITA CANCELADA"', notifsCancel.length >= 1, notifsCancel.length);

  // 4.5 Omitir motivo → reporte igual se envía (sin campo Motivo)
  const ph2 = freshPhone();
  await registrar(ph2, 'Ivan Soto', '13 de abril de 1993');
  clearNotifs();
  await send(ph2, 'agendar');
  await send(ph2, '24 de junio');
  await send(ph2, '9am');
  await send(ph2, 'si');
  await send(ph2, 'no');
  await send(ph2, 'omitir');
  const notifsOmit = getNotifsByPattern(/NUEVA CITA AGENDADA|REPORTE PRE/);
  check('NOT-09', 'Notificaciones enviadas incluso al omitir motivo', notifsOmit.length >= 1, notifsOmit.length);

  // 4.6 Escalación → médico recibe alerta
  clearNotifs();
  await send(ph2, 'emergencia');
  const notifsEsc = getNotifsByPattern(/PACIENTE SOLICITA|ATENCI/i);
  check('NOT-10', 'Médico recibe alerta de escalación', notifsEsc.length >= 1, notifsEsc.length);

  // 4.7 Cancelar todas → notif por cada cita cancelada
  const ph3 = freshPhone();
  await registrar(ph3, 'Federico Luna', '7 de julio de 1980');
  await agendarCompleto(ph3, '25 de junio', '9am', 'no ya he venido', 'cita1');
  await agendarCompleto(ph3, '26 de junio', '9am', 'no ya he venido', 'cita2');
  clearNotifs();
  await send(ph3, 'cancelar todas mis citas');
  await send(ph3, 'si');
  const notifsAll = getNotifsByPattern(/CITA CANCELADA|Cancelaci[oó]n de citas/i);
  check('NOT-11', 'Cancelación masiva → médico notificado', notifsAll.length >= 1, notifsAll.length);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 5: REAGENDAMIENTO COLOQUIAL
// ══════════════════════════════════════════════════════════════════════════════
async function grupoReagendamiento() {
  console.log('\n🔄 GRUPO 5: REAGENDAMIENTO');

  const ph1 = freshPhone();
  await registrar(ph1, 'Sandra Gutierrez', '20 de mayo de 1986');
  await agendarCompleto(ph1, '22 de junio', '10am', 'no ya he venido', 'consulta general');

  const citaAntes = getActiveCitas(ph1)[0];
  const calIdAntes = citaAntes?.google_calendar_event_id;

  // 5.1 "le puedo mover a mi cita"
  let r = await send(ph1, 'le puedo mover a mi cita');
  check('REA-01', '"le puedo mover" = reagendar', /reagend|fecha/i.test(r), r);

  r = await send(ph1, '29 de junio');
  check('REA-02', 'Nueva fecha aceptada, pide hora', /hora/i.test(r), r);

  r = await send(ph1, '4pm');
  check('REA-03', 'Hora aceptada → confirmación', /confirma/i.test(r), r);

  await send(ph1, 'si');
  await send(ph1, 'no');
  r = await send(ph1, 'seguimiento general');
  check('REA-04', 'Reagendamiento completado', /listo/i.test(r), r);

  const citaDespues = getActiveCitas(ph1)[0];
  check('REA-05', 'Nueva cita en BD', !!citaDespues, 'no cita');
  check('REA-06', 'Calendar ID cambió', citaDespues?.google_calendar_event_id !== calIdAntes, citaDespues?.google_calendar_event_id);

  const citaVieja = getAllCitas(ph1).find(c => c.id === citaAntes.id);
  check('REA-07', 'Cita anterior marcada como cancelada', citaVieja?.estado === 'cancelada', citaVieja?.estado);

  // 5.2 "se me complicó, puedo ir otro día"
  const ph2 = freshPhone();
  await registrar(ph2, 'Roberto Diaz', '15 de julio de 1990');
  await agendarCompleto(ph2, '29 de junio', '11am', 'no ya he venido', 'dolor');

  r = await send(ph2, 'se me complico, puedo ir otro dia');
  check('REA-08', '"se me complico" = reagendar', /reagend|fecha/i.test(r), r);
  await send(ph2, 'salir');

  // 5.3 Reagendar sin citas activas
  const ph3 = freshPhone();
  await registrar(ph3, 'Monica Vela', '28 de agosto de 1991');
  r = await send(ph3, 'quiero cambiar mi cita');
  check('REA-09', 'Reagendar sin citas → informa que no hay', /no tienes|no.*cita/i.test(r), r);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 6: CANCELACIÓN AVANZADA
// ══════════════════════════════════════════════════════════════════════════════
async function grupoCancelacion() {
  console.log('\n❌ GRUPO 6: CANCELACIÓN');

  // 6.1 "ya no voy a poder ir" → inicia cancelación
  const ph1 = freshPhone();
  await registrar(ph1, 'Alejandro Fuentes', '12 de marzo de 1984');
  await agendarCompleto(ph1, '1 de julio', '9am', 'no ya he venido', 'tos');

  let r = await send(ph1, 'ya no voy a poder ir');
  check('CAN-01', '"ya no voy a poder ir" = cancelar', /confirmas/i.test(r), r);

  // "nel" = no cancelo → cita sigue activa
  r = await send(ph1, 'nel');
  check('CAN-02', '"nel" = no cancelo', /sigue en pie/i.test(r), r);
  check('CAN-03', 'Cita sigue activa tras "nel"', getActiveCitas(ph1).length === 1, getActiveCitas(ph1).length);

  // 6.2 "chale ya no puedo ir" → vuelve a iniciar cancelación
  r = await send(ph1, 'chale ya no puedo ir');
  check('CAN-04', '"chale ya no puedo" = cancelar', /confirmas/i.test(r), r);

  clearNotifs();
  r = await send(ph1, 'si');
  check('CAN-05', 'Confirmación con "si" cancela cita', /cancelada/i.test(r), r);
  check('CAN-06', 'Cita en BD con estado cancelada', getActiveCitas(ph1).length === 0, getActiveCitas(ph1).length);

  // Notificación al médico
  const notifsC = getNotifsByPattern(/CITA CANCELADA/);
  check('CAN-07', 'Médico notificado de cancelación', notifsC.length >= 1, notifsC.length);

  // 6.3 Cancelar todas (3 citas)
  const ph2 = freshPhone();
  await registrar(ph2, 'Francisco Ramos', '4 de abril de 1979');
  await agendarCompleto(ph2, '2 de julio', '9am', 'no ya he venido', 'c1');
  await agendarCompleto(ph2, '3 de julio', '10am', 'no ya he venido', 'c2');
  await agendarCompleto(ph2, '7 de julio', '11am', 'no ya he venido', 'c3');

  check('CAN-08', '3 citas activas antes de cancelar', getActiveCitas(ph2).length === 3, getActiveCitas(ph2).length);

  r = await send(ph2, 'cancelar todas mis citas');
  check('CAN-09', 'Pide confirmación para cancelar todas', /todas.*\d/i.test(r), r);

  r = await send(ph2, 'si');
  check('CAN-10', 'Todas canceladas', getActiveCitas(ph2).length === 0, getActiveCitas(ph2).length);

  // 6.4 Cancelar específica (1 de 2)
  const ph3 = freshPhone();
  await registrar(ph3, 'Isabel Ortiz', '17 de diciembre de 1993');
  await agendarCompleto(ph3, '8 de julio', '12pm', 'no ya he venido', 'rev1');
  await agendarCompleto(ph3, '9 de julio', '12pm', 'no ya he venido', 'rev2');

  r = await send(ph3, 'cancelar mi cita');
  check('CAN-11', 'Lista para elegir cuál cancelar', /cu[aá]l.*cancelar|\d\./i.test(r), r);

  r = await send(ph3, '1');
  check('CAN-12', 'Pide confirmación de la cita 1', /confirmas/i.test(r), r);

  r = await send(ph3, 'si');
  check('CAN-13', 'Cita 1 cancelada exitosamente', /cancelada/i.test(r), r);
  check('CAN-14', 'Solo 1 cita activa queda', getActiveCitas(ph3).length === 1, getActiveCitas(ph3).length);

  // 6.5 Cancelar sin citas
  const ph4 = freshPhone();
  await registrar(ph4, 'Daniela Vargas', '9 de septiembre de 1998');
  r = await send(ph4, 'cancelar mi cita');
  check('CAN-15', 'Cancelar sin citas → informa "no tienes citas"', /no tienes citas/i.test(r), r);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 7: ASISTENCIA DEL DOCTOR
// ══════════════════════════════════════════════════════════════════════════════
async function grupoAsistencia() {
  console.log('\n🏥 GRUPO 7: ASISTENCIA DEL DOCTOR');

  const db = getDb();
  const medico = medicoRepo.findActivos()[0];

  // 7.1 Cita que "empezó hace 20 min" → findPendientesAsistencia la detecta
  const ph1 = freshPhone();
  await registrar(ph1, 'Mariana Olvera', '14 de julio de 1992');
  const p1 = getPatient(ph1);
  const hace20 = new Date(Date.now() - 20 * 60_000);
  const citaId1 = db.prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado)
    VALUES (?, ?, ?, 30, 'programada')
  `).run(p1.id, medico.id, toSqliteDateTime(hace20)).lastInsertRowid;

  const pendientes = citaRepo.findPendientesAsistencia();
  check('ASI-01', 'Cita 20 min después detectada', pendientes.some(c => c.id === citaId1), pendientes.map(c => c.id));

  // 7.2 Marcar como preguntada → desaparece de pendientes
  citaRepo.marcarAsistenciaPreguntada(citaId1);
  check('ASI-02', 'Ya no aparece en pendientes tras marcar', !citaRepo.findPendientesAsistencia().some(c => c.id === citaId1), false);

  // 7.3 findPendienteRespuestaDoctor la encuentra
  const pendDoc = citaRepo.findPendienteRespuestaDoctor();
  check('ASI-03', 'findPendienteRespuestaDoctor la encuentra', pendDoc?.id === citaId1, pendDoc?.id);

  // 7.4 Doctor responde "si" → estado completada
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);
  let r = await send(DOCTOR_PHONE, 'si');
  check('ASI-04', 'Doctor confirma asistencia', /asistió|asistio|registrado/i.test(r), r);
  const ca = db.prepare('SELECT * FROM citas WHERE id = ?').get(citaId1);
  check('ASI-05', 'Estado → completada', ca.estado === 'completada', ca.estado);

  // 7.5 Doctor responde "no" → estado no_asistio
  const ph2 = freshPhone();
  await registrar(ph2, 'Luis Herrera', '3 de noviembre de 1985');
  const p2 = getPatient(ph2);
  const hace25 = new Date(Date.now() - 25 * 60_000);
  const citaId2 = db.prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado)
    VALUES (?, ?, ?, 30, 'programada')
  `).run(p2.id, medico.id, toSqliteDateTime(hace25)).lastInsertRowid;

  citaRepo.marcarAsistenciaPreguntada(citaId2);
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);
  r = await send(DOCTOR_PHONE, 'no');
  check('ASI-06', 'Doctor registra no asistencia', /no asistió|no asistio|registrado/i.test(r), r);
  const cn = db.prepare('SELECT * FROM citas WHERE id = ?').get(citaId2);
  check('ASI-07', 'Estado → no_asistio', cn.estado === 'no_asistio', cn.estado);

  // 7.6 Respuesta ambigua → re-pregunta, estado sin cambiar
  const ph3 = freshPhone();
  await registrar(ph3, 'Ana Belen Cruz', '1 de enero de 2000');
  const p3 = getPatient(ph3);
  const hace15 = new Date(Date.now() - 15 * 60_000);
  const citaId3 = db.prepare(`
    INSERT INTO citas (paciente_id, medico_id, fecha_hora, duracion_min, estado)
    VALUES (?, ?, ?, 30, 'programada')
  `).run(p3.id, medico.id, toSqliteDateTime(hace15)).lastInsertRowid;

  citaRepo.marcarAsistenciaPreguntada(citaId3);
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);
  r = await send(DOCTOR_PHONE, 'ahorita checo');
  check('ASI-08', 'Respuesta ambigua → re-pregunta', /sí|si.*no|lleg[oó]/i.test(r), r);
  const cs = db.prepare('SELECT * FROM citas WHERE id = ?').get(citaId3);
  check('ASI-09', 'Estado sin cambiar con respuesta ambigua', cs.estado === 'programada', cs.estado);

  // Limpiar: responder correctamente
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);
  await send(DOCTOR_PHONE, 'si');

  // 7.7 Doctor sin citas pendientes → ignorado
  db.prepare('DELETE FROM sesiones WHERE telefono = ?').run(DOCTOR_PHONE);
  r = await send(DOCTOR_PHONE, 'hola');
  check('ASI-10', 'Sin pendientes → doctor ignorado (null)', r === '[null]', r);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 8: EDGE CASES DE FECHAS Y HORAS
// ══════════════════════════════════════════════════════════════════════════════
async function grupoFechasHoras() {
  console.log('\n🕐 GRUPO 8: FECHAS Y HORAS — EDGE CASES');

  const ph = freshPhone();
  await registrar(ph, 'Prueba Fechas', '1 de enero de 1990');

  // "mañana" (si no es domingo)
  await send(ph, 'agendar');
  let r = await send(ph, 'mañana');
  const manana = new Date(); manana.setDate(manana.getDate() + 1);
  if (manana.getDay() !== 0 && manana.getDay() !== 6) {
    check('FH-01', '"mañana" pide hora', /hora/i.test(r), r);
  } else {
    check('FH-01', '"mañana" (fin de semana) rechazado', /no trabaja/i.test(r), r);
  }
  await send(ph, 'salir');

  // Fecha en el pasado rechazada
  await send(ph, 'agendar');
  r = await send(ph, '1 de enero de 2025');
  check('FH-02', 'Fecha pasada rechazada', /pas[oó]/i.test(r), r);

  // Domingo rechazado — calcular próximo domingo dinámicamente
  const hoy = new Date();
  const dias = ['domingo','lunes','martes','miercoles','jueves','viernes','sabado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const diasHastaDom = (7 - hoy.getDay()) % 7 || 7;
  const domingo = new Date(hoy); domingo.setDate(hoy.getDate() + diasHastaDom);
  r = await send(ph, `${domingo.getDate()} de ${meses[domingo.getMonth()]}`);
  check('FH-03', 'Domingo rechazado como día laboral', /no trabaja/i.test(r), r);

  // Martes válido, hora 7am rechazada
  r = await send(ph, '9 de junio');  // martes
  r = await send(ph, '7am');
  check('FH-04', '7am rechazado (antes de apertura)', /horario/i.test(r), r);
  await send(ph, 'salir');  // reset

  // 3pm válido (no hay pausa de comida — horario 8:00 a 20:00)
  await send(ph, 'agendar');
  await send(ph, '9 de junio');
  r = await send(ph, '3pm');
  check('FH-05', '3pm válido (sin pausa de comida) → confirmación', /confirma/i.test(r), r);
  await send(ph, 'no');  // cancel

  // Hora válida 10am
  await send(ph, 'agendar');
  await send(ph, '9 de junio');
  r = await send(ph, '10am');
  check('FH-06', '10am aceptado → confirmación', /confirma/i.test(r), r);
  await send(ph, 'no');

  // "5 de la tarde" = 17:00 PM
  await send(ph, 'agendar');
  await send(ph, '9 de junio');
  r = await send(ph, '5 de la tarde');
  check('FH-07', '"5 de la tarde" = 5:00 PM', /5:00\s*PM/i.test(r), r);
  await send(ph, 'no');

  // "mediodía" = 12:00 PM
  await send(ph, 'agendar');
  await send(ph, '9 de junio');
  r = await send(ph, 'mediodia');
  check('FH-08', '"mediodía" = 12:00 PM', /12:00\s*PM/i.test(r), r);
  await send(ph, 'no');

  // "3 y media de la tarde" = 3:30 PM
  await send(ph, 'agendar');
  await send(ph, '9 de junio');
  r = await send(ph, '3 y media de la tarde');
  check('FH-09', '"3 y media de la tarde" = 3:30 PM', /3:30\s*PM/i.test(r), r);
  await send(ph, 'no');

  // Doctor solo trabaja lun-vie: sábado rechazado
  const diasHastaSab = (6 - hoy.getDay() + 7) % 7 || 7;
  const sabado = new Date(hoy); sabado.setDate(hoy.getDate() + diasHastaSab);
  const sabFrase = `${sabado.getDate()} de ${meses[sabado.getMonth()]}`;

  await send(ph, 'agendar');
  r = await send(ph, sabFrase);
  check('FH-10', 'Sábado rechazado (doctor solo lun-vie)', /no trabaja/i.test(r), r);
  await send(ph, 'salir');

  // Hora 7pm = 19:00 (válida, límite antes de cierre 20:00)
  await send(ph, 'agendar');
  await send(ph, '9 de junio');
  r = await send(ph, '7pm');
  check('FH-11', '7pm = 19:00 aceptado (antes del cierre)', /confirma/i.test(r), r);
  await send(ph, 'no');

  // Hora 8pm = 20:00 rechazada (igual al cierre — exclusivo)
  await send(ph, 'agendar');
  await send(ph, '9 de junio');
  r = await send(ph, '8pm');
  check('FH-12', '8pm = 20:00 rechazado (límite exclusivo)', /horario/i.test(r), r);
  await send(ph, 'salir');
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 9: ESCAPE Y NAVEGACIÓN
// ══════════════════════════════════════════════════════════════════════════════
async function grupoEscape() {
  console.log('\n🚪 GRUPO 9: ESCAPE Y NAVEGACIÓN');

  const ph = freshPhone();
  await registrar(ph, 'Pablo Rios', '20 de febrero de 1991');

  // "salir" en flujo de agendar
  await send(ph, 'agendar');
  let r = await send(ph, 'salir');
  check('NAV-01', '"salir" regresa al menú', /agendar/i.test(r) && /pablo/i.test(r), r);
  check('NAV-02', 'Sesión en idle tras salir', getSession(ph)?.estado_flujo === 'idle', getSession(ph)?.estado_flujo);

  // "menu" dentro de flujo
  await send(ph, 'agendar');
  await send(ph, '10 de julio');
  r = await send(ph, 'menu');
  check('NAV-03', '"menu" regresa al menú principal', /pablo/i.test(r), r);

  // "volver"
  await send(ph, 'agendar');
  r = await send(ph, 'volver');
  check('NAV-04', '"volver" regresa al menú', /pablo/i.test(r), r);

  // "dejalo"
  await send(ph, 'agendar');
  r = await send(ph, 'dejalo');
  check('NAV-05', '"dejalo" regresa al menú', /pablo/i.test(r), r);

  // "mejor otro dia" en CONFIRMANDO_CITA → pide nueva fecha (no menú)
  await send(ph, 'agendar');
  await send(ph, '13 de julio');
  await send(ph, '10am');
  r = await send(ph, 'mejor otro dia');
  check('NAV-06', '"mejor otro dia" en confirmación → pide fecha', /fecha/i.test(r), r);
  await send(ph, 'salir');
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 10: DATOS DEL PACIENTE
// ══════════════════════════════════════════════════════════════════════════════
async function grupoDatosPaciente() {
  console.log('\n👤 GRUPO 10: DATOS DEL PACIENTE');

  const ph = freshPhone();
  await registrar(ph, 'Norma Acosta', '8 de agosto de 1983');

  // "mis datos" muestra info
  let r = await send(ph, 'mis datos');
  check('DAT-01', '"mis datos" muestra nombre', /norma/i.test(r), r);
  check('DAT-02', '"mis datos" muestra teléfono', new RegExp(ph).test(r), r);
  check('DAT-03', '"mis datos" muestra cumpleaños', /agosto/i.test(r), r);

  // Cambiar nombre via flujo
  r = await send(ph, 'cambiar mi nombre');
  check('DAT-04', 'Inicia flujo de cambio de nombre', /nombre correcto|escribe.*nombre/i.test(r), r);

  r = await send(ph, 'Norma Patricia Acosta Garcia');
  check('DAT-05', 'Nombre actualizado correctamente', /actualic.*norma/i.test(r), r);
  check('DAT-06', 'Nombre en BD actualizado', getPatient(ph)?.nombre === 'Norma Patricia Acosta Garcia', getPatient(ph)?.nombre);

  // Corrección inline de nombre
  r = await send(ph, 'mi nombre es Norma Acosta Ramirez');
  check('DAT-07', 'Corrección inline actualiza nombre', /actualic/i.test(r), r);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 11: ESCALACIÓN Y EMERGENCIAS
// ══════════════════════════════════════════════════════════════════════════════
async function grupoEscalacion() {
  console.log('\n🚨 GRUPO 11: ESCALACIÓN');

  // "emergencia" escala
  const ph1 = freshPhone();
  await registrar(ph1, 'Jorge Medina', '10 de enero de 1988');
  let r = await send(ph1, 'emergencia');
  check('EMR-01', '"emergencia" escala a humano', /paso con alguien|atienda/i.test(r), r);

  // En modo humano no responde
  r = await send(ph1, 'hola siguen ahi');
  check('EMR-02', 'En modo humano no responde (null)', r === '[null]', r);

  // "hablar con alguien"
  const ph2 = freshPhone();
  await registrar(ph2, 'Leticia Campos', '25 de noviembre de 1985');
  r = await send(ph2, 'quiero hablar con alguien');
  check('EMR-03', '"hablar con alguien" = escalar', /paso con alguien|atienda/i.test(r), r);

  // Frustración
  const ph3 = freshPhone();
  await registrar(ph3, 'Pedro Paramo', '1 de mayo de 1988');
  r = await send(ph3, 'ya me harte, esto no funciona');
  check('EMR-04', 'Frustración → escala', /paso con alguien|atienda/i.test(r), r);

  // Menú opción 4
  const ph4 = freshPhone();
  await registrar(ph4, 'Karla Mendoza', '6 de junio de 1990');
  await send(ph4, 'hola');
  r = await send(ph4, '4');
  check('EMR-05', 'Opción 4 = escalar', /paso con alguien|atienda/i.test(r), r);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 12: MULTIMEDIA Y EDGE CASES
// ══════════════════════════════════════════════════════════════════════════════
async function grupoMultimedia() {
  console.log('\n📱 GRUPO 12: MULTIMEDIA Y EDGE CASES');

  const ph = freshPhone();
  await registrar(ph, 'Camila Test', '5 de mayo de 1995');

  let r = await send(ph, '__MEDIA_NO_SOPORTADO__');
  check('MUL-01', 'Multimedia rechazado con mensaje amable', /solo.*texto/i.test(r), r);

  r = await send(ph, 'que horario tienen');
  check('MUL-02', 'Pregunta de horario → info de clínica', /horario|lunes/i.test(r), r);

  r = await send(ph, 'donde queda la clinica');
  check('MUL-03', 'Pregunta de ubicación → responde', /direcci|clinica/i.test(r), r);

  r = await send(ph, 'muchas gracias');
  check('MUL-04', '"gracias" → agradecimiento', /gusto/i.test(r), r);

  r = await send(ph, 'adios');
  check('MUL-05', '"adios" → despedida', /luego|d[ií]a/i.test(r), r);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 13: CONCURRENCIA — 5 PACIENTES INTERCALADOS
// ══════════════════════════════════════════════════════════════════════════════
async function grupoConcurrencia() {
  console.log('\n⚡ GRUPO 13: CONCURRENCIA — 5 PACIENTES SIMULTÁNEOS');

  const ph = [freshPhone(), freshPhone(), freshPhone(), freshPhone(), freshPhone()];
  const nombres  = ['Dona Maria Gonzalez', 'Chuy Hernandez', 'Eduardo Reyes', 'Carmen Juarez', 'Karla Soto'];
  const cumples  = ['1 de enero de 1950', '15 de marzo de 2001', '7 de julio de 1975', '25 de diciembre de 1945', '10 de octubre de 1993'];
  const fechas   = ['7 de julio', '8 de julio', '9 de julio', '10 de julio', '13 de julio'];
  const horas    = ['10am', '11am', '9am', '4pm', '10am'];
  const motivos  = ['dolor de rodillas', 'revision anual', 'chequeo general', 'presion alta', 'migrana'];

  // Ronda 1: Todos saludan simultáneamente → piden consentimiento
  const saludos = await Promise.all(ph.map(p => send(p, 'hola')));
  for (let i = 0; i < 5; i++) {
    check(`CON-${i+1}a`, `Paciente ${i+1} saludo → pide consentimiento`, /aceptas|aviso/i.test(saludos[i]), saludos[i].substring(0, 80));
  }

  // Ronda 1b: Todos aceptan aviso LFPDPPP
  await Promise.all(ph.map(p => send(p, 'sí')));

  // Ronda 2: Todos dan nombre
  const rNombres = await Promise.all(ph.map((p, i) => send(p, nombres[i])));
  for (let i = 0; i < 5; i++) {
    check(`CON-${i+1}b`, `Paciente ${i+1} nombre aceptado`, /mucho gusto/i.test(rNombres[i]), rNombres[i].substring(0, 80));
  }

  // Ronda 3: Todos dan cumpleaños
  const rCumples = await Promise.all(ph.map((p, i) => send(p, cumples[i])));
  for (let i = 0; i < 5; i++) {
    check(`CON-${i+1}c`, `Paciente ${i+1} registrado`, /registrad/i.test(rCumples[i]), rCumples[i].substring(0, 80));
  }

  // Verificar BD: cada uno tiene estado activo
  for (let i = 0; i < 5; i++) {
    const p = getPatient(ph[i]);
    check(`CON-${i+1}d`, `Paciente ${i+1} → estado activo en BD`, p?.estado === 'activo', p?.estado);
  }

  // Ronda 4: Todos agendan intercalado
  await Promise.all(ph.map(p => send(p, 'agendar')));
  await Promise.all(ph.map((p, i) => send(p, fechas[i])));
  await Promise.all(ph.map((p, i) => send(p, horas[i])));
  await Promise.all(ph.map(p => send(p, 'si')));
  await Promise.all(ph.map(p => send(p, 'no')));
  const rMotivos = await Promise.all(ph.map((p, i) => send(p, motivos[i])));

  // Verificar que cada paciente terminó su flujo
  for (let i = 0; i < 5; i++) {
    check(`CON-${i+1}e`, `Paciente ${i+1} completó agendamiento`, /listo/i.test(rMotivos[i]), rMotivos[i].substring(0, 80));
  }

  // Verificar citas en BD — sin mezcla de datos
  for (let i = 0; i < 5; i++) {
    const citas = getActiveCitas(ph[i]);
    check(`CON-${i+1}f`, `Paciente ${i+1} tiene 1 cita activa`, citas.length === 1, citas.length);
  }

  for (let i = 0; i < 5; i++) {
    const citas = getActiveCitas(ph[i]);
    if (citas.length > 0) {
      const primeraPalabra = motivos[i].split(' ')[0];
      check(`CON-${i+1}g`, `Paciente ${i+1} tiene motivo correcto (sin mezcla)`,
        new RegExp(primeraPalabra, 'i').test(citas[0]?.motivo_consulta || ''), citas[0]?.motivo_consulta);
    }
  }

  // Verificar que sesiones están en idle (flujo completado limpiamente)
  for (let i = 0; i < 5; i++) {
    const s = getSession(ph[i]);
    check(`CON-${i+1}h`, `Sesión paciente ${i+1} en idle`, s?.estado_flujo === 'idle', s?.estado_flujo);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 14: TIMEOUT Y RECUPERACIÓN DE SESIÓN
// ══════════════════════════════════════════════════════════════════════════════
async function grupoTimeout() {
  console.log('\n⏰ GRUPO 14: TIMEOUT Y RECUPERACIÓN');

  // 14.1 limpiarInactivas → idle pero preserva datos_temporales
  const ph1 = freshPhone();
  await registrar(ph1, 'Timeout Uno', '1 de febrero de 1990');
  await send(ph1, 'agendar');
  await send(ph1, '14 de julio');
  await send(ph1, '10am');
  await send(ph1, 'si');  // confirmar → cita_id_creada ya existe
  await send(ph1, 'no');  // → estado PIDIENDO_MOTIVO

  const datosAntes = getSesionDatos(ph1);
  check('TMO-01', 'cita_id_creada existe antes del timeout', !!datosAntes.cita_id_creada, JSON.stringify(datosAntes));
  check('TMO-02', 'Estado es pidiendo_motivo', getSession(ph1)?.estado_flujo === 'pidiendo_motivo', getSession(ph1)?.estado_flujo);

  // Simular expiración y limpiar
  simularExpiracion(ph1);
  sesionRepo.limpiarInactivas(SESSION_TIMEOUT_MS);

  check('TMO-03', 'Estado → idle tras limpiarInactivas', getSession(ph1)?.estado_flujo === 'idle', getSession(ph1)?.estado_flujo);

  const datosDespues = getSesionDatos(ph1);
  check('TMO-04', 'datos_temporales.cita_id_creada PRESERVADO', !!datosDespues.cita_id_creada, JSON.stringify(datosDespues));

  // Paciente retoma con motivo → recovery automático
  const r = await send(ph1, 'me duele el estomago mucho');
  check('TMO-05', 'Recovery: bot acepta motivo tras expiración', /listo/i.test(r), r);

  const citas = getActiveCitas(ph1);
  check('TMO-06', 'Motivo guardado tras recovery', /estomago/i.test(citas[0]?.motivo_consulta || ''), citas[0]?.motivo_consulta);

  // 14.2 Sesión expirada sin cita pendiente → no hay recovery
  const ph2 = freshPhone();
  await registrar(ph2, 'Timeout Dos', '1 de marzo de 1990');
  await send(ph2, 'agendar');
  // Solo pidió agendar, no llegó a crear cita
  simularExpiracion(ph2);
  sesionRepo.limpiarInactivas(SESSION_TIMEOUT_MS);

  check('TMO-07', 'Sesión sin cita → idle tras timeout', getSession(ph2)?.estado_flujo === 'idle', getSession(ph2)?.estado_flujo);
  check('TMO-08', 'Sin cita_id_creada → no hay recovery', !getSesionDatos(ph2).cita_id_creada, JSON.stringify(getSesionDatos(ph2)));
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 15: FLUJO E2E COMPLETO — "LA DOÑA MARIA"
// ══════════════════════════════════════════════════════════════════════════════
async function grupoE2E() {
  console.log('\n🎯 GRUPO 15: FLUJO E2E — "LA DOÑA MARIA"');

  const ph = freshPhone();

  // Primer contacto → aviso LFPDPPP
  let r = await send(ph, 'buenas tardes, alguien me paso este numero');
  check('E2E-01', 'Primer contacto pide consentimiento LFPDPPP', /aceptas|aviso/i.test(r), r);

  await send(ph, 'sí');  // aceptar aviso → ahora pide nombre
  r = await send(ph, 'me llamo Maria de los Angeles Gutierrez Perez');
  check('E2E-02', 'Nombre largo aceptado', /mucho gusto.*maria/i.test(r), r);

  r = await send(ph, '20 de octubre de 1958');
  check('E2E-03', 'Registro completo', /registrad/i.test(r), r);
  check('E2E-04', 'Paciente en BD activo', getPatient(ph)?.estado === 'activo', getPatient(ph)?.estado);

  // Agenda cita con lenguaje coloquial
  r = await send(ph, 'quiero una cita con el doctor');
  check('E2E-05', '"quiero una cita" inicia agendamiento', /fecha/i.test(r), r);

  r = await send(ph, '15 de julio');
  check('E2E-06', 'Fecha 15 de julio aceptada', /hora/i.test(r), r);

  r = await send(ph, '10 de la manana');
  check('E2E-07', '"10 de la mañana" = 10:00 AM → confirmación', /confirma/i.test(r), r);

  clearNotifs();  // capturar notificaciones desde aquí
  r = await send(ph, 'si confirmamos');
  check('E2E-08', '"si confirmamos" = confirmar_si → pide primera visita', /primera visita/i.test(r), r);

  r = await send(ph, 'si es mi primera vez que vengo');
  check('E2E-09', 'Primera visita reconocida', /motivo/i.test(r), r);

  r = await send(ph, 'ando con dolores de rodillas y tambien me duele la espalda');
  check('E2E-10', 'Motivo coloquial aceptado → cita completada', /listo/i.test(r), r);

  let citas = getActiveCitas(ph);
  check('E2E-11', 'Cita en BD', citas.length === 1, citas.length);
  check('E2E-12', 'Motivo guardado correctamente', /rodillas/i.test(citas[0]?.motivo_consulta || ''), citas[0]?.motivo_consulta);
  check('E2E-13', 'Primera visita = 1', citas[0]?.primera_visita === 1, citas[0]?.primera_visita);

  // Notificaciones
  check('E2E-14', 'Médico recibió notif nueva cita', getNotifsByPattern(/NUEVA CITA AGENDADA/).length >= 1, getNotifsByPattern(/NUEVA CITA AGENDADA/).length);
  check('E2E-15', 'Médico recibió reporte pre-consulta', getNotifsByPattern(/REPORTE PRE-CONSULTA/).length >= 1, getNotifsByPattern(/REPORTE PRE-CONSULTA/).length);

  const calId1 = citas[0]?.google_calendar_event_id;

  // Consulta su cita
  r = await send(ph, 'cuando es mi cita');
  check('E2E-16', 'Consulta muestra cita', /julio/i.test(r), r);

  // Se le complicó → reagenda
  r = await send(ph, 'fijese que se me complico ese dia, puedo ir otro dia?');
  check('E2E-17', '"se me complico" = reagendar', /reagend|fecha/i.test(r), r);

  await send(ph, '16 de julio');
  await send(ph, '11am');
  await send(ph, 'si');
  await send(ph, 'no');
  r = await send(ph, 'lo mismo las rodillas');
  check('E2E-18', 'Reagendamiento completado', /listo/i.test(r), r);

  citas = getActiveCitas(ph);
  check('E2E-19', 'Solo 1 cita activa tras reagendar', citas.length === 1, citas.length);
  check('E2E-20', 'Nuevo Calendar ID (distinto al original)', citas[0]?.google_calendar_event_id !== calId1, citas[0]?.google_calendar_event_id);

  // Agenda segunda cita
  r = await send(ph, 'agendar otra cita');
  check('E2E-21', 'Inicia segunda cita', /fecha/i.test(r), r);
  await send(ph, '17 de julio');
  await send(ph, '10am');
  await send(ph, 'si');
  await send(ph, 'no');
  r = await send(ph, 'seguimiento');
  check('E2E-22', 'Segunda cita agendada', /listo/i.test(r), r);

  citas = getActiveCitas(ph);
  check('E2E-23', '2 citas activas', citas.length === 2, citas.length);

  // Cancela la primera
  r = await send(ph, 'cancelar mi cita');
  check('E2E-24', 'Lista de citas para cancelar', /cu[aá]l.*cancelar|\d\./i.test(r), r);

  r = await send(ph, '1');
  check('E2E-25', 'Confirma cancelar cita 1', /confirmas/i.test(r), r);

  r = await send(ph, 'si');
  check('E2E-26', 'Cita 1 cancelada', /cancelada/i.test(r), r);
  check('E2E-27', '1 cita activa restante', getActiveCitas(ph).length === 1, getActiveCitas(ph).length);

  // Ver datos y despedirse
  r = await send(ph, 'mis datos');
  check('E2E-28', '"mis datos" muestra info de La Doña', /maria/i.test(r), r);

  r = await send(ph, 'muchas gracias, hasta luego');
  check('E2E-29', 'Despedida reconocida', /luego|gusto|d[ií]a/i.test(r), r);
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 16: TYPOS Y VARIANTES REALES DE ESCRITURA
// ══════════════════════════════════════════════════════════════════════════════
async function grupoTypos() {
  console.log('\n✏️  GRUPO 16: TYPOS Y VARIANTES DE ESCRITURA');

  const ph = freshPhone();
  await registrar(ph, 'Typos Test', '1 de abril de 1990');

  // "necesito sita" (sita = cita)
  let r = await send(ph, 'necesito sita');
  check('TYP-01', '"necesito sita" = agendar (sita aceptado)', /fecha/i.test(r), r);
  await send(ph, 'salir');

  // "agendar sita"
  r = await send(ph, 'agendar sita');
  check('TYP-02', '"agendar sita" = agendar', /fecha/i.test(r), r);
  await send(ph, 'salir');

  // "sii" como confirmación (doble i)
  await send(ph, 'agendar');
  await send(ph, '20 de julio');
  await send(ph, '10am');
  r = await send(ph, 'sii');
  check('TYP-03', '"sii" acepta como confirmar_si', /primera visita/i.test(r), r);
  await send(ph, 'no');
  r = await send(ph, 'dolor');
  check('TYP-04', 'Cita con "sii" completada', /listo/i.test(r), r);

  // "GRACIAS" en mayúsculas (normalización)
  r = await send(ph, 'GRACIAS');
  check('TYP-05', '"GRACIAS" mayúsculas reconocido', /gusto/i.test(r), r);

  // Menú desde "hola" en mayúsculas
  r = await send(ph, 'HOLA');
  check('TYP-06', '"HOLA" mayúsculas reconocido como saludo', /agendar/i.test(r), r);

  // "cancelar" solo (una palabra)
  const ph2 = freshPhone();
  await registrar(ph2, 'Test Cancelar Solo', '5 de mayo de 1990');
  await agendarCompleto(ph2, '21 de julio', '10am', 'no ya he venido', 'test');
  r = await send(ph2, 'cancelar');
  check('TYP-07', '"cancelar" solo = intent cancelar', /confirmas/i.test(r), r);
  await send(ph2, 'no'); // abortar
}

// ══════════════════════════════════════════════════════════════════════════════
// GRUPO 17: COMPLIANCE LFPDPPP — CONSENTIMIENTO Y DERECHO ARCO
// ══════════════════════════════════════════════════════════════════════════════
async function grupoCompliance() {
  console.log('\n🔒 GRUPO 17: COMPLIANCE LFPDPPP (consentimiento + baja ARCO)');

  // 17.1 Primer contacto pide aviso de privacidad con sí/no
  const ph1 = freshPhone();
  let r = await send(ph1, 'hola');
  check('CMP-01', 'Primer contacto presenta aviso LFPDPPP', /aceptas.*aviso|aviso.*privacidad|consentimiento/i.test(r), r.substring(0, 120));
  check('CMP-02', 'Aviso incluye URL', /aviso[- ]privacidad|http/i.test(r), r.substring(0, 120));

  // 17.2 Respuesta ambigua → re-pregunta sin avanzar
  r = await send(ph1, 'a lo mejor');
  check('CMP-03', 'Respuesta ambigua → insiste en sí/no', /aceptes|responde.*s[ií]/i.test(r), r.substring(0, 120));
  const p1pre = getPatient(ph1);
  check('CMP-04', 'Estado del paciente sigue en esperando_consentimiento',
    p1pre?.estado === 'esperando_consentimiento', p1pre?.estado);

  // 17.3 Acepta → pide nombre y registra consentimiento_fecha/version
  r = await send(ph1, 'sí');
  check('CMP-05', 'Acepta consentimiento → pide nombre', /llamas|nombre/i.test(r), r);
  const p1accept = getPatient(ph1);
  check('CMP-06', 'consentimiento_fecha registrado', !!p1accept?.consentimiento_fecha, p1accept?.consentimiento_fecha);
  check('CMP-07', 'consentimiento_version registrado', p1accept?.consentimiento_version === 'v1.0', p1accept?.consentimiento_version);

  // Completar registro
  await send(ph1, 'Prueba Compliance');
  await send(ph1, '10 de enero de 1990');

  // 17.4 Rechazo → borra paciente (hard delete permitido: nunca consintió)
  const ph2 = freshPhone();
  await send(ph2, 'hola');
  r = await send(ph2, 'no');
  check('CMP-08', 'Rechaza consentimiento → confirma sin guardar datos', /sin tus datos|cambias de opini[oó]n/i.test(r), r);
  check('CMP-09', 'Paciente eliminado tras rechazo', !getPatient(ph2), getPatient(ph2));

  // 17.5 Baja ARCO: paciente registrado solicita baja
  const ph3 = freshPhone();
  await registrar(ph3, 'Usuario Baja', '5 de mayo de 1980');
  await agendarCompleto(ph3, '22 de julio', '10am', 'no ya he venido', 'consulta');
  const citasAntes = getActiveCitas(ph3);
  check('CMP-10', 'Paciente tiene 1 cita activa antes de baja', citasAntes.length === 1, citasAntes.length);

  r = await send(ph3, 'quiero darme de baja');
  check('CMP-11', 'Solicitud de baja → pide confirmación ARCO', /confirmas.*baja|cancelar[aá].*citas|ARCO/i.test(r), r.substring(0, 160));

  r = await send(ph3, 'no');
  check('CMP-12', 'Aborta baja con "no" → mantiene datos', /datos siguen seguros/i.test(r), r);
  check('CMP-13', 'Baja abortada: paciente sigue activo', getPatient(ph3)?.estado === 'activo', getPatient(ph3)?.estado);
  check('CMP-14', 'Baja abortada: cita sigue activa', getActiveCitas(ph3).length === 1, getActiveCitas(ph3).length);

  // Ahora sí se da de baja
  r = await send(ph3, 'darme de baja');
  check('CMP-15', 'Solicitud de baja (2da vuelta) pide confirmación', /confirmas.*baja|cancelar[aá].*citas/i.test(r), r.substring(0, 120));
  r = await send(ph3, 'sí');
  check('CMP-16', 'Confirma baja → mensaje de cierre', /baja|cancelada/i.test(r), r);
  const p3 = getPatient(ph3);
  check('CMP-17', 'Paciente marcado con baja_fecha', !!p3?.baja_fecha, p3?.baja_fecha);
  check('CMP-18', 'Paciente.estado = inactivo', p3?.estado === 'inactivo', p3?.estado);
  check('CMP-19', 'Nombre anonimizado a [BAJA]', p3?.nombre === '[BAJA]', p3?.nombre);
  check('CMP-20', 'Citas activas canceladas tras baja', getActiveCitas(ph3).length === 0, getActiveCitas(ph3).length);

  // 17.6 Paciente de baja que escribe de nuevo → tratado como NUEVO (pide aviso otra vez)
  r = await send(ph3, 'hola');
  check('CMP-21', 'Paciente con baja vuelve → pide consentimiento otra vez', /aceptas|aviso/i.test(r), r.substring(0, 120));
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════
(async () => {
  console.log('\n' + '═'.repeat(58));
  console.log('  TEST EXHAUSTIVO — Bot WhatsApp Médico');
  console.log('  Fecha: ' + new Date().toLocaleString('es-MX'));
  console.log('═'.repeat(58));

  await limpiarTodoPrueba();
  calendar.init();

  await grupoRegistroMexicano();
  await grupoAgendamientoColoquial();
  await grupoBugMotivo();
  await grupoNotificaciones();
  await grupoReagendamiento();
  await grupoCancelacion();
  await grupoAsistencia();
  await grupoFechasHoras();
  await grupoEscape();
  await grupoDatosPaciente();
  await grupoEscalacion();
  await grupoMultimedia();
  await grupoConcurrencia();
  await grupoTimeout();
  await grupoE2E();
  await grupoTypos();
  await grupoCompliance();

  // Limpieza final
  await limpiarTodoPrueba();

  // Resumen
  console.log('\n' + '═'.repeat(58));
  console.log(`  RESULTADO: ${passed} ✅  ${failed} ❌  (total ${total})`);
  console.log('═'.repeat(58));

  if (failures.length > 0) {
    console.log('\n🔴 FALLOS DETECTADOS:');
    failures.forEach(f => {
      console.log(`  ${f.id}: ${f.label}`);
      console.log(`     Got: "${f.got}"`);
    });
  }

  console.log('');
  process.exit(failed > 0 ? 1 : 0);
})();
