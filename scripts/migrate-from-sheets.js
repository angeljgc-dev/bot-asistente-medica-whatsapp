'use strict';
/**
 * Importa datos de Clinica_AI_Pacientes.xlsx a SQLite.
 * Uso: node scripts/migrate-from-sheets.js [ruta-al-xlsx]
 *
 * Requiere: npm install xlsx (devDependency)
 */

const path = require('path');
const fs   = require('fs');

// Cargar env y BD
require('dotenv').config();
const { runMigrations } = require('../src/database/migrate');
const { getDb }         = require('../src/database/db');
const logger            = require('../src/utils/logger');

runMigrations();

const XLSX_PATH = process.argv[2] ||
  path.join(process.cwd(), '..', 'wb', 'Clinica_AI_Pacientes.xlsx');

if (!fs.existsSync(XLSX_PATH)) {
  logger.error(`Archivo no encontrado: ${XLSX_PATH}`);
  logger.info('Uso: node scripts/migrate-from-sheets.js [ruta-al-xlsx]');
  process.exit(1);
}

let xlsx;
try {
  xlsx = require('xlsx');
} catch {
  logger.error('Por favor ejecuta: npm install --save-dev xlsx');
  process.exit(1);
}

const workbook   = xlsx.readFile(XLSX_PATH);
const sheetName  = workbook.SheetNames[0];
const sheet      = workbook.Sheets[sheetName];
const rows       = xlsx.utils.sheet_to_json(sheet, { defval: '' });

logger.info(`Encontradas ${rows.length} filas en "${sheetName}"`);

const db = getDb();

const insertPaciente = db.prepare(`
  INSERT OR IGNORE INTO pacientes (telefono, nombre, fecha_nacimiento, estado)
  VALUES (?, ?, ?, 'activo')
`);

let importados = 0;
let omitidos   = 0;

for (const row of rows) {
  // Intentar mapear columnas comunes del Excel actual
  const telefono = String(
    row['Teléfono'] || row['telefono'] || row['TELEFONO'] || row['phone'] || ''
  ).trim().replace(/\D/g, '');

  if (!telefono || telefono.length < 7) {
    omitidos++;
    continue;
  }

  const nombre = String(
    row['Nombre'] || row['nombre'] || row['NOMBRE'] || row['name'] || ''
  ).trim();

  const cumpleStr = String(
    row['Cumpleaños'] || row['cumpleanos'] || row['fecha_nacimiento'] ||
    row['Fecha Nacimiento'] || row['birthdate'] || ''
  ).trim();

  let fechaNac = null;
  if (cumpleStr) {
    // Intentar parsear fecha
    const d = new Date(cumpleStr);
    if (!isNaN(d) && d.getFullYear() > 1900) {
      fechaNac = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
  }

  try {
    insertPaciente.run(telefono, nombre || null, fechaNac);
    importados++;
    logger.debug(`Importado: ${telefono} — ${nombre}`);
  } catch (e) {
    logger.warn(`No se pudo importar ${telefono}: ${e.message}`);
    omitidos++;
  }
}

logger.info(`Migración completada: ${importados} importados, ${omitidos} omitidos`);
logger.info(`Total en BD: ${db.prepare('SELECT COUNT(*) as n FROM pacientes').get().n}`);

process.exit(0);
