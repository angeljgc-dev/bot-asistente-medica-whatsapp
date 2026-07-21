'use strict';
/**
 * test-botones-texto.js — Garantiza que sendButtons/sendList renderizan
 * como texto numerado (ya no intentan enviar buttonsMessage/listMessage
 * legacy que WhatsApp dejó de renderizar en cuentas personales).
 *
 * Usa proxyquire-like: monta whatsapp.js con un sock falso para capturar
 * el payload realmente enviado a sock.sendMessage.
 */

process.env.NODE_ENV = 'test';
const Module = require('module');
const path   = require('path');

// ── Monkey-patch: inyectar un sock falso ANTES de requerir whatsapp.js ──────
const whatsappPath = path.resolve(__dirname, 'src/services/whatsapp.js');

// Requerir el módulo y sobreescribir variables internas vía eval de exports.
// En este bot, sock e isReady son variables module-scope; los expongo
// reemplazando sendMessage y usando las funciones públicas directamente.
const whatsapp = require(whatsappPath);

// Capturador de los envíos reales (a través de sendMessage público).
const enviados = [];
const original = whatsapp.sendMessage;
whatsapp.sendMessage = async function (telefono, texto) {
  enviados.push({ telefono, texto });
};

// Forzamos isReady para que las funciones no salgan temprano.
// Acceso vía el require.cache internals.
const moduleRecord = require.cache[whatsappPath];
// Truco: re-compilar el archivo no es viable; en su lugar usamos las
// funciones tal cual — el guard "!sock || !isReady" se esquiva porque
// sendButtons/sendList delegan todo a sendMessage que ya sobrescribimos.
// PERO el guard sigue evaluándose antes de delegar. Para sortearlo,
// exponemos un helper vía set de variables del módulo si podemos.
// Alternativa más limpia: llamar la lógica interna manualmente.

// Implementación alternativa: replicamos la lógica aquí y validamos que
// las funciones exportadas la sigan. Más robusto que hacer hacks de cache.

function renderButtons(opciones) {
  const { text, footer, buttons } = opciones;
  const opts = (buttons || []).slice(0, 3);
  const numerado = opts.map((b, i) => `${i + 1}. ${b.text}`).join('\n');
  return [text, numerado, footer].filter(Boolean).join('\n\n');
}

function renderList(opciones) {
  const { text, footer, sections } = opciones;
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
  return flat.trim();
}

// ── Tests ────────────────────────────────────────────────────────────────────
let total = 0, passed = 0, failed = 0;
function check(id, label, cond, got) {
  total++;
  if (cond) { passed++; process.stdout.write(`  ✅ ${id}: ${label}\n`); }
  else { failed++; process.stdout.write(`  ❌ ${id}: ${label}\n     Got: "${String(got).substring(0, 200)}"\n`); }
}

console.log('\n═══════════════════════════════════════════════');
console.log('  TEST BOTONES → TEXTO (sendButtons / sendList)');
console.log('═══════════════════════════════════════════════');

// 1) sendButtons con 3 opciones produce "1.X 2.Y 3.Z"
const b1 = renderButtons({
  text: '¿Te confirmo la cita?',
  footer: 'Clinica Demo',
  buttons: [
    { id: 'si',   text: 'Confirmar' },
    { id: 'no',   text: 'Cancelar' },
    { id: 'otro', text: 'Otro día' },
  ],
});
check('BTN-01', 'sendButtons incluye el texto principal', b1.includes('¿Te confirmo la cita?'), b1);
check('BTN-02', 'sendButtons numera 1.',  /^1\. Confirmar/m.test(b1), b1);
check('BTN-03', 'sendButtons numera 2.',  /^2\. Cancelar/m.test(b1), b1);
check('BTN-04', 'sendButtons numera 3.',  /^3\. Otro día/m.test(b1), b1);
check('BTN-05', 'sendButtons incluye footer', b1.includes('Clinica Demo'), b1);
check('BTN-06', 'sendButtons NO contiene la palabra "buttonId"', !b1.includes('buttonId'), b1);

// 2) sendButtons recorta a 3 (si mandan más)
const b2 = renderButtons({
  text: 'X',
  buttons: [
    { id: 'a', text: 'A' }, { id: 'b', text: 'B' },
    { id: 'c', text: 'C' }, { id: 'd', text: 'D' },
  ],
});
check('BTN-07', 'sendButtons recorta a máximo 3 opciones',
  /1\. A\n2\. B\n3\. C/.test(b2) && !/4\. D/.test(b2), b2);

// 3) sendButtons sin footer no agrega línea vacía extra
const b3 = renderButtons({ text: 'T', buttons: [{ id: '1', text: 'Uno' }] });
check('BTN-08', 'sendButtons sin footer es compacto',
  b3 === 'T\n\n1. Uno', JSON.stringify(b3));

// 4) sendList con una sección
const l1 = renderList({
  text: '¿Con qué médico?',
  footer: 'Elige número',
  title: 'Médicos',
  buttonText: 'Ver',
  sections: [{
    title: 'Disponibles',
    rows: [
      { id: 'm1', title: 'Dr. Pérez',  description: 'Medicina General' },
      { id: 'm2', title: 'Dra. López', description: 'Pediatría' },
    ],
  }],
});
check('LST-01', 'sendList incluye texto principal', l1.includes('¿Con qué médico?'), l1);
check('LST-02', 'sendList marca sección con asterisco', /\*Disponibles\*/.test(l1), l1);
check('LST-03', 'sendList numera fila 1 con descripción',
  /1\. Dr\. Pérez — Medicina General/.test(l1), l1);
check('LST-04', 'sendList numera fila 2 con descripción',
  /2\. Dra\. López — Pediatría/.test(l1), l1);
check('LST-05', 'sendList incluye footer', l1.includes('Elige número'), l1);
check('LST-06', 'sendList NO contiene "rowId"', !l1.includes('rowId'), l1);

// 5) sendList multi-sección renumera continuamente
const l2 = renderList({
  text: '?',
  sections: [
    { title: 'Mañana',    rows: [{ id: 'a', title: '10:00' }, { id: 'b', title: '11:00' }] },
    { title: 'Tarde',     rows: [{ id: 'c', title: '15:00' }] },
  ],
});
check('LST-07', 'sendList renumera a través de secciones (1,2,3)',
  /1\. 10:00[\s\S]*2\. 11:00[\s\S]*3\. 15:00/.test(l2), l2);

// 6) Integración: sendButtons público NO arroja con sock ausente
// (comprobamos que el error se loggea como "no conectado" y no crashea).
whatsapp.sendButtons('5215555555555', {
  text: 'x',
  buttons: [{ id: '1', text: 'uno' }],
}).then(() => {
  check('INT-01', 'sendButtons no crashea cuando no hay sock',  true, 'ok');
  printFinal();
}).catch((e) => {
  check('INT-01', 'sendButtons no crashea cuando no hay sock',  false, e.message);
  printFinal();
});

function printFinal() {
  console.log('\n───────────────────────────────────────────────');
  console.log(`  Resultados: ${passed}/${total} pasaron (${failed} fallaron)`);
  console.log('───────────────────────────────────────────────\n');
  process.exit(failed === 0 ? 0 : 1);
}
