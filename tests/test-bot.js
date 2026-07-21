'use strict';
/**
 * test-bot.js — Simula una conversación completa con el bot desde terminal.
 * Uso: node test-bot.js
 * No usa WhatsApp real; llama directamente al messageRouter.
 */

const readline = require('readline');
const { routeMessage } = require('../src/handlers/messageRouter');

// Número de teléfono de prueba (inventado, no existe en WA)
const TEST_PHONE = '5200000000001';

const rl = readline.createInterface({
  input:  process.stdin,
  output: process.stdout,
});

console.log('\n========================================');
console.log(' 🤖  Bot Clínica Cabrera — Modo Prueba  ');
console.log('========================================');
console.log(` Teléfono simulado: ${TEST_PHONE}`);
console.log(' Escribe "salir" para terminar.\n');

async function enviar(texto) {
  try {
    const respuesta = await routeMessage(TEST_PHONE, texto);
    if (respuesta) {
      console.log(`\n🤖 Bot: ${respuesta}\n`);
    } else {
      console.log('\n🤖 Bot: [sin respuesta]\n');
    }
  } catch (e) {
    console.error('\n❌ Error:', e.message, '\n');
  }
}

function preguntar() {
  rl.question('👤 Tú: ', async (input) => {
    const texto = input.trim();
    if (!texto) { preguntar(); return; }
    if (texto.toLowerCase() === 'salir') {
      console.log('\nSesión de prueba terminada.\n');
      rl.close();
      process.exit(0);
    }
    await enviar(texto);
    preguntar();
  });
}

// Arrancar con un "hola" automático
(async () => {
  await enviar('hola');
  preguntar();
})();
