'use strict';
require('dotenv').config();

function require_env(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Variable de entorno faltante: ${name}`);
  return val;
}

module.exports = {
  GROQ_API_KEY:            require_env('GROQ_API_KEY'),
  DOCTOR_PHONE:            require_env('DOCTOR_PHONE'),
  DOCTOR_NAME:             process.env.DOCTOR_NAME || 'Dr. Ejemplo',
  CLINIC_NAME:             process.env.CLINIC_NAME || 'Clínica Médica',
  CLINIC_HOURS:            process.env.CLINIC_HOURS || 'Lunes a Viernes, 8:00 AM a 8:00 PM',
  API_SECRET_TOKEN:        process.env.API_SECRET_TOKEN || 'dev-token-inseguro',
  GOOGLE_CREDENTIALS_PATH: process.env.GOOGLE_CREDENTIALS_PATH || './auth/google-credentials.json',
  GOOGLE_CALENDAR_ID:      process.env.GOOGLE_CALENDAR_ID || '',
  PORT:                    parseInt(process.env.PORT || '3000', 10),
  NODE_ENV:                process.env.NODE_ENV || 'development',
  // Contactos personales del dueño del número (separados por coma). Se ignoran en whatsapp.js.
  IGNORED_PHONES:          (process.env.IGNORED_PHONES || '').split(',').map(p => p.trim()).filter(Boolean),

  // Pagos con Stripe. Si PAGO_ANTICIPO_CENTAVOS=0 el flujo se salta.
  STRIPE_SECRET_KEY:        process.env.STRIPE_SECRET_KEY || '',
  STRIPE_WEBHOOK_SECRET:    process.env.STRIPE_WEBHOOK_SECRET || '',
  STRIPE_SUCCESS_URL:       process.env.STRIPE_SUCCESS_URL || 'https://example.com/pago-ok',
  STRIPE_CANCEL_URL:        process.env.STRIPE_CANCEL_URL  || 'https://example.com/pago-cancelado',
  PAGO_ANTICIPO_CENTAVOS:   parseInt(process.env.PAGO_ANTICIPO_CENTAVOS || '0', 10),  // 0 = sin anticipo
  PAGO_MONEDA:              process.env.PAGO_MONEDA || 'mxn',
  PAGO_TIMEOUT_MIN:         parseInt(process.env.PAGO_TIMEOUT_MIN || '15', 10),
};
