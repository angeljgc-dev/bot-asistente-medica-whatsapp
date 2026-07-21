'use strict';
const path    = require('path');
const qrcode  = require('qrcode-terminal');
const QRCode  = require('qrcode');
const logger  = require('../utils/logger');

let sock       = null;   // Baileys socket
let isReady    = false;
let currentQR  = null;   // Raw QR string (para el endpoint /qr)

// Map: stripped_lid_number → original_raw_jid
// Needed to send responses back to @lid devices correctly
const lidJidMap = new Map();

// Deduplicación de mensajes: cubre dos casos de Baileys
// 1) mismo msg.key.id entregado dos veces
// 2) mismo contenido (phone+text) dentro de una ventana corta (IDs distintos, protocolo multi-device)
const _processedIds  = new Set();                // dedup por ID exacto
const _recentContent = new Map();               // dedup por contenido: "phone|text" → timestamp
const _DEDUP_ID_TTL_MS      = 60_000;           // 1 min
const _DEDUP_CONTENT_WIN_MS = 5_000;            // 5 segundos

// Contactos personales a ignorar — configurado en .env como IGNORED_PHONES=5211234..,5217654..
// env.js normaliza la lista; aquí la volvemos Set para lookup O(1) por número.
const env = require('../config/env');
const _IGNORED_PHONES = new Set(env.IGNORED_PHONES || []);

function _isDuplicate(msgId, phone, text) {
  // 1. Por ID
  if (msgId && _processedIds.has(msgId)) return true;

  // 2. Por contenido dentro de ventana de 5s
  const key = `${phone}|${text}`;
  const last = _recentContent.get(key);
  if (last && Date.now() - last < _DEDUP_CONTENT_WIN_MS) return true;

  // Registrar
  if (msgId) {
    _processedIds.add(msgId);
    setTimeout(() => _processedIds.delete(msgId), _DEDUP_ID_TTL_MS);
  }
  _recentContent.set(key, Date.now());
  setTimeout(() => _recentContent.delete(key), _DEDUP_CONTENT_WIN_MS);
  return false;
}

function getCurrentQR() { return currentQR; }

/**
 * Inicializa la conexión de Baileys.
 * onMessage(telefono, texto) se llama con cada mensaje entrante.
 */
async function init(onMessage) {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    makeInMemoryStore,
  } = require('@whiskeysockets/baileys');

  const Pino = require('pino');
  const baileysLogger = Pino({ level: 'silent' });

  const AUTH_DIR = path.join(process.cwd(), 'auth', 'baileys_auth');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  logger.info(`Baileys versión: ${version.join('.')}`);

  sock = makeWASocket({
    version,
    logger: baileysLogger,
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    browser: ['Clinica Bot', 'Chrome', '3.0.0'],
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      logger.info('📱 QR listo — abre http://localhost:3000/qr en Chrome y escanéalo');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      isReady = true;
      logger.info('✅ WhatsApp conectado correctamente');
      // Marcar al bot como "online" globalmente. SIN esto, los presence updates
      // 'composing' no aparecen como "escribiendo…" en el chat del paciente.
      // (Baileys: sock.sendPresenceUpdate('available') sin JID = presencia global)
      sock.sendPresenceUpdate('available').catch(e => {
        logger.warn(`No se pudo marcar presence available global: ${e.message}`);
      });
    }

    if (connection === 'close') {
      isReady = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn(`WhatsApp desconectado (código ${code}), reconectando: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(() => init(onMessage), 5000);
      } else {
        logger.error('Sesión cerrada. Borra auth/baileys_auth/ y reinicia.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message)   continue;

      // Ignorar mensajes viejos (> 2 min) para evitar que Baileys replaye mensajes
      // de sesiones anteriores al reconectar
      const msgTimestamp = msg.messageTimestamp;
      if (msgTimestamp && (Date.now() / 1000 - msgTimestamp) > 120) {
        logger.debug(`Mensaje antiguo ignorado [${msg.key.id}] ts=${msgTimestamp}`);
        continue;
      }

      const rawJid = msg.key.remoteJid;
      const telefono = rawJid
        .replace(/@s\.whatsapp\.net$/, '')
        .replace(/@c\.us$/, '')
        .replace(/:\d+@lid$/, '')   // strip lid format "number:0@lid"
        .replace(/@lid$/, '');       // strip plain @lid
      if (!telefono || rawJid.includes('g.us')) continue;        // ignorar grupos
      if (rawJid === 'status@broadcast') continue;             // ignorar estados de WhatsApp
      if (_IGNORED_PHONES.has(telefono)) continue;             // ignorar contactos personales

      // Store @lid → original JID mapping so responses go to the right place
      if (rawJid.includes('@lid')) {
        lidJidMap.set(telefono, rawJid);
      }

      // Respuestas interactivas de WhatsApp:
      // - buttonsResponseMessage.selectedButtonId  → texto es el buttonId (ej "menu:agendar")
      // - templateButtonReplyMessage.selectedId    → formato legacy
      // - listResponseMessage.singleSelectReply.selectedRowId  → texto es el rowId (ej "slot:2026-04-22T10:00:00Z")
      // El router interpreta estos prefijos ('menu:', 'slot:', 'medico:', 'confirm:') como si fueran texto natural.
      const buttonId = msg.message.buttonsResponseMessage?.selectedButtonId
                    || msg.message.templateButtonReplyMessage?.selectedId;
      const rowId    = msg.message.listResponseMessage?.singleSelectReply?.selectedRowId
                    || msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;

      const texto =
        buttonId ||
        rowId ||
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!texto.trim()) {
        // Check if it's a media message we can't process
        const msgContent = msg.message;
        const isMedia = msgContent.audioMessage || msgContent.stickerMessage ||
                        msgContent.documentMessage || msgContent.contactMessage ||
                        msgContent.locationMessage || msgContent.videoMessage ||
                        (msgContent.imageMessage && !msgContent.imageMessage.caption);
        if (isMedia) {
          logger.info(`📥 ${telefono}: [mensaje multimedia]`);
          try {
            await onMessage(telefono, '__MEDIA_NO_SOPORTADO__');
          } catch (e) {
            logger.error(`Error procesando media de ${telefono}:`, e);
          }
        }
        continue;
      }

      // Deduplicar: mismo ID o mismo contenido en ventana de 5s
      if (_isDuplicate(msg.key.id, telefono, texto.trim())) {
        logger.warn(`⚠ Duplicado ignorado [${msg.key.id}] ${telefono}: ${texto.substring(0, 40)}`);
        continue;
      }

      logger.info(`📥 ${telefono}: ${texto.substring(0, 80)}`);

      try {
        await onMessage(telefono, texto.trim());
      } catch (e) {
        logger.error(`Error procesando mensaje de ${telefono}:`, e);
      }
    }
  });
}

/**
 * Resuelve el JID para enviar: prefiere el @lid mapeado, cae a @s.whatsapp.net.
 */
function _resolverJid(telefono) {
  if (lidJidMap.has(telefono)) return lidJidMap.get(telefono);
  if (telefono.includes('@'))  return telefono;
  return `${telefono}@s.whatsapp.net`;
}

/**
 * Envía un mensaje de texto a un número.
 */
async function sendMessage(telefono, texto) {
  if (!sock || !isReady) {
    logger.error('sendMessage: WhatsApp no conectado');
    return;
  }
  const jid = _resolverJid(telefono);
  try {
    await sock.sendMessage(jid, { text: texto });
    logger.debug(`📤 → ${jid}: ${texto.substring(0, 60)}`);
  } catch (e) {
    logger.error(`sendMessage error → ${telefono}: ${e.message}`);
  }
}

/**
 * Calcula la duración del "escribiendo..." en función del largo del texto.
 *
 * Objetivo: que se sienta humano, no programado. Antes era 800-2500ms; quedaba
 * muy seco para mensajes largos (lista de horarios, confirmaciones). Ahora:
 *   - Mínimo 1.4s (siempre se ve el "escribiendo…" un par de segundos)
 *   - ~28ms por carácter (≈ velocidad realista de tipeo en móvil)
 *   - Tope 4.5s (no aburre al usuario en mensajes muy largos)
 *   - Pequeño jitter ±200ms para evitar que dos respuestas seguidas tengan
 *     exactamente la misma duración.
 */
function _typingDelay(texto) {
  const base    = Math.min(Math.max(texto.length * 28, 1400), 4500);
  const jitter  = (Math.random() * 400) - 200;
  return Math.round(base + jitter);
}

async function _enviarConTyping(telefono, texto) {
  const jid = _resolverJid(telefono);
  try {
    const delay = _typingDelay(texto);

    // 1) Suscribirse a la presencia del chat (necesario para enviar updates a este JID)
    await sock.presenceSubscribe(jid);
    // 2) Marcar nuestra presencia como disponible para ESTE chat (algunos clientes
    // sólo muestran "escribiendo…" si previamente nos vieron como "en línea")
    await sock.sendPresenceUpdate('available', jid);
    // 3) "escribiendo…"
    await sock.sendPresenceUpdate('composing', jid);

    // El indicador 'composing' expira en ~10s del lado del cliente; si vamos
    // a esperar más, lo refrescamos a la mitad del tiempo para que no parpadee.
    let refreshTimer = null;
    if (delay > 8000) {
      refreshTimer = setInterval(() => {
        sock.sendPresenceUpdate('composing', jid).catch(() => {});
      }, 7000);
    }

    await new Promise(r => setTimeout(r, delay));
    if (refreshTimer) clearInterval(refreshTimer);

    await sock.sendPresenceUpdate('paused', jid);
    await sock.sendMessage(jid, { text: texto });
    logger.debug(`📤 → ${telefono} (typing ${delay}ms): ${texto.substring(0, 60)}`);
  } catch (e) {
    logger.error(`sendMessage error → ${telefono}: ${e.message}`);
  }
}

async function sendMessageWithTyping(telefono, texto) {
  if (!sock || !isReady) {
    logger.error('sendMessage: WhatsApp no conectado');
    return;
  }
  await _enviarConTyping(telefono, texto);
}

/**
 * Envía "botones" como lista numerada en texto plano.
 *
 * Decisión: WhatsApp dejó de renderizar buttonsMessage/listMessage en cuentas
 * personales (post-2023). Baileys los envía sin error, pero el cliente los
 * muestra como texto sin los botones clickeables, causando UX confusa
 * ("¿cómo activo los botones?"). La API moderna `interactiveMessage` tampoco
 * es confiable en cuentas personales.
 *
 * Por eso siempre renderizamos como texto numerado: el flujo de entrada ya
 * acepta "1", "2", "3" vía el intent `menu_opcion`. Se mantiene la firma
 * y el payload `{ type: 'buttons', ... }` para no romper a los callers.
 *
 * @param {string} telefono
 * @param {{ text:string, footer?:string, buttons:Array<{id:string,text:string}> }} opciones
 */
async function sendButtons(telefono, { text, footer, buttons }) {
  if (!sock || !isReady) {
    logger.error('sendButtons: WhatsApp no conectado');
    return;
  }
  const opciones = (buttons || []).slice(0, 3);
  const numerado = opciones.map((b, i) => `${i + 1}. ${b.text}`).join('\n');
  const cuerpo = [text, numerado, footer].filter(Boolean).join('\n\n');
  // Como va a texto plano, mantenemos la sensación humana con el indicador "escribiendo…"
  await _enviarConTyping(telefono, cuerpo);
}

/**
 * Envía un list message como texto numerado con secciones.
 *
 * Mismo razonamiento que `sendButtons`: listMessage no se renderiza en
 * clientes actuales de WhatsApp para cuentas personales. Se mantiene la
 * firma para no romper callers; el usuario responde con el número.
 *
 * @param {string} telefono
 * @param {{ text:string, footer?:string, title:string, buttonText:string,
 *           sections:Array<{ title:string, rows:Array<{id:string,title:string,description?:string}> }> }} opciones
 */
async function sendList(telefono, { text, footer, title, buttonText, sections }) {
  if (!sock || !isReady) {
    logger.error('sendList: WhatsApp no conectado');
    return;
  }
  let flat = text + '\n\n';
  let idx = 1;
  for (const s of (sections || [])) {
    if (s.title) flat += `*${s.title}*\n`;
    for (const r of (s.rows || [])) {
      flat += `${idx++}. ${r.title}`;
      if (r.description) flat += ` — ${r.description}`;
      flat += '\n';
    }
    flat += '\n';
  }
  if (footer) flat += '\n' + footer;
  // Mismo razonamiento que en sendButtons: texto plano + indicador de escritura.
  await _enviarConTyping(telefono, flat.trim());
}

function getIsReady() { return isReady; }

module.exports = {
  init,
  sendMessage,
  sendMessageWithTyping,
  sendButtons,
  sendList,
  getIsReady,
  getCurrentQR,
  QRCode,
};
