'use strict';
const citaRepo     = require('../database/repositories/citaRepo');
const medicoRepo   = require('../database/repositories/medicoRepo');
const pacienteRepo = require('../database/repositories/pacienteRepo');
const sessionManager = require('../session/sessionManager');
const { detectarFecha }          = require('../parsers/dateParser');
const { extraerHora, aplicarHora } = require('../parsers/timeParser');
const T            = require('../utils/messageTemplates');
const calendar     = require('../services/calendar');
const whatsapp     = require('../services/whatsapp');
const { ESTADOS, TENTATIVA_TIMEOUT_MS } = require('../config/constants');
const logger       = require('../utils/logger');
const env          = require('../config/env');
const metricas     = require('../database/repositories/metricasRepo');

/**
 * Registra un evento de métrica sin romper el flujo. Ver metricasRepo.
 */
function _trackMetric(tipo, telefono, payload) {
  try {
    metricas.registrar(tipo, telefono, payload);
  } catch (e) {
    logger.warn(`metricas.registrar fallo: ${e.message}`);
  }
}

// ── Orquestador ───────────────────────────────────────────────────────────────

async function manejarAgendamiento(sesion, paciente, texto) {
  // Verificar expiración de reserva tentativa antes de cualquier paso
  await _limpiarTentativaExpirada(sesion);

  const estado = sesion.estado_flujo;

  if (estado === ESTADOS.ELIGIENDO_MEDICO)        return elegirMedico(sesion, texto);
  if (estado === ESTADOS.ELIGIENDO_FECHA)         return elegirFecha(sesion, paciente, texto);
  if (estado === ESTADOS.ELIGIENDO_HORA)          return elegirHora(sesion, paciente, texto);
  if (estado === ESTADOS.CONFIRMANDO_CITA)        return confirmarCita(sesion, paciente, texto);
  if (estado === ESTADOS.PIDIENDO_PRIMERA_VISITA) return recibirPrimeraVisita(sesion, paciente, texto);
  if (estado === ESTADOS.PIDIENDO_MOTIVO)         return recibirMotivo(sesion, paciente, texto);

  return iniciarAgendamiento(sesion, paciente, texto);
}

// ── Inicio ────────────────────────────────────────────────────────────────────

async function iniciarAgendamiento(sesion, paciente, texto) {
  const medicoUnico = medicoRepo.getMedicoUnico();

  if (medicoUnico) {
    sesion.datos_temporales.medico_id     = medicoUnico.id;
    sesion.datos_temporales.medico_nombre = medicoUnico.nombre;

    const resultado = _intentarExtractarFechaHora(texto);

    if (resultado?.fecha && resultado?.hora) {
      return await _procesarFechaHora(sesion, paciente, resultado.fecha, resultado.hora);
    }
    if (resultado?.fecha) {
      sesion.datos_temporales.fecha_propuesta = resultado.fecha.toISOString();
      sessionManager.cambiarEstado(sesion, ESTADOS.ELIGIENDO_HORA);
      return T.pedirHora(resultado.fecha);
    }

    sessionManager.cambiarEstado(sesion, ESTADOS.ELIGIENDO_FECHA);
    return T.pedirFecha();

  } else {
    const medicos = medicoRepo.findActivos();
    sessionManager.cambiarEstado(sesion, ESTADOS.ELIGIENDO_MEDICO);

    // List message con los médicos disponibles (fallback a texto en dispositivos incompatibles).
    return {
      type: 'list',
      text: '👨‍⚕️ ¿Con qué médico deseas la cita?',
      footer: env.CLINIC_NAME,
      title: 'Médicos disponibles',
      buttonText: 'Ver médicos',
      sections: [{
        title: 'Especialidades',
        rows: medicos.map((m, i) => ({
          id: `medico:${i + 1}`,                   // 1-based para reusar elegirMedico
          title: m.nombre,
          description: m.especialidad || '',
        })),
      }],
    };
  }
}

// ── Elegir médico ─────────────────────────────────────────────────────────────

async function elegirMedico(sesion, texto) {
  const medicos = medicoRepo.findActivos();
  const t = texto.trim().toLowerCase();
  let medico = null;

  const num = parseInt(t, 10);
  if (!isNaN(num) && num >= 1 && num <= medicos.length) medico = medicos[num - 1];

  if (!medico) {
    medico = medicos.find(m =>
      m.nombre.toLowerCase().includes(t) || m.especialidad.toLowerCase().includes(t)
    );
  }

  if (!medico) {
    const lista = medicos.map((m, i) => `${i+1}. ${m.nombre}`).join('\n');
    return `❓ No encontré ese médico. Por favor elige un número:\n\n${lista}`;
  }

  sesion.datos_temporales.medico_id     = medico.id;
  sesion.datos_temporales.medico_nombre = medico.nombre;
  sessionManager.cambiarEstado(sesion, ESTADOS.ELIGIENDO_FECHA);
  return T.pedirFecha();
}

// ── Elegir fecha ──────────────────────────────────────────────────────────────

async function elegirFecha(sesion, paciente, texto) {
  const fecha = detectarFecha(texto);

  if (!fecha) {
    sessionManager.guardar(sesion);
    return `❓ No entendí la fecha. Intenta con algo como:\n_"mañana", "15 de abril", "próximo lunes"_`;
  }

  // Validar que no sea pasada
  const ahora = new Date();
  ahora.setHours(0, 0, 0, 0);
  if (fecha < ahora) {
    sessionManager.guardar(sesion);
    return `Esa fecha ya pasó 😅 ¿Para qué otro día?`;
  }

  // Validar día laboral
  const medico = medicoRepo.findById(sesion.datos_temporales.medico_id);
  if (medico) {
    const diasMap = { 0: 'dom', 1: 'lun', 2: 'mar', 3: 'mie', 4: 'jue', 5: 'vie', 6: 'sab' };
    const diaSemana  = diasMap[fecha.getDay()];
    const diasActivos = medico.dias_laborales.split(',').map(d => d.trim());
    if (!diasActivos.includes(diaSemana)) {
      sessionManager.guardar(sesion);
      return `El doctor no trabaja ese día. Atiende: ${diasActivos.join(', ')}. ¿Qué otro día te queda bien?`;
    }
  }

  // Intentar extraer hora del mismo mensaje
  const hora = extraerHora(texto);
  if (hora) {
    return await _procesarFechaHora(sesion, paciente, fecha, hora);
  }

  sesion.datos_temporales.fecha_propuesta = fecha.toISOString();
  sessionManager.cambiarEstado(sesion, ESTADOS.ELIGIENDO_HORA);

  // Mostrar el horario de atención del médico ese día y pedir la hora en texto.
  // Evita los list-messages (WhatsApp dejó de renderizarlos en cuentas personales);
  // dar el rango explícito le deja al paciente elegir una hora válida sin adivinar.
  const { formatoSoloFecha } = require('../utils/dateFormatter');
  const medicoDia = medicoRepo.findById(sesion.datos_temporales.medico_id);
  if (medicoDia) {
    const rango = medicoRepo.describeHorario(medicoDia, fecha);
    return `⏰ Ese día atendemos de *${rango}*.\n\n¿A qué hora te queda bien el *${formatoSoloFecha(fecha)}*?\n\n_Escríbelo tal cual: "3 de la tarde", "10 am", "10:30"_`;
  }

  // Fallback si no se pudo leer al médico
  return T.pedirHora(fecha);
}

// ── Elegir hora ───────────────────────────────────────────────────────────────

async function elegirHora(sesion, paciente, texto) {
  const hora = extraerHora(texto);

  if (!hora) {
    return `❓ No entendí la hora. Intenta con:\n_"3pm", "3 de la tarde", "10:30"_`;
  }

  const fechaBase = new Date(sesion.datos_temporales.fecha_propuesta);
  return await _procesarFechaHora(sesion, paciente, fechaBase, hora);
}

// ── Confirmar cita ────────────────────────────────────────────────────────────

async function confirmarCita(sesion, paciente, texto) {
  const { detectarIntencion } = require('../parsers/intentParser');
  const intencion = detectarIntencion(texto);

  if (/\b(otro\s+d[ií]a|otra\s+fecha|cambiar|otra\s+hora|diferente|mejor\s+no|no\s+me\s+queda|no\s+puedo\s+ese)\b/i.test(texto)) {
    await _liberarTentativa(sesion);
    sessionManager.cambiarEstado(sesion, ESTADOS.ELIGIENDO_FECHA);
    return `¡Claro! ¿Para qué fecha te queda mejor? 📅`;
  }

  if (intencion === 'confirmar_si') {
    return await _crearCitaConfirmada(sesion, paciente);
  }

  // Negativa explícita → cancelar
  if (intencion === 'confirmar_no') {
    await _liberarTentativa(sesion);
    sessionManager.resetear(sesion);
    return T.agendadoCancelado();
  }

  // Pregunta inocente durante la confirmación → responder sin cancelar y re-preguntar
  const datos  = sesion.datos_temporales;
  const fh     = datos.fecha_hora_propuesta ? new Date(datos.fecha_hora_propuesta) : null;
  const medico = datos.medico_nombre || '';
  const { formatoFechaHumano } = require('../utils/dateFormatter');

  const resumen = fh
    ? `\n\n_Sigue pendiente tu cita:_\n👨‍⚕️ ${medico}\n📅 ${formatoFechaHumano(fh)}\n\nResponde *sí* para confirmar o *no* para cancelar 😊`
    : `\n\n¿Confirmas la cita? Responde *sí* para confirmar o *no* para cancelar 😊`;

  if (intencion === 'pregunta_precio') {
    return `💰 Para precios exactos te recomiendo llamar a la clínica, ya que varían según el servicio.${resumen}`;
  }
  if (intencion === 'pregunta_requisitos') {
    return `📋 Para tu cita te recomiendo traer: una identificación, estudios previos si tienes, y la lista de medicamentos que tomas actualmente.${resumen}`;
  }
  if (intencion === 'pregunta_procedimiento') {
    return `👨‍⚕️ En tu consulta el doctor revisará tu motivo, hará preguntas sobre tu historial y te indicará el siguiente paso. Dura aproximadamente 30 minutos.${resumen}`;
  }
  if (intencion === 'info_clinica') {
    return `🏥 Estamos en horario de Lunes a Viernes, 8:00 AM a 8:00 PM. Para dirección o teléfono de la clínica, con gusto te conecto con alguien del equipo.${resumen}`;
  }

  // Mensaje realmente desconocido → solo re-preguntar (sin cancelar)
  if (fh) {
    return `¿Confirmas tu cita?\n\n👨‍⚕️ ${medico}\n📅 ${formatoFechaHumano(fh)}\n\nResponde *sí* para confirmar o *no* para cancelar 😊`;
  }
  return `¿Confirmas la cita? Responde *sí* para confirmar o *no* para cancelar 😊`;
}

// ── Primera visita ────────────────────────────────────────────────────────────

async function recibirPrimeraVisita(sesion, paciente, texto) {
  const { detectarIntencion } = require('../parsers/intentParser');
  const intencion  = detectarIntencion(texto);
  const citaId     = sesion.datos_temporales.cita_id_creada;
  const esPrimera  = intencion === 'confirmar_si'
                     || /\b(s[ií]|primera|primera\s+vez|primera\s+visita|nunca|jamás)\b/i.test(texto.toLowerCase());

  if (citaId) citaRepo.setPrimeraVisita(citaId, esPrimera);

  sessionManager.cambiarEstado(sesion, ESTADOS.PIDIENDO_MOTIVO);
  return T.pedirMotivo(esPrimera);
}

// ── Motivo de consulta ────────────────────────────────────────────────────────

async function recibirMotivo(sesion, paciente, texto) {
  const { detectarIntencion } = require('../parsers/intentParser');
  const intencion = detectarIntencion(texto);
  const citaId    = sesion.datos_temporales.cita_id_creada;

  if (intencion !== 'omitir' && texto.trim().length > 2) {
    citaRepo.setMotivo(citaId, texto.trim());
  }

  // Enviar reporte pre-consulta al médico
  try {
    const cita   = citaRepo.findById(citaId);
    const medico = cita ? medicoRepo.findById(cita.medico_id) : null;
    if (medico) {
      const historial = citaRepo.findHistorialPaciente(paciente.id, 5);
      const reporte   = T.reportePreConsulta(paciente, cita, medico, historial);
      await whatsapp.sendMessage(medico.telefono, reporte);
      logger.info(`Reporte pre-consulta enviado al médico ${medico.nombre} para ${paciente.nombre}`);
    }
  } catch (e) {
    logger.error(`Error enviando reporte pre-consulta: ${e.message}`);
  }

  sessionManager.resetear(sesion);
  return `✅ ¡Listo, ${paciente.nombre}! Tu cita quedó registrada y ya le envié tu información al doctor.\n\n¿Hay algo más en lo que te pueda ayudar?`;
}

// ── Flujo de cancelación ──────────────────────────────────────────────────────

async function manejarCancelacion(sesion, paciente, texto) {
  const { detectarIntencion } = require('../parsers/intentParser');
  const { formatoSoloFecha, formatoSoloHora } = require('../utils/dateFormatter');

  if (sesion.estado_flujo === ESTADOS.CANCELANDO_CITA) {

    // — Esperando que el paciente elija cuál cita cancelar —
    if (sesion.datos_temporales.esperando_seleccion_cancelar) {
      const trimmed = texto.trim();
      const quiereTodas = /\b(todas?)\b/i.test(trimmed) || trimmed === '0';

      if (quiereTodas) {
        const citaIds = sesion.datos_temporales.citas_opciones;
        const citas   = citaIds.map(id => citaRepo.findById(id)).filter(Boolean);
        delete sesion.datos_temporales.esperando_seleccion_cancelar;
        sesion.datos_temporales.cancelar_todas = true;
        sessionManager.guardar(sesion);

        let msg = `⚠️ ¿Confirmas que quieres cancelar *todas* tus ${citas.length} citas?\n\n`;
        citas.forEach((c, i) => {
          msg += `${i+1}. 👨‍⚕️ ${c.medico_nombre} — 📅 ${formatoSoloFecha(c.fecha_hora)} ⏰ ${formatoSoloHora(c.fecha_hora)}\n`;
        });
        return msg + `\nEscribe *"sí"* para confirmar o *"no"* para regresar.`;
      }

      const num     = parseInt(trimmed, 10);
      const citaIds = sesion.datos_temporales.citas_opciones;
      if (!isNaN(num) && num >= 1 && num <= citaIds.length) {
        sesion.datos_temporales.cita_a_cancelar_id = citaIds[num - 1];
        delete sesion.datos_temporales.esperando_seleccion_cancelar;
        delete sesion.datos_temporales.citas_opciones;
        sessionManager.guardar(sesion);
        const cita = citaRepo.findById(citaIds[num - 1]);
        return T.confirmarCancelacion(cita.medico_nombre, cita.fecha_hora);
      }
      return `Por favor escribe el número de la cita (1-${citaIds.length}), *0* para cancelar todas, o escribe *"todas"* 😊`;
    }

    // — Esperando confirmación (una cita o todas) —
    const intencion = detectarIntencion(texto);

    if (intencion === 'confirmar_si') {
      // Cancelar todas
      if (sesion.datos_temporales.cancelar_todas) {
        const citaIds = sesion.datos_temporales.citas_opciones;
        const citas   = citaIds.map(id => citaRepo.findById(id)).filter(Boolean);
        return await _cancelarTodasLasCitas(citas, paciente, sesion);
      }

      // Cancelar una
      const citaId = sesion.datos_temporales.cita_a_cancelar_id;
      const cita   = citaRepo.findById(citaId);

      if (cita?.google_calendar_event_id) {
        await calendar.eliminarEvento(cita.google_calendar_event_id);
      }

      citaRepo.cancelar(citaId);
      _trackMetric('cita_cancelada', paciente.telefono, { cita_id: citaId, bulk: false });

      const medico = medicoRepo.findById(cita.medico_id);
      if (medico) {
        await whatsapp.sendMessage(
          medico.telefono,
          T.notificacionCancelada(paciente.nombre, paciente.telefono, medico.nombre, cita.fecha_hora)
        );
      }

      sessionManager.resetear(sesion);
      return T.citaCancelada();
    }

    sessionManager.resetear(sesion);
    return T.cancelacionAbortada();
  }

  // — Estado inicial: identificar citas del paciente —
  const citas = citaRepo.findAllActivasPaciente(paciente.id);
  if (!citas || citas.length === 0) return T.sinCitaActiva();

  if (citas.length === 1) {
    sesion.datos_temporales.cita_a_cancelar_id = citas[0].id;
    sessionManager.cambiarEstado(sesion, ESTADOS.CANCELANDO_CITA);
    return T.confirmarCancelacion(citas[0].medico_nombre, citas[0].fecha_hora);
  }

  // Múltiples citas — detectar "cancelar todas" en el mensaje inicial
  if (/\b(todas|todas\s+las?\s+citas?|todas\s+mis\s+citas?|cancelar\s+todo)\b/i.test(texto)) {
    sesion.datos_temporales.citas_opciones = citas.map(c => c.id);
    sesion.datos_temporales.cancelar_todas = true;
    sessionManager.cambiarEstado(sesion, ESTADOS.CANCELANDO_CITA);

    let msg = `⚠️ ¿Confirmas que quieres cancelar *todas* tus ${citas.length} citas?\n\n`;
    citas.forEach((c, i) => {
      msg += `${i+1}. 👨‍⚕️ ${c.medico_nombre} — 📅 ${formatoSoloFecha(c.fecha_hora)} ⏰ ${formatoSoloHora(c.fecha_hora)}\n`;
    });
    return msg + `\nEscribe *"sí"* para confirmar o *"no"* para regresar.`;
  }

  sesion.datos_temporales.citas_opciones               = citas.map(c => c.id);
  sesion.datos_temporales.esperando_seleccion_cancelar = true;
  sessionManager.cambiarEstado(sesion, ESTADOS.CANCELANDO_CITA);

  let msg = `Tienes ${citas.length} citas programadas. ¿Cuál quieres cancelar?\n\n`;
  citas.forEach((c, i) => {
    msg += `${i+1}. 👨‍⚕️ ${c.medico_nombre} — 📅 ${formatoSoloFecha(c.fecha_hora)} ⏰ ${formatoSoloHora(c.fecha_hora)}\n`;
  });
  msg += `0️⃣  *Cancelar todas*\n`;
  return msg + `\nEscribe el número o *0* para cancelar todas.`;
}

/**
 * Cancela todas las citas de la lista, borra sus eventos de Calendar
 * y notifica al médico con un resumen.
 */
async function _cancelarTodasLasCitas(citas, paciente, sesion) {
  const { formatoSoloFecha, formatoSoloHora } = require('../utils/dateFormatter');

  for (const cita of citas) {
    if (cita.google_calendar_event_id) {
      try { await calendar.eliminarEvento(cita.google_calendar_event_id); } catch (e) {
        logger.error(`Error eliminando evento Calendar: ${e.message}`);
      }
    }
    citaRepo.cancelar(cita.id);
    _trackMetric('cita_cancelada', paciente.telefono, { cita_id: cita.id, bulk: true });
  }

  // Notificar a cada médico involucrado con sus citas canceladas
  const medicoIds = [...new Set(citas.map(c => c.medico_id))];
  for (const medicoId of medicoIds) {
    const medico = medicoRepo.findById(medicoId);
    if (!medico) continue;
    const citasMedico = citas.filter(c => c.medico_id === medicoId);
    let msg = `❌ *Cancelación de citas — ${paciente.nombre}*\n`;
    msg += `📞 ${paciente.telefono}\n\n`;
    msg += `Se cancelaron ${citasMedico.length} cita(s):\n`;
    citasMedico.forEach(c => {
      msg += `• 📅 ${formatoSoloFecha(c.fecha_hora)} ⏰ ${formatoSoloHora(c.fecha_hora)}\n`;
    });
    try { await whatsapp.sendMessage(medico.telefono, msg); } catch (e) {
      logger.error(`Error notificando médico cancelación masiva: ${e.message}`);
    }
  }

  sessionManager.resetear(sesion);
  return `✅ Listo, ${paciente.nombre}. Cancelé todas tus citas (${citas.length}). ¿Hay algo más en lo que te pueda ayudar?`;
}

// ── Flujo de reagendamiento ───────────────────────────────────────────────────

async function manejarReagendamiento(sesion, paciente, texto) {
  if (sesion.estado_flujo === ESTADOS.REAGENDANDO_CITA) {

    if (sesion.datos_temporales.esperando_seleccion_reagendar) {
      const num     = parseInt(texto.trim(), 10);
      const citaIds = sesion.datos_temporales.citas_opciones;
      if (!isNaN(num) && num >= 1 && num <= citaIds.length) {
        const cita = citaRepo.findById(citaIds[num - 1]);
        sesion.datos_temporales.cita_a_reagendar_id = cita.id;
        sesion.datos_temporales.medico_id           = cita.medico_id;
        sesion.datos_temporales.medico_nombre       = cita.medico_nombre;
        delete sesion.datos_temporales.esperando_seleccion_reagendar;
        delete sesion.datos_temporales.citas_opciones;
        sessionManager.cambiarEstado(sesion, ESTADOS.ELIGIENDO_FECHA);
        return `🔄 Reagendando tu cita con *${cita.medico_nombre}*.\n\n${T.pedirFecha()}`;
      }
      return `Por favor escribe el número de la cita (1-${citaIds.length}) 😊`;
    }

    return manejarAgendamiento(sesion, paciente, texto);
  }

  const citas = citaRepo.findAllActivasPaciente(paciente.id);
  if (!citas || citas.length === 0) return T.sinCitaActiva();

  if (citas.length === 1) {
    sesion.datos_temporales.cita_a_reagendar_id = citas[0].id;
    sesion.datos_temporales.medico_id           = citas[0].medico_id;
    sesion.datos_temporales.medico_nombre       = citas[0].medico_nombre;

    const fechaInicial = detectarFecha(texto);
    if (fechaInicial) {
      const horaInicial = extraerHora(texto);
      if (horaInicial) {
        return await _procesarFechaHora(sesion, paciente, fechaInicial, horaInicial);
      }
      sesion.datos_temporales.fecha_propuesta = fechaInicial.toISOString();
      sessionManager.cambiarEstado(sesion, ESTADOS.ELIGIENDO_HORA);
      return `🔄 Reagendando tu cita con *${citas[0].medico_nombre}*.\n\n` + T.pedirHora(fechaInicial);
    }

    sessionManager.cambiarEstado(sesion, ESTADOS.ELIGIENDO_FECHA);
    return `🔄 Reagendando tu cita con *${citas[0].medico_nombre}*.\n\n${T.pedirFecha()}`;
  }

  const { formatoSoloFecha, formatoSoloHora } = require('../utils/dateFormatter');
  sesion.datos_temporales.citas_opciones                = citas.map(c => c.id);
  sesion.datos_temporales.esperando_seleccion_reagendar = true;
  sessionManager.cambiarEstado(sesion, ESTADOS.REAGENDANDO_CITA);

  let msg = `Tienes ${citas.length} citas programadas. ¿Cuál quieres reagendar?\n\n`;
  citas.forEach((c, i) => {
    msg += `${i+1}. 👨‍⚕️ ${c.medico_nombre} — 📅 ${formatoSoloFecha(c.fecha_hora)} ⏰ ${formatoSoloHora(c.fecha_hora)}\n`;
  });
  return msg + `\nEscribe el número de la cita.`;
}

// ── Helpers privados ──────────────────────────────────────────────────────────

function _intentarExtractarFechaHora(texto) {
  return { fecha: detectarFecha(texto), hora: extraerHora(texto) };
}

/**
 * Valida fecha+hora, verifica disponibilidad (SQLite + Calendar),
 * crea evento tentativo si disponible, y avanza al estado de confirmación.
 */
async function _procesarFechaHora(sesion, paciente, fecha, hora) {
  const medicoId     = sesion.datos_temporales.medico_id;
  const medicoNombre = sesion.datos_temporales.medico_nombre;
  const medico       = medicoRepo.findById(medicoId);
  const fechaHora    = aplicarHora(fecha, hora.horas, hora.minutos);

  // Validar que no sea pasada
  if (fechaHora <= new Date()) {
    return `Esa fecha/hora ya pasó 😅 ¿Para qué otro momento?`;
  }

  // Validar dentro del horario del médico
  if (medico && !medicoRepo.esDentroHorario(medico, fechaHora, hora.horas, hora.minutos)) {
    return `El horario del doctor ese día es de *${medicoRepo.describeHorario(medico, fechaHora)}*. ¿A qué otra hora te queda bien?`;
  }

  // Verificar conflicto en SQLite
  if (citaRepo.verificarConflicto(medicoId, fechaHora, medico?.duracion_cita_min || 30)) {
    const disponibles = medicoRepo.getHorariosDisponibles(medicoId, fecha).slice(0, 3);
    if (disponibles.length === 0) {
      return `Ese día el doctor ya no tiene horarios disponibles. ¿Quieres elegir otro día?`;
    }
    return T.conflictoHorario(disponibles);
  }

  // Verificar en Google Calendar si está configurado
  if (calendar.isEnabled()) {
    const durMin = medico?.duracion_cita_min || 30;
    const fin    = new Date(fechaHora.getTime() + durMin * 60_000);
    const { disponible } = await calendar.verificarDisponibilidad(fechaHora, fin);

    if (!disponible) {
      const disponibles = medicoRepo.getHorariosDisponibles(medicoId, fecha).slice(0, 3);
      if (disponibles.length === 0) {
        return T.conflictoCalendar();
      }
      return T.conflictoCalendar(disponibles);
    }

    // Crear evento tentativo para bloquear el slot
    const tentativoId = await calendar.crearEventoTentativo(
      paciente.nombre,
      fechaHora,
      durMin
    );

    if (tentativoId === null) {
      // 409 — slot tomado en el último segundo
      const disponibles = medicoRepo.getHorariosDisponibles(medicoId, fecha).slice(0, 3);
      return T.conflictoCalendar(disponibles);
    }

    // Guardar tentativo con timestamp de expiración
    sesion.datos_temporales.tentativo_calendar_id = tentativoId;
    sesion.datos_temporales.tentativa_expira      = Date.now() + TENTATIVA_TIMEOUT_MS;
  }

  sesion.datos_temporales.fecha_hora_propuesta = fechaHora.toISOString();
  sessionManager.cambiarEstado(sesion, ESTADOS.CONFIRMANDO_CITA);

  // Salvaguarda diagnóstica: si por cualquier razón el estado no quedó en
  // CONFIRMANDO_CITA tras el cambiarEstado (visto en producción 2026-04-23
  // con tentativo creado pero estado atascado en `eligiendo_hora`), forzamos
  // un re-guardado y dejamos rastro en el log para no volver a perder al paciente.
  if (sesion.estado_flujo !== ESTADOS.CONFIRMANDO_CITA) {
    logger.error(
      `_procesarFechaHora ${paciente.telefono}: estado quedó en "${sesion.estado_flujo}" ` +
      `tras cambiarEstado(CONFIRMANDO_CITA). Forzando re-persistencia.`
    );
    sesion.estado_flujo = ESTADOS.CONFIRMANDO_CITA;
    sessionManager.guardar(sesion);
  }
  return T.confirmarCitaInteractivo(paciente.nombre, medicoNombre, fechaHora);
}

/**
 * Crea la cita en BD y actualiza/confirma el evento en Calendar.
 */
async function _crearCitaConfirmada(sesion, paciente) {
  const fechaHora    = new Date(sesion.datos_temporales.fecha_hora_propuesta);
  const medicoId     = sesion.datos_temporales.medico_id;
  const medicoNombre = sesion.datos_temporales.medico_nombre;
  const medico       = medicoRepo.findById(medicoId);
  const esReagendamiento = !!sesion.datos_temporales.cita_a_reagendar_id;

  // Cancelar cita anterior en reagendamiento
  if (esReagendamiento) {
    const citaAnterior = citaRepo.findById(sesion.datos_temporales.cita_a_reagendar_id);
    if (citaAnterior?.google_calendar_event_id) {
      await calendar.eliminarEvento(citaAnterior.google_calendar_event_id);
    }
    citaRepo.cancelar(sesion.datos_temporales.cita_a_reagendar_id);
  }

  // Crear cita en BD
  const citaId = citaRepo.create({
    pacienteId:  paciente.id,
    medicoId,
    fechaHora,
    duracionMin: medico?.duracion_cita_min || 30,
  });

  // Métrica: cita_creada / cita_reagendada
  _trackMetric(esReagendamiento ? 'cita_reagendada' : 'cita_creada', paciente.telefono, {
    cita_id: citaId,
    medico_id: medicoId,
    fecha_hora: typeof fechaHora === 'string' ? fechaHora : new Date(fechaHora).toISOString(),
  });

  // Gestionar evento en Calendar
  const tentativoId = sesion.datos_temporales.tentativo_calendar_id;
  if (tentativoId) {
    // Actualizar tentativo a confirmado
    const ok = await calendar.confirmarEvento(
      tentativoId,
      `Cita — ${paciente.nombre} — ${medicoNombre}`,
      `Paciente: ${paciente.nombre}\nTel: ${paciente.telefono}`
    );
    if (ok) citaRepo.setCalendarEventId(citaId, tentativoId);
  } else if (calendar.isEnabled()) {
    // Calendar configurado pero sin tentativo (rara vez) — crear directo
    const eventId = await calendar.crearEvento({
      titulo:      `Cita — ${paciente.nombre} — ${medicoNombre}`,
      descripcion: `Paciente: ${paciente.nombre}\nTel: ${paciente.telefono}`,
      fechaHora,
      duracionMin: medico?.duracion_cita_min || 30,
    });
    if (eventId) citaRepo.setCalendarEventId(citaId, eventId);
  }

  // Notificar al médico (notificación básica de nueva cita; reporte completo llega con el motivo)
  if (medico) {
    const msg = esReagendamiento
      ? T.notificacionReagendada(paciente.nombre, paciente.telefono, medico.nombre, fechaHora)
      : T.notificacionNuevaCita(paciente.nombre, paciente.telefono, medico.nombre, fechaHora, null);
    try {
      await whatsapp.sendMessage(medico.telefono, msg);
    } catch (e) {
      logger.error(`Error notificando médico: ${e.message}`);
    }
  }

  // Guardar citaId y avanzar al paso de primera visita
  sesion.datos_temporales.cita_id_creada        = citaId;
  delete sesion.datos_temporales.tentativo_calendar_id;
  delete sesion.datos_temporales.tentativa_expira;
  sessionManager.cambiarEstado(sesion, ESTADOS.PIDIENDO_PRIMERA_VISITA);

  const base = esReagendamiento
    ? T.citaReagendada(paciente.nombre, medicoNombre, fechaHora)
    : T.citaAgendada(paciente.nombre, medicoNombre, fechaHora);

  return base + '\n\n' + T.pedirPrimeraVisita();
}

/**
 * Limpia la reserva tentativa si expiró (llamado al inicio de cada interacción).
 */
async function _limpiarTentativaExpirada(sesion) {
  const { tentativo_calendar_id, tentativa_expira } = sesion.datos_temporales;
  if (!tentativo_calendar_id || !tentativa_expira) return;
  if (Date.now() < tentativa_expira) return;

  logger.info(`Tentativa expirada para ${sesion.telefono}, liberando slot`);
  await calendar.eliminarEvento(tentativo_calendar_id);
  sessionManager.resetear(sesion);
}

/**
 * Elimina evento tentativo cuando el usuario cancela/elige otro día.
 */
async function _liberarTentativa(sesion) {
  const id = sesion.datos_temporales.tentativo_calendar_id;
  if (id) {
    await calendar.eliminarEvento(id);
    delete sesion.datos_temporales.tentativo_calendar_id;
    delete sesion.datos_temporales.tentativa_expira;
  }
}

module.exports = {
  manejarAgendamiento,
  manejarCancelacion,
  manejarReagendamiento,
};
