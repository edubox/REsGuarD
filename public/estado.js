// Lógica pura del repintado: se repinta solo si cambian los datos o el minuto
// (los textos relativos, «hace 3 min», envejecen aunque los datos no cambien).
export function claveDePintado(datos, ahora = new Date()) {
  return JSON.stringify([Math.floor(ahora.getTime() / 60000), datos]);
}

export function haCambiado(anterior, nueva) {
  return anterior !== nueva;
}

export const CADUCIDAD_AVISO = 8000;

// Qué texto muestra la banda: un aviso manual vigente (<8 s) gana; después el
// error de carga; después el aviso de estado (ver avisoDeEstado).
export function textoDeBanda({ manual, errorDeCarga, falta }, ahora) {
  if (manual && ahora - manual.desde < CADUCIDAD_AVISO) return manual.texto;
  return errorDeCarga || falta || '';
}

// El aviso de estado, por prioridad: falta la carpeta de destino; está indicada
// pero no disponible (la unidad no está montada); falta configurar Telegram.
export function avisoDeEstado(resumen) {
  if (!resumen.destino) return 'Falta indicar la carpeta de destino de las copias. Ábrela en «Ajustes».';
  if (!resumen.destino_disponible) {
    return 'La carpeta de destino no está disponible ahora mismo: comprueba que la unidad está montada. Mientras tanto no se copia nada.';
  }
  if (!resumen.telegram_configurado) return 'Los avisos por Telegram no están configurados. Ábrelos en «Ajustes».';
  return '';
}
