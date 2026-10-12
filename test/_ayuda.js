import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from '../src/git.js';

export function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'resguard-'));
}

// Un «GitHub» local: repo bare que hace de origen y una copia de trabajo para empujarle commits.
export async function crearOrigen(base, nombre = 'origen') {
  const bare = path.join(base, `${nombre}.git`);
  const wt = path.join(base, `${nombre}-wt`);
  await git(['init', '--bare', '-q', '-b', 'main', bare]);
  await git(['init', '-q', '-b', 'main', wt]);
  await git(['remote', 'add', 'origin', bare], { cwd: wt });
  return { bare, wt };
}

export async function commit(origen, fichero, contenido, rama = 'main') {
  const actual = (await git(['symbolic-ref', '--short', 'HEAD'], { cwd: origen.wt })).trim();
  if (actual !== rama) {
    try {
      await git(['checkout', '-q', rama], { cwd: origen.wt });
    } catch {
      await git(['checkout', '-q', '-b', rama], { cwd: origen.wt });
    }
  }
  await fs.writeFile(path.join(origen.wt, fichero), contenido);
  await git(['add', '-A'], { cwd: origen.wt });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', `cambio en ${fichero}`], { cwd: origen.wt });
  await git(['push', '-q', '-f', 'origin', rama], { cwd: origen.wt });
  return (await git(['rev-parse', 'HEAD'], { cwd: origen.wt })).trim();
}

export async function borrarRama(origen, rama) {
  await git(['update-ref', '-d', `refs/heads/${rama}`], { cwd: origen.bare });
}

// rutas: { '/repos/o/r': { status, json, cuerpo, error } }. La clave puede ser el pathname o la URL completa.
export function falsoFetch(rutas = {}) {
  const llamadas = [];
  const opciones = [];
  const f = async (url, op) => {
    const texto = String(url);
    llamadas.push(texto);
    opciones.push(op);
    const r = rutas[texto] ?? rutas[new URL(texto).pathname];
    if (!r) return new Response('{"message":"Not Found"}', { status: 404 });
    if (r.error) throw new Error(r.error);
    return new Response(r.cuerpo ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  };
  f.llamadas = llamadas;
  f.opciones = opciones;
  f.rutas = rutas;
  return f;
}
