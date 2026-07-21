'use strict';
const fs     = require('fs');
const env    = require('../config/env');
const logger = require('../utils/logger');

let google   = null;
let calendar = null;

function init() {
  if (!env.GOOGLE_CALENDAR_ID) {
    logger.info('Google Calendar: GOOGLE_CALENDAR_ID no configurado, integración desactivada');
    return false;
  }
  if (!fs.existsSync(env.GOOGLE_CREDENTIALS_PATH)) {
    logger.warn(`Google Calendar: credenciales no encontradas en ${env.GOOGLE_CREDENTIALS_PATH}`);
    return false;
  }
  try {
    google   = require('googleapis').google;
    const auth = new google.auth.GoogleAuth({
      keyFile: env.GOOGLE_CREDENTIALS_PATH,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });
    calendar = google.calendar({ version: 'v3', auth });
    logger.info('Google Calendar: inicializado correctamente');
    return true;
  } catch (e) {
    logger.error('Google Calendar: error al inicializar', e);
    return false;
  }
}

function isEnabled() {
  return !!calendar;
}

/**
 * Verifica disponibilidad de un slot usando freebusy.query.
 * @returns {{ disponible: boolean, fallback: boolean }}
 */
async function verificarDisponibilidad(inicio, fin) {
  if (!calendar) return { disponible: true, fallback: true };

  try {
    const { data } = await calendar.freebusy.query({
      resource: {
        timeMin:  inicio.toISOString(),
        timeMax:  fin.toISOString(),
        timeZone: 'America/Mexico_City',
        items:    [{ id: env.GOOGLE_CALENDAR_ID }],
      },
    });

    const busy = data.calendars[env.GOOGLE_CALENDAR_ID]?.busy || [];
    return { disponible: busy.length === 0, fallback: false };
  } catch (e) {
    logger.error('Calendar: error verificando disponibilidad', e.message);
    return { disponible: true, fallback: true };  // fail-open
  }
}

/**
 * Crea un evento tentativo ("Reserva temporal") para bloquear el slot
 * mientras el paciente confirma sus datos.
 * @returns {string|null} eventId, o null si el slot ya está ocupado.
 */
async function crearEventoTentativo(nombre, fechaHora, duracionMin = 30) {
  if (!calendar) return null;

  try {
    const inicio = new Date(fechaHora);
    const fin    = new Date(inicio.getTime() + duracionMin * 60_000);

    const { data } = await calendar.events.insert({
      calendarId: env.GOOGLE_CALENDAR_ID,
      resource: {
        summary:     `🔄 Reserva temporal — ${nombre}`,
        description: 'Pendiente de confirmación por el paciente',
        start: { dateTime: inicio.toISOString(), timeZone: 'America/Mexico_City' },
        end:   { dateTime: fin.toISOString(),    timeZone: 'America/Mexico_City' },
        status:  'tentative',
        colorId: '5',  // banana (amarillo)
      },
    });

    logger.info(`Calendar: evento tentativo creado ${data.id} para ${nombre}`);
    return data.id;
  } catch (e) {
    // 409 = conflicto — el slot fue tomado justo antes
    const status = e.code || e.response?.status;
    if (status === 409) {
      logger.warn(`Calendar: conflicto 409 al crear evento tentativo para ${nombre}`);
      return null;
    }
    logger.error('Calendar: error creando evento tentativo', e.message);
    return null;
  }
}

/**
 * Convierte un evento tentativo en confirmado (actualiza summary + status).
 */
async function confirmarEvento(eventId, titulo, descripcion) {
  if (!calendar || !eventId) return false;

  try {
    await calendar.events.patch({
      calendarId: env.GOOGLE_CALENDAR_ID,
      eventId,
      resource: {
        summary:     titulo,
        description: descripcion || '',
        status:      'confirmed',
        colorId:     '2',  // sage (verde)
      },
    });
    logger.info(`Calendar: evento confirmado ${eventId}`);
    return true;
  } catch (e) {
    logger.error(`Calendar: error confirmando evento ${eventId}: ${e.message}`);
    return false;
  }
}

/**
 * Crea un evento confirmado directamente (usado cuando Calendar no tenía tentativo).
 * @returns {string|null} ID del evento creado.
 */
async function crearEvento({ titulo, descripcion, fechaHora, duracionMin = 30 }) {
  if (!calendar) return null;

  try {
    const inicio = new Date(fechaHora);
    const fin    = new Date(inicio.getTime() + duracionMin * 60_000);

    const { data } = await calendar.events.insert({
      calendarId: env.GOOGLE_CALENDAR_ID,
      resource: {
        summary:     titulo,
        description: descripcion || '',
        start: { dateTime: inicio.toISOString(), timeZone: 'America/Mexico_City' },
        end:   { dateTime: fin.toISOString(),    timeZone: 'America/Mexico_City' },
        status:  'confirmed',
        colorId: '2',
      },
    });

    logger.info(`Calendar: evento creado ${data.id}`);
    return data.id;
  } catch (e) {
    logger.error('Calendar: error creando evento', e.message);
    return null;
  }
}

/**
 * Elimina todos los eventos del bot (por patrón de título) en un rango de fechas.
 * Usado exclusivamente por el test-suite para limpiar eventos huérfanos.
 * @returns {number} Cantidad de eventos eliminados.
 */
async function purgarEventosPrueba(timeMin, timeMax) {
  if (!calendar) return 0;

  let count      = 0;
  let pageToken  = null;
  const PATRON   = /^(🔄 Reserva temporal|Cita —)/;

  do {
    const params = {
      calendarId:   env.GOOGLE_CALENDAR_ID,
      timeMin:      timeMin.toISOString(),
      timeMax:      timeMax.toISOString(),
      singleEvents: true,
      maxResults:   250,
    };
    if (pageToken) params.pageToken = pageToken;

    const { data } = await calendar.events.list(params);

    for (const evento of (data.items || [])) {
      if (PATRON.test(evento.summary || '')) {
        try {
          await calendar.events.delete({ calendarId: env.GOOGLE_CALENDAR_ID, eventId: evento.id });
          count++;
          logger.info(`Calendar purga: eliminado ${evento.id} — ${evento.summary}`);
        } catch (e) {
          logger.warn(`Calendar purga: no se pudo eliminar ${evento.id}: ${e.message}`);
        }
      }
    }

    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return count;
}

/**
 * Elimina un evento de Google Calendar.
 */
async function eliminarEvento(eventId) {
  if (!calendar || !eventId) return;

  try {
    await calendar.events.delete({
      calendarId: env.GOOGLE_CALENDAR_ID,
      eventId,
    });
    logger.info(`Calendar: evento eliminado ${eventId}`);
  } catch (e) {
    logger.warn(`Calendar: no se pudo eliminar evento ${eventId}: ${e.message}`);
  }
}

module.exports = {
  init,
  isEnabled,
  verificarDisponibilidad,
  crearEventoTentativo,
  confirmarEvento,
  crearEvento,
  eliminarEvento,
  purgarEventosPrueba,
};
