'use strict';
const env    = require('../config/env');
const logger = require('../utils/logger');

/**
 * Integración con Stripe Checkout para anticipos de cita.
 *
 * Principios de seguridad:
 *   - La tarjeta del paciente nunca pasa por el bot: sólo generamos un link
 *     Stripe Checkout y lo enviamos por WhatsApp.
 *   - Guardamos sólo `stripe_session_id` para reconciliar por webhook.
 *   - Toda confirmación de pago se valida contra la firma de Stripe.
 */

let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY no configurada');
  }
  // eslint-disable-next-line global-require
  const Stripe = require('stripe');
  _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
  return _stripe;
}

/**
 * ¿Cobramos anticipo? Si PAGO_ANTICIPO_CENTAVOS = 0 el flujo del bot salta
 * por completo el paso de pago.
 */
function isEnabled() {
  return env.PAGO_ANTICIPO_CENTAVOS > 0 && !!env.STRIPE_SECRET_KEY;
}

/**
 * Crea una Checkout Session para anticipo de cita.
 * Devuelve { id, url, expiresAt }.
 *
 * La expiración del Session es controlada por Stripe (min 30 min).
 * Nuestro "timeout lógico" PAGO_TIMEOUT_MIN lo gestiona el bot internamente
 * liberando el slot y enviando mensaje de cancelación si no llega el webhook.
 */
async function crearCheckoutSession({ citaId, telefono, descripcion, metadata = {} }) {
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: env.PAGO_MONEDA,
        unit_amount: env.PAGO_ANTICIPO_CENTAVOS,
        product_data: {
          name: descripcion || 'Anticipo de cita médica',
        },
      },
      quantity: 1,
    }],
    success_url: env.STRIPE_SUCCESS_URL,
    cancel_url:  env.STRIPE_CANCEL_URL,
    metadata: {
      ...metadata,
      cita_id: String(citaId || ''),
      telefono: String(telefono || ''),
    },
    // No recolectamos datos del cliente en Stripe — vinculamos por metadata.
  });
  return { id: session.id, url: session.url, expiresAt: session.expires_at };
}

/**
 * Recupera una Checkout Session (para consultar su estado).
 */
async function obtenerSession(sessionId) {
  const stripe = getStripe();
  return stripe.checkout.sessions.retrieve(sessionId);
}

/**
 * Construye un `event` verificando la firma del webhook.
 * Requiere STRIPE_WEBHOOK_SECRET configurado. Si no lo está, lanza explícitamente
 * para que el endpoint responda 400 (nunca aceptamos un webhook sin firma).
 */
function construirEventoWebhook(rawBody, signatureHeader) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error('STRIPE_WEBHOOK_SECRET no configurada');
  }
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, env.STRIPE_WEBHOOK_SECRET);
}

module.exports = {
  isEnabled,
  crearCheckoutSession,
  obtenerSession,
  construirEventoWebhook,
};
