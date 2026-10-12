import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { crearServicio } from '../src/servicio.js';
import { crearGithub } from '../src/sources/github.js';
import { abrirStore } from '../src/store.js';
import { git } from '../src/git.js';
import { tmp, crearOrigen, commit, borrarRama, falsoFetch } from './_ayuda.js';

async function montar(t) {
  const base = await tmp();
  const origen = await crearOrigen(base);
  await commit(origen, 'a.txt', 'uno');
  const config = { puerto: 0, datos: path.join(base, 'data') };
  const destino = path.join(base, 'nas');
  const gh = crearGithub({
    fetch: falsoFetch({ '/repos/o/r': { json: {} } }),
    urlRepo: () => origen.bare,
    urlWiki: () => path.join(base, 'no-hay-wiki.git'),
  });
  const mensajes = [];
  const fetchTelegram = async (_u, o) => { mensajes.push(JSON.parse(o.body).text); return new Response('{"ok":true}'); };
  const servicio = await crearServicio({ config, tipos: { github: gh }, fetchTelegram });
  const servidor = servicio.app.listen(0);
  t.after(() => { servidor.close(); servicio.store.cerrar(); });
  const url = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = async (metodo, ruta, cuerpo) => {
    const r = await fetch(url + ruta, {
      method: metodo,
      headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return { status: r.status, cuerpo: r.status === 204 ? null : await r.json() };
  };
  return { base, origen, config, destino, servicio, mensajes, pedir };
}

test('de extremo a extremo: alta por la API, copia, instantánea restaurable y salvaguarda', async (t) => {
  const m = await montar(t);
  const sinDestino = await m.pedir('GET', '/api/resumen');
  assert.equal(sinDestino.cuerpo.destino, null);
  const aj = await m.pedir('PUT', '/api/ajustes', {
    carpetaDestino: m.destino, telegramToken: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ', telegramChat: '42',
  });
  assert.equal(aj.status, 200);

  const alta = await m.pedir('POST', '/api/fuentes', { repo: 'o/r', frecuenciaHoras: 1, diasGuardar: 7 });
  assert.equal(alta.status, 201);
  await m.servicio.planificador.esperar();

  let [f] = (await m.pedir('GET', '/api/fuentes')).cuerpo;
  assert.equal(f.estado, 'ok');
  assert.equal(f.num_instantaneas, 1);
  assert.ok(f.bytes_espejo > 0);

  const dir = path.join(m.destino, 'github', 'o', 'r');
  const [bundle] = await fs.readdir(path.join(dir, 'snapshots'));
  const restaurado = path.join(m.base, 'restaurado');
  await git(['clone', '-q', path.join(dir, 'snapshots', bundle), restaurado]);
  assert.equal(await fs.readFile(path.join(restaurado, 'a.txt'), 'utf8'), 'uno');

  await borrarRama(m.origen, 'main');
  await m.pedir('POST', `/api/fuentes/${f.id}/copiar`);
  await m.servicio.planificador.esperar();
  [f] = (await m.pedir('GET', '/api/fuentes')).cuerpo;
  assert.equal(f.estado, 'error');
  assert.equal(f.motivo, 'vacio');
  assert.deepEqual(await fs.readdir(path.join(dir, 'snapshots')), [bundle]);
  assert.equal(m.mensajes.length, 1);
  assert.match(m.mensajes[0], /o\/r/);

  const ejecuciones = (await m.pedir('GET', `/api/fuentes/${f.id}/ejecuciones`)).cuerpo;
  assert.deepEqual(ejecuciones.map((e) => e.resultado), ['error', 'ok']);
  assert.deepEqual(await fs.readdir(path.join(m.config.datos, 'work')).catch(() => []), []);
});

const T_ARRANQUE = new Date('2026-10-12T09:00:00Z');

// Deja en disco el estado de un servicio que murió a mitad de una copia y vuelve a arrancarlo.
async function arrancarTrasCorte({ proxima = null, telegram = async () => new Response('{"ok":true}') } = {}) {
  const base = await tmp();
  const config = { puerto: 0, datos: path.join(base, 'data') };
  await fs.mkdir(path.join(config.datos, 'work', '1'), { recursive: true });
  await fs.writeFile(path.join(config.datos, 'work', '1', 'resto'), 'x');
  const previo = abrirStore(path.join(config.datos, 'resguard.db'));
  previo.ponerAjuste('telegram_token', '123456:ABCdefGHIjklMNOpqrSTUvwxYZ');
  previo.ponerAjuste('telegram_chat', '42');
  const f = previo.crearFuente({ tipo: 'github', owner: 'o', repo: 'r', frecuenciaHoras: 24, diasGuardar: 7, ahora: new Date('2026-10-11T09:00:00Z') });
  previo.actualizarFuente(f.id, { estado: 'ok', estado_desde: '2026-10-11T09:00:00.000Z', ultima_ok: '2026-10-11T09:00:00.000Z', proxima_copia: proxima });
  previo.iniciarEjecucion(f.id, new Date('2026-10-12T08:59:00Z'));
  previo.cerrar();

  const llamadas = { comprobar: 0, copiar: 0 };
  const tipos = { github: {
    comprobar: async () => { llamadas.comprobar++; return { ok: false, motivo: 'red', detalle: 'no debería llamarse' }; },
    copiar: async () => { llamadas.copiar++; throw new Error('no debería llamarse'); },
  } };
  const mensajes = [];
  const fetchTelegram = async (u, o) => { mensajes.push(JSON.parse(o.body).text); return telegram(u, o); };
  const servicio = await crearServicio({ config, tipos, fetchTelegram, ahora: () => new Date(T_ARRANQUE) });
  await servicio.avisosDeArranque;
  return { config, f, servicio, llamadas, mensajes };
}

test('al arrancar: limpia la carpeta de trabajo y deja en error «interrumpida», avisada y sin relanzar, la copia a medias', async (t) => {
  const m = await arrancarTrasCorte();
  t.after(() => m.servicio.store.cerrar());
  const { store, planificador } = m.servicio;
  assert.equal(existsSync(path.join(m.config.datos, 'work', '1')), false);
  assert.equal(store.ejecuciones(m.f.id)[0].resultado, 'interrumpida');
  const f = store.fuente(m.f.id);
  assert.equal(f.estado, 'error');
  assert.equal(f.motivo, 'interrumpida');
  assert.equal(f.estado_desde, '2026-10-12T09:00:00.000Z');
  assert.equal(f.ultima_ok, '2026-10-11T09:00:00.000Z');
  assert.equal(f.proxima_copia, '2026-10-13T09:00:00.000Z');
  assert.equal(m.mensajes.length, 1);
  assert.match(m.mensajes[0], /o\/r/);
  assert.match(m.mensajes[0], /se interrumpió por un reinicio del servicio/);
  assert.equal(f.clave_avisada, 'error|interrumpida');

  // El primer tic no la relanza: no hay bucle de reintentos tras un proceso muerto.
  await planificador.tic();
  assert.deepEqual(m.llamadas, { comprobar: 0, copiar: 0 });
  assert.deepEqual(planificador.estado(), { enCurso: null, cola: [] });
  assert.equal(store.ejecuciones(m.f.id).length, 1);
});

test('al arrancar tras un corte: una próxima copia ya pasada se lleva al futuro; una futura no se toca', async (t) => {
  const pasada = await arrancarTrasCorte({ proxima: '2026-10-12T08:00:00.000Z' });
  t.after(() => pasada.servicio.store.cerrar());
  assert.equal(pasada.servicio.store.fuente(pasada.f.id).proxima_copia, '2026-10-13T09:00:00.000Z');
  await pasada.servicio.planificador.tic();
  assert.deepEqual(pasada.llamadas, { comprobar: 0, copiar: 0 });

  const futura = await arrancarTrasCorte({ proxima: '2026-10-12T15:00:00.000Z' });
  t.after(() => futura.servicio.store.cerrar());
  const f = futura.servicio.store.fuente(futura.f.id);
  assert.equal(f.proxima_copia, '2026-10-12T15:00:00.000Z');
  assert.equal(f.motivo, 'interrumpida');
});

test('al arrancar tras un corte: si el aviso no puede salir, el servicio arranca igual', async (t) => {
  const m = await arrancarTrasCorte({ telegram: async () => { throw new Error('sin red'); } });
  t.after(() => m.servicio.store.cerrar());
  const f = m.servicio.store.fuente(m.f.id);
  assert.equal(f.estado, 'error');
  assert.equal(f.motivo, 'interrumpida');
  assert.equal(f.clave_avisada, null);
  assert.equal(m.mensajes.length, 1);
});

test('arranque normal, sin copias a medias: no se toca ninguna fuente ni se avisa', async (t) => {
  const base = await tmp();
  const config = { puerto: 0, datos: path.join(base, 'data') };
  await fs.mkdir(config.datos, { recursive: true });
  const previo = abrirStore(path.join(config.datos, 'resguard.db'));
  previo.ponerAjuste('telegram_token', '123456:ABCdefGHIjklMNOpqrSTUvwxYZ');
  previo.ponerAjuste('telegram_chat', '42');
  const f = previo.crearFuente({ tipo: 'github', owner: 'o', repo: 'r', frecuenciaHoras: 24, diasGuardar: 7, ahora: new Date('2026-10-11T09:00:00Z') });
  const e = previo.iniciarEjecucion(f.id, new Date('2026-10-11T09:00:00Z'));
  previo.terminarEjecucion(e, { fin: new Date('2026-10-11T09:01:00Z'), resultado: 'ok', motivo: null, detalle: null, cambios: true });
  const antes = previo.fuente(f.id);
  previo.cerrar();
  const mensajes = [];
  const servicio = await crearServicio({
    config, fetchTelegram: async (_u, o) => { mensajes.push(o.body); return new Response('{"ok":true}'); }, ahora: () => new Date(T_ARRANQUE),
  });
  t.after(() => servicio.store.cerrar());
  await servicio.avisosDeArranque;
  assert.deepEqual(servicio.store.fuente(f.id), antes);
  assert.deepEqual(mensajes, []);
});
