-- 009_pagos.sql
-- Pagos con anticipo (Stripe Checkout).
-- Registramos el session_id para reconciliar vía webhook.
-- No guardamos nunca tokens de pago ni datos de tarjeta.

CREATE TABLE IF NOT EXISTS pagos (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  cita_id             INTEGER REFERENCES citas(id),
  telefono            TEXT NOT NULL,
  stripe_session_id   TEXT UNIQUE NOT NULL,
  monto_centavos      INTEGER NOT NULL,
  moneda              TEXT NOT NULL DEFAULT 'mxn',
  estado              TEXT NOT NULL DEFAULT 'pendiente'
    CHECK(estado IN ('pendiente','exitoso','fallido','expirado')),
  metadata            TEXT,
  creado_en           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado_en      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_pagos_telefono ON pagos (telefono);
CREATE INDEX IF NOT EXISTS idx_pagos_cita     ON pagos (cita_id);
CREATE INDEX IF NOT EXISTS idx_pagos_estado   ON pagos (estado);
