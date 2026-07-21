-- 008_nps.sql
-- Encuesta NPS post-consulta.
-- El job diario a las 19:00 busca citas 'completada' cerradas 24–26 h atrás
-- sin NPS previo, envía la encuesta y guarda la respuesta aquí.

CREATE TABLE IF NOT EXISTS nps_respuestas (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  cita_id          INTEGER REFERENCES citas(id),
  telefono         TEXT NOT NULL,
  puntaje          INTEGER,                  -- 0..10, NULL hasta que responde
  comentario       TEXT,
  enviado_en       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  respondido_en    TEXT
);

CREATE INDEX IF NOT EXISTS idx_nps_cita     ON nps_respuestas (cita_id);
CREATE INDEX IF NOT EXISTS idx_nps_telefono ON nps_respuestas (telefono);
CREATE INDEX IF NOT EXISTS idx_nps_enviado  ON nps_respuestas (enviado_en);
