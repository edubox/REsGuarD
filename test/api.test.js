import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { abrirStore } from '../src/store.js';
import { crearAlmacen } from '../src/almacen.js';
import { crearNotificador } from '../src/notifier.js';
import { crearApp } from '../src/api.js';
import { tmp } from './_ayuda.js';

const TOKEN = '123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789';
const AHORA = new Date('2026-10-20T09:00:00Z');

async function montar(t, envolver) {
  const base = await tmp();
  const store = abrirStore(':memory:');
  const almacen = crearAlmacen({ raiz: () => store.ajuste('almacen_raiz') });
  const destino = path.join(base, 'nas');
  await almacen.preparar(destino);
  store.ponerAjuste('almacen_raiz', destino);
  const comprobaciones = { respuesta: { ok: true, huella: 'h' } };
  const tipos = { github: { comprobar: async () => comprobaciones.respuesta } };
  const plan = { enCurso: null, cola: [], encoladas: [] };
  const planificador = {
    encolar: (id) => { plan.encoladas.push(Number(id)); return true; },
    estado: () => ({ enCurso: plan.enCurso, cola: plan.cola }),
  };
  const telegram = { ok: true, textos: [] };
  const notificador = crearNotificador({
    store,
    fetch: async (_u, o) => {
      telegram.textos.push(JSON.parse(o.body).text);
      return new Response(JSON.stringify(telegram.ok ? { ok: true } : { ok: false, description: 'chat not found' }), { status: telegram.ok ? 200 : 400 });
    },
  });
  const publico = path.join(base, 'public');
  await fs.mkdir(publico);
  await fs.writeFile(path.join(publico, 'index.html'), '<title>REsGuarD</title>');
  const app = crearApp({ store, almacen: envolver ? envolver(almacen, plan) : almacen, planificador, notificador, tipos, publico, ahora: () => AHORA });
  const servidor = app.listen(0);
  t.after(() => servidor.close());
  const url = `http://127.0.0.1:${servidor.address().port}`;
  const pedir = async (metodo, ruta, cuerpo, crudo) => {
    const r = await fetch(url + ruta, {
      method: metodo,
      headers: cuerpo !== undefined || crudo ? { 'Content-Type': 'application/json' } : {},
      body: crudo ?? (cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined),
    });
    const texto = await r.text();
    return { status: r.status, cuerpo: texto ? JSON.parse(texto) : null };
  };
  const alta = (repo = 'octocat/Hello-World', extra = {}) =>
    pedir('POST', '/api/fuentes', { repo, frecuenciaHoras: 24, diasGuardar: 30, ...extra });
  return { base, destino, store, almacen, comprobaciones, plan, telegram, pedir, alta, url };
}

test('POST /api/fuentes crea la fuente, la encola y acepta una URL', async (t) => {
  const m = await montar(t);
  const r = await m.alta('https://github.com/octocat/Hello-World/');
  assert.equal(r.status, 201);
  assert.equal(r.cuerpo.owner, 'octocat');
  assert.equal(r.cuerpo.repo, 'Hello-World');
  assert.equal(r.cuerpo.frecuencia_horas, 24);
  assert.equal(r.cuerpo.estado, 'pendiente');
  assert.deepEqual(m.plan.encoladas, [r.cuerpo.id]);
});

test('POST con un repo que no existe: 404 y no se crea', async (t) => {
  const m = await montar(t);
  m.comprobaciones.respuesta = { ok: false, motivo: 'no_encontrado', detalle: 'HTTP 404' };
  const r = await m.alta();
  assert.equal(r.status, 404);
  assert.match(r.cuerpo.error, /no existe/);
  assert.deepEqual(m.store.fuentes(), []);
  assert.deepEqual(m.plan.encoladas, []);
});

test('POST con un repo vacío: 422; sin conexión: 502; ninguno crea fuente', async (t) => {
  const m = await montar(t);
  m.comprobaciones.respuesta = { ok: false, motivo: 'vacio', detalle: '' };
  assert.equal((await m.alta()).status, 422);
  m.comprobaciones.respuesta = { ok: false, motivo: 'red', detalle: 'timeout' };
  assert.equal((await m.alta()).status, 502);
  assert.deepEqual(m.store.fuentes(), []);
});

test('POST duplicado, también con otra capitalización: 409', async (t) => {
  const m = await montar(t);
  assert.equal((await m.alta('octocat/Hello-World')).status, 201);
  const r = await m.alta('OctoCat/hello-world');
  assert.equal(r.status, 409);
  assert.equal(m.store.fuentes().length, 1);
});

test('POST con datos no válidos: 400', async (t) => {
  const m = await montar(t);
  const casos = [
    { repo: 'a/..' }, { repo: 'solo' }, { repo: 'a/b/../c' }, { repo: '' }, { repo: 7 },
    { frecuenciaHoras: 0 }, { frecuenciaHoras: 1.5 }, { frecuenciaHoras: '24' }, { frecuenciaHoras: 8761 }, { frecuenciaHoras: null },
    { diasGuardar: 0 }, { diasGuardar: -1 }, { diasGuardar: 3651 }, { diasGuardar: '30' },
  ];
  for (const extra of casos) {
    const r = await m.pedir('POST', '/api/fuentes', { repo: 'octocat/Hello-World', frecuenciaHoras: 24, diasGuardar: 30, ...extra });
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(typeof r.cuerpo.error, 'string');
  }
  assert.deepEqual(m.store.fuentes(), []);
});

test('JSON mal formado: 400 en JSON', async (t) => {
  const m = await montar(t);
  const r = await m.pedir('POST', '/api/fuentes', undefined, '{mal');
  assert.equal(r.status, 400);
  assert.equal(typeof r.cuerpo.error, 'string');
});

test('GET /api/fuentes añade estado de cola, días disponibles, texto del motivo y ruta', async (t) => {
  const m = await montar(t);
  const { cuerpo: f } = await m.alta();
  m.store.actualizarFuente(f.id, { estado: 'error', motivo: 'vacio', primera_instantanea: '2026-10-10T08:00:00.000Z' });
  m.plan.enCurso = f.id;
  const r = await m.pedir('GET', '/api/fuentes');
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.length, 1);
  assert.equal(r.cuerpo[0].en_curso, true);
  assert.equal(r.cuerpo[0].en_cola, false);
  assert.equal(r.cuerpo[0].dias_disponibles, 10);
  assert.match(r.cuerpo[0].motivo_texto, /vacío/);
  assert.equal(r.cuerpo[0].ruta, path.join(m.base, 'nas', 'github', 'octocat', 'Hello-World'));
});

test('PATCH cambia frecuencia, días y pausa; valida', async (t) => {
  const m = await montar(t);
  const { cuerpo: f } = await m.alta();
  m.store.actualizarFuente(f.id, { proxima_copia: '2026-10-25T09:00:00.000Z' });
  const r = await m.pedir('PATCH', `/api/fuentes/${f.id}`, { frecuenciaHoras: 6, diasGuardar: 90, activa: false });
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.frecuencia_horas, 6);
  assert.equal(r.cuerpo.dias_guardar, 90);
  assert.equal(r.cuerpo.activa, 0);
  assert.equal(r.cuerpo.proxima_copia, '2026-10-20T15:00:00.000Z');
  assert.equal((await m.pedir('PATCH', `/api/fuentes/${f.id}`, { frecuenciaHoras: 0 })).status, 400);
  assert.equal((await m.pedir('PATCH', `/api/fuentes/${f.id}`, { activa: 'no' })).status, 400);
  assert.equal((await m.pedir('PATCH', '/api/fuentes/999', { diasGuardar: 5 })).status, 404);
});

test('DELETE conserva los datos salvo que se pida borrarlos', async (t) => {
  const m = await montar(t);
  const { cuerpo: a } = await m.alta('o/a');
  const { cuerpo: b } = await m.alta('o/b');
  for (const f of [a, b]) {
    const dir = path.join(m.almacen.rutaFuente(f), 'snapshots');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '2026-10-12T090000Z.code.bundle'), 'x');
  }
  assert.equal((await m.pedir('DELETE', `/api/fuentes/${a.id}`)).status, 204);
  assert.equal(existsSync(m.almacen.rutaFuente(a)), true);
  assert.equal((await m.pedir('DELETE', `/api/fuentes/${b.id}?borrarDatos=1`)).status, 204);
  assert.equal(existsSync(m.almacen.rutaFuente(b)), false);
  assert.deepEqual(m.store.fuentes(), []);
  assert.equal((await m.pedir('DELETE', '/api/fuentes/999')).status, 404);
});

test('DELETE mientras se está copiando: 409', async (t) => {
  const m = await montar(t);
  const { cuerpo: f } = await m.alta();
  m.plan.enCurso = f.id;
  assert.equal((await m.pedir('DELETE', `/api/fuentes/${f.id}`)).status, 409);
  assert.equal(m.store.fuentes().length, 1);
});

test('POST copiar encola; GET ejecuciones lista', async (t) => {
  const m = await montar(t);
  const { cuerpo: f } = await m.alta();
  const r = await m.pedir('POST', `/api/fuentes/${f.id}/copiar`);
  assert.equal(r.status, 202);
  assert.deepEqual(r.cuerpo, { encolada: true });
  assert.deepEqual(m.plan.encoladas, [f.id, f.id]);
  assert.equal((await m.pedir('POST', '/api/fuentes/999/copiar')).status, 404);
  m.store.iniciarEjecucion(f.id, AHORA);
  const e = await m.pedir('GET', `/api/fuentes/${f.id}/ejecuciones`);
  assert.equal(e.cuerpo.length, 1);
  assert.equal((await m.pedir('GET', '/api/fuentes/999/ejecuciones')).status, 404);
});

test('ajustes: el token se guarda pero nunca se devuelve entero', async (t) => {
  const m = await montar(t);
  assert.deepEqual((await m.pedir('GET', '/api/ajustes')).cuerpo, { carpetaDestino: m.destino, telegramToken: '', telegramChat: '', configurado: false });
  const r = await m.pedir('PUT', '/api/ajustes', { telegramToken: TOKEN, telegramChat: '-100200300' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.cuerpo, { carpetaDestino: m.destino, telegramToken: '••••6789', telegramChat: '-100200300', configurado: true });
  assert.equal(JSON.stringify((await m.pedir('GET', '/api/ajustes')).cuerpo).includes(TOKEN), false);
  assert.equal(m.store.ajuste('telegram_token'), TOKEN);
});

test('ajustes: reenviar el token enmascarado o no enviarlo no lo pisa', async (t) => {
  const m = await montar(t);
  await m.pedir('PUT', '/api/ajustes', { telegramToken: TOKEN, telegramChat: '1' });
  await m.pedir('PUT', '/api/ajustes', { telegramToken: '••••6789', telegramChat: '2' });
  assert.equal(m.store.ajuste('telegram_token'), TOKEN);
  await m.pedir('PUT', '/api/ajustes', { telegramChat: '@canal_avisos' });
  assert.equal(m.store.ajuste('telegram_token'), TOKEN);
  assert.equal(m.store.ajuste('telegram_chat'), '@canal_avisos');
});

test('ajustes: token o chat con formato imposible: 400', async (t) => {
  const m = await montar(t);
  assert.equal((await m.pedir('PUT', '/api/ajustes', { telegramToken: 'no-es-un-token' })).status, 400);
  assert.equal((await m.pedir('PUT', '/api/ajustes', { telegramChat: 'hola mundo' })).status, 400);
  assert.equal((await m.pedir('PUT', '/api/ajustes', { telegramChat: 5 })).status, 400);
  assert.equal(m.store.ajuste('telegram_token'), null);
});

test('ajustes: cambiar la carpeta de destino la prepara, la guarda y las fuentes pasan a usarla', async (t) => {
  const m = await montar(t);
  const nueva = path.join(m.base, 'otro', 'destino');
  const r = await m.pedir('PUT', '/api/ajustes', { carpetaDestino: `  ${nueva}/ ` });
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.carpetaDestino, nueva);
  assert.equal(existsSync(path.join(nueva, '.resguard')), true);
  assert.deepEqual(await m.almacen.disponible(), { ok: true });
  await m.alta();
  const [f] = (await m.pedir('GET', '/api/fuentes')).cuerpo;
  assert.equal(f.ruta, path.join(nueva, 'github', 'octocat', 'Hello-World'));
});

test('ajustes: carpeta de destino no válida: 400; cambiarla a media copia: 409', async (t) => {
  const m = await montar(t);
  assert.equal((await m.pedir('PUT', '/api/ajustes', { carpetaDestino: 'copias/relativa' })).status, 400);
  assert.equal((await m.pedir('PUT', '/api/ajustes', { carpetaDestino: 7 })).status, 400);
  m.plan.enCurso = 1;
  const nueva = path.join(m.base, 'otra');
  const r = await m.pedir('PUT', '/api/ajustes', { carpetaDestino: nueva });
  assert.equal(r.status, 409);
  assert.equal(existsSync(nueva), false);
  assert.equal(m.store.ajuste('almacen_raiz'), m.destino);
  // reenviar la misma carpeta (lo hace el formulario al guardar el token) no es un cambio
  assert.equal((await m.pedir('PUT', '/api/ajustes', { carpetaDestino: m.destino, telegramChat: '5' })).status, 200);
});

test('sin carpeta de destino la web sigue funcionando: ruta y destino nulos', async (t) => {
  const m = await montar(t);
  m.store.ponerAjuste('almacen_raiz', '');
  const { cuerpo: f } = await m.alta();
  assert.equal((await m.pedir('GET', '/api/fuentes')).cuerpo[0].ruta, null);
  const r = await m.pedir('GET', '/api/resumen');
  assert.equal(r.cuerpo.destino, null);
  assert.equal(r.cuerpo.libre, null);
  assert.equal(r.cuerpo.destino_disponible, false);
  assert.equal((await m.pedir('GET', '/api/ajustes')).cuerpo.carpetaDestino, '');
  assert.equal((await m.pedir('DELETE', `/api/fuentes/${f.id}?borrarDatos=1`)).status, 204);
});

test('probar: envía un mensaje; si Telegram lo rechaza, 502 con el motivo', async (t) => {
  const m = await montar(t);
  await m.pedir('PUT', '/api/ajustes', { telegramToken: TOKEN, telegramChat: '1' });
  assert.deepEqual(await m.pedir('POST', '/api/ajustes/probar'), { status: 200, cuerpo: { ok: true } });
  assert.match(m.telegram.textos[0], /REsGuarD/);
  m.telegram.ok = false;
  const r = await m.pedir('POST', '/api/ajustes/probar');
  assert.equal(r.status, 502);
  assert.match(r.cuerpo.error, /chat not found/);
});

test('resumen: totales', async (t) => {
  const m = await montar(t);
  const { cuerpo: f } = await m.alta();
  m.store.actualizarFuente(f.id, { bytes_espejo: 100, bytes_instantaneas: 20, bytes_release: 3 });
  const r = await m.pedir('GET', '/api/resumen');
  assert.equal(r.cuerpo.destino, m.destino);
  assert.equal(r.cuerpo.fuentes, 1);
  assert.equal(r.cuerpo.bytes_total, 123);
  assert.equal(typeof r.cuerpo.libre, 'number');
  assert.equal(r.cuerpo.en_curso, false);
  assert.equal(r.cuerpo.telegram_configurado, false);
  assert.equal(r.cuerpo.destino_disponible, true);
});

test('resumen con la unidad sin montar: destino configurado pero no disponible, y sin espacio libre', async (t) => {
  const m = await montar(t);
  await fs.rm(path.join(m.destino, '.resguard'));
  const r = await m.pedir('GET', '/api/resumen');
  assert.equal(r.cuerpo.destino, m.destino);
  assert.equal(r.cuerpo.destino_disponible, false);
  assert.equal(r.cuerpo.libre, null);
  // Consultar el resumen no escribe nada en el punto de montaje vacío.
  assert.deepEqual(await fs.readdir(m.destino), []);
});

test('GET /api/fuentes lleva el detalle de la última ejecución terminada, o null', async (t) => {
  const m = await montar(t);
  const { cuerpo: f } = await m.alta();
  const detalleDe = async () => (await m.pedir('GET', '/api/fuentes')).cuerpo[0].detalle;
  assert.equal(await detalleDe(), null);
  const e1 = m.store.iniciarEjecucion(f.id, AHORA);
  assert.equal(await detalleDe(), null);
  m.store.terminarEjecucion(e1, { fin: AHORA, resultado: 'error', motivo: 'red', detalle: 'git ls-remote: <b>no se pudo</b> resolver github.com', cambios: false });
  assert.equal(await detalleDe(), 'git ls-remote: <b>no se pudo</b> resolver github.com');
  // Una copia en curso no tapa el detalle de la última que terminó.
  const e2 = m.store.iniciarEjecucion(f.id, AHORA);
  assert.equal(await detalleDe(), 'git ls-remote: <b>no se pudo</b> resolver github.com');
  m.store.terminarEjecucion(e2, { fin: AHORA, resultado: 'ok', motivo: null, detalle: null, cambios: true });
  assert.equal(await detalleDe(), null);
  // Y es de cada fuente, no de la última ejecución de cualquiera.
  const { cuerpo: otra } = await m.alta('octocat/Otra');
  const e3 = m.store.iniciarEjecucion(otra.id, AHORA);
  m.store.terminarEjecucion(e3, { fin: AHORA, resultado: 'aviso', motivo: 'release', detalle: 'HTTP 500', cambios: true });
  const lista = (await m.pedir('GET', '/api/fuentes')).cuerpo;
  assert.deepEqual(lista.map((x) => [x.repo, x.detalle]), [['Hello-World', null], ['Otra', 'HTTP 500']]);
});

test('sirve la web estática y responde 404 en JSON a rutas de API desconocidas', async (t) => {
  const m = await montar(t);
  const html = await (await fetch(`${m.url}/`)).text();
  assert.match(html, /REsGuarD/);
  const r = await m.pedir('GET', '/api/nada');
  assert.equal(r.status, 404);
  assert.equal(typeof r.cuerpo.error, 'string');
});

test('DELETE con borrarDatos y la unidad sin montar: 503, la fuente y sus datos se conservan', async (t) => {
  const m = await montar(t);
  const { cuerpo: f } = await m.alta();
  const dir = path.join(m.almacen.rutaFuente(f), 'snapshots');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '2026-10-12T090000Z.code.bundle'), 'x');
  await fs.rm(path.join(m.destino, '.resguard'));
  const r = await m.pedir('DELETE', `/api/fuentes/${f.id}?borrarDatos=1`);
  assert.equal(r.status, 503);
  assert.match(r.cuerpo.error, /marca de REsGuarD/);
  assert.equal(m.store.fuentes().length, 1);
  assert.equal(existsSync(m.almacen.rutaFuente(f)), true);
  // sin borrarDatos no se toca el almacén: se puede quitar de la lista
  assert.equal((await m.pedir('DELETE', `/api/fuentes/${f.id}`)).status, 204);
  assert.deepEqual(m.store.fuentes(), []);
  assert.equal(existsSync(m.almacen.rutaFuente(f)), true);
});

test('PUT carpeta: si una copia arranca mientras se prepara la carpeta nueva, 409 y no se guarda', async (t) => {
  const m = await montar(t, (almacen, plan) => ({
    ...almacen,
    preparar: async (r) => { const p = await almacen.preparar(r); plan.enCurso = 1; return p; },
  }));
  const nueva = path.join(m.base, 'otra');
  const r = await m.pedir('PUT', '/api/ajustes', { carpetaDestino: nueva });
  assert.equal(r.status, 409);
  assert.equal(m.store.ajuste('almacen_raiz'), m.destino);
});

test('PUT carpeta: la misma carpeta escrita con /./ no es un cambio, aunque haya una copia en curso', async (t) => {
  const m = await montar(t);
  m.plan.enCurso = 1;
  const r = await m.pedir('PUT', '/api/ajustes', { carpetaDestino: `${m.base}/./nas` });
  assert.equal(r.status, 200);
  assert.equal(r.cuerpo.carpetaDestino, m.destino);
});

test('DELETE: si la fuente se encola mientras se comprueba la unidad, 409 y no se borra nada', async (t) => {
  let id;
  const m = await montar(t, (almacen, plan) => ({
    ...almacen,
    disponible: async () => { const d = await almacen.disponible(); plan.cola = [id]; return d; },
  }));
  const { cuerpo: f } = await m.alta();
  id = f.id;
  await fs.mkdir(m.almacen.rutaFuente(f), { recursive: true });
  const r = await m.pedir('DELETE', `/api/fuentes/${f.id}?borrarDatos=1`);
  assert.equal(r.status, 409);
  assert.equal(m.store.fuentes().length, 1);
  assert.equal(existsSync(m.almacen.rutaFuente(f)), true);
});

test('DELETE: si no se pueden borrar las copias, 500 con la ruta y la fuente ya fuera de la lista', async (t) => {
  const m = await montar(t, (almacen) => ({
    ...almacen,
    borrarFuente: async () => { throw new Error('EBUSY'); },
  }));
  const { cuerpo: f } = await m.alta();
  const dir = m.almacen.rutaFuente(f);
  await fs.mkdir(dir, { recursive: true });
  const r = await m.pedir('DELETE', `/api/fuentes/${f.id}?borrarDatos=1`);
  assert.equal(r.status, 500);
  assert.ok(r.cuerpo.error.includes(dir), r.cuerpo.error);
  assert.match(r.cuerpo.error, /quitado de la lista/);
  assert.deepEqual(m.store.fuentes(), []);
  assert.equal(existsSync(dir), true);
});
