'use strict';
const pacienteRepo   = require('../database/repositories/pacienteRepo');
const sessionManager = require('../session/sessionManager');
const { extraerFechaNacimiento } = require('../parsers/dateParser');
const { normalizarTexto }        = require('../parsers/textNormalizer');
const { detectarIntencion }      = require('../parsers/intentParser');
const T                          = require('../utils/messageTemplates');
const { calcularEdad }           = require('../utils/dateFormatter');
const { ESTADOS, ESTADOS_PACIENTE, CONSENT_VERSION } = require('../config/constants');
const logger = require('../utils/logger');

/**
 * Maneja el flujo de registro de un nuevo paciente.
 * Devuelve la respuesta a enviar al usuario.
 */
async function manejarRegistro(sesion, paciente, texto) {
  const tel = sesion.telefono;

  // Recuperación: si la sesión está en idle pero el paciente tiene un estado de registro
  // en curso, restauramos el estado de sesión desde el paciente. Esto sucede cuando
  // Baileys repite mensajes de una sesión anterior o la sesión se pierde entre mensajes.
  if (sesion.estado_flujo === ESTADOS.IDLE && paciente) {
    if (paciente.estado === ESTADOS_PACIENTE.ESPERANDO_CONSENTIMIENTO) {
      logger.warn(`Registro recovery ${tel}: esperando consentimiento — restaurando estado`);
      sessionManager.cambiarEstado(sesion, ESTADOS.ESPERANDO_CONSENTIMIENTO);
    } else if (paciente.estado === ESTADOS_PACIENTE.REGISTRANDO_CUMPLE ||
        (paciente.estado === ESTADOS_PACIENTE.REGISTRANDO_NOMBRE && paciente.nombre)) {
      logger.warn(`Registro recovery ${tel}: paciente.estado=${paciente.estado} con sesión idle — restaurando REGISTRANDO_CUMPLE`);
      sessionManager.cambiarEstado(sesion, ESTADOS.REGISTRANDO_CUMPLE);
    } else if (paciente.estado === ESTADOS_PACIENTE.REGISTRANDO_NOMBRE && !paciente.nombre) {
      logger.warn(`Registro recovery ${tel}: sesión idle sin nombre — restaurando REGISTRANDO_NOMBRE`);
      sessionManager.cambiarEstado(sesion, ESTADOS.REGISTRANDO_NOMBRE);
    }
  }

  // Estado: esperando consentimiento LFPDPPP
  if (sesion.estado_flujo === ESTADOS.ESPERANDO_CONSENTIMIENTO) {
    const intencion = detectarIntencion(texto);

    if (intencion === 'confirmar_si') {
      pacienteRepo.setConsentimiento(tel, new Date(), CONSENT_VERSION);
      pacienteRepo.setEstado(tel, ESTADOS_PACIENTE.REGISTRANDO_NOMBRE);
      sessionManager.cambiarEstado(sesion, ESTADOS.REGISTRANDO_NOMBRE);
      logger.info(`Consentimiento aceptado por ${tel} (versión ${CONSENT_VERSION})`);
      return T.bienvenidaNombre();
    }

    if (intencion === 'confirmar_no') {
      // Nunca consintió — hard delete permitido
      pacienteRepo.deleteByTelefono(tel);
      sessionManager.resetear(sesion);
      logger.info(`Consentimiento rechazado por ${tel} — registro eliminado`);
      return T.consentimientoRechazado();
    }

    return T.consentimientoPendiente();
  }

  // Estado: esperando nombre
  if (sesion.estado_flujo === ESTADOS.REGISTRANDO_NOMBRE) {
    const nombre = extraerNombre(texto);

    if (!nombre) {
      return '❓ No pude identificar tu nombre. Por favor escríbelo completo, por ejemplo: "Juan Pérez"';
    }

    pacienteRepo.setNombre(tel, nombre);
    sessionManager.cambiarEstado(sesion, ESTADOS.REGISTRANDO_CUMPLE);

    return T.pedirCumple(nombre);
  }

  // Estado: esperando fecha de nacimiento
  if (sesion.estado_flujo === ESTADOS.REGISTRANDO_CUMPLE) {
    const fecha = extraerFechaNacimiento(texto);

    if (!fecha) {
      return T.cumpleanosNoValido();
    }

    pacienteRepo.setFechaNacimiento(tel, fecha);
    sessionManager.resetear(sesion);

    const nombre = pacienteRepo.findByTelefono(tel)?.nombre || '';
    const edad   = calcularEdad(fecha);

    logger.info(`Paciente registrado: ${nombre} (${tel})`);
    return T.registroCompleto(nombre, edad);
  }

  // Primera vez — iniciar flujo con aviso de privacidad LFPDPPP
  pacienteRepo.create(tel);
  pacienteRepo.setEstado(tel, ESTADOS_PACIENTE.ESPERANDO_CONSENTIMIENTO);
  sessionManager.cambiarEstado(sesion, ESTADOS.ESPERANDO_CONSENTIMIENTO);

  return T.bienvenidaNuevo();
}

/**
 * Extrae el nombre del mensaje. Acepta múltiples formatos:
 * - "Juan Pérez"
 * - "mi nombre es Juan Pérez"
 * - "me llamo Juan Pérez"
 * - "soy Juan Pérez"
 */
function extraerNombre(texto) {
  if (!texto) return null;

  const t = texto.trim();

  // Patrones con prefijo
  const patrones = [
    /mi\s+nombre\s+es\s+(.+)/i,
    /me\s+llamo\s+(.+)/i,
    /soy\s+(.+)/i,
    /llamenme\s+(.+)/i,
    /puedes\s+llamarme\s+(.+)/i,
  ];

  for (const p of patrones) {
    const m = t.match(p);
    if (m) {
      const nombre = limpiarNombre(m[1]);
      if (nombre) return nombre;
    }
  }

  // Si el texto parece directamente un nombre (2-4 palabras, sin números, > 3 chars)
  const palabras   = t.trim().split(/\s+/);
  const soloLetras = /^[a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s]+$/i.test(t.trim());

  // Palabras que NO son nombres — saludos, respuestas, interjecciones
  const NO_NOMBRES = new Set([
    'hola','hello','hi','hey','buenas','buenos','saludos','buen','dia','dias',
    'tardes','noches','ola','oye','ey','que','tal','onda',
    'si','no','ok','okay','vale','bien','mal','gracias','porfa',
    'adios','bye','chao','hasta','luego','pronto','nos','vemos',
    'omitir','saltar','skip','cancelar','salir','menu','volver',
    'nada','todo','algo','alguien','nadie',
    // Verbos de acción / palabras de intención que no son nombres
    'ocupo','necesito','quiero','puedo','quisiera','podria','puedes',
    'agendar','reagendar','cita','consulta','doctor','medico',
    'me','le','una','un','para','por','con','del','los','las',
    'urge','ayuda','favor','pedir','hacer','ver','como',
  ]);

  const primeraPalabra = palabras[0].toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (soloLetras && palabras.length >= 1 && palabras.length <= 5 && t.length >= 3
      && !NO_NOMBRES.has(primeraPalabra)) {
    return limpiarNombre(t);
  }

  return null;
}

function limpiarNombre(nombre) {
  return nombre
    .trim()
    .replace(/[^a-záéíóúüñA-ZÁÉÍÓÚÜÑ\s']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(' ') || null;
}

module.exports = { manejarRegistro, extraerNombre };
