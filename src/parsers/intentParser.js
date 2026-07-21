'use strict';
const { normalizarTexto } = require('./textNormalizer');

/**
 * Detecta la intención principal del mensaje del usuario.
 *
 * Retorna uno de:
 *  'saludo', 'agendar', 'reagendar', 'cancelar', 'consultar_cita',
 *  'confirmar_si', 'confirmar_no', 'omitir', 'escalar_humano',
 *  'triage_urgencia_alta', 'pregunta_precio', 'pregunta_requisitos',
 *  'pregunta_procedimiento', 'info_clinica', 'menu_opcion', 'nombre',
 *  'cambiar_nombre', 'cambiar_cumple', 'mis_datos', 'agradecimiento',
 *  'despedida', 'desconocido'
 */
function detectarIntencion(texto) {
  if (!texto || typeof texto !== 'string') return 'desconocido';
  const t = normalizarTexto(texto);

  // PRIORIDAD ABSOLUTA — Triage de urgencia clínica alta
  // Estos síntomas requieren 911 / atención inmediata, NO agendar una cita.
  if (/\b(dolor\s+(de\s+|en\s+(el|la)\s+|al\s+|fuerte\s+de\s+)?pecho|opresion\s+(en\s+)?(el\s+)?pecho|me\s+aprieta\s+el\s+pecho|siento\s+(un\s+)?(peso|presion)\s+(en\s+)?(el\s+)?pecho|dolor\s+toracico|infarto|me\s+va\s+a\s+dar\s+(un\s+)?infarto|ataque\s+(al\s+)?corazon|no\s+puedo\s+respirar|me\s+falta\s+(el\s+)?aire|dificultad\s+para\s+respirar|ahogandome|me\s+ahogo|no\s+respiro|asfixia|estoy\s+sangrando\s+(mucho|fuerte|abundante)?|sangrado\s+(fuerte|abundante|mucho|grave|masivo)|perdi\s+(mucha\s+)?sangre|me\s+desmaye|me\s+desmayo|perdi\s+(el\s+)?conocimiento|estoy\s+inconsciente|convulsion(es|ando)?|esta\s+convulsionando|no\s+reacciona|no\s+despierta|acv|derrame\s+cerebral|embolia|no\s+siento\s+(la\s+)?(cara|brazo|pierna)|se\s+me\s+paralizo|parto|contracciones\s+(fuertes|seguidas)|voy\s+a\s+parir|rompi\s+(la\s+)?(fuente|aguas)|intoxicacion|envenenamiento|me\s+tome\s+(algo|pastillas)|sobredosis|quiero\s+matarme|me\s+quiero\s+suicidar)\b/.test(t))
    return 'triage_urgencia_alta';

  // "me urge una cita" → agendar (tiene contexto médico)
  if (/\b(urge|urgente|urgencia)\b/.test(t) && /\b(cita|sita|consulta|atender|ver\s+al|hora|doctor|medico)\b/.test(t))
    return 'agendar';

  // Escalación urgente — prioridad máxima
  if (/\b(emergencia|urgente|urgencia|hablar\s+con\s+(alguien|humano|doctor|medico|persona)|necesito\s+ayuda\s+urgente)\b/.test(t))
    return 'escalar_humano';

  // Frustración → escalación
  if (/\b(no sirve|no funciona|ya me harte|no entiendes|eres un robot|no me ayudas|maquina tonta|bot tonto|necesito un humano|quiero hablar con una persona|esto es una porqueria)\b/.test(t))
    return 'escalar_humano';

  // Confirmación — incluye mexicanismos comunes
  if (/^(si|sí|confirmo|confirmar|acepto|aceptar|correcto|exacto|dale|ok|okay|claro|perfecto|por\s+supuesto|sii*|va|listo|sale|simon|orale|andale|de\s+acuerdo|hecho|esta\s+bien|me\s+parece(\s+bien)?|ahi\s+estare|ahi\s+voy|ahi\s+estoy|va\s+que\s+va|con\s+gusto|eso\s+mero|chido|nel\s+todo\s+bien)$/i.test(t.trim())
    || (/\b(si|sí|confirmo|acepto|correcto|dale|claro|perfecto|listo|sale|simon|orale|andale|de\s+acuerdo|me\s+parece\s+bien)\b/.test(t) && t.length < 20))
  return 'confirmar_si';

  // "no" corto (sin palabras de acción de citas) → confirmar_no
  if (/\b(no|nop|nope|nel|negativo|incorrecto|no\s+quiero|no\s+gracias|nombre\s+no|nel\s+pastel|simon\s+que\s+no)\b/.test(t) && t.length < 25
      && !/\b(cita|sita|reagendar|cancelar|anular|puedo|ir|poder|asistir|otro\s+dia)\b/.test(t))
    return 'confirmar_no';

  // Omitir
  if (/\b(omitir|omite|saltar|skip|prefiero\s+no|no\s+quiero\s+decir|sin\s+motivo)\b/.test(t))
    return 'omitir';

  // Saludos
  if (/^(hola|buenos?\s+(dias|tardes|noches)|buenas|hey|buen\s+dia|saludos|hi|hello|oye|ey|que\s+tal|que\s+onda)\b/.test(t))
    return 'saludo';

  // Menú
  if (/^[1234]$/.test(t.trim()))
    return 'menu_opcion';

  // Reagendar (antes que agendar)
  // "otro medico/doctor" también cae aquí: el flujo de reagendamiento permite elegir otro médico.
  if (/\b(reagendar|re-agendar|cambiar\s+(mi\s+)?cita|mover\s*(le)?\s+(mi\s+|a\s+)?(mi\s+)?cita|modificar\s+(mi\s+)?cita|nueva\s+fecha|cambio\s+de\s+cita|puedo\s+ir\s+otro\s+dia|se\s+me\s+complico|puede\s+ser\s+otro\s+dia|le\s+puedo\s+mover|(ir|cambiar|cambio)\s+(con|a|al)\s+(otro|otra)\s+(medico|medica|doctor|doctora)|quiero\s+(ir|cambiar)\s+con\s+otr[oa])/i.test(t))
    return 'reagendar';

  // Cancelar
  if (/\b(cancelar\s*(mi\s+|todas?\s+(mis?\s+|las?\s+)?)?citas?|anular\s*(mi\s+)?cita|eliminar\s*(mi\s+)?cita|quiero\s+cancelar|cancelar\s+todas?|ya\s+no\s+(puedo|voy\s+a?\s+poder)?\s*(ir|asistir)|no\s+voy\s+a?\s*(poder\s+)?(ir|asistir)|no\s+puedo\s+(ir|asistir)|no\s+ire|chale.*(no puedo|ya no|cancelar)|ya\s+no\s+voy|cancelarla|cancelarlo)\b/i.test(t)
      || /^cancelar?$/i.test(t.trim())
      || /^ya\s+no\s+puedo$/i.test(t.trim()))
    return 'cancelar';

  // Consultar cita
  if (/\b(cual\s+es\s+(mi|la)\s+(proxima\s+)?cita|cuando\s+(tengo|es)\s+(mi\s+)?cita|mi\s+(proxima\s+)?cita|ver\s+mi\s+cita|consultar\s+(mis?\s+)?citas?|tengo\s+cita|cuantas?\s+(citas?|sitas?)|mis\s+(citas?|sitas?)|ver\s+citas?|tengo\s+algo\s+pendiente|alguna\s+cita|que\s+citas\s+tengo)\b/.test(t))
    return 'consultar_cita';

  // Agendar
  // Incluye síntomas y situaciones clínicas comunes: embarazo, menstruación, ansiedad, insomnio, vómito, diarrea, alergia.
  if (/\b(agendar|agenda|[kq]uiero\s+(\w+\s+)?(cita|sita|consulta)|necesito\s+(\w+\s+)?(cita|sita|consulta|ver\s+al\s+(doctor|medico))|pedir\s+(una\s+)?(cita|sita)|hacer\s+(una\s+)?(cita|sita)|reservar|apartar|(cita|sita)\s+para|(cita|sita)\s+el|(cita|sita)\s+manana|hay\s+(citas?|sitas?|espacio|lugar|disponibilidad)|me\s+pueden\s+atender|puedo\s+ir|ir\s+a\s+consulta|ocupo\s+(una\s+)?(cita|sita)|dar\s*(me)?\s+hora|checarme|ando\s+mal[oa]?|me\s+siento\s+mal|estoy\s+mal[oa]?|me\s+duele|tengo\s+(dolor|fiebre|nausea|mareo|tos|gripa|vomito|diarrea|alergia|ansiedad|insomnio)|estoy\s+(embarazada|embarazado)|creo\s+que\s+estoy\s+embarazada|mi\s+(regla|menstruacion|periodo))\b/.test(t))
    return 'agendar';

  // Nombre propio (registro)
  if (/\b(mi\s+nombre\s+es|me\s+llamo|soy\s+[a-z]|llamenme)\b/.test(t))
    return 'nombre';

  // Cambiar nombre
  if (/\b(cambiar\s+(mi\s+)?nombre|actualizar\s+(mi\s+)?nombre|corregir\s+(mi\s+)?nombre|mi\s+nombre\s+esta\s+mal|quiero\s+cambiar\s+(mi\s+)?nombre)\b/.test(t))
    return 'cambiar_nombre';

  // Cambiar cumpleaños/fecha de nacimiento
  if (/\b(cambiar\s+(mi\s+)?(cumple|cumpleanos|fecha\s+de\s+nacimiento)|mi\s+cumple(anos)?\s+(es|esta\s+mal)|corregir\s+(mi\s+)?(cumple|cumpleanos|fecha))\b/.test(t))
    return 'cambiar_cumple';

  // Ver mis datos
  if (/\b(mis\s+datos|mi\s+informacion|mi\s+perfil|que\s+datos\s+tienen|que\s+info\s+tienen|ver\s+mi\s+(perfil|info|informacion)|mis?\s+registro)\b/.test(t))
    return 'mis_datos';

  // Pregunta específica de precio / costo
  // Nota: "cuanto es" solo cuenta si va seguido de la/una/el/mi/por (precio implícito de algo),
  // para evitar falsos positivos tipo "cuánto es 2+2".
  if (/\b(cuanto\s+(cuesta|vale|sale|me\s+sale|me\s+cuesta|seria)|cuanto\s+es\s+(la|una|el|un|tu|su|mi|por)\s+\w+|precio|costo|tarifa|cobran|que\s+cobran|cuanto\s+pagar|cuanto\s+debo\s+pagar|cual\s+es\s+el\s+precio|cual\s+es\s+el\s+costo|costos|precios|aceptan\s+seguro|metodos?\s+de\s+pago|aceptan\s+(tarjeta|efectivo|pagos?)|aceptan\s+deposito|puedo\s+pagar\s+con|formas?\s+de\s+pago)\b/.test(t))
    return 'pregunta_precio';

  // Pregunta sobre requisitos / qué llevar
  if (/\b(que\s+(debo|tengo\s+que|hay\s+que|necesito)\s+llevar|que\s+llevo|que\s+llevar|que\s+debo\s+traer|que\s+tengo\s+que\s+traer|requisitos|que\s+documentos|necesito\s+(algo|traer|llevar)|llevar\s+algo|papeles|identificacion|ine|credencial|estudios\s+previos|analisis\s+previos)\b/.test(t))
    return 'pregunta_requisitos';

  // Pregunta sobre procedimiento / cómo es la consulta
  if (/\b(como\s+(es|sera|va\s+a\s+ser)\s+(la\s+)?(consulta|cita|revision|procedimiento)|en\s+que\s+consiste|cual\s+es\s+el\s+procedimiento|que\s+me\s+van\s+a\s+hacer|que\s+me\s+haran|cuanto\s+(dura|tarda)\s+(la\s+)?(consulta|cita)|duracion\s+de\s+la\s+consulta|protocolo|paso\s+a\s+paso)\b/.test(t))
    return 'pregunta_procedimiento';

  // Información de la clínica (horario/ubicación general, médicos disponibles)
  if (/\b(horario|horarios|direccion|ubicacion|donde\s+queda|donde\s+esta|donde\s+estan|como\s+llego|servicios|telefono\s+de\s+la\s+clinica|informacion\s+de\s+la\s+clinica|que\s+medicos?\s+(hay|tienen|atienden)|cuales?\s+(medicos?|doctores?)|otros?\s+medicos?\s+(hay|tienen|disponibles?)|(ver|consultar)\s+(otros?\s+)?(medicos?|doctores?)|medicos?\s+disponibles?|disponibilidad\s+de\s+(horario|dias)|que\s+dias\s+atienden|dime\s+(la\s+)?disponibilidad)\b/.test(t))
    return 'info_clinica';

  // Baja / derecho ARCO de cancelación
  if (/\b(darme\s+de\s+baja|quiero\s+(darme\s+de\s+)?baja|eliminar\s+mis\s+datos|borrar\s+mis\s+datos|borra\s+mis\s+datos|olvida\s+mis\s+datos|olvida\s+todo\s+de\s+mi|no\s+quiero\s+seguir\s+aqu[ií]|no\s+quiero\s+que\s+guarden\s+mis\s+datos|ejercer\s+mi\s+derecho\s+arco|derechos?\s+arco)\b/.test(t)
      || /^baja$/i.test(t.trim()))
    return 'baja_datos';

  // Agradecimiento / despedida
  if (/^(gracias|muchas\s+gracias|mil\s+gracias|te\s+agradezco|grax|agradecido|agradecida|ok\s+gracias|listo\s+gracias)\b/.test(t))
    return 'agradecimiento';

  if (/^(adios|bye|hasta\s+luego|nos\s+vemos|chao|chau|que\s+tengas\s+buen\s+dia|buen\s+dia|buenas\s+noches|hasta\s+pronto)\b/.test(t))
    return 'despedida';

  return 'desconocido';
}

/**
 * Detecta si el texto menciona una fecha/hora (para decidir si pasar a parsers).
 */
function contieneFechaHora(texto) {
  const t = normalizarTexto(texto);
  return (
    /\b(hoy|manana|pasado\s+manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(t) ||
    /\b\d{1,2}[\/\-]\d{1,2}/.test(t) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(t) ||
    /\b\d{1,2}\s+de\s+\w+/.test(t) ||
    /\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b/.test(t) ||
    /\b\d{1,2}\s*(am|pm)\b/.test(t) ||
    /\ba\s+las?\s+\d/.test(t) ||
    /\b(manana|tarde|noche)\b/.test(t)
  );
}

module.exports = { detectarIntencion, contieneFechaHora };
