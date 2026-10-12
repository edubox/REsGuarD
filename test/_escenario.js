import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { crearAlmacen } from '../src/almacen.js';
import { crearGithub } from '../src/sources/github.js';
import { tmp, crearOrigen, commit, falsoFetch } from './_ayuda.js';

export async function escenario({ rutas = {}, wiki = false, verificar, opcionesGithub = {} } = {}) {
  const base = await tmp();
  const origen = await crearOrigen(base);
  await commit(origen, 'a.txt', 'uno');
  const origenWiki = wiki ? await crearOrigen(base, 'wiki') : null;
  if (origenWiki) await commit(origenWiki, 'Home.md', 'hola');
  const almacen = crearAlmacen({ raiz: path.join(base, 'nas') });
  await almacen.preparar(path.join(base, 'nas'));
  const fetch = falsoFetch({ '/repos/o/r': { json: {} }, ...rutas });
  const gh = crearGithub({
    fetch,
    urlRepo: () => origen.bare,
    urlWiki: () => (origenWiki ? origenWiki.bare : path.join(base, 'no-hay-wiki.git')),
    ...(verificar ? { verificar } : {}),
    ...opcionesGithub,
  });
  const fuente = {
    id: 1, tipo: 'github', owner: 'o', repo: 'r', frecuencia_horas: 24, dias_guardar: 30,
    huella_refs: null, huella_wiki: null, release_id: null, release_tag: null,
  };
  return { base, origen, origenWiki, almacen, fetch, gh, fuente, dirTrabajo: path.join(base, 'work') };
}

export async function copiarUna(e, marca) {
  const c = await e.gh.comprobar(e.fuente);
  assert.equal(c.ok, true, `comprobar falló: ${c.motivo}`);
  await fs.mkdir(e.dirTrabajo, { recursive: true });
  const r = await e.gh.copiar(e.fuente, { almacen: e.almacen, dirTrabajo: e.dirTrabajo, marca, huella: c.huella });
  Object.assign(e.fuente, r.parche);
  return r;
}
