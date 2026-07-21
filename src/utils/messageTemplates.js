'use strict';
const { formatoFechaHumano, formatoSoloFecha, formatoSoloHora, calcularEdad } = require('./dateFormatter');
const env = require('../config/env');

const CLINICA = env.CLINIC_NAME;

// ─── Registro ────────────────────────────────────────────────────────────────

const T = {
  // Antes de pedir datos personales, LFPDPPP exige aviso + consentimiento expreso.
  bienvenidaNuevo: () => {
    const { CONSENT_URL } = require('../config/constants');
    return `🏥 ¡Hola! Soy Valentina, de *${CLINICA}*.\n\n` +
      `Para ayudarte con tus citas necesito datos básicos (nombre y fecha de nacimiento). ` +
      `Los uso solo para tu atención médica y no los comparto con terceros.\n\n` +
      `📄 Aviso completo: ${CONSENT_URL}\n\n` +
      `¿Aceptas que guarde tus datos según el aviso?\n\n` +
      `Responde *sí* o *no* 😊`;
  },

  // Tras aceptar el aviso
  bienvenidaNombre: () =>
    `¡Gracias! 😊 ¿Cómo te llamas?`,

  // Rechazo del consentimiento — se borra el registro pendiente
  consentimientoRechazado: () =>
    `Entendido 🙏 Sin tus datos no puedo agendarte citas, pero si cambias de opinión escríbeme cuando quieras.`,

  // Respuesta no comprendida al aviso (ni sí ni no)
  consentimientoPendiente: () =>
    `Para continuar necesito que aceptes el aviso de privacidad.\n\nResponde *sí* para aceptar o *no* para rechazar 😊`,

  // Confirmación de solicitud de baja (ARCO - derecho de cancelación)
  bajaConfirmada: (nombre) =>
    `✅ Listo${nombre ? `, ${nombre}` : ''}. Tus datos fueron dados de baja y tus citas activas canceladas.\n\n` +
    `Si vuelves a escribirnos, te registraremos como paciente nuevo.`,

  bajaAbortada: () =>
    `Perfecto, tus datos siguen seguros 👍 ¿En qué más te puedo ayudar?`,

  bajaPregunta: () =>
    `⚠️ ¿Confirmas que quieres darte de baja?\n\n` +
    `Esto cancelará *todas tus citas activas* y eliminará tus datos personales según tu derecho ARCO (Ley Federal de Protección de Datos).\n\n` +
    `Responde *sí* para confirmar o *no* para cancelar.`,

  pedirCumple: (nombre) =>
    `¡Mucho gusto, *${nombre}*! 😊\n\nPara tu expediente, ¿cuándo es tu cumpleaños?\n\n_Puedes decirlo como quieras, por ejemplo: 15 de marzo de 1990_`,

  registroCompleto: (nombre, edad) =>
    `¡Listo, ${nombre}! Ya quedaste registrado 😊${edad ? ` (${edad} años)` : ''}\n\n` +
    `¿En qué te puedo ayudar?\n\n` +
    `1. Agendar una cita\n2. Consultar mis citas\n3. Cancelar o cambiar una cita\n\n` +
    `O escríbeme lo que necesites con tus palabras 💬`,

  cumpleanosNoValido: () =>
    `Mmm, no me quedó clara la fecha 😅 ¿Me la puedes poner así?:\n\n_15 de julio de 2000_ o _15/07/2000_`,

  // ─── Citas ────────────────────────────────────────────────────────────────

  pedirFecha: () =>
    `📅 ¿Para qué fecha quieres tu cita?\n\n_Ejemplo: "mañana", "próximo lunes", "15 de abril"_`,

  pedirHora: (fecha) =>
    `¿A qué hora te queda bien el *${formatoSoloFecha(fecha)}*? ⏰\n\n_Ejemplo: "3 de la tarde", "10 am", "10:30"_`,

  confirmarCita: (nombre, medico, fechaHora) =>
    `📋 Te confirmo los datos:\n\n` +
    `👨‍⚕️ ${medico}\n` +
    `📅 ${formatoFechaHumano(fechaHora)}\n\n` +
    `¿Le confirmamos? 😊`,

  // Versión interactiva con botones — misma info, contrato { type: 'buttons' }
  confirmarCitaInteractivo: (nombre, medico, fechaHora) => ({
    type: 'buttons',
    text:
      `📋 Te confirmo los datos:\n\n` +
      `👨‍⚕️ ${medico}\n` +
      `📅 ${formatoFechaHumano(fechaHora)}\n\n` +
      `¿Le confirmamos? 😊`,
    footer: CLINICA,
    buttons: [
      { id: 'confirm:si',      text: '✅ Confirmar' },
      { id: 'confirm:cambiar', text: '🔄 Otra fecha' },
      { id: 'confirm:no',      text: '❌ Cancelar' },
    ],
  }),

  pedirPrimeraVisita: () =>
    `👋 ¿Es tu primera visita con nosotros?\n\nResponde *sí* o *no* 😊`,

  pedirMotivo: (esPrimera) =>
    esPrimera
      ? `💬 ¿Cuál es el motivo de tu consulta?\n\nCuéntame cómo te has sentido para que el doctor lo tenga en cuenta antes de que llegues.\n\n_Si prefieres no decirlo, escribe "omitir"_`
      : `💬 ¿Cuál es el motivo de tu consulta?\n\n_Si prefieres no decirlo, escribe "omitir"_`,

  citaAgendada: (nombre, medico, fechaHora) =>
    `¡Listo, ${nombre}! Tu cita quedó agendada 🎉\n\n` +
    `👨‍⚕️ ${medico}\n` +
    `📅 ${formatoSoloFecha(fechaHora)}\n` +
    `⏰ ${formatoSoloHora(fechaHora)}\n\n` +
    `Te mando recordatorio un día antes. ¡Te esperamos!`,

  citaReagendada: (nombre, medico, fechaHora) =>
    `¡Listo! Tu cita quedó reagendada 🔄\n\n` +
    `👨‍⚕️ ${medico}\n` +
    `📅 ${formatoSoloFecha(fechaHora)}\n` +
    `⏰ ${formatoSoloHora(fechaHora)}\n\n` +
    `Te mando recordatorio un día antes. ¡Te esperamos!`,

  agendadoCancelado: () =>
    `Ok, no se agendó nada. ¿Te puedo ayudar con algo más?`,

  conflictoHorario: (horariosAlternos) => {
    let msg = `Ese horario ya está ocupado 😬 Te puedo ofrecer:\n\n`;
    horariosAlternos.forEach((h, i) => {
      msg += `${i+1}. ${formatoFechaHumano(h)}\n`;
    });
    msg += `\n¿Te queda bien alguno, o prefieres otra fecha?`;
    return msg;
  },

  conflictoCalendar: (horariosAlternos) => {
    let msg = `Lo siento, ese horario ya no está disponible 😬\n\n`;
    if (horariosAlternos && horariosAlternos.length > 0) {
      msg += `Te puedo ofrecer:\n`;
      horariosAlternos.forEach((h, i) => {
        msg += `${i+1}. ${formatoFechaHumano(h)}\n`;
      });
      msg += `\n¿Alguna te funciona, o prefieres otra fecha?`;
    } else {
      msg += `Ese día ya no hay horarios disponibles. ¿Quieres elegir otro día?`;
    }
    return msg;
  },

  sinCitaActiva: () =>
    `No tienes citas programadas por el momento.\n\n¿Quieres que te agende una? 😊`,

  citaActual: (nombre, medico, fechaHora, motivo) =>
    `📋 Tu próxima cita:\n\n` +
    `👨‍⚕️ ${medico}\n` +
    `📅 ${formatoSoloFecha(fechaHora)}\n` +
    `⏰ ${formatoSoloHora(fechaHora)}` +
    (motivo ? `\n💬 Motivo: ${motivo}` : '') +
    `\n\n¿Necesitas reagendarla o cancelarla?`,

  // ─── Cancelación ──────────────────────────────────────────────────────────

  confirmarCancelacion: (medico, fechaHora) =>
    `Tienes una cita con *${medico}* el *${formatoFechaHumano(fechaHora)}*.\n\n¿Confirmas que quieres cancelarla?`,

  citaCancelada: () =>
    `Listo, tu cita quedó cancelada ✅\n\n¿Quieres agendar una nueva?`,

  cancelacionAbortada: () =>
    `Perfecto, tu cita sigue en pie 👍 ¿Algo más en que te ayude?`,

  // ─── Recordatorios ────────────────────────────────────────────────────────

  recordatorio24h: (nombre, medico, fechaHora, motivo) =>
    `⏰ ¡Hola, ${nombre}! Te recuerdo que mañana tienes cita:\n\n` +
    `👨‍⚕️ ${medico}\n` +
    `📅 ${formatoFechaHumano(fechaHora)}` +
    (motivo ? `\n💬 ${motivo}` : '') +
    `\n\nSi necesitas cancelar o reagendar, escríbeme. ¡Te esperamos! 🏥`,

  recordatorio2h: (nombre, medico, fechaHora) =>
    `🔔 ¡${nombre}, tu cita es en 2 horas!\n\n` +
    `👨‍⚕️ ${medico}\n` +
    `📅 ${formatoFechaHumano(fechaHora)}\n\n` +
    `Recuerda llegar 10 minutos antes. ¡Te esperamos! 🏥`,

  // ─── Notificaciones al médico ─────────────────────────────────────────────

  notificacionNuevaCita: (nombrePaciente, telefonoPaciente, medico, fechaHora, motivo) =>
    `🏥 *NUEVA CITA AGENDADA*\n\n` +
    `👤 Paciente: ${nombrePaciente}\n` +
    `📞 Teléfono: ${telefonoPaciente}\n` +
    `👨‍⚕️ Médico: ${medico}\n` +
    `📅 Fecha: ${formatoSoloFecha(fechaHora)}\n` +
    `⏰ Hora: ${formatoSoloHora(fechaHora)}\n` +
    (motivo ? `💬 Motivo: ${motivo}\n` : ''),

  notificacionReagendada: (nombrePaciente, telefonoPaciente, medico, fechaHora) =>
    `🔄 *CITA REAGENDADA*\n\n` +
    `👤 Paciente: ${nombrePaciente}\n` +
    `📞 Teléfono: ${telefonoPaciente}\n` +
    `👨‍⚕️ Médico: ${medico}\n` +
    `📅 Nueva fecha: ${formatoSoloFecha(fechaHora)}\n` +
    `⏰ Nueva hora: ${formatoSoloHora(fechaHora)}`,

  notificacionCancelada: (nombrePaciente, telefonoPaciente, medico, fechaHora) =>
    `❌ *CITA CANCELADA*\n\n` +
    `👤 Paciente: ${nombrePaciente}\n` +
    `📞 Teléfono: ${telefonoPaciente}\n` +
    `👨‍⚕️ Médico: ${medico}\n` +
    `📅 Fecha: ${formatoSoloFecha(fechaHora)}\n` +
    `⏰ Hora: ${formatoSoloHora(fechaHora)}`,

  reportePreConsulta: (paciente, cita, medico, historial) => {
    const edad = paciente.fecha_nacimiento ? calcularEdad(paciente.fecha_nacimiento) : null;
    let msg = `📋 *REPORTE PRE-CONSULTA — ${CLINICA}*\n`;
    msg += `${'═'.repeat(32)}\n\n`;
    msg += `👤 *Paciente:* ${paciente.nombre}\n`;
    if (edad) msg += `🎂 *Edad:* ${edad} años\n`;
    msg += `📞 *Teléfono:* ${paciente.telefono}\n\n`;
    msg += `📅 *Cita actual:*\n`;
    msg += `   Fecha: ${formatoFechaHumano(cita.fecha_hora)}\n`;
    if (cita.motivo_consulta) msg += `   Motivo: ${cita.motivo_consulta}\n`;
    if (historial && historial.length > 0) {
      msg += `\n📚 *Historial (últimas ${historial.length} citas):*\n`;
      historial.forEach(h => {
        msg += `   • ${formatoSoloFecha(h.fecha_hora)}: ${h.motivo_consulta || 'Sin motivo'} — ${h.estado}\n`;
      });
    }
    msg += `\n${'═'.repeat(32)}`;
    return msg;
  },

  // ─── Cumpleaños ───────────────────────────────────────────────────────────

  felizCumpleanos: (nombre, edad) =>
    `🎂 ¡Feliz cumpleaños, ${nombre}! 🎉\n\n` +
    (edad ? `¡Hoy cumples ${edad} años! ` : '') +
    `Que tengas un día increíble.\n\n` +
    `Con cariño, todo el equipo de *${CLINICA}* ❤️`,

  // ─── Escalación humano ────────────────────────────────────────────────────

  escaladoHumano: () =>
    `Claro que sí, ahorita te paso con alguien del equipo de *${CLINICA}* para que te atienda personalmente 👨‍⚕️\n\nPor favor espera un momento.`,

  alertaEscalacion: (nombrePaciente, telefono, ultimoMensaje) =>
    `🚨 *PACIENTE SOLICITA ATENCIÓN HUMANA*\n\n` +
    `👤 ${nombrePaciente}\n` +
    `📞 ${telefono}\n` +
    `💬 Último mensaje: "${ultimoMensaje}"\n\n` +
    `Por favor atiéndele lo antes posible.`,

  // ─── Triage de urgencia alta ──────────────────────────────────────────────

  urgenciaAlta: () =>
    `🚨 *Lo que describes suena urgente.*\n\n` +
    `Por tu seguridad, por favor llama al *911* ahora mismo o acude al servicio de urgencias más cercano.\n\n` +
    `Ya le avisé al equipo de *${CLINICA}* para que te contacte lo antes posible. No esperes a que te respondamos si es una emergencia.`,

  alertaUrgenciaAlta: (nombrePaciente, telefono, ultimoMensaje) =>
    `🚨🚨🚨 *POSIBLE URGENCIA CLÍNICA*\n\n` +
    `👤 ${nombrePaciente || '(paciente no registrado)'}\n` +
    `📞 ${telefono}\n` +
    `💬 Mensaje: "${ultimoMensaje}"\n\n` +
    `⚠️ Contacta al paciente de INMEDIATO. Ya se le sugirió llamar al 911.`,

  // ─── Asistencia ───────────────────────────────────────────────────────────

  preguntarAsistencia: (cita) =>
    `🏥 *Verificación de asistencia*\n\n` +
    `¿El paciente *${cita.paciente_nombre}* llegó a su cita de las *${formatoSoloHora(cita.fecha_hora)}*?\n\n` +
    `Responde *sí* si asistió o *no* si no llegó.`,

  asistenciaRegistrada: (nombrePaciente, asistio, siguienteCita) => {
    let msg = asistio
      ? `✅ Registrado. *${nombrePaciente}* asistió a la cita.`
      : `⚠️ Registrado. *${nombrePaciente}* no asistió a la cita.`;
    if (siguienteCita) {
      msg += `\n\n¿Y el paciente *${siguienteCita.paciente_nombre}* que tenía cita a las *${formatoSoloHora(siguienteCita.fecha_hora)}* llegó?\n\nResponde *sí* o *no*.`;
    }
    return msg;
  },

  // ─── Errores y fallbacks ──────────────────────────────────────────────────

  errorServicio: () =>
    `Ay, disculpa, algo falló de mi lado 😅 ¿Me repites tu mensaje por favor?`,

  menuPrincipal: (nombre) =>
    `¡Hola, ${nombre}! ¿En qué te puedo ayudar? 😊\n\n` +
    `1. Agendar una cita\n` +
    `2. Consultar mis citas\n` +
    `3. Cancelar o cambiar una cita\n` +
    `4. Hablar con alguien del equipo\n\n` +
    `O escríbeme lo que necesites 💬`,
};

module.exports = T;
