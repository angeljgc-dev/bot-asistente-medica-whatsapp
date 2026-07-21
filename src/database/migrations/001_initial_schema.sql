PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

-- =====================================================================
-- PACIENTES
-- =====================================================================
CREATE TABLE IF NOT EXISTS pacientes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono         TEXT UNIQUE NOT NULL,
    nombre           TEXT,
    fecha_nacimiento DATE,
    estado           TEXT NOT NULL DEFAULT 'nuevo'
        CHECK(estado IN ('nuevo','registrando_nombre','registrando_cumple','activo','inactivo')),
    created_at       DATETIME DEFAULT (datetime('now','localtime')),
    updated_at       DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pacientes_telefono ON pacientes(telefono);
CREATE INDEX IF NOT EXISTS idx_pacientes_estado ON pacientes(estado);

-- =====================================================================
-- MÉDICOS
-- =====================================================================
CREATE TABLE IF NOT EXISTS medicos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre            TEXT NOT NULL,
    especialidad      TEXT NOT NULL DEFAULT 'Medicina General',
    telefono          TEXT NOT NULL,
    horario_inicio    TEXT NOT NULL DEFAULT '08:00',
    horario_fin       TEXT NOT NULL DEFAULT '20:00',
    dias_laborales    TEXT NOT NULL DEFAULT 'lun,mar,mie,jue,vie',
    duracion_cita_min INTEGER NOT NULL DEFAULT 30,
    activo            INTEGER NOT NULL DEFAULT 1
);

-- =====================================================================
-- CITAS
-- =====================================================================
CREATE TABLE IF NOT EXISTS citas (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id                 INTEGER NOT NULL REFERENCES pacientes(id),
    medico_id                   INTEGER NOT NULL REFERENCES medicos(id),
    fecha_hora                  DATETIME NOT NULL,
    duracion_min                INTEGER NOT NULL DEFAULT 30,
    motivo_consulta             TEXT,
    sintomas                    TEXT,
    notas_previas               TEXT,
    estado                      TEXT NOT NULL DEFAULT 'programada'
        CHECK(estado IN ('pendiente_confirmacion','programada','confirmada',
                         'completada','cancelada','no_asistio')),
    google_calendar_event_id    TEXT,
    recordatorio_24h_enviado    INTEGER NOT NULL DEFAULT 0,
    recordatorio_1h_enviado     INTEGER NOT NULL DEFAULT 0,
    recordatorio_medico_enviado INTEGER NOT NULL DEFAULT 0,
    created_at                  DATETIME DEFAULT (datetime('now','localtime')),
    updated_at                  DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_citas_conflicto
    ON citas(medico_id, fecha_hora, estado);
CREATE INDEX IF NOT EXISTS idx_citas_recordatorios
    ON citas(estado, fecha_hora, recordatorio_24h_enviado, recordatorio_1h_enviado);
CREATE INDEX IF NOT EXISTS idx_citas_paciente
    ON citas(paciente_id, estado);

-- =====================================================================
-- HISTORIAL DE CONSULTAS
-- =====================================================================
CREATE TABLE IF NOT EXISTS historial_consultas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id   INTEGER NOT NULL REFERENCES pacientes(id),
    cita_id       INTEGER REFERENCES citas(id),
    diagnostico   TEXT,
    tratamiento   TEXT,
    notas_medico  TEXT,
    created_at    DATETIME DEFAULT (datetime('now','localtime'))
);

-- =====================================================================
-- SESIONES CONVERSACIONALES
-- =====================================================================
CREATE TABLE IF NOT EXISTS sesiones (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    telefono            TEXT UNIQUE NOT NULL,
    estado_flujo        TEXT NOT NULL DEFAULT 'idle',
    datos_temporales    TEXT NOT NULL DEFAULT '{}',
    historial_mensajes  TEXT NOT NULL DEFAULT '[]',
    ultima_actividad    DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sesiones_telefono ON sesiones(telefono);

-- =====================================================================
-- TRIGGERS: updated_at automático
-- =====================================================================
CREATE TRIGGER IF NOT EXISTS trg_pacientes_updated_at
AFTER UPDATE ON pacientes BEGIN
    UPDATE pacientes SET updated_at = datetime('now','localtime') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_citas_updated_at
AFTER UPDATE ON citas BEGIN
    UPDATE citas SET updated_at = datetime('now','localtime') WHERE id = NEW.id;
END;
