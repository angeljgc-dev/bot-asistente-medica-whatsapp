'use strict';

/**
 * Normaliza texto para facilitar el parsing:
 *  - minúsculas
 *  - elimina acentos
 *  - colapsa espacios
 *  - elimina puntuación irrelevante
 */
function normalizarTexto(texto) {
  if (!texto || typeof texto !== 'string') return '';
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // quita diacríticos
    .replace(/[^a-z0-9\s:/\-\.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Versión sin quitar puntuación especial — para tests que necesiten
 * reconocer "/" en fechas, etc.
 */
function normalizarSuave(texto) {
  if (!texto || typeof texto !== 'string') return '';
  return texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { normalizarTexto, normalizarSuave };
