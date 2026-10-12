import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirStore } from '../src/store.js';
import { crearNotificador } from '../src/notifier.js';
import { describirMotivo } from '../src/motivos.js';

const TOKEN = '123456:ABCdefGHIjklMNOpqrSTUvwxYZ0123456789';

function montar({ configurado = true, respuesta } = {}) {
  const store = abrirStore(':memory:');
  if (configurado) {
    store.ponerAjuste('telegram_token', TOKEN);
    store.ponerAjuste('telegram_chat', '-100200300');
  }
  const f = store.crearFuente({ tipo: 'github', owner: 'o', repo: 'r', frecuenciaHoras: 24, diasGuardar: 30, ahora: new Date() });
  const enviados = [];
  const estado = { respuesta: respuesta ?? (() => new Response('{"ok":true}', { status: 200 })) };
  const fetch = async (url, opciones) => {
    enviados.push({ url, cuerpo: JSON.parse(opciones.body), signal: opciones.signal });
    return estado.respuesta();
  };
  const n = crearNotificador({ store, fetch });
  const poner = (campos) => {
    store.actualizarFuente(f.id, campos);
    return store.fuente(f.id);
  };
  return { store, f, enviados, n, poner, estado };
}

test('describirMotivo', () => {
  assert.match(describirMotivo('no_encontrado'), /404/);
  assert.match(describirMotivo('vacio'), /vacío/);
  assert.match(describirMotivo('wiki+release'), /wiki.*release/);
  assert.equal(describirMotivo('algo_nuevo'), 'algo_nuevo');
  assert.equal(describirMotivo(null), '');
});

test('sin configurar no se llama a Telegram', async () => {
  const { n, enviados } = montar({ configurado: false });
  const r = await n.enviar('hola');
  assert.equal(r.enviado, false);
  assert.match(r.detalle, /no está configurado/);
  assert.equal(enviados.length, 0);
});

test('enviar llama a sendMessage con el chat y el texto', async () => {
  const { n, enviados } = montar();
  assert.deepEqual(await n.enviar('hola'), { enviado: true });
  assert.equal(enviados[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(enviados[0].cuerpo.chat_id, '-100200300');
  assert.equal(enviados[0].cuerpo.text, 'hola');
});

test('enviar pasa un signal con tiempo límite a fetch', async () => {
  const { n, enviados } = montar();
  await n.enviar('hola');
  assert.ok(enviados[0].signal instanceof AbortSignal);
});

test('la primera copia correcta no genera aviso', async () => {
  const { n, enviados, poner } = montar();
  await n.avisar(poner({ estado: 'ok', motivo: null }));
  assert.equal(enviados.length, 0);
});

test('al pasar a error se avisa una vez, no en cada intento', async () => {
  const { n, enviados, poner, store, f } = montar();
  await n.avisar(poner({ estado: 'error', motivo: 'vacio', ultima_instantanea: '2026-10-11T09:00:00.000Z' }), { detalle: 'sin ramas' });
  await n.avisar(store.fuente(f.id), { detalle: 'sin ramas' });
  await n.avisar(store.fuente(f.id), { detalle: 'sin ramas' });
  assert.equal(enviados.length, 1);
  const texto = enviados[0].cuerpo.text;
  assert.match(texto, /o\/r/);
  assert.match(texto, /vacío/);
  assert.match(texto, /sin ramas/);
  assert.match(texto, /2026-10-11/);
  assert.equal(store.fuente(f.id).clave_avisada, 'error|vacio');
});

test('si cambia el motivo se avisa de nuevo', async () => {
  const { n, enviados, poner } = montar();
  await n.avisar(poner({ estado: 'error', motivo: 'red' }));
  await n.avisar(poner({ estado: 'error', motivo: 'no_encontrado' }));
  assert.equal(enviados.length, 2);
  assert.match(enviados[1].cuerpo.text, /404/);
});

test('la recuperación se avisa una vez', async () => {
  const { n, enviados, poner, store, f } = montar();
  await n.avisar(poner({ estado: 'error', motivo: 'red' }));
  await n.avisar(poner({ estado: 'ok', motivo: null }));
  await n.avisar(store.fuente(f.id));
  assert.equal(enviados.length, 2);
  assert.match(enviados[1].cuerpo.text, /normalidad/);
  assert.equal(store.fuente(f.id).clave_avisada, 'ok');
});

test('si Telegram falla no se da por avisado y se reintenta en la copia siguiente', async () => {
  const m = montar({ respuesta: () => new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 }) });
  const r = await m.n.avisar(m.poner({ estado: 'error', motivo: 'vacio' }));
  assert.equal(r.enviado, false);
  assert.match(r.detalle, /Unauthorized/);
  assert.equal(m.store.fuente(m.f.id).clave_avisada, null);

  m.estado.respuesta = () => new Response('{"ok":true}', { status: 200 });
  await m.n.avisar(m.store.fuente(m.f.id));
  assert.equal(m.enviados.length, 2);
  assert.equal(m.store.fuente(m.f.id).clave_avisada, 'error|vacio');
});

test('el token nunca aparece en el detalle de un error', async () => {
  const m = montar({ respuesta: () => { throw new Error(`fetch failed: https://api.telegram.org/bot${TOKEN}/sendMessage`); } });
  const r = await m.n.enviar('hola');
  assert.equal(r.enviado, false);
  assert.equal(r.detalle.includes(TOKEN), false);
  assert.match(r.detalle, /fetch failed/);
});

test('si leer los ajustes lanza, enviar no lanza', async () => {
  const store = { ajuste: () => { throw new Error('SQLITE_BUSY'); } };
  const n = crearNotificador({ store, fetch: async () => { throw new Error('no debería llamarse'); } });
  const r = await n.enviar('hola');
  assert.equal(r.enviado, false);
  assert.match(r.detalle, /SQLITE_BUSY/);
});

test('si guardar clave_avisada lanza, avisar no lanza y el aviso cuenta como enviado', async () => {
  const m = montar();
  const fuente = m.poner({ estado: 'error', motivo: 'red' });
  m.store.actualizarFuente = () => { throw new Error('SQLITE_BUSY'); };
  const r = await m.n.avisar(fuente);
  assert.equal(r.enviado, true);
  assert.equal(m.enviados.length, 1);
});
