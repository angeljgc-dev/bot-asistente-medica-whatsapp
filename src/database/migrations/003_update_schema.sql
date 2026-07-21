-- 003_update_schema.sql
-- Agrega: primera_visita / recordatorio_2h a citas,
-- curp a pacientes,
-- horario_almuerzo + horario_sabado_fin a medicos
-- y actualiza el horario del Dr. Ejemplo al esquema nuevo.

ALTER TABLE citas ADD COLUMN primera_visita INTEGER NOT NULL DEFAULT 0;
ALTER TABLE citas ADD COLUMN recordatorio_2h_enviado INTEGER NOT NULL DEFAULT 0;

ALTER TABLE pacientes ADD COLUMN curp TEXT;

ALTER TABLE medicos ADD COLUMN horario_almuerzo_inicio TEXT;
ALTER TABLE medicos ADD COLUMN horario_almuerzo_fin     TEXT;
ALTER TABLE medicos ADD COLUMN horario_sabado_fin        TEXT;

-- Horario Dr. Ejemplo:
-- Lun-Vie 09:00-14:00 mañana, 16:00-20:00 tarde (almuerzo 14-16)
-- Sábado  09:00-13:00 (sin tarde)
UPDATE medicos SET
  horario_inicio          = '09:00',
  horario_fin             = '20:00',
  horario_almuerzo_inicio = '14:00',
  horario_almuerzo_fin    = '16:00',
  horario_sabado_fin      = '13:00',
  dias_laborales          = 'lun,mar,mie,jue,vie,sab'
WHERE nombre = 'Dr. Ejemplo';
