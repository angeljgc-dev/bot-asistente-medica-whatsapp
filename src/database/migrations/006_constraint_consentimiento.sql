-- Actualizar CHECK constraint de pacientes.estado para incluir
-- 'esperando_consentimiento' (LFPDPPP). SQLite no permite ALTER CHECK, así
-- que reconstruimos la tabla preservando todos los datos.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE pacientes_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telefono         TEXT UNIQUE NOT NULL,
  nombre           TEXT,
  fecha_nacimiento DATE,
  estado           TEXT NOT NULL DEFAULT 'nuevo'
    CHECK(estado IN ('nuevo','esperando_consentimiento','registrando_nombre','registrando_cumple','activo','inactivo')),
  created_at       DATETIME DEFAULT (datetime('now','localtime')),
  updated_at       DATETIME DEFAULT (datetime('now','localtime')),
  curp             TEXT,
  consentimiento_fecha    TEXT,
  consentimiento_version  TEXT,
  baja_fecha       TEXT,
  baja_motivo      TEXT
);

INSERT INTO pacientes_new (id, telefono, nombre, fecha_nacimiento, estado,
  created_at, updated_at, curp, consentimiento_fecha, consentimiento_version,
  baja_fecha, baja_motivo)
SELECT id, telefono, nombre, fecha_nacimiento, estado,
       created_at, updated_at, curp, consentimiento_fecha, consentimiento_version,
       baja_fecha, baja_motivo
FROM pacientes;

DROP TABLE pacientes;
ALTER TABLE pacientes_new RENAME TO pacientes;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pacientes_telefono ON pacientes(telefono);
CREATE INDEX IF NOT EXISTS idx_pacientes_estado ON pacientes(estado);
CREATE INDEX IF NOT EXISTS idx_pacientes_baja ON pacientes(baja_fecha)
  WHERE baja_fecha IS NOT NULL;

COMMIT;

PRAGMA foreign_keys = ON;
