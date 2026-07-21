'use strict';

const MESES = [
  'enero','febrero','marzo','abril','mayo','junio',
  'julio','agosto','septiembre','octubre','noviembre','diciembre'
];
const DIAS_SEMANA = [
  'domingo','lunes','martes','miércoles','jueves','viernes','sábado'
];

/**
 * Formatea un Date o string ISO a texto legible en español.
 * Ej: "lunes 7 de abril de 2026 a las 3:00 PM"
 */
function formatoFechaHumano(fechaHora) {
  const d = fechaHora instanceof Date ? fechaHora : new Date(fechaHora);
  if (isNaN(d)) return String(fechaHora);

  const dia     = DIAS_SEMANA[d.getDay()];
  const fecha   = d.getDate();
  const mes     = MESES[d.getMonth()];
  const anio    = d.getFullYear();
  const horas   = d.getHours();
  const minutos = String(d.getMinutes()).padStart(2, '0');
  const ampm    = horas >= 12 ? 'PM' : 'AM';
  const hora12  = horas % 12 || 12;

  return `${dia} ${fecha} de ${mes} de ${anio} a las ${hora12}:${minutos} ${ampm}`;
}

/**
 * Sólo fecha: "lunes 7 de abril de 2026"
 */
function formatoSoloFecha(fechaHora) {
  const d = fechaHora instanceof Date ? fechaHora : new Date(fechaHora);
  if (isNaN(d)) return String(fechaHora);

  const dia   = DIAS_SEMANA[d.getDay()];
  const fecha = d.getDate();
  const mes   = MESES[d.getMonth()];
  const anio  = d.getFullYear();
  return `${dia} ${fecha} de ${mes} de ${anio}`;
}

/**
 * Sólo hora: "3:00 PM"
 */
function formatoSoloHora(fechaHora) {
  const d = fechaHora instanceof Date ? fechaHora : new Date(fechaHora);
  if (isNaN(d)) return String(fechaHora);

  const horas   = d.getHours();
  const minutos = String(d.getMinutes()).padStart(2, '0');
  const ampm    = horas >= 12 ? 'PM' : 'AM';
  const hora12  = horas % 12 || 12;
  return `${hora12}:${minutos} ${ampm}`;
}

/**
 * Calcula edad en años completos.
 */
function calcularEdad(fechaNacimiento) {
  const nac = fechaNacimiento instanceof Date ? fechaNacimiento : new Date(fechaNacimiento);
  if (isNaN(nac)) return null;

  const hoy   = new Date();
  let edad    = hoy.getFullYear() - nac.getFullYear();
  const m     = hoy.getMonth() - nac.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < nac.getDate())) edad--;
  return edad;
}

/**
 * Convierte Date a string ISO local para SQLite: "YYYY-MM-DD HH:MM:SS"
 */
function toSqliteDateTime(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const pad = n => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())} ` +
         `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

/**
 * Verifica si hoy es el cumpleaños de una fecha dada.
 */
function esCumpleanosHoy(fechaNacimiento) {
  const nac = fechaNacimiento instanceof Date ? fechaNacimiento : new Date(fechaNacimiento);
  if (isNaN(nac)) return false;

  const hoy = new Date();
  return nac.getMonth() === hoy.getMonth() && nac.getDate() === hoy.getDate();
}

module.exports = {
  formatoFechaHumano,
  formatoSoloFecha,
  formatoSoloHora,
  calcularEdad,
  toSqliteDateTime,
  esCumpleanosHoy,
};
