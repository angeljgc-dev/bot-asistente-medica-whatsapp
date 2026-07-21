'use strict';
/**
 * test-panel-web.js — Smoke test de panel web y /api/panel/series.
 *
 * Monta un Express mínimo que registra los mismos handlers de src/index.js
 * para evitar arrancar WhatsApp. Verifica:
 *   - 401 sin token
 *   - 200 y JSON bien formado con token (Bearer y ?token=)
 *   - panel.html sirve el archivo HTML estático
 *   - series incluye las 4 claves (intents, fallbacks, citas_creadas, citas_canceladas)
 */

process.env.NODE_ENV = 'test';
const path    = require('path');
const http    = require('http');
const express = require('express');
const env     = require('../src/config/env');
const { runMigrations } = require('../src/database/migrate');
const metricasRepo = require('../src/database/repositories/metricasRepo');
const { getDb } = require('../src/database/db');

runMigrations();

// Sembrar algunos eventos para que las series no estén vacías.
const hoy = new Date();
for (let i = 0; i < 5; i++) {
  metricasRepo.registrar('intent_detectado', '5210000000' + i, { q: 'hola' });
}
metricasRepo.registrar('fallback_groq', '5210000001', { q: 'test' });
metricasRepo.registrar('cita_creada', '5210000002', { id: 1 });
metricasRepo.registrar('cita_cancelada', '5210000003', { id: 2 });
metricasRepo.registrar('escalacion', '5210000004', { motivo: 'prueba' });
metricasRepo.registrar('triage_urgencia_alta', '5210000005', { texto_truncado: 'dolor' });

// ── App mínimo que replica los endpoints relevantes ─────────────────────────
const app = express();
app.use(express.json());

function authBearer(req, res, next) {
  const t = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!t || t !== env.API_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use('/static', express.static(path.join(__dirname, 'public')));

function authQuery(req, res, next) {
  const t = (req.query.token || '').trim();
  if (!t || t !== env.API_SECRET_TOKEN) return res.status(401).send('Unauthorized');
  next();
}
app.get('/panel.html', authQuery, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'panel.html'));
});

app.get('/panel', authBearer, (req, res) => {
  const kpi = metricasRepo.kpi7d();
  const total = kpi.intents + kpi.fallbacks;
  const fallback_rate_pct = total > 0
    ? Number(((kpi.fallbacks / total) * 100).toFixed(2))
    : 0;
  res.json({ ventana: '7d', ...kpi, fallback_rate_pct, generado_en: new Date().toISOString() });
});

app.get('/api/panel/series', (req, res) => {
  const bearer = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const qtoken = (req.query.token || '').trim();
  if ((!bearer || bearer !== env.API_SECRET_TOKEN) &&
      (!qtoken || qtoken !== env.API_SECRET_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
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
});

// ── Helpers de HTTP ─────────────────────────────────────────────────────────
function request(port, method, path, { token, bearer } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (bearer) headers['Authorization'] = 'Bearer ' + bearer;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

let total = 0, passed = 0, failed = 0;
function check(id, label, cond, got) {
  total++;
  if (cond) { passed++; process.stdout.write(`  ✅ ${id}: ${label}\n`); }
  else { failed++; process.stdout.write(`  ❌ ${id}: ${label}\n     Got: "${String(got).substring(0, 160)}"\n`); }
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  console.log('\n═══════════════════════════════════════════════');
  console.log('  TEST PANEL WEB');
  console.log(`  Puerto ${port}, token configurado: ${env.API_SECRET_TOKEN ? 'sí' : 'NO'}`);
  console.log('═══════════════════════════════════════════════');

  try {
    // PAN-01: /api/panel/series sin token → 401
    let r = await request(port, 'GET', '/api/panel/series?dias=30');
    check('PAN-01', '/api/panel/series sin token responde 401', r.status === 401, r.status);

    // PAN-02: /api/panel/series con Bearer válido → 200 JSON
    r = await request(port, 'GET', '/api/panel/series?dias=30', { bearer: env.API_SECRET_TOKEN });
    check('PAN-02', '/api/panel/series con Bearer responde 200', r.status === 200, r.status);
    let json = {};
    try { json = JSON.parse(r.body); } catch (_) {}
    check('PAN-03', 'response incluye series.intents array', Array.isArray(json.series?.intents), typeof json.series?.intents);
    check('PAN-04', 'response incluye series.fallbacks', Array.isArray(json.series?.fallbacks), typeof json.series?.fallbacks);
    check('PAN-05', 'response incluye series.citas_creadas', Array.isArray(json.series?.citas_creadas), typeof json.series?.citas_creadas);
    check('PAN-06', 'response incluye series.citas_canceladas', Array.isArray(json.series?.citas_canceladas), typeof json.series?.citas_canceladas);
    check('PAN-07', 'response incluye escalaciones array', Array.isArray(json.escalaciones), typeof json.escalaciones);
    check('PAN-08', 'response incluye urgencias array', Array.isArray(json.urgencias), typeof json.urgencias);
    check('PAN-09', 'series.intents tiene al menos un día con datos', json.series?.intents?.length >= 1, json.series?.intents?.length);

    // PAN-10: /api/panel/series con ?token= → 200
    r = await request(port, 'GET', `/api/panel/series?dias=30&token=${encodeURIComponent(env.API_SECRET_TOKEN)}`);
    check('PAN-10', '/api/panel/series con ?token= responde 200', r.status === 200, r.status);

    // PAN-11: /panel.html sin token → 401
    r = await request(port, 'GET', '/panel.html');
    check('PAN-11', '/panel.html sin token responde 401', r.status === 401, r.status);

    // PAN-12: /panel.html con ?token= → 200 y contiene Chart.js
    r = await request(port, 'GET', `/panel.html?token=${encodeURIComponent(env.API_SECRET_TOKEN)}`);
    check('PAN-12', '/panel.html con token responde 200', r.status === 200, r.status);
    check('PAN-13', '/panel.html HTML incluye Chart.js CDN', /chart\.js/i.test(r.body), r.body.substring(0, 80));
    check('PAN-14', '/panel.html incluye canvas chart-intents', r.body.includes('chart-intents'), '');
    check('PAN-15', '/panel.html incluye canvas chart-citas', r.body.includes('chart-citas'), '');

    // PAN-16: /panel (KPIs) con Bearer → 200 y shape esperado
    r = await request(port, 'GET', '/panel', { bearer: env.API_SECRET_TOKEN });
    check('PAN-16', '/panel con Bearer responde 200', r.status === 200, r.status);
    try { json = JSON.parse(r.body); } catch (_) { json = {}; }
    check('PAN-17', '/panel devuelve fallback_rate_pct numérico', typeof json.fallback_rate_pct === 'number', typeof json.fallback_rate_pct);
    check('PAN-18', '/panel devuelve intents numérico', typeof json.intents === 'number', typeof json.intents);

  } catch (e) {
    console.error('\n💥 Excepción inesperada:', e);
  } finally {
    server.close();
  }

  console.log('\n───────────────────────────────────────────────');
  console.log(`  Resultados: ${passed}/${total} pasaron (${failed} fallaron)`);
  console.log('───────────────────────────────────────────────\n');
  process.exit(failed === 0 ? 0 : 1);
})();
