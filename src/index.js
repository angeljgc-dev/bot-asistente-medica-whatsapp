'use strict';

// ── Cargar variables de entorno primero ───────────────────────────────────
const env    = require('./config/env');
const logger = require('./utils/logger');

logger.info(`🏥 ${env.CLINIC_NAME} — Bot WhatsApp v2.0 iniciando...`);
logger.info(`Entorno: ${env.NODE_ENV}`);

// ── Migraciones BD ─────────────────────────────────────────────────────────
const { runMigrations } = require('./database/migrate');
runMigrations();

// ── Servicios ──────────────────────────────────────────────────────────────
const whatsapp      = require('./services/whatsapp');
const calendar      = require('./services/calendar');
const { routeMessage } = require('./handlers/messageRouter');
const { enqueue }   = require('./queue/messageQueue');
const { iniciarScheduler } = require('./cron/scheduler');
const express       = require('express');

// ── Google Calendar (opcional) ─────────────────────────────────────────────
calendar.init();

// ── Limpiar eventos tentativos huérfanos de reinicios anteriores ───────────
(async () => {
  const { getDb } = require('./database/db');
  try {
    const ahora = Date.now();
    const sesionesConTentativo = getDb()
      .prepare(`SELECT telefono, datos_temporales FROM sesiones WHERE datos_temporales LIKE '%tentativo_calendar_id%'`)
      .all();

    for (const row of sesionesConTentativo) {
      try {
        const datos = JSON.parse(row.datos_temporales || '{}');
        const { tentativo_calendar_id, tentativa_expira } = datos;
        if (!tentativo_calendar_id) continue;

        // Si ya expiró, eliminar el evento tentativo de Calendar
        const expira = tentativa_expira ? new Date(tentativa_expira).getTime() : 0;
        if (expira < ahora) {
          await calendar.eliminarEvento(tentativo_calendar_id);
          // Limpiar del session data
          delete datos.tentativo_calendar_id;
          delete datos.tentativa_expira;
          getDb().prepare(`UPDATE sesiones SET datos_temporales = ? WHERE telefono = ?`)
            .run(JSON.stringify(datos), row.telefono);
          logger.info(`Startup: tentativo huérfano eliminado ${tentativo_calendar_id} (${row.telefono})`);
        }
      } catch (e) {
        logger.warn(`Startup: error limpiando tentativo de ${row.telefono}: ${e.message}`);
      }
    }
  } catch (e) {
    logger.warn(`Startup: error en limpieza de tentativos: ${e.message}`);
  }
})();

// ── Inicializar WhatsApp ───────────────────────────────────────────────────
whatsapp.init(async (telefono, texto) => {
  const respuesta = await enqueue(telefono, () => routeMessage(telefono, texto));

  if (!respuesta) return;

  // Respuesta puede ser string (texto plano) o un objeto interactivo.
  // Contrato: { type: 'buttons'|'list', ...payload }.
  if (typeof respuesta === 'string') {
    await whatsapp.sendMessageWithTyping(telefono, respuesta);
  } else if (respuesta.type === 'buttons') {
    await whatsapp.sendButtons(telefono, respuesta);
  } else if (respuesta.type === 'list') {
    await whatsapp.sendList(telefono, respuesta);
  } else {
    logger.error(`Respuesta de tipo desconocido: ${JSON.stringify(respuesta).substring(0, 200)}`);
  }
});

// ── Scheduler (recordatorios y cumpleaños) ─────────────────────────────────
iniciarScheduler();

// ── Servidor HTTP ──────────────────────────────────────────────────────────
const app = express();

// Stripe webhook — DEBE ir ANTES de express.json() porque la firma
// se calcula sobre el raw body. express.raw preserva el Buffer.
app.post('/stripe-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const pagos    = require('./services/pagos');
      const pagoRepo = require('./database/repositories/pagoRepo');
      const metricasRepo = require('./database/repositories/metricasRepo');

      const signature = req.headers['stripe-signature'];
      if (!signature) return res.status(400).send('Missing signature');

      let event;
      try {
        event = pagos.construirEventoWebhook(req.body, signature);
      } catch (err) {
        logger.warn(`Stripe webhook firma inválida: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const telefono = session.metadata?.telefono;
        pagoRepo.marcarEstado(session.id, 'exitoso');
        try { metricasRepo.registrar('pago_exitoso', telefono, { session_id: session.id }); } catch (_) {}

        logger.info(`Pago exitoso: session=${session.id} telefono=${telefono}`);

        // Notificar al paciente por WhatsApp y avanzar su flujo.
        if (telefono) {
          try {
            await whatsapp.sendMessage(
              telefono,
              '✅ ¡Pago recibido! Tu cita queda confirmada. Te esperamos.'
            );
          } catch (e) {
            logger.warn(`Pago: no se pudo notificar ${telefono}: ${e.message}`);
          }
        }
      } else if (event.type === 'checkout.session.expired' ||
                 event.type === 'payment_intent.payment_failed') {
        const session = event.data.object;
        pagoRepo.marcarEstado(session.id || session.metadata?.session_id, 'fallido');
        try {
          const tel = session.metadata?.telefono;
          metricasRepo.registrar('pago_fallido', tel, { type: event.type });
        } catch (_) {}
      }

      res.json({ received: true });
    } catch (e) {
      logger.error(`stripe-webhook error: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  }
);

app.use(express.json());

// Autenticación por Bearer token
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token      = authHeader.replace('Bearer ', '').trim();

  if (!token || token !== env.API_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Enviar mensaje desde Google Calendar / externo
app.post('/send-message', authMiddleware, async (req, res) => {
  const { telefono, mensaje } = req.body;

  if (!telefono || !mensaje) {
    return res.status(400).json({ error: 'Faltan parámetros: telefono, mensaje' });
  }

  try {
    await whatsapp.sendMessage(telefono, mensaje);
    logger.info(`HTTP /send-message → ${telefono}`);
    res.json({ success: true });
  } catch (e) {
    logger.error(`HTTP /send-message error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// QR code para escanear con WhatsApp
app.get('/qr', async (req, res) => {
  const { getCurrentQR, QRCode: QR } = require('./services/whatsapp');
  const qrString = getCurrentQR();

  if (whatsapp.getIsReady()) {
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ WhatsApp ya está conectado</h2></body></html>');
  }

  if (!qrString) {
    return res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>⏳ Esperando QR... recarga en 3 segundos</h2><script>setTimeout(()=>location.reload(),3000)</script></body></html>');
  }

  const dataUrl = await QR.toDataURL(qrString, { width: 350, margin: 2 });
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#fff">
    <h2>📱 Escanea con WhatsApp</h2>
    <p>Abre WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${dataUrl}" style="border-radius:12px"/>
    <p style="color:#aaa">Esta página se recarga automáticamente</p>
    <script>setTimeout(()=>location.reload(),15000)</script>
  </body></html>`);
});

// Aviso de privacidad público (LFPDPPP) — URL que el bot envía a los pacientes
app.get('/aviso-privacidad', (req, res) => {
  const { CONSENT_VERSION } = require('./config/constants');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<title>Aviso de Privacidad — ${env.CLINIC_NAME}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:0 auto;padding:32px 20px;line-height:1.65;color:#222;background:#fafafa}
  h1{color:#1a5490;border-bottom:2px solid #1a5490;padding-bottom:8px}
  h2{color:#1a5490;margin-top:28px}
  .version{color:#666;font-size:0.9em;margin-top:-8px}
  a{color:#1a5490}
  .nota{background:#fff7d6;border-left:4px solid #e3b341;padding:12px 16px;margin:20px 0;border-radius:4px}
</style>
</head><body>
<h1>Aviso de Privacidad</h1>
<p class="version">Versión ${CONSENT_VERSION} — Vigente</p>

<h2>1. Identidad del responsable</h2>
<p><strong>${env.CLINIC_NAME}</strong> (en lo sucesivo, "la Clínica") es el responsable del tratamiento de los datos personales que recabamos a través del canal de WhatsApp, conforme a la <em>Ley Federal de Protección de Datos Personales en Posesión de los Particulares</em> (LFPDPPP).</p>

<h2>2. Datos personales que recabamos</h2>
<ul>
  <li>Nombre completo</li>
  <li>Fecha de nacimiento</li>
  <li>Número de teléfono (WhatsApp)</li>
  <li>Motivo de consulta (proporcionado voluntariamente)</li>
  <li>Historial de citas agendadas, confirmadas, reagendadas o canceladas</li>
</ul>
<p>No recabamos datos bancarios, CURP, RFC ni identificaciones oficiales por este canal.</p>

<h2>3. Finalidades del tratamiento</h2>
<p>Usamos tus datos exclusivamente para:</p>
<ul>
  <li>Agendar, reagendar, confirmar y cancelar tus citas médicas.</li>
  <li>Enviarte recordatorios 24 horas y 2 horas antes de tu cita.</li>
  <li>Registrar tu asistencia para mejorar la atención.</li>
  <li>Felicitarte en tu cumpleaños (opcional).</li>
  <li>Transmitir al médico el motivo de consulta antes de tu cita.</li>
</ul>

<h2>4. Transferencias</h2>
<p>No transferimos tus datos a terceros, salvo obligación legal o requerimiento de autoridad competente. La agenda médica se sincroniza con Google Calendar como herramienta operativa interna de la Clínica.</p>

<h2>5. Derechos ARCO</h2>
<p>Puedes ejercer tus derechos de <strong>Acceso, Rectificación, Cancelación y Oposición</strong> en cualquier momento:</p>
<ul>
  <li><strong>Por WhatsApp</strong>: envía la palabra <code>baja</code> para cancelar tus datos y citas activas.</li>
  <li><strong>Por correo</strong>: escribe a <a href="mailto:privacidad@${(env.CLINIC_NAME||'clinica').toLowerCase().replace(/\\s+/g,'-')}.mx">el correo de privacidad de la Clínica</a> solicitando acceso o rectificación.</li>
</ul>

<h2>6. Medidas de seguridad</h2>
<p>Tus datos se almacenan cifrados en reposo, con acceso restringido al personal autorizado. Implementamos registros de auditoría de accesos y eliminación segura bajo solicitud ARCO.</p>

<h2>7. Cambios al aviso</h2>
<p>Cualquier modificación a este aviso se publicará en esta misma URL con una nueva versión. Los pacientes deberán re-confirmar el consentimiento al interactuar con la Clínica tras un cambio mayor.</p>

<div class="nota">
  <strong>Consentimiento:</strong> al responder "sí" en el chat, aceptas los términos de este aviso en su versión ${CONSENT_VERSION}.
</div>
</body></html>`);
});

// Endpoints ARCO (acceso y cancelación) — protegidos con Bearer token
app.get('/arco/:telefono', authMiddleware, (req, res) => {
  const pacienteRepoLocal = require('./database/repositories/pacienteRepo');
  const citaRepoLocal     = require('./database/repositories/citaRepo');
  const p = pacienteRepoLocal.findByTelefono(req.params.telefono);
  if (!p) return res.status(404).json({ error: 'Paciente no encontrado' });

  const citasActivas = citaRepoLocal.findAllActivasPaciente(p.id);
  const historial    = citaRepoLocal.findHistorialPaciente(p.id, 100);
  logger.info(`ARCO acceso: exportados datos de ${req.params.telefono}`);
  res.json({
    paciente:       p,
    citas_activas:  citasActivas,
    historial,
    exportado_en:   new Date().toISOString(),
  });
});

app.delete('/arco/:telefono', authMiddleware, async (req, res) => {
  const pacienteRepoLocal = require('./database/repositories/pacienteRepo');
  const citaRepoLocal     = require('./database/repositories/citaRepo');
  const calendarLocal     = require('./services/calendar');

  const p = pacienteRepoLocal.findByTelefono(req.params.telefono);
  if (!p) return res.status(404).json({ error: 'Paciente no encontrado' });

  // Cancelar citas activas y liberar Calendar antes de la baja
  const citasActivas = citaRepoLocal.findAllActivasPaciente(p.id);
  for (const c of citasActivas) {
    if (c.google_calendar_event_id) {
      try { await calendarLocal.eliminarEvento(c.google_calendar_event_id); }
      catch (e) { logger.error(`ARCO delete: error borrando evento: ${e.message}`); }
    }
    citaRepoLocal.cancelar(c.id);
  }

  pacienteRepoLocal.darDeBaja(req.params.telefono, req.body?.motivo || 'Solicitud ARCO vía endpoint');
  logger.info(`ARCO baja: procesada para ${req.params.telefono} — ${citasActivas.length} cita(s) canceladas`);
  res.json({ success: true, citas_canceladas: citasActivas.length });
});

// Panel de KPIs — observabilidad básica para operaciones de clínica.
// Requiere Bearer token (reutiliza authMiddleware). Ventana fija de 7 días.
app.get('/panel', authMiddleware, (req, res) => {
  try {
    const metricasRepo = require('./database/repositories/metricasRepo');
    const kpi = metricasRepo.kpi7d();
    const total = kpi.intents + kpi.fallbacks;
    const fallbackRatePct = total > 0
      ? Number(((kpi.fallbacks / total) * 100).toFixed(2))
      : 0;
    res.json({
      ventana: '7d',
      desde: kpi.desde,
      intents: kpi.intents,
      fallbacks: kpi.fallbacks,
      citas_creadas: kpi.citas_creadas,
      citas_canceladas: kpi.citas_canceladas,
      reagendamientos: kpi.reagendamientos,
      escalaciones: kpi.escalaciones,
      urgencias: kpi.urgencias,
      fallback_rate_pct: fallbackRatePct,
      generado_en: new Date().toISOString(),
    });
  } catch (e) {
    logger.error(`GET /panel error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Panel web — estáticos
const path = require('path');
app.use('/static', express.static(path.join(__dirname, '..', 'public')));

// Auth por query-param para el HTML del panel (pop-ups con Bearer no son triviales).
function authQueryMiddleware(req, res, next) {
  const t = (req.query.token || '').trim();
  if (!t || t !== env.API_SECRET_TOKEN) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

app.get('/panel.html', authQueryMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'panel.html'));
});

// Series diarias para gráficas del panel web.
app.get('/api/panel/series', (req, res) => {
  // Acepta Bearer o query-token para facilitar fetch desde la página.
  const bearer = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const qtoken = (req.query.token || '').trim();
  if ((!bearer || bearer !== env.API_SECRET_TOKEN) &&
      (!qtoken || qtoken !== env.API_SECRET_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const metricasRepo = require('./database/repositories/metricasRepo');
    const dias = Math.min(parseInt(req.query.dias || '30', 10) || 30, 180);
    const series = {
      intents:          metricasRepo.serieDiaria('intent_detectado', dias),
      fallbacks:        metricasRepo.serieDiaria('fallback_groq', dias),
      citas_creadas:    metricasRepo.serieDiaria('cita_creada', dias),
      citas_canceladas: metricasRepo.serieDiaria('cita_cancelada', dias),
    };
    const escalaciones = metricasRepo.ultimos('escalacion', 20);
    const urgencias    = metricasRepo.ultimos('triage_urgencia_alta', 20);
    res.json({ dias, series, escalaciones, urgencias });
  } catch (e) {
    logger.error(`GET /api/panel/series error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Broadcasts segmentados
// POST /broadcast  { segmento, mensaje, force? }
app.post('/broadcast', authMiddleware, async (req, res) => {
  try {
    const { segmento, mensaje, force } = req.body || {};
    if (!segmento || !mensaje) {
      return res.status(400).json({ error: 'Faltan campos: segmento, mensaje' });
    }
    const broadcast = require('./services/broadcast');
    const resultado = await broadcast.enviarBroadcast(segmento, mensaje, {
      force: !!force,
    });
    res.json(resultado);
  } catch (e) {
    logger.error(`POST /broadcast error: ${e.message}`);
    res.status(400).json({ error: e.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    whatsapp: whatsapp.getIsReady() ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

app.listen(env.PORT, () => {
  logger.info(`🌐 Servidor HTTP en puerto ${env.PORT}`);
  logger.info(`   GET  http://localhost:${env.PORT}/health`);
  logger.info(`   POST http://localhost:${env.PORT}/send-message  (Bearer token)`);
});

// ── Manejo de salida limpia ────────────────────────────────────────────────
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function shutdown(signal) {
  logger.info(`${signal} recibido — cerrando...`);
  const { closeDb } = require('./database/db');
  closeDb();
  process.exit(0);
}
