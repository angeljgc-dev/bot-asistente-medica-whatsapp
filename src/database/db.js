'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const logger   = require('../utils/logger');

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'clinic.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  _db = new Database(DB_PATH, { verbose: null });

  // Performance y seguridad
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');
  _db.pragma('foreign_keys = ON');
  _db.pragma('synchronous = NORMAL');

  logger.info(`Base de datos abierta: ${DB_PATH}`);
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
    logger.info('Base de datos cerrada');
  }
}

module.exports = { getDb, closeDb };
