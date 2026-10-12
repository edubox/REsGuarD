const MOTIVOS = {
  no_encontrado: 'el repositorio ya no existe o ha dejado de ser público (404)',
  vacio: 'el repositorio está vacío',
  red: 'no se pudo conectar con GitHub',
  almacen: 'la carpeta de destino no está disponible',
  bundle_invalido: 'la instantánea generada no superó la verificación',
  espejo_dañado: 'el espejo guardado estaba dañado y se ha reconstruido',
  wiki: 'falló la copia de la wiki',
  release: 'falló la descarga del último release',
  retencion: 'no se pudieron borrar instantáneas antiguas',
  interrumpida: 'la copia se interrumpió por un reinicio del servicio',
  interno: 'error interno',
};

export function describirMotivo(motivo) {
  if (!motivo) return '';
  return motivo.split('+').map((m) => MOTIVOS[m] ?? m).join('; ');
}
