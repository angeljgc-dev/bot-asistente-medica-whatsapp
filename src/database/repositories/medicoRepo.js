'use strict';
const { getDb }              = require('../db');
const { BUFFER_ENTRE_CITAS_MIN } = require('../../config/constants');

function findActivos() {
  return getDb()
    .prepare('SELECT * FROM medicos WHERE activo = 1 ORDER BY id')
    .all();
}

function findById(id) {
  return getDb()
    .prepare('SELECT * FROM medicos WHERE id = ?')
    .get(id) || null;
}

function findByTelefono(telefono) {
  return getDb()
    .prepare('SELECT * FROM medicos WHERE telefono = ?')
    .get(telefono) || null;
}

/**
 * Si sólo hay un médico activo lo devuelve; si hay varios, devuelve null.
 */
function getMedicoUnico() {
  const activos = findActivos();
  return activos.length === 1 ? activos[0] : null;
}

/**
 * Devuelve true si la hora dada está dentro del horario laboral del médico
 * en la fecha dada, respetando el descanso de almuerzo y el horario de sábado.
 */
function esDentroHorario(medico, fecha, horaH, horaM = 0) {
  const diaSemana = fecha.getDay(); // 0=dom … 6=sab
  const esSabado  = diaSemana === 6;

  const hIni  = parseInt(medico.horario_inicio, 10);
  const hFin  = esSabado && medico.horario_sabado_fin
                ? parseInt(medico.horario_sabado_fin, 10)
                : parseInt(medico.horario_fin, 10);

  // Fuera de rango general
  if (horaH < hIni || horaH >= hFin) return false;

  // Almuerzo solo aplica lunes-viernes
  if (!esSabado && medico.horario_almuerzo_inicio && medico.horario_almuerzo_fin) {
    const hAlmIni = parseInt(medico.horario_almuerzo_inicio, 10);
    const hAlmFin = parseInt(medico.horario_almuerzo_fin, 10);
    if (horaH >= hAlmIni && horaH < hAlmFin) return false;
  }

  return true;
}

/**
 * Mensaje de horario para mostrar al paciente.
 */
function describeHorario(medico, fecha) {
  const esSabado = fecha.getDay() === 6;
  if (esSabado) {
    const fin = medico.horario_sabado_fin || medico.horario_fin;
    return `${medico.horario_inicio} a ${fin}`;
  }
  if (medico.horario_almuerzo_inicio) {
    return `${medico.horario_inicio} a ${medico.horario_almuerzo_inicio} y de ${medico.horario_almuerzo_fin} a ${medico.horario_fin}`;
  }
  return `${medico.horario_inicio} a ${medico.horario_fin}`;
}

/**
 * Genera lista de horarios disponibles para un médico en una fecha,
 * respetando el descanso de almuerzo, horario de sábado y el buffer entre citas.
 *
 * @param {number} medicoId
 * @param {Date}   fecha
 * @returns {Date[]}
 */
function getHorariosDisponibles(medicoId, fecha) {
  const medico = findById(medicoId);
  if (!medico) return [];

  const durMin    = medico.duracion_cita_min;
  const pasoPaso  = durMin + BUFFER_ENTRE_CITAS_MIN;  // paso con buffer incluido
  const esSabado  = fecha.getDay() === 6;

  const hIni = parseInt(medico.horario_inicio, 10);
  const hFin = esSabado && medico.horario_sabado_fin
               ? parseInt(medico.horario_sabado_fin, 10)
               : parseInt(medico.horario_fin, 10);

  const hAlmIni = (!esSabado && medico.horario_almuerzo_inicio)
                  ? parseInt(medico.horario_almuerzo_inicio, 10) : null;
  const hAlmFin = (!esSabado && medico.horario_almuerzo_fin)
                  ? parseInt(medico.horario_almuerzo_fin, 10) : null;

  // Citas ya programadas ese día
  const fechaStr = `${fecha.getFullYear()}-${String(fecha.getMonth()+1).padStart(2,'0')}-${String(fecha.getDate()).padStart(2,'0')}`;
  const ocupados = getDb()
    .prepare(`
      SELECT fecha_hora, duracion_min FROM citas
      WHERE medico_id = ? AND date(fecha_hora) = ? AND estado NOT IN ('cancelada','no_asistio')
    `)
    .all(medicoId, fechaStr);

  const slots = [];
  let minutos = hIni * 60;
  const finMin = hFin * 60;

  while (minutos + durMin <= finMin) {
    const horaH = Math.floor(minutos / 60);
    const horaM = minutos % 60;

    // Saltar almuerzo
    if (hAlmIni !== null && horaH >= hAlmIni && horaH < hAlmFin) {
      minutos = hAlmFin * 60;
      continue;
    }

    const slot = new Date(fecha);
    slot.setHours(horaH, horaM, 0, 0);

    // Verificar que no haya cita existente que se solape (considerando su buffer)
    const slotIni = slot.getTime();
    const slotFin = slotIni + durMin * 60_000;

    const ocupado = ocupados.some(c => {
      const cIni = new Date(c.fecha_hora).getTime();
      const cFin = cIni + (c.duracion_min + BUFFER_ENTRE_CITAS_MIN) * 60_000;
      return slotIni < cFin && slotFin > cIni;
    });

    if (!ocupado) slots.push(new Date(slot));

    minutos += pasoPaso;
  }

  return slots;
}

module.exports = {
  findActivos,
  findById,
  findByTelefono,
  getMedicoUnico,
  getHorariosDisponibles,
  esDentroHorario,
  describeHorario,
};
