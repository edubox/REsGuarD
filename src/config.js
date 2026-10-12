import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function cargarConfig(env = process.env) {
  return {
    puerto: Number(env.RESGUARD_PUERTO || 3200),
    datos: env.RESGUARD_DATOS || path.join(RAIZ, 'data'),
  };
}
