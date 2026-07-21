'use strict';

// Números ordinales y cardinales en español → número
const NUMERO_PALABRA = {
  // Unidades
  'cero': 0, 'uno': 1, 'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4,
  'cinco': 5, 'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9,
  'diez': 10, 'once': 11, 'doce': 12, 'trece': 13, 'catorce': 14,
  'quince': 15, 'dieciseis': 16, 'diecisiete': 17, 'dieciocho': 18,
  'diecinueve': 19, 'veinte': 20, 'veintiuno': 21, 'veintidos': 22,
  'veintitres': 23, 'veinticuatro': 24, 'veinticinco': 25,
  'veintiseis': 26, 'veintisiete': 27, 'veintiocho': 28,
  'veintinueve': 29, 'treinta': 30, 'treinta y uno': 31,
  // Ordinales
  'primero': 1, 'primer': 1, 'primera': 1,
  'segundo': 2, 'segunda': 2,
  'tercero': 3, 'tercer': 3, 'tercera': 3,
  'cuarto': 4, 'cuarta': 4,
  'quinto': 5, 'quinta': 5,
  'sexto': 6, 'sexta': 6,
  'septimo': 7, 'septima': 7,
  'octavo': 8, 'octava': 8,
  'noveno': 9, 'novena': 9,
  'decimo': 10, 'decima': 10,
  'undecimo': 11, 'duodecimo': 12,
  'decimotercero': 13, 'decimocuarto': 14, 'decimoquinto': 15,
  'decimosexto': 16, 'decimoseptimo': 17, 'decimoctavo': 18,
  'decimonoveno': 19, 'vigesimo': 20,
  'vigesimo primero': 21, 'vigesimo segundo': 22, 'vigesimo tercero': 23,
  'vigesimo cuarto': 24, 'vigesimo quinto': 25, 'vigesimo sexto': 26,
  'vigesimo septimo': 27, 'vigesimo octavo': 28, 'vigesimo noveno': 29,
  'trigesimo': 30, 'trigesimo primero': 31,
};

// Meses en español → número (1-12)
const MES_NUMERO = {
  'enero': 1, 'ene': 1,
  'febrero': 2, 'feb': 2,
  'marzo': 3, 'mar': 3,
  'abril': 4, 'abr': 4,
  'mayo': 5,
  'junio': 6, 'jun': 6,
  'julio': 7, 'jul': 7,
  'agosto': 8, 'ago': 8,
  'septiembre': 9, 'sep': 9, 'setiembre': 9,
  'octubre': 10, 'oct': 10,
  'noviembre': 11, 'nov': 11,
  'diciembre': 12, 'dic': 12,
};

// Nombres de días en español
const DIA_NOMBRE = {
  'lunes': 1, 'martes': 2, 'miercoles': 3, 'jueves': 4,
  'viernes': 5, 'sabado': 6, 'domingo': 0,
};

/**
 * Convierte una palabra en español a número, o devuelve null.
 */
function palabraANumero(palabra) {
  if (!palabra) return null;
  const p = palabra.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (!isNaN(p)) return parseInt(p, 10);
  return NUMERO_PALABRA[p] ?? null;
}

/**
 * Convierte un nombre de mes en español a número (1-12), o null.
 */
function mesANumero(mes) {
  if (!mes) return null;
  const m = mes.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return MES_NUMERO[m] ?? null;
}

/**
 * Convierte nombre de día a número ISO (1=lunes, 0=domingo), o null.
 */
function diaSemanaNombre(dia) {
  if (!dia) return null;
  const d = dia.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return DIA_NOMBRE[d] ?? null;
}

module.exports = { palabraANumero, mesANumero, diaSemanaNombre, NUMERO_PALABRA, MES_NUMERO };
