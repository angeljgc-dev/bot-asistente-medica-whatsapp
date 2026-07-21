'use strict';
const { normalizarTexto, normalizarSuave } = require('./textNormalizer');
const { palabraANumero, mesANumero, diaSemanaNombre } = require('./spanishNumbers');

let chrono = null;
try {
  chrono = require('chrono-node');
} catch (_) {}

/**
 * Detecta fecha en texto en español y devuelve un Date o null.
 *
 * Patrones propios (7):
 *  1. Fechas relativas: "hoy", "mañana", "pasado mañana"
 *  2. DD/MM/YYYY o DD-MM-YYYY o DD/MM
 *  3. YYYY-MM-DD (ISO)
 *  4. "15 de marzo de 2025", "15 de marzo"
 *  5. Números en palabras: "cinco de diciembre del 2025"
 *  6. Día relativo: "próximo lunes", "este viernes", "el martes"
 *  7. Día del mes con artículo: "el 5", "el quince"
 *
 * Fallback: chrono-node (si está disponible)
 */
function detectarFecha(texto, referencia) {
  if (!texto) return null;
  const hoy    = referencia ? new Date(referencia) : new Date();
  hoy.setHours(0, 0, 0, 0);

  const norm  = normalizarTexto(texto);
  const suave = normalizarSuave(texto);

  // Patrón 1: relativas — "pasado mañana" ANTES que "mañana" para evitar match prematuro
  if (/\bhoy\b/.test(norm))              return new Date(hoy);
  if (/\bpasado\s+manana\b/.test(norm))  { const d = new Date(hoy); d.setDate(d.getDate() + 2); return d; }
  if (/\bmanana\b/.test(norm))           { const d = new Date(hoy); d.setDate(d.getDate() + 1); return d; }

  // Patrón 2: DD/MM/YYYY, DD-MM-YYYY, DD/MM
  let m = suave.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
  if (m) {
    const dia = parseInt(m[1], 10);
    const mes = parseInt(m[2], 10) - 1;
    const anio = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3],10) : parseInt(m[3],10)) : hoy.getFullYear();
    if (dia >= 1 && dia <= 31 && mes >= 0 && mes <= 11) {
      const d = new Date(anio, mes, dia);
      // Si la fecha es pasada y no se especificó año, avanzar al próximo año
      if (!m[3] && d < hoy) d.setFullYear(d.getFullYear() + 1);
      return d;
    }
  }

  // Patrón 3: ISO YYYY-MM-DD
  m = suave.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const d = new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
    if (!isNaN(d)) return d;
  }

  // Patrón 4 & 5: "15 de marzo de 2025", "cinco de diciembre 2025"
  m = norm.match(/\b(\w+)\s+de\s+(\w+)(?:\s+(?:del?\s+)?(\d{2,4}))?\b/);
  if (m) {
    const dia  = palabraANumero(m[1]);
    const mes  = mesANumero(m[2]);
    if (dia !== null && mes !== null) {
      let anio = hoy.getFullYear();
      if (m[3]) anio = m[3].length === 2 ? 2000 + parseInt(m[3],10) : parseInt(m[3],10);
      const d = new Date(anio, mes - 1, dia);
      if (!isNaN(d) && dia >= 1 && dia <= 31) {
        if (!m[3] && d < hoy) d.setFullYear(d.getFullYear() + 1);
        return d;
      }
    }
  }

  // Patrón 4b: "marzo 15", "marzo 15 2025" (variante americana)
  m = norm.match(/\b(\w+)\s+(\d{1,2})(?:\s+(?:del?\s+)?(\d{2,4}))?\b/);
  if (m) {
    const mes  = mesANumero(m[1]);
    const dia  = parseInt(m[2], 10);
    if (mes !== null && !isNaN(dia)) {
      let anio = hoy.getFullYear();
      if (m[3]) anio = m[3].length === 2 ? 2000 + parseInt(m[3],10) : parseInt(m[3],10);
      const d = new Date(anio, mes - 1, dia);
      if (!isNaN(d) && dia >= 1 && dia <= 31) {
        if (!m[3] && d < hoy) d.setFullYear(d.getFullYear() + 1);
        return d;
      }
    }
  }

  // Patrón 6: "próximo lunes", "este viernes", "el martes"
  m = norm.match(/\b(?:proximo|proxima|este|esta|el|la)?\s*(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/);
  if (m) {
    const diaObj  = diaSemanaNombre(m[1]);
    if (diaObj !== null) {
      const d = new Date(hoy);
      const hoyDia = d.getDay(); // 0=dom
      let diff = diaObj - hoyDia;
      if (diff <= 0) diff += 7;
      d.setDate(d.getDate() + diff);
      return d;
    }
  }

  // Patrón 7: "el 5", "el quince" (sin mes, asumir mes actual o siguiente)
  m = norm.match(/\bel\s+(\w+)\b/);
  if (m) {
    const dia = palabraANumero(m[1]);
    if (dia !== null && dia >= 1 && dia <= 31) {
      const d = new Date(hoy.getFullYear(), hoy.getMonth(), dia);
      if (d < hoy) d.setMonth(d.getMonth() + 1);
      return d;
    }
  }

  // Fallback: chrono-node
  if (chrono) {
    try {
      const results = chrono.es.parse(texto, hoy);
      if (results.length > 0) {
        return results[0].start.date();
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Versión para fechas de nacimiento — no avanza al año siguiente si es pasada,
 * y acepta años de 4 dígitos como obligatorios.
 */
function extraerFechaNacimiento(texto) {
  if (!texto) return null;
  const norm  = normalizarTexto(texto);
  const suave = normalizarSuave(texto);

  // DD/MM/YYYY o DD-MM-YYYY
  let m = suave.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
  if (m) {
    const d = new Date(parseInt(m[3],10), parseInt(m[2],10)-1, parseInt(m[1],10));
    if (!isNaN(d) && d < new Date()) return d;
  }

  // "15 de marzo de 1990", "cinco de diciembre de 1990"
  m = norm.match(/\b(\w+)\s+de\s+(\w+)\s+del?\s+(\d{4})\b/);
  if (m) {
    const dia  = palabraANumero(m[1]);
    const mes  = mesANumero(m[2]);
    const anio = parseInt(m[3], 10);
    if (dia !== null && mes !== null && anio >= 1900 && anio <= new Date().getFullYear()) {
      const d = new Date(anio, mes - 1, dia);
      if (!isNaN(d)) return d;
    }
  }

  // "marzo 15, 1990"
  m = norm.match(/\b(\w+)\s+(\d{1,2})[,\s]+(\d{4})\b/);
  if (m) {
    const mes  = mesANumero(m[1]);
    const dia  = parseInt(m[2], 10);
    const anio = parseInt(m[3], 10);
    if (mes !== null && anio >= 1900 && anio <= new Date().getFullYear()) {
      const d = new Date(anio, mes - 1, dia);
      if (!isNaN(d)) return d;
    }
  }

  // Patrón: "15 julio 2000" (sin "de")
  m = norm.match(/\b(\d{1,2})\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+(\d{4})\b/);
  if (m) {
    const dia = parseInt(m[1], 10);
    const mes = mesANumero(m[2]);
    const anio = parseInt(m[3], 10);
    if (mes !== null && dia >= 1 && dia <= 31 && anio >= 1900 && anio <= new Date().getFullYear()) {
      const fecha = new Date(anio, mes - 1, dia);
      if (fecha <= new Date()) return fecha;
    }
  }

  // Patrón: DD/MM/YY (año de 2 dígitos)
  m = norm.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})\b/);
  if (m && !norm.match(/\b\d{4}\b/)) {  // solo si no hay año de 4 dígitos
    const dia = parseInt(m[1], 10);
    const mes = parseInt(m[2], 10) - 1;
    let anio = parseInt(m[3], 10);
    anio = anio <= 25 ? 2000 + anio : 1900 + anio;  // 00-25 = 2000s, 26-99 = 1900s
    if (dia >= 1 && dia <= 31 && mes >= 0 && mes <= 11 && anio >= 1900) {
      const fecha = new Date(anio, mes, dia);
      if (fecha <= new Date()) return fecha;
    }
  }

  return null;
}

module.exports = { detectarFecha, extraerFechaNacimiento };
