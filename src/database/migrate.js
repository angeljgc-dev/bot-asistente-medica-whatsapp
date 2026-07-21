'use strict';
const fs   = require('fs');
const path = require('path');
const { getDb } = require('./db');
const logger    = require('../utils/logger');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function runMigrations() {
  const db = getDb();

  // Tabla de control de migraciones
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT (datetime('now','localtime'))
    )
  `);

  const applied = new Set(
    db.prepare('SELECT name FROM _migrations').all().map(r => r.name)
  );

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);

    logger.info(`Migración aplicada: ${file}`);
  }

  logger.info('Migraciones completadas');
}

module.exports = { runMigrations };

// Permitir ejecución directa: node src/database/migrate.js
if (require.main === module) {
  runMigrations();
  process.exit(0);
}
