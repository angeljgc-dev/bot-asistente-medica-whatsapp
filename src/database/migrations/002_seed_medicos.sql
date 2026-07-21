-- Seed inicial: médico principal de la clínica
-- Edita nombre, especialidad y teléfono antes de ejecutar
-- El teléfono debe coincidir con DOCTOR_PHONE en .env

INSERT OR IGNORE INTO medicos
    (nombre, especialidad, telefono, horario_inicio, horario_fin, dias_laborales, duracion_cita_min, activo)
VALUES
    ('Dr. Eduardo Vargas', 'Medicina General', '5219211358856', '08:00', '20:00', 'lun,mar,mie,jue,vie', 30, 1);
