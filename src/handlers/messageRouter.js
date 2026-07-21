'use strict';
const pacienteRepo   = require('../database/repositories/pacienteRepo');
const citaRepo       = require('../database/repositories/citaRepo');
const sessionManager = require('../session/sessionManager');
const registrationFlow = require('./registrationFlow');
const appointmentFlow  = require('./appointmentFlow');
const escalationHandler = require('./escalationHandler');
const attendanceHandler = require('./attendanceHandler');
const npsHandler        = require('./npsHandler');
const { detectarIntencion } = require('../parsers/intentParser');
const groq           = require('../services/groq');
const T              = require('../utils/messageTemplates');
const { calcularEdad, formatoSoloFecha } = require('../utils/dateFormatter');
const { ESTADOS, ESTADOS_PACIENTE } = require('../config/constants');
const env            = require('../config/env');
const logger         = require('../utils/logger');
const metricas       = require('../database/repositories/metricasRepo');

/**
 * Registra un evento de métrica sin romper el flujo si la BD falla.
 * Nunca debe lanzar — el flujo principal no depende de esto.
 */
function _trackMetric(tipo, telefono, payload) {
  try {
    metricas.registrar(tipo, telefono, payload);
  } catch (e) {
    logger.warn(`metricas.registrar fallo: ${e.message}`);
  }
}

/**
 * Orquestador principal de mensajes entrantes.
 * Recibe (telefono, texto) y devuelve la respuesta a enviar.
 */
async function routeMessage(telefono, texto) {
  // 0. Normalizar respuestas interactivas de WhatsApp.
  // El botón/row llega como id (ej "menu:agendar", "slot:2026-04-22T10:00Z")
  // y lo traducimos a frase natural para que el resto del router no cambie.
  if (typeof texto === 'string') {
    if (texto.startsWith('menu:')) {
      const op = texto.slice(5);
      if (op === 'agendar')   texto = 'quiero agendar';
      else if (op === 'consultar') texto = 'consultar mis citas';
      else if (op === 'cancelar')  texto = 'cancelar mi cita';
      else if (op === 'hablar')    texto = 'hablar con humano';
    } else if (texto.startsWith('confirm:')) {
      const op = texto.slice(8);
      if (op === 'si')      texto = 'sí';
      else if (op === 'no') texto = 'no';
      else if (op === 'cambiar') texto = 'otro día';
    } else if (texto.startsWith('medico:')) {
      texto = texto.slice(7);   // "medico:3" → "3" (elegirMedico parsea número)
    } else if (texto.startsWith('slot:')) {
      const iso = texto.slice(5);
      const d = new Date(iso);
      if (!isNaN(d.getTime())) {
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        texto = `${hh}:${mm}`;  // timeParser interpreta 24h format
      }
    }
  }

  // 1. Cargar o crear sesión
  const sesion = sessionManager.cargar(telefono);

  // 2. Verificar timeout de escalación
  if (sesion.estado_flujo === ESTADOS.ESCALADO_HUMANO) {
    if (!escalationHandler.verificarTimeoutEscalacion(sesion)) {
      // Aún en modo humano — no responder automáticamente
      return null;
    }
    // Timeout expirado → regresar al bot
    sessionManager.resetear(sesion);
    logger.info(`Escalación expirada para ${telefono}, regresando a bot`);
  }

  // 3.5 Mensaje multimedia no soportado
  if (texto === '__MEDIA_NO_SOPORTADO__') {
    return 'Disculpa, por el momento solo puedo leer mensajes de texto ✍️ ¿Me escribes lo que necesitas?';
  }

  // 3.1 Mensajes del médico — solo procesar si tiene una pregunta de asistencia pendiente
  if (telefono === env.DOCTOR_PHONE || telefono === env.DOCTOR_PHONE?.replace(/^\+/, '')) {
    const citaPendiente = citaRepo.findPendienteRespuestaDoctor();
    if (citaPendiente) {
      return await attendanceHandler.procesarRespuestaDoctor(citaPendiente, texto);
    }
    logger.debug(`Mensaje del doctor ${telefono} ignorado por el bot`);
    return null;
  }

  // 3.0 PRIORIDAD MÁXIMA — Triage de urgencia clínica alta
  // Debe correr ANTES de todo lo demás (incluso de flujos de registro/citas) para
  // no "agendar" a alguien que está reportando un dolor de pecho.
  const intencionTriage = detectarIntencion(texto);
  if (intencionTriage === 'triage_urgencia_alta') {
    const pacienteTriage = pacienteRepo.findByTelefono(telefono);
    _trackMetric('triage_urgencia_alta', telefono, { texto_truncado: String(texto).substring(0, 80) });
    return escalationHandler.escalarUrgencia(sesion, pacienteTriage, texto);
  }

  // 3. Detectar escalación urgente (prioridad máxima)
  if (/\b(emergencia|urgente|urgencia)\b/i.test(texto)) {
    const paciente = pacienteRepo.findByTelefono(telefono);
    _trackMetric('escalacion', telefono, { motivo: 'palabra_clave_urgente' });
    return escalationHandler.escalar(sesion, paciente, texto);
  }

  // 4. Cargar o crear paciente
  let paciente = pacienteRepo.findByTelefono(telefono);

  // 4.1 Paciente dado de baja (ARCO) → tratar como nuevo paciente
  // Esto preserva el registro histórico pero inicia una nueva relación con consentimiento.
  if (paciente && paciente.baja_fecha) {
    logger.info(`Paciente ${telefono} previamente dado de baja — iniciando nuevo registro`);
    paciente = null;
  }

  if (!paciente) {
    return registrationFlow.manejarRegistro(sesion, null, texto);
  }

  // 5. Flujos de registro en progreso
  if (
    sesion.estado_flujo === ESTADOS.ESPERANDO_CONSENTIMIENTO ||
    sesion.estado_flujo === ESTADOS.REGISTRANDO_NOMBRE ||
    sesion.estado_flujo === ESTADOS.REGISTRANDO_CUMPLE ||
    paciente.estado === ESTADOS_PACIENTE.NUEVO ||
    paciente.estado === ESTADOS_PACIENTE.ESPERANDO_CONSENTIMIENTO ||
    paciente.estado === ESTADOS_PACIENTE.REGISTRANDO_NOMBRE ||
    paciente.estado === ESTADOS_PACIENTE.REGISTRANDO_CUMPLE
  ) {
    return registrationFlow.manejarRegistro(sesion, paciente, texto);
  }

  // 5.5 Corrección de nombre (paciente ya registrado)
  if (/\b(mi nombre (no es|es|completo)|me llamo|no me llamo|nombre (correcto|real|completo) es)\b/i.test(texto)
      && paciente.estado === ESTADOS_PACIENTE.ACTIVO) {
    const nuevoNombre = texto
      .replace(/.*(?:mi nombre (?:completo )?(?:no )?es|me llamo|nombre (?:correcto|real|completo) es)\s*/i, '')
      .replace(/[^a-záéíóúñü\s]/gi, '')
      .trim();
    if (nuevoNombre && nuevoNombre.length >= 3) {
      const nombreFinal = nuevoNombre.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      pacienteRepo.updateNombreSolo(telefono, nombreFinal);
      return `¡Listo! Ya actualicé tu nombre a *${nombreFinal}* ✅ ¿En qué más te ayudo?`;
    }
  }

  // 5.6 Flujo NPS — si la sesión está esperando puntaje o comentario,
  // la respuesta del paciente se procesa antes que cualquier otro routing.
  if (
    sesion.estado_flujo === ESTADOS.ESPERANDO_NPS_PUNTAJE ||
    sesion.estado_flujo === ESTADOS.ESPERANDO_NPS_COMENTARIO
  ) {
    const r = await npsHandler.manejarRespuesta(sesion, paciente, texto);
    if (r !== null) return r;
  }

  // 6. Re-cargar paciente (puede haber sido actualizado)
  paciente = pacienteRepo.findByTelefono(telefono);

  // 7. Detectar intención
  const intencion = detectarIntencion(texto);
  if (intencion && intencion !== 'desconocido') {
    _trackMetric('intent_detectado', telefono, { intent: intencion });
  }

  // 7.5 Escape: permitir al usuario salir de un flujo en progreso
  if ([ESTADOS.ELIGIENDO_MEDICO, ESTADOS.ELIGIENDO_FECHA, ESTADOS.ELIGIENDO_HORA,
       ESTADOS.CONFIRMANDO_CITA, ESTADOS.PIDIENDO_PRIMERA_VISITA, ESTADOS.PIDIENDO_MOTIVO,
       ESTADOS.CANCELANDO_CITA, ESTADOS.REAGENDANDO_CITA,
       ESTADOS.CAMBIANDO_NOMBRE, ESTADOS.CAMBIANDO_CUMPLE].includes(sesion.estado_flujo)) {
    const textoNorm = texto.toLowerCase().trim();
    if (/^(salir|cancelar|menu|menú|volver|no quiero|dejalo|déjalo)$/i.test(textoNorm)
        || (intencion === 'confirmar_no'
            && sesion.estado_flujo !== ESTADOS.CONFIRMANDO_CITA
            && sesion.estado_flujo !== ESTADOS.CANCELANDO_CITA
            && sesion.estado_flujo !== ESTADOS.PIDIENDO_PRIMERA_VISITA
            && sesion.estado_flujo !== ESTADOS.PIDIENDO_MOTIVO)) {
      sessionManager.resetear(sesion);
      return T.menuPrincipal(paciente.nombre);
    }
  }

  // 7.6 Flujo de cambio de nombre
  if (sesion.estado_flujo === ESTADOS.CAMBIANDO_NOMBRE) {
    const { extraerNombre } = require('./registrationFlow');
    const nombre = extraerNombre(texto);
    if (nombre) {
      pacienteRepo.updateNombreSolo(telefono, nombre);
      sessionManager.resetear(sesion);
      return `¡Listo! Ya actualicé tu nombre a *${nombre}* ✅ ¿En qué más te ayudo?`;
    }
    return `No entendí el nombre 😅 Escríbelo completo, por ejemplo: _"María García López"_`;
  }

  // 7.65 Flujo de baja (ARCO — derecho de cancelación LFPDPPP)
  if (sesion.estado_flujo === ESTADOS.SOLICITANDO_BAJA) {
    const intencionBaja = detectarIntencion(texto);

    if (intencionBaja === 'confirmar_si') {
      // Cancelar todas las citas activas
      const citas = citaRepo.findAllActivasPaciente(paciente.id);
      const calendar = require('../services/calendar');
      for (const c of citas) {
        if (c.google_calendar_event_id) {
          try { await calendar.eliminarEvento(c.google_calendar_event_id); }
          catch (e) { logger.error(`Baja: error borrando evento Calendar ${c.id}: ${e.message}`); }
        }
        citaRepo.cancelar(c.id);
      }
      const nombrePrevio = paciente.nombre;
      pacienteRepo.darDeBaja(telefono, 'Solicitud del usuario vía WhatsApp');
      sessionManager.resetear(sesion);
      logger.info(`BAJA procesada para ${telefono} (${nombrePrevio}) — ${citas.length} cita(s) canceladas`);
      return T.bajaConfirmada(nombrePrevio);
    }

    sessionManager.resetear(sesion);
    return T.bajaAbortada();
  }

  // 7.7 Flujo de cambio de cumpleaños
  if (sesion.estado_flujo === ESTADOS.CAMBIANDO_CUMPLE) {
    const { extraerFechaNacimiento } = require('../parsers/dateParser');
    const fecha = extraerFechaNacimiento(texto);
    if (fecha) {
      pacienteRepo.setFechaNacimientoSolo(telefono, fecha);
      sessionManager.resetear(sesion);
      const edad = calcularEdad(fecha);
      return `¡Listo! Actualicé tu fecha de nacimiento ✅${edad ? ` (${edad} años)` : ''}\n\n¿En qué más te ayudo?`;
    }
    return `Mmm, no me quedó clara la fecha 😅 ¿Me la puedes poner así?:\n\n_15 de julio de 2000_ o _15/07/2000_`;
  }

  // 8. Flujos de citas en progreso (ignorar intención, continuar el flujo)
  if ([
    ESTADOS.ELIGIENDO_MEDICO,
    ESTADOS.ELIGIENDO_FECHA,
    ESTADOS.ELIGIENDO_HORA,
    ESTADOS.CONFIRMANDO_CITA,
    ESTADOS.PIDIENDO_PRIMERA_VISITA,
    ESTADOS.PIDIENDO_MOTIVO,
  ].includes(sesion.estado_flujo)) {
    return appointmentFlow.manejarAgendamiento(sesion, paciente, texto);
  }

  if (sesion.estado_flujo === ESTADOS.CANCELANDO_CITA) {
    return appointmentFlow.manejarCancelacion(sesion, paciente, texto);
  }

  if (sesion.estado_flujo === ESTADOS.REAGENDANDO_CITA) {
    return appointmentFlow.manejarReagendamiento(sesion, paciente, texto);
  }

  // 9. Recuperar flujo de motivo si la sesión expiró pero hay una cita pendiente sin motivo
  // (ocurre cuando limpiarInactivas resetea la sesión mientras el paciente tardó en contestar)
  // Debe ir ANTES del switch para que no lo intercepte el case 'agendar'
  if (sesion.datos_temporales && sesion.datos_temporales.cita_id_creada) {
    const citaPendiente = citaRepo.findById(sesion.datos_temporales.cita_id_creada);
    if (citaPendiente
        && !citaPendiente.motivo_consulta
        && ['programada', 'confirmada', 'pendiente_confirmacion'].includes(citaPendiente.estado)) {
      // Restaurar el estado y procesar el mensaje como motivo
      sesion.estado_flujo = ESTADOS.PIDIENDO_MOTIVO;
      return appointmentFlow.manejarAgendamiento(sesion, paciente, texto);
    }
    // Cita ya tiene motivo o fue cancelada — limpiar dato obsoleto
    delete sesion.datos_temporales.cita_id_creada;
    sessionManager.guardar(sesion);
  }

  // 9.5 Despachar por intención desde IDLE
  switch (intencion) {

    case 'agendar':
      return appointmentFlow.manejarAgendamiento(sesion, paciente, texto);

    case 'reagendar':
      return appointmentFlow.manejarReagendamiento(sesion, paciente, texto);

    case 'cancelar':
      return appointmentFlow.manejarCancelacion(sesion, paciente, texto);

    case 'consultar_cita': {
      const citas = citaRepo.findAllActivasPaciente(paciente.id);
      if (!citas || citas.length === 0) return T.sinCitaActiva();
      if (citas.length === 1) {
        return T.citaActual(paciente.nombre, citas[0].medico_nombre, citas[0].fecha_hora, citas[0].motivo_consulta);
      }
      // Multiple appointments
      let msg = `📋 Tienes *${citas.length} citas* programadas:\n\n`;
      citas.forEach((c, i) => {
        const { formatoSoloFecha, formatoSoloHora } = require('../utils/dateFormatter');
        msg += `${i+1}. 👨‍⚕️ ${c.medico_nombre}\n   📅 ${formatoSoloFecha(c.fecha_hora)} — ⏰ ${formatoSoloHora(c.fecha_hora)}`;
        if (c.motivo_consulta) msg += `\n   💬 ${c.motivo_consulta}`;
        msg += `\n\n`;
      });
      msg += `¿Necesitas reagendar o cancelar alguna?`;
      return msg;
    }

    case 'baja_datos':
      sessionManager.cambiarEstado(sesion, ESTADOS.SOLICITANDO_BAJA);
      return T.bajaPregunta();

    case 'escalar_humano':
      _trackMetric('escalacion', telefono, { motivo: 'intent_escalar_humano' });
      return escalationHandler.escalar(sesion, paciente, texto);

    case 'menu_opcion': {
      const num = parseInt(texto.trim(), 10);
      if (num === 1) return appointmentFlow.manejarAgendamiento(sesion, paciente, texto);
      if (num === 2) {
        const citas = citaRepo.findAllActivasPaciente(paciente.id);
        if (!citas || citas.length === 0) return T.sinCitaActiva();
        if (citas.length === 1) {
          return T.citaActual(paciente.nombre, citas[0].medico_nombre, citas[0].fecha_hora, citas[0].motivo_consulta);
        }
        let msg = `📋 Tienes *${citas.length} citas* programadas:\n\n`;
        citas.forEach((c, i) => {
          const { formatoSoloFecha, formatoSoloHora } = require('../utils/dateFormatter');
          msg += `${i+1}. 👨‍⚕️ ${c.medico_nombre}\n   📅 ${formatoSoloFecha(c.fecha_hora)} — ⏰ ${formatoSoloHora(c.fecha_hora)}`;
          if (c.motivo_consulta) msg += `\n   💬 ${c.motivo_consulta}`;
          msg += `\n\n`;
        });
        msg += `¿Necesitas reagendar o cancelar alguna?`;
        return msg;
      }
      if (num === 3) return `¿Qué necesitas hacer con tu cita?\n\nEscríbeme *"cancelar mi cita"* o *"cambiar mi cita"* 😊`;
      if (num === 4) return escalationHandler.escalar(sesion, paciente, texto);
      break;
    }

    case 'saludo':
      return {
        type: 'buttons',
        text: `¡Hola, ${paciente.nombre}! ¿En qué te puedo ayudar? 😊\n\nO escríbeme lo que necesites 💬`,
        footer: env.CLINIC_NAME,
        buttons: [
          { id: 'menu:agendar',   text: '📅 Agendar cita' },
          { id: 'menu:consultar', text: '📋 Ver mis citas' },
          { id: 'menu:hablar',    text: '💬 Hablar con humano' },
        ],
      };

    case 'cambiar_nombre':
      sessionManager.cambiarEstado(sesion, ESTADOS.CAMBIANDO_NOMBRE);
      return `¡Claro! ¿Cuál es tu nombre correcto? Escríbelo completo 😊`;

    case 'cambiar_cumple':
      sessionManager.cambiarEstado(sesion, ESTADOS.CAMBIANDO_CUMPLE);
      return `¡Claro! ¿Cuál es tu fecha de nacimiento correcta?\n\n_Ejemplo: 15 de julio de 1990_`;

    case 'mis_datos': {
      const edad = paciente.fecha_nacimiento ? calcularEdad(paciente.fecha_nacimiento) : null;
      let msg = `📋 Tus datos registrados:\n\n`;
      msg += `👤 *Nombre:* ${paciente.nombre}\n`;
      if (paciente.fecha_nacimiento) msg += `🎂 *Cumpleaños:* ${formatoSoloFecha(paciente.fecha_nacimiento)}${edad ? ` (${edad} años)` : ''}\n`;
      msg += `📞 *Teléfono:* ${paciente.telefono}\n`;
      msg += `\n¿Necesitas cambiar algo? Escríbeme _"cambiar mi nombre"_ o _"cambiar mi cumpleaños"_`;
      return msg;
    }

    case 'info_clinica':
      return `🏥 *${env.CLINIC_NAME}*\n\n` +
        `👨‍⚕️ Doctor: ${env.DOCTOR_NAME}\n` +
        `🕐 Horario: ${env.CLINIC_HOURS}\n\n` +
        `Para dirección, precios o servicios específicos, puedo conectarte con alguien del equipo 😊\n\nEscríbeme _"hablar con alguien"_ si lo necesitas.`;

    case 'pregunta_precio':
      return `💰 Los precios varían según el servicio. Te recomiendo llamar directamente a la clínica o, si quieres, te conecto con alguien del equipo que te dé el dato exacto 😊`;

    case 'pregunta_requisitos':
      return `📋 Para tu cita te recomiendo traer:\n\n• Una identificación\n• Estudios previos (si tienes)\n• Lista de medicamentos que tomas actualmente\n\n¿Te agendo una cita?`;

    case 'pregunta_procedimiento':
      return `👨‍⚕️ En tu consulta el doctor revisará tu motivo, hará preguntas sobre tu historial y te indicará el siguiente paso. Dura aproximadamente 30 minutos.\n\n¿Te agendo una cita?`;

    case 'agradecimiento':
      return `¡Con mucho gusto! 😊 Aquí estoy si necesitas algo más.`;

    case 'despedida':
      return `¡Hasta luego! 👋 Que tengas un excelente día. Cuando necesites algo, aquí estoy.`;

    default:
      break;
  }

  // 10. Fallback: respuesta con IA (Groq)
  _trackMetric('fallback_groq', telefono, {
    estado_sesion: sesion.estado_flujo,
    texto_truncado: String(texto).substring(0, 80),
  });
  const respuestaIA = await groq.generarRespuesta(
    sesion.historial_mensajes,
    texto,
    env.CLINIC_NAME
  );
  sessionManager.agregarMensaje(sesion, 'user', texto);
  sessionManager.agregarMensaje(sesion, 'assistant', respuestaIA);

  return respuestaIA;
}

module.exports = { routeMessage };
