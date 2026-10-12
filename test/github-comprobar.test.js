import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { crearGithub } from '../src/sources/github.js';
import { FalloCopia } from '../src/errores.js';
import { tmp, crearOrigen, commit, borrarRama, falsoFetch } from './_ayuda.js';

const F = { tipo: 'github', owner: 'o', repo: 'r' };

async function montar(rutas = { '/repos/o/r': { json: {} } }) {
  const base = await tmp();
  const origen = await crearOrigen(base);
  const fetch = falsoFetch(rutas);
  const gh = crearGithub({ fetch, urlRepo: () => origen.bare });
  return { base, origen, fetch, gh };
}

test('FalloCopia lleva motivo y detalle', () => {
  const e = new FalloCopia('vacio', 'sin ramas');
  assert.equal(e.motivo, 'vacio');
  assert.equal(e.detalle, 'sin ramas');
  assert.ok(e instanceof Error);
});

test('repo con contenido: ok, y la huella cambia cuando cambia el origen', async () => {
  const { origen, gh, fetch } = await montar();
  await commit(origen, 'a.txt', 'uno');
  const r1 = await gh.comprobar(F);
  assert.equal(r1.ok, true);
  assert.match(r1.huella, /^[0-9a-f]{64}$/);
  assert.equal((await gh.comprobar(F)).huella, r1.huella);
  await commit(origen, 'a.txt', 'dos');
  assert.notEqual((await gh.comprobar(F)).huella, r1.huella);
  assert.equal(fetch.llamadas[0], 'https://api.github.com/repos/o/r');
});

for (const status of [404, 410, 451]) {
  test(`la API responde ${status}: no_encontrado, aunque git respondiera`, async () => {
    const { origen, gh } = await montar({ '/repos/o/r': { status } });
    await commit(origen, 'a.txt', 'uno');
    const r = await gh.comprobar(F);
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'no_encontrado');
    assert.match(r.detalle, new RegExp(String(status)));
  });
}

test('repo vacío: vacio', async () => {
  const { gh } = await montar();
  const r = await gh.comprobar(F);
  assert.deepEqual({ ok: r.ok, motivo: r.motivo }, { ok: false, motivo: 'vacio' });
});

test('repo vaciado después (todas las ramas borradas): vacio', async () => {
  const { origen, gh } = await montar();
  await commit(origen, 'a.txt', 'uno');
  await borrarRama(origen, 'main');
  assert.equal((await gh.comprobar(F)).motivo, 'vacio');
});

test('límite de la API (403) con git respondiendo: ok, no es un 404', async () => {
  const { origen, gh } = await montar({ '/repos/o/r': { status: 403 } });
  await commit(origen, 'a.txt', 'uno');
  assert.equal((await gh.comprobar(F)).ok, true);
});

test('la API no responde pero git sí: ok', async () => {
  const { origen, gh } = await montar({ '/repos/o/r': { error: 'ENOTFOUND' } });
  await commit(origen, 'a.txt', 'uno');
  assert.equal((await gh.comprobar(F)).ok, true);
});

test('API limitada y git falla: red, con los dos detalles', async () => {
  const base = await tmp();
  const gh = crearGithub({
    fetch: falsoFetch({ '/repos/o/r': { status: 403 } }),
    urlRepo: () => path.join(base, 'no-existe.git'),
  });
  const r = await gh.comprobar(F);
  assert.equal(r.motivo, 'red');
  assert.match(r.detalle, /HTTP 403/);
  assert.match(r.detalle, /git ls-remote/);
});

test('si cancelar el cuerpo falla tras un 404, sigue siendo no_encontrado', async () => {
  const base = await tmp();
  const fetch = async () => ({ status: 404, ok: false, body: { cancel: () => Promise.reject(new Error('cancel roto')) } });
  const gh = crearGithub({ fetch, urlRepo: () => path.join(base, 'no-existe.git') });
  const r = await gh.comprobar(F);
  assert.equal(r.ok, false);
  assert.equal(r.motivo, 'no_encontrado');
});

test('la llamada a la API lleva un signal de tiempo máximo', async () => {
  const { origen, fetch } = await montar();
  await commit(origen, 'a.txt', 'uno');
  let opciones;
  const espia = async (url, o) => { opciones = o; return fetch(url, o); };
  const gh2 = crearGithub({ fetch: espia, urlRepo: () => origen.bare });
  await gh2.comprobar(F);
  assert.ok(opciones.signal instanceof AbortSignal);
});
