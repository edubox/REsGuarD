const UNIDADES = ['B', 'KB', 'MB', 'GB', 'TB'];

export function bytes(n) {
  if (!n) return '0 B';
  const i = Math.min(UNIDADES.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  const texto = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace('.', ',');
  return `${texto} ${UNIDADES[i]}`;
}

export function relativo(iso, ahora = new Date()) {
  if (!iso) return 'nunca';
  const s = Math.round((new Date(iso) - ahora) / 1000);
  const abs = Math.abs(s);
  if (abs < 60) return s <= 0 ? 'hace un momento' : 'enseguida';
  const [n, u] = abs < 3600 ? [abs / 60, 'min'] : abs < 86400 ? [abs / 3600, 'h'] : [abs / 86400, 'd'];
  return s < 0 ? `hace ${Math.round(n)} ${u}` : `en ${Math.round(n)} ${u}`;
}

export function fecha(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
}
