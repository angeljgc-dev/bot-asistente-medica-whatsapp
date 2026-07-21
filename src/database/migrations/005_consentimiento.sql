-- Compliance LFPDPPP: consentimiento expreso y derecho ARCO de cancelación
-- Columnas NULL permitido: un paciente existente previo a esta migración no tiene
-- consentimiento registrado — se le pedirá la próxima vez que interactúe.

ALTER TABLE pacientes ADD COLUMN consentimiento_fecha TEXT;
ALTER TABLE pacientes ADD COLUMN consentimiento_version TEXT;
ALTER TABLE pacientes ADD COLUMN baja_fecha TEXT;
ALTER TABLE pacientes ADD COLUMN baja_motivo TEXT;

-- Índice para listar bajas (reportes de cumplimiento ARCO).
CREATE INDEX IF NOT EXISTS idx_pacientes_baja ON pacientes(baja_fecha)
  WHERE baja_fecha IS NOT NULL;
