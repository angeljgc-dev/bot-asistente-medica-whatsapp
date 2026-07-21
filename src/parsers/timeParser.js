'use strict';
const { normalizarTexto } = require('./textNormalizer');
const { palabraANumero }  = require('./spanishNumbers');

/**
 * Extrae hora de un texto en español y devuelve { horas, minutos } o null.
 *
 * Patrones soportados:
 *  1. "5pm", "5:30pm", "5 pm", "5:30 pm"
 *  2. "17:00", "09:30"
 *  3. "cinco de la tarde", "5 de la tarde", "3 de la mañana"
 *  4. "tres y media", "once y cuarto", "dos y cuarto"
 *  5. "a las 3", "a las cinco"
 *  6. "mediodía" → 12:00, "medianoche" → 0:00
 *  7. "8 de la mañana", "8 am"
 */
function extraerHora(texto) {
  if (!texto) return null;
  const norm = normalizarTexto(texto);

  // Patrón 1 & 7: "5pm", "5:30 pm", "5 am"
  let m = norm.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    if (m[3] === 'pm' && h !== 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { horas: h, minutos: min };
  }

  // Patrón 2: "17:00", "09:30"
  m = norm.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { horas: h, minutos: min };
  }

  // Patrón 6: mediodía / medianoche
  if (/mediod[ií]a/.test(norm))  return { horas: 12, minutos: 0 };
  if (/medianoche/.test(norm))   return { horas: 0,  minutos: 0 };

  // Patrón 3: "X de la tarde/noche/mañana"
  m = norm.match(/\b(\w+)\s+de\s+la\s+(manana|tarde|noche)\b/);
  if (m) {
    let h = palabraANumero(m[1]);
    if (h !== null) {
      if (m[2] === 'tarde' && h < 12) h += 12;
      if (m[2] === 'noche' && h < 12) h += 12;
      if (m[2] === 'manana' && h === 12) h = 0;
      if (h >= 0 && h <= 23) return { horas: h, minutos: 0 };
    }
  }

  // También: "las X de la tarde/noche/mañana"
  m = norm.match(/\blas?\s+(\w+)\s+de\s+la\s+(manana|tarde|noche)\b/);
  if (m) {
    let h = palabraANumero(m[1]);
    if (h !== null) {
      if (m[2] === 'tarde' && h < 12) h += 12;
      if (m[2] === 'noche' && h < 12) h += 12;
      if (m[2] === 'manana' && h === 12) h = 0;
      if (h >= 0 && h <= 23) return { horas: h, minutos: 0 };
    }
  }

  // Patrón 4: "tres y media", "once y cuarto", "seis y veinte"
  m = norm.match(/\b(\w+)\s+y\s+(media|cuarto|(\w+))\b/);
  if (m) {
    let h = palabraANumero(m[1]);
    if (h !== null) {
      let min = 0;
      if (m[2] === 'media')  min = 30;
      else if (m[2] === 'cuarto') min = 15;
      else { const n = palabraANumero(m[2]); if (n !== null) min = n; }
      // Asumir tarde si h < 8 (rango 1-7 suele ser PM en clínica)
      if (h >= 1 && h <= 7) h += 12;
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { horas: h, minutos: min };
    }
  }

  // Patrón 5: "a las 3", "a las cinco"
  m = norm.match(/\ba\s+las?\s+(\w+)\b/);
  if (m) {
    let h = palabraANumero(m[1]);
    if (h !== null) {
      if (h >= 1 && h <= 7) h += 12;
      if (h >= 0 && h <= 23) return { horas: h, minutos: 0 };
    }
  }

  // Patrón: rango genérico "en la mañana/tarde/noche", "por la mañana/tarde"
  m = norm.match(/\b(?:en|por)\s+la\s+(manana|tarde|noche)\b/);
  if (m) {
    if (m[1] === 'manana') return { horas: 9, minutos: 0, esRango: true, rangoInicio: 8, rangoFin: 12 };
    if (m[1] === 'tarde')  return { horas: 15, minutos: 0, esRango: true, rangoInicio: 13, rangoFin: 18 };
    if (m[1] === 'noche')  return { horas: 19, minutos: 0, esRango: true, rangoInicio: 18, rangoFin: 20 };
  }

  // Patrón: "después de las X", "a partir de las X"
  m = norm.match(/\b(?:despues|a\s+partir)\s+de\s+las?\s+(\w+)\b/);
  if (m) {
    let h = parseInt(m[1], 10) || palabraANumero(m[1]);
    if (h !== null && h >= 0 && h <= 23) {
      if (h >= 1 && h <= 7) h += 12;
      return { horas: h, minutos: 0 };
    }
  }

  // Patrón: "lo más pronto/temprano posible", "lo antes posible"
  if (/\b(lo\s+mas\s+(pronto|temprano)|lo\s+antes\s+posible|lo\s+mas\s+pronto\s+posible|primera\s+hora|temprano)\b/.test(norm)) {
    return { horas: 8, minutos: 0, esRango: true, rangoInicio: 8, rangoFin: 10 };
  }

  // Patrón: número solo cuando estamos en contexto de selección de hora (sin contexto de fecha)
  m = norm.match(/^(\d{1,2})$/);
  if (m) {
    let h = parseInt(m[1], 10);
    if (h >= 1 && h <= 7) h += 12;
    if (h >= 0 && h <= 23) return { horas: h, minutos: 0 };
  }

  // Fallback: solo con contexto explícito de hora (tarde/noche/manana)
  m = norm.match(/\b(\d{1,2})\b/);
  if (m) {
    const esTarde = /\b(tarde|noche)\b/.test(norm);
    const esManana = /\bde\s+la\s+manana\b/.test(norm);  // only "de la mañana", not "mañana" (tomorrow)
    if (esTarde || esManana) {
      let h = parseInt(m[1], 10);
      if (esTarde && h < 12) h += 12;
      if (esManana && h === 12) h = 0;
      if (h >= 0 && h <= 23) return { horas: h, minutos: 0 };
    }
  }

  return null;
}

/**
 * Aplica hora extraída a un objeto Date.
 */
function aplicarHora(fecha, horas, minutos) {
  const d = new Date(fecha);
  d.setHours(horas, minutos, 0, 0);
  return d;
}

module.exports = { extraerHora, aplicarHora };
