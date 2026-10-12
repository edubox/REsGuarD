const NOMBRE = /^[A-Za-z0-9._-]{1,100}$/;

export function nombreValido(s) {
  return typeof s === 'string' && NOMBRE.test(s) && s !== '.' && s !== '..';
}

export function parsearRepo(texto) {
  if (typeof texto !== 'string') return null;
  const original = texto.trim();
  const esUrl = /^(git@github\.com:|(https?:\/\/)?(www\.)?github\.com\/)/i.test(original);
  const resto = original
    .replace(/^git@github\.com:/i, '')
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  const partes = resto.split('/');
  if (partes.length < 2 || partes.includes('') || partes.includes('..')) return null;
  if (!esUrl && partes.length !== 2) return null;
  const owner = partes[0];
  const repo = partes[1].replace(/\.git$/i, '');
  if (!nombreValido(owner) || !nombreValido(repo)) return null;
  return { owner, repo };
}
