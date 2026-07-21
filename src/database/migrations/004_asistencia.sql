-- 004_asistencia.sql
-- Agrega seguimiento de asistencia a citas.
-- asistencia_preguntada: 1 cuando el bot ya le preguntó al médico si el paciente llegó.
-- El estado de la cita (completada / no_asistio) registra la respuesta.

ALTER TABLE citas ADD COLUMN asistencia_preguntada INTEGER NOT NULL DEFAULT 0;
