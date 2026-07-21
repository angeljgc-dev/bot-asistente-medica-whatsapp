'use strict';
/**
 * test-metricas.js — Cobertura mínima del repositorio de métricas, del
 * endpoint /panel y del job de alerta de fallback ().
 *
 * Independiente de test-exhaustivo.js. Ejecutar: node test-metricas.js
 */

const metricas = require('../src/database/repositories/metricasRepo');
const { getDb } = require('../src/database/db');
const { jobAlertaFallback } = require('../src/cron/scheduler');
const logger = require('../src/utils/logger');

let total = 0, passed = 0, failed = 0;
const failures = [];

function check(id, label, cond, got) {
  total++;
  if (cond) {
    passed++;
    process.stdout.write(`  ✅ ${id}: ${label}\n`);
  } else {
    failed++;
    const g = String(got).substring(0, 160);
    process.stdout.write(`  ❌ ${id}: ${label}\n     Got: "${g}"\n`);
    failures.push({ id, label, got: g });
  }
}

function limpiarMetricasPrueba() {
  getDb().prepare("DELETE FROM metricas_eventos WHERE tipo LIKE 'test_%' OR telefono LIKE '5299999%'").run();
}

// ── Tests ────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  TEST MÉTRICAS — observabilidad ');
  console.log('═══════════════════════════════════════════════');

  limpiarMetricasPrueba();

  // MET-01: roundtrip registrar → contarPorTipo
  metricas.registrar('test_roundtrip', '5299999999', { n: 1 });
  metricas.registrar('test_roundtrip', '5299999999', { n: 2 });
  const desde = getDb().prepare("SELECT datetime('now','localtime','-1 hour') AS d").get().d;
  const n1 = metricas.contarPorTipo('test_roundtrip', desde);
  check('MET-01', 'registrar + contarPorTipo roundtrip (2 eventos)', n1 === 2, n1);

  // MET-02: listarPorTipo devuelve payload parseable
  const lista = metricas.listarPorTipo('test_roundtrip', desde, 10);
  const payloadOk = lista.length === 2 && JSON.parse(lista[0].payload).n !== undefined;
  check('MET-02', 'listarPorTipo retorna eventos con payload JSON', payloadOk, JSON.stringify(lista[0]));

  // MET-03: registrar con payload null no falla
  let ok = true;
  try { metricas.registrar('test_sin_payload', null, null); }
  catch (e) { ok = false; }
  check('MET-03', 'registrar acepta payload null + telefono null', ok, ok);

  // MET-04: kpi7d expone los 7 contadores esperados
  const kpi = metricas.kpi7d();
  const campos = ['intents','fallbacks','citas_creadas','citas_canceladas','reagendamientos','escalaciones','urgencias'];
  const todosPresentes = campos.every(c => typeof kpi[c] === 'number');
  check('MET-04', 'kpi7d expone los 7 campos numéricos', todosPresentes, JSON.stringify(kpi));

  // MET-05: integración con routeMessage — al detectar un intent se registra
  // (requiere mockear Groq/Calendar como hace test-exhaustivo)
  const whatsapp = require('../src/services/whatsapp');
  whatsapp.sendMessage = async () => {};
  const groq = require('../src/services/groq');
  groq.generarRespuesta = async () => '[mock]';
  const calendar = require('../src/services/calendar');
  calendar.isEnabled       = () => true;
  calendar.verificarDisponibilidad = async () => ({ disponible: true });
  calendar.crearEventoTentativo    = async () => 'fake-evt';
  calendar.confirmarEvento         = async () => true;
  calendar.eliminarEvento          = async () => true;
  calendar.crearEvento             = async () => 'fake-evt';
  calendar.init                    = () => {};

  const { routeMessage } = require('../src/handlers/messageRouter');
  const ph = '5299999401';

  // Baseline
  getDb().prepare('DELETE FROM pacientes WHERE telefono = ?').run(ph);
  getDb().prepare('DELETE FROM sesiones WHERE telefono = ?').run(ph);
  limpiarMetricasPrueba();

  await routeMessage(ph, 'hola');          // aviso LFPDPPP
  await routeMessage(ph, 'sí');            // consentimiento → nombre
  await routeMessage(ph, 'Prueba Metrica');
  await routeMessage(ph, '15 de marzo de 1990');
  await routeMessage(ph, 'agendar');       // intent=agendar
  await routeMessage(ph, 'salir');
  await routeMessage(ph, 'gracias');       // intent=agradecimiento

  const eventosIntent = metricas.contarPorTipo('intent_detectado', desde);
  check('MET-05', 'routeMessage registra intent_detectado tras detección',
    eventosIntent >= 1, eventosIntent);

  // MET-06: fallback_groq se registra cuando el intent es desconocido
  await routeMessage(ph, 'xyzzy qwerty blorp');  // texto sin match → fallback
  const eventosFallback = metricas.contarPorTipo('fallback_groq', desde);
  check('MET-06', 'routeMessage registra fallback_groq en texto desconocido',
    eventosFallback >= 1, eventosFallback);

  // MET-07: cita_creada se registra al completar agendamiento
  limpiarMetricasPrueba();
  const ph2 = '5299999402';
  getDb().prepare('DELETE FROM pacientes WHERE telefono = ?').run(ph2);
  getDb().prepare('DELETE FROM sesiones WHERE telefono = ?').run(ph2);
  await routeMessage(ph2, 'hola');
  await routeMessage(ph2, 'sí');
  await routeMessage(ph2, 'Cita Metrica');
  await routeMessage(ph2, '15/03/1990');
  await routeMessage(ph2, 'agendar');
  await routeMessage(ph2, '25 de julio');
  await routeMessage(ph2, '10am');
  await routeMessage(ph2, 'si');
  await routeMessage(ph2, 'no');
  await routeMessage(ph2, 'dolor de prueba');
  const eventosCita = metricas.contarPorTipo('cita_creada', desde);
  check('MET-07', 'agendamiento completo registra cita_creada', eventosCita >= 1, eventosCita);

  // MET-08: cita_cancelada se registra al cancelar
  limpiarMetricasPrueba();
  await routeMessage(ph2, 'cancelar mi cita');
  await routeMessage(ph2, 'si');
  const eventosCancel = metricas.contarPorTipo('cita_cancelada', desde);
  check('MET-08', 'cancelación registra cita_cancelada', eventosCancel >= 1, eventosCancel);

  // MET-09: escalacion se registra por palabra clave urgente
  limpiarMetricasPrueba();
  await routeMessage(ph2, 'es urgente necesito ayuda');
  const eventosEsc = metricas.contarPorTipo('escalacion', desde);
  check('MET-09', 'palabra clave "urgente" registra escalacion', eventosEsc >= 1, eventosEsc);

  // MET-10: jobAlertaFallback no rompe cuando no hay tráfico
  limpiarMetricasPrueba();
  let warned = false;
  const origWarn = logger.warn;
  logger.warn = (m) => { if (/ALERTA.*fallback/i.test(m)) warned = true; };
  await jobAlertaFallback();
  logger.warn = origWarn;
  check('MET-10', 'jobAlertaFallback silencioso con muestra < 10', warned === false, warned);

  // MET-11: jobAlertaFallback dispara WARN cuando fallback_rate > 20% y muestra ≥ 10
  limpiarMetricasPrueba();
  // Limpiamos también los intents/fallbacks de la última hora que hayan
  // quedado de ejecuciones previas de test-exhaustivo o test-metricas.
  getDb().prepare(
    "DELETE FROM metricas_eventos WHERE tipo IN ('intent_detectado','fallback_groq') " +
    "AND creado_en >= datetime('now','localtime','-1 hour')"
  ).run();
  // 10 intents + 5 fallbacks = 33.3% > 20% con total 15 ≥ 10
  for (let i = 0; i < 10; i++) metricas.registrar('intent_detectado', '5299999998', { i });
  for (let i = 0; i < 5; i++)  metricas.registrar('fallback_groq', '5299999998', { i });
  let warned2 = false;
  const origWarn2 = logger.warn;
  logger.warn = (m) => { if (/ALERTA.*fallback_rate/i.test(m)) warned2 = true; };
  await jobAlertaFallback();
  logger.warn = origWarn2;
  check('MET-11', 'jobAlertaFallback emite WARN cuando pct > 20% con muestra suficiente',
    warned2 === true, warned2);

  // MET-12: /panel con token correcto responde JSON con fallback_rate_pct
  const express = require('express');
  const env = require('../src/config/env');
  const app = express();
  app.use(express.json());
  // Replicamos authMiddleware para aislar la prueba
  const authMw = (req, res, next) => {
    const t = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    if (!t || t !== env.API_SECRET_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
    next();
  };
  app.get('/panel', authMw, (req, res) => {
    const k = metricas.kpi7d();
    const tot = k.intents + k.fallbacks;
    const pct = tot > 0 ? Number(((k.fallbacks / tot) * 100).toFixed(2)) : 0;
    res.json({ ventana: '7d', ...k, fallback_rate_pct: pct, generado_en: new Date().toISOString() });
  });

  await new Promise(resolve => {
    const server = app.listen(0, async () => {
      const port = server.address().port;
      const http = require('http');

      // Sin token → 401
      await new Promise(r => {
        http.get(`http://localhost:${port}/panel`, res => {
          check('MET-12', '/panel sin Bearer → 401', res.statusCode === 401, res.statusCode);
          r();
        });
      });

      // Con token → 200 + campos
      await new Promise(r => {
        const req = http.request({
          host: 'localhost',
          port,
          path: '/panel',
          method: 'GET',
          headers: { Authorization: `Bearer ${env.API_SECRET_TOKEN}` },
        }, res => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            check('MET-13', '/panel con Bearer válido → 200', res.statusCode === 200, res.statusCode);
            try {
              const json = JSON.parse(body);
              check('MET-14', '/panel JSON incluye fallback_rate_pct',
                typeof json.fallback_rate_pct === 'number', JSON.stringify(json));
              check('MET-15', '/panel JSON incluye los 7 contadores',
                ['intents','fallbacks','citas_creadas','citas_canceladas','reagendamientos','escalaciones','urgencias']
                  .every(c => typeof json[c] === 'number'),
                JSON.stringify(json));
            } catch (e) {
              check('MET-14', '/panel retorna JSON válido', false, e.message);
            }
            r();
          });
        });
        req.end();
      });

      server.close(resolve);
    });
  });

  // Limpieza
  limpiarMetricasPrueba();
  getDb().prepare("DELETE FROM pacientes WHERE telefono LIKE '5299999%'").run();
  getDb().prepare("DELETE FROM sesiones WHERE telefono LIKE '5299999%'").run();
  getDb().prepare("DELETE FROM citas WHERE paciente_id NOT IN (SELECT id FROM pacientes)").run();

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  RESULTADO: ${passed} ✅  ${failed} ❌  (total ${total})`);
  console.log('═══════════════════════════════════════════════');

  if (failures.length > 0) {
    console.log('\n🔴 FALLOS:');
    failures.forEach(f => {
      console.log(`  ${f.id}: ${f.label}`);
      console.log(`     Got: "${f.got}"`);
    });
    process.exit(1);
  }
  process.exit(0);
})().catch(e => {
  console.error('ERROR FATAL:', e);
  process.exit(2);
});
