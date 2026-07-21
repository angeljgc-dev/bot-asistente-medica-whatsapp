'use strict';

// Horario de atención por defecto (HH:MM)
const HORARIO_DEFAULT = { inicio: '08:00', fin: '20:00' };

// Días laborales codificados
const DIAS_SEMANA = { lun: 1, mar: 2, mie: 3, jue: 4, vie: 5, sab: 6, dom: 0 };

// Duración por defecto de una cita (minutos)
const DURACION_CITA_MIN = 30;

// Timeout de sesión inactiva (milisegundos) — 10 minutos
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

// Buffer entre citas (minutos) — tiempo de limpieza/preparación
const BUFFER_ENTRE_CITAS_MIN = 15;

// Timeout de reserva tentativa en Calendar (milisegundos) — 5 minutos
const TENTATIVA_TIMEOUT_MS = 5 * 60 * 1000;

// Máximo de mensajes en historial de IA
const MAX_HISTORIAL_IA = 10;

// Ventana de tolerancia para recordatorios (minutos)
const VENTANA_RECORDATORIO_MIN = 10;

// Estados de flujo de la máquina de estados
const ESTADOS = {
  IDLE:                 'idle',
  REGISTRANDO_NOMBRE:   'registrando_nombre',
  REGISTRANDO_CUMPLE:   'registrando_cumple',
  ELIGIENDO_MEDICO:     'eligiendo_medico',
  ELIGIENDO_FECHA:      'eligiendo_fecha',
  ELIGIENDO_HORA:       'eligiendo_hora',
  CONFIRMANDO_CITA:     'confirmando_cita',
  PIDIENDO_MOTIVO:      'pidiendo_motivo',
  CANCELANDO_CITA:      'cancelando_cita',
  REAGENDANDO_CITA:     'reagendando_cita',
  ESCALADO_HUMANO:      'escalado_humano',
  CAMBIANDO_NOMBRE:          'cambiando_nombre',
  CAMBIANDO_CUMPLE:          'cambiando_cumple',
  PIDIENDO_PRIMERA_VISITA:   'pidiendo_primera_visita',
  ESPERANDO_CONSENTIMIENTO:  'esperando_consentimiento',
  SOLICITANDO_BAJA:          'solicitando_baja',
  ESPERANDO_NPS_PUNTAJE:     'esperando_nps_puntaje',
  ESPERANDO_NPS_COMENTARIO:  'esperando_nps_comentario',
};

// Estados de cita en BD
const ESTADOS_CITA = {
  PENDIENTE_CONFIRMACION: 'pendiente_confirmacion',
  PROGRAMADA:             'programada',
  CONFIRMADA:             'confirmada',
  COMPLETADA:             'completada',
  CANCELADA:              'cancelada',
  NO_ASISTIO:             'no_asistio',
};

// Estados de paciente en BD
const ESTADOS_PACIENTE = {
  NUEVO:                    'nuevo',
  ESPERANDO_CONSENTIMIENTO: 'esperando_consentimiento',
  REGISTRANDO_NOMBRE:       'registrando_nombre',
  REGISTRANDO_CUMPLE:       'registrando_cumple',
  ACTIVO:                   'activo',
  INACTIVO:                 'inactivo',
};

// Modelo de Groq a usar
const GROQ_MODEL = 'llama-3.1-8b-instant';

// Compliance LFPDPPP — versión y URL del aviso de privacidad.
// Al cambiar el aviso, incrementa la versión; los pacientes con versión anterior
// deben re-consentir antes de continuar (no implementado aún — fase posterior).
const CONSENT_VERSION = 'v1.0';
const CONSENT_URL     = process.env.CONSENT_URL
                     || `http://localhost:${process.env.PORT || '3000'}/aviso-privacidad`;

// Timeout para llamadas a APIs externas (ms)
const API_TIMEOUT_MS = 30_000;

module.exports = {
  HORARIO_DEFAULT,
  DIAS_SEMANA,
  DURACION_CITA_MIN,
  SESSION_TIMEOUT_MS,
  BUFFER_ENTRE_CITAS_MIN,
  TENTATIVA_TIMEOUT_MS,
  MAX_HISTORIAL_IA,
  VENTANA_RECORDATORIO_MIN,
  ESTADOS,
  ESTADOS_CITA,
  ESTADOS_PACIENTE,
  GROQ_MODEL,
  API_TIMEOUT_MS,
  CONSENT_VERSION,
  CONSENT_URL,
};
