-- Observabilidad: tabla de eventos para métricas y KPIs.
-- Se usa para medir: tasa de intents, fallback a Groq, ciclo de vida de citas,
-- escalaciones, urgencias. payload en JSON para flexibilidad.

CREATE TABLE IF NOT EXISTS metricas_eventos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo       TEXT NOT NULL,
  telefono   TEXT,
  payload    TEXT,
  creado_en  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_metricas_tipo_fecha ON metricas_eventos (tipo, creado_en);
CREATE INDEX IF NOT EXISTS idx_metricas_telefono   ON metricas_eventos (telefono);
