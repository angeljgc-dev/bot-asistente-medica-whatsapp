'use strict';
const logger = require('../utils/logger');

/**
 * Cola de mensajes FIFO por número de teléfono.
 *
 * Garantiza que los mensajes de un mismo usuario se procesen en orden,
 * mientras que diferentes usuarios se procesan en paralelo.
 *
 * Estructura: Map<telefono, Promise>
 * Cada nuevo mensaje encadena su procesamiento al Promise anterior del mismo usuario.
 */
const queues = new Map();

/**
 * Encola el procesamiento de un mensaje y devuelve una Promise que se resuelve
 * con la respuesta a enviar.
 *
 * @param {string}   telefono
 * @param {Function} handler  async () => string|null
 */
function enqueue(telefono, handler) {
  const previous = queues.get(telefono) || Promise.resolve();

  const next = previous
    .then(() => handler())
    .catch(err => {
      logger.error(`Queue error ${telefono}: ${err.message}`);
      return null;
    });

  queues.set(telefono, next.catch(() => {}));  // never fail the chain

  return next;
}

/**
 * Limpieza periódica — elimina entradas resueltas para no acumular memoria.
 * Llamada por node-cron cada 5 minutos.
 */
function cleanupResolved() {
  // En JS no hay forma directa de saber si una Promise está resuelta,
  // así que simplemente limitamos el tamaño del mapa eliminando las más antiguas
  // si supera un umbral razonable (p. ej. 1000 usuarios concurrentes).
  if (queues.size > 1000) {
    const keys = Array.from(queues.keys()).slice(0, 200);
    keys.forEach(k => queues.delete(k));
    logger.debug(`Queue cleanup: eliminadas ${keys.length} entradas antiguas`);
  }
}

module.exports = { enqueue, cleanupResolved };
