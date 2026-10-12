import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { abrirStore } from '../src/store.js';
import { crearAlmacen } from '../src/almacen.js';
import { crearNotificador } from '../src/notifier.js';
import { crearRunner } from '../src/runner.js';
import { git } from '../src/git.js';
import { commit, borrarRama } from './_ayuda.js';
import { escenario } from './_escenario.js';

async function montar(opciones = {}) {
  const e = await escenario(opciones);
  const store = abrirStore(':memory:');
  store.ponerAjuste('telegram_token', '1:tokentokentokentokentoken');
  store.ponerAjuste('telegram_chat', '42');
  const mensajes = [];
  const notificador = crearNotificador({
    store,
    fetch: async (_url, o) => {
      mensajes.push(JSON.parse(o.body).text);
      return new Response('{"ok":true}');
    },
  });
  const reloj = { t: new Date('2026-10-12T09:00:00Z') };
  const f = store.crearFuente({ tipo: 'github', owner: 'o', repo: 'r', frecuenciaHoras: 24, diasGuardar: 7, ahora: reloj.t });
  const datos = path.join(e.base, 'data');
  const almacen = opciones.almacen ?? (opciones.envolver ? opciones.envolver(e.almacen) : e.almacen);
  const runner = crearRunner({
    store: opciones.envolverStore ? opciones.envolverStore(store) : store, almacen, tipos: { github: opciones.tipo ?? e.gh }, notificador, datos, ahora: () => new Date(reloj.t),
  });
  const avanzar = (horas) => { reloj.t = new Date(reloj.t.getTime() + horas * 3600_000); };
  const foto = async () => ({
    instantaneas: (await almacen.instantaneas(f)).map((i) => `${i.nombre}:${i.bytes}`),
    refs: await git(['for-each-ref'], { cwd: path.join(almacen.rutaFuente(f), 'mirror.git') }),
  });
  return { ...e, almacen, store, f, runner, mensajes, reloj, avanzar, datos, foto };
}

test('copia correcta: estado, fechas, tamaños, registro y carpeta de trabajo vacía', async () => {
  const m = await montar();
  const r = await m.runner.ejecutar(m.f.id);
  assert.deepEqual(r, { resultado: 'ok', motivo: null, detalle: null, cambios: true });
  const f = m.store.fuente(m.f.id);
  assert.equal(f.estado, 'ok');
  assert.equal(f.ultima_ok, '2026-10-12T09:00:00.000Z');
  assert.equal(f.proxima_copia, '2026-10-13T09:00:00.000Z');
  assert.equal(f.estado_desde, '2026-10-12T09:00:00.000Z');
  assert.equal(f.num_instantaneas, 1);
  assert.equal(f.primera_instantanea, '2026-10-12T09:00:00.000Z');
  assert.equal(f.ultima_instantanea, '2026-10-12T09:00:00.000Z');
  assert.ok(f.bytes_espejo > 0 && f.bytes_instantaneas > 0);
  assert.match(f.huella_refs, /^[0-9a-f]{64}$/);
  const [ej] = m.store.ejecuciones(m.f.id);
  assert.equal(ej.resultado, 'ok');
  assert.equal(ej.cambios, 1);
  assert.equal(existsSync(path.join(m.datos, 'work', String(m.f.id))), false);
  assert.deepEqual(m.mensajes, []);
});

test('SALVAGUARDA origen vaciado: nada de lo guardado cambia y se avisa', async () => {
  const m = await montar();
  await m.runner.ejecutar(m.f.id);
  const antes = await m.foto();
  await borrarRama(m.origen, 'main');
  m.avanzar(24);
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.resultado, 'error');
  assert.equal(r.motivo, 'vacio');
  assert.deepEqual(await m.foto(), antes);
  const f = m.store.fuente(m.f.id);
  assert.equal(f.estado, 'error');
  assert.equal(f.ultima_ok, '2026-10-12T09:00:00.000Z');
  assert.equal(f.proxima_copia, '2026-10-14T09:00:00.000Z');
  assert.equal(m.mensajes.length, 1);
  assert.match(m.mensajes[0], /vacío/);
});

test('SALVAGUARDA 404: nada de lo guardado cambia y se avisa', async () => {
  const m = await montar();
  await m.runner.ejecutar(m.f.id);
  const antes = await m.foto();
  m.fetch.rutas['/repos/o/r'] = { status: 404 };
  await commit(m.origen, 'a.txt', 'cambio que no debe copiarse');
  m.avanzar(24);
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.motivo, 'no_encontrado');
  assert.deepEqual(await m.foto(), antes);
  assert.equal(m.mensajes.length, 1);
  assert.match(m.mensajes[0], /404/);
});

test('SALVAGUARDA carpeta de destino no disponible: error almacen y nada escrito en la ruta', async () => {
  const base = (await escenario()).base;
  const raiz = path.join(base, 'montaje', 'resguard');
  const almacen = crearAlmacen({ raiz }); // sin marca: como una unidad de red sin montar
  const m = await montar({ almacen });
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.resultado, 'error');
  assert.equal(r.motivo, 'almacen');
  assert.equal(existsSync(raiz), false);
  assert.match(m.mensajes[0], /carpeta de destino/);
});

test('dos fallos iguales seguidos avisan una vez; la recuperación avisa otra', async () => {
  const m = await montar();
  await m.runner.ejecutar(m.f.id);
  m.fetch.rutas['/repos/o/r'] = { status: 404 };
  m.avanzar(24);
  await m.runner.ejecutar(m.f.id);
  m.avanzar(24);
  await m.runner.ejecutar(m.f.id);
  assert.equal(m.mensajes.length, 1);
  m.fetch.rutas['/repos/o/r'] = { json: {} };
  m.avanzar(24);
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.resultado, 'ok');
  assert.equal(m.mensajes.length, 2);
  assert.match(m.mensajes[1], /normalidad/);
});

async function sembrarViejas(m) {
  const dir = path.join(m.almacen.rutaFuente(m.f), 'snapshots');
  const [actual] = await fs.readdir(dir);
  for (const dia of ['01', '02', '03']) {
    await fs.copyFile(path.join(dir, actual), path.join(dir, `2026-09-${dia}T090000Z.code.bundle`));
  }
}

test('la retención corre tras una copia correcta y deja la más reciente anterior al plazo', async () => {
  const m = await montar();
  await m.runner.ejecutar(m.f.id);
  await sembrarViejas(m);
  await commit(m.origen, 'a.txt', 'dos');
  m.avanzar(24);
  await m.runner.ejecutar(m.f.id);
  assert.deepEqual((await m.almacen.instantaneas(m.f)).map((i) => i.marca), [
    '2026-09-03T090000Z', '2026-10-12T090000Z', '2026-10-13T090000Z',
  ]);
  assert.equal(m.store.fuente(m.f.id).num_instantaneas, 3);
});

test('SALVAGUARDA la retención no corre tras un fallo', async () => {
  const m = await montar();
  await m.runner.ejecutar(m.f.id);
  await sembrarViejas(m);
  await borrarRama(m.origen, 'main');
  m.avanzar(24);
  await m.runner.ejecutar(m.f.id);
  assert.equal((await m.almacen.instantaneas(m.f)).length, 4);
});

// Un almacén en el que no se pueden borrar instantáneas (abiertas desde otro equipo, solo lectura…).
const sinPoderBorrar = (estado) => (a) => ({
  ...a,
  borrarInstantanea: async (...args) => {
    if (estado.fallar) throw new Error('EBUSY: el fichero está en uso');
    return a.borrarInstantanea(...args);
  },
});

test('fallo de retención: aviso, la copia cuenta como hecha y el parche se guarda', async () => {
  const estado = { fallar: false };
  const m = await montar({ envolver: sinPoderBorrar(estado) });
  await m.runner.ejecutar(m.f.id);
  const huella1 = m.store.fuente(m.f.id).huella_refs;
  await sembrarViejas(m);
  await commit(m.origen, 'a.txt', 'dos');
  estado.fallar = true;
  m.avanzar(24);
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.resultado, 'aviso');
  assert.equal(r.motivo, 'retencion');
  assert.equal(r.cambios, true);
  assert.match(r.detalle, /2026-09-01T090000Z\.code\.bundle/);
  assert.match(r.detalle, /EBUSY/);
  let f = m.store.fuente(m.f.id);
  assert.equal(f.estado, 'aviso');
  assert.equal(f.motivo, 'retencion');
  assert.equal(f.ultima_ok, '2026-10-13T09:00:00.000Z');
  assert.match(f.huella_refs, /^[0-9a-f]{64}$/);
  assert.notEqual(f.huella_refs, huella1);
  assert.equal(f.num_instantaneas, 5);
  assert.equal(m.mensajes.length, 1);
  assert.match(m.mensajes[0], /no se pudieron borrar instantáneas antiguas/);
  assert.equal(m.store.ejecuciones(m.f.id)[0].resultado, 'aviso');

  // El parche se guardó: sin cambios en el origen no aparece otra instantánea idéntica.
  m.avanzar(24);
  const r2 = await m.runner.ejecutar(m.f.id);
  assert.equal(r2.resultado, 'aviso');
  assert.equal(r2.cambios, false);
  assert.equal((await m.almacen.instantaneas(m.f)).length, 5);
  assert.equal(m.mensajes.length, 1);

  // Cuando ya se puede borrar, la retención se pone al día y se avisa de la vuelta a la normalidad.
  estado.fallar = false;
  m.avanzar(24);
  const r3 = await m.runner.ejecutar(m.f.id);
  assert.equal(r3.resultado, 'ok');
  assert.deepEqual((await m.almacen.instantaneas(m.f)).map((i) => i.marca), [
    '2026-09-03T090000Z', '2026-10-12T090000Z', '2026-10-13T090000Z',
  ]);
  f = m.store.fuente(m.f.id);
  assert.equal(f.estado, 'ok');
  assert.equal(m.mensajes.length, 2);
});

test('fallo de retención junto a otro aviso: se combinan con el formato a+b', async () => {
  const estado = { fallar: false };
  const m = await montar({ envolver: sinPoderBorrar(estado), rutas: { '/repos/o/r/releases/latest': { status: 500 } } });
  await m.runner.ejecutar(m.f.id);
  await sembrarViejas(m);
  estado.fallar = true;
  m.avanzar(24);
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.resultado, 'aviso');
  assert.equal(r.motivo, 'release+retencion');
  assert.match(r.detalle, /HTTP 500.* · .*EBUSY/);
  assert.equal(m.store.fuente(m.f.id).ultima_ok, '2026-10-13T09:00:00.000Z');
  assert.match(m.mensajes.at(-1), /falló la descarga del último release; no se pudieron borrar instantáneas antiguas/);
});

test('la retención usa los días a guardar vigentes al aplicarla, no los leídos al empezar', async () => {
  let m;
  let cambiar = false;
  const tipo = {
    comprobar: (f) => m.gh.comprobar(f),
    copiar: async (...args) => {
      // Como si el usuario editara la fuente en la web mientras se copia.
      if (cambiar) m.store.actualizarFuente(m.f.id, { dias_guardar: 3650 });
      return m.gh.copiar(...args);
    },
  };
  m = await montar({ tipo });
  await m.runner.ejecutar(m.f.id);
  await sembrarViejas(m);
  await commit(m.origen, 'a.txt', 'dos');
  cambiar = true;
  m.avanzar(24);
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.resultado, 'ok');
  assert.equal((await m.almacen.instantaneas(m.f)).length, 5);
});

test('fallo del release: aviso, el código cuenta como copiado', async () => {
  const m = await montar({ rutas: { '/repos/o/r/releases/latest': { status: 500 } } });
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.resultado, 'aviso');
  assert.equal(r.motivo, 'release');
  const f = m.store.fuente(m.f.id);
  assert.equal(f.estado, 'aviso');
  assert.equal(f.ultima_ok, '2026-10-12T09:00:00.000Z');
  assert.equal(f.num_instantaneas, 1);
  assert.match(m.mensajes[0], /release/);
});

test('un error inesperado queda como interno y programa la siguiente copia (no reintenta en bucle)', async () => {
  const tipo = { comprobar: async () => ({ ok: true, huella: 'h' }), copiar: async () => { throw new TypeError('algo roto'); } };
  const m = await montar({ tipo });
  const r = await m.runner.ejecutar(m.f.id);
  assert.deepEqual(r, { resultado: 'error', motivo: 'interno', detalle: 'algo roto', cambios: false });
  assert.equal(m.store.fuente(m.f.id).proxima_copia, '2026-10-13T09:00:00.000Z');
  assert.equal(existsSync(path.join(m.datos, 'work', String(m.f.id))), false);
});

test('ejecutar una fuente que no existe devuelve null', async () => {
  const m = await montar();
  assert.equal(await m.runner.ejecutar(999), null);
});

// Simula que la unidad de red se desmonta: en la ruta queda un punto de montaje
// vacío (sin marca y sin datos) y lo guardado deja de verse hasta volver a montar.
async function desmontar(m) {
  await fs.rename(path.join(m.base, 'nas'), path.join(m.base, 'nas.desmontado'));
  await fs.mkdir(path.join(m.base, 'nas'));
}
async function volverAMontar(m) {
  assert.deepEqual(await fs.readdir(path.join(m.base, 'nas')), [], 'se escribió en el punto de montaje vacío');
  await fs.rmdir(path.join(m.base, 'nas'));
  await fs.rename(path.join(m.base, 'nas.desmontado'), path.join(m.base, 'nas'));
}

test('el destino deja de estar disponible a mitad de la copia: error, nada tocado, siguiente copia programada', async () => {
  let m;
  let romper = false;
  const tipo = {
    comprobar: (f) => m.gh.comprobar(f),
    copiar: async (...args) => {
      // disponible() ya dijo que sí; ahora la unidad «se desmonta».
      if (romper) await desmontar(m);
      return m.gh.copiar(...args);
    },
  };
  m = await montar({ tipo });
  await m.runner.ejecutar(m.f.id);
  const antes = await m.foto();
  const tras1 = m.store.fuente(m.f.id);
  romper = true;
  await commit(m.origen, 'a.txt', 'cambio a mitad de copia');
  m.avanzar(24);
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.resultado, 'error');
  assert.equal(r.motivo, 'almacen');
  assert.equal(r.cambios, false);
  const f = m.store.fuente(m.f.id);
  assert.equal(f.estado, 'error');
  assert.equal(f.motivo, 'almacen');
  assert.equal(f.proxima_copia, '2026-10-14T09:00:00.000Z');
  assert.equal(existsSync(path.join(m.datos, 'work', String(m.f.id))), false);
  await volverAMontar(m);
  assert.deepEqual(await m.foto(), antes);
  // Lo guardado sigue ahí aunque ahora no se vea: las cifras no se ponen a cero.
  assert.equal(f.ultima_ok, '2026-10-12T09:00:00.000Z');
  assert.equal(f.num_instantaneas, 1);
  assert.equal(f.primera_instantanea, '2026-10-12T09:00:00.000Z');
  assert.equal(f.ultima_instantanea, '2026-10-12T09:00:00.000Z');
  assert.equal(f.bytes_espejo, tras1.bytes_espejo);
  assert.equal(f.bytes_instantaneas, tras1.bytes_instantaneas);
  assert.ok(tras1.bytes_espejo > 0 && tras1.bytes_instantaneas > 0);
  assert.equal(m.mensajes.length, 1);
  assert.match(m.mensajes[0], /carpeta de destino/);
  assert.match(m.mensajes[0], /Última instantánea: 2026-10-12T09:00:00\.000Z/);
});

test('el destino se desmonta y la copia falla por otra causa: tampoco se miden ceros', async () => {
  let m;
  let romper = false;
  const tipo = {
    comprobar: (f) => m.gh.comprobar(f),
    copiar: async (...args) => {
      if (!romper) return m.gh.copiar(...args);
      await desmontar(m);
      throw new TypeError('algo roto');
    },
  };
  m = await montar({ tipo });
  await m.runner.ejecutar(m.f.id);
  const tras1 = m.store.fuente(m.f.id);
  romper = true;
  m.avanzar(24);
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.motivo, 'interno');
  const f = m.store.fuente(m.f.id);
  assert.equal(f.num_instantaneas, 1);
  assert.equal(f.ultima_instantanea, '2026-10-12T09:00:00.000Z');
  assert.equal(f.bytes_espejo, tras1.bytes_espejo);
  assert.match(m.mensajes[0], /Última instantánea: 2026-10-12T09:00:00\.000Z/);
  await volverAMontar(m);
});

test('la próxima copia queda fijada en el futuro antes de empezar a copiar (un proceso que muera a mitad no reintenta en bucle)', async () => {
  let m;
  const visto = {};
  const tipo = {
    comprobar: async (f) => {
      visto.alComprobar = m.store.fuente(f.id).proxima_copia;
      visto.enCurso = m.store.ejecuciones(f.id)[0]?.resultado;
      m.avanzar(1); // la copia tarda una hora
      return m.gh.comprobar(f);
    },
    copiar: (...args) => m.gh.copiar(...args),
  };
  m = await montar({ tipo });
  assert.equal(m.store.fuente(m.f.id).proxima_copia, null);
  await m.runner.ejecutar(m.f.id);
  assert.equal(visto.alComprobar, '2026-10-13T09:00:00.000Z');
  assert.equal(visto.enCurso, 'en_curso');
  // El cálculo final se mantiene: cuenta desde que termina.
  assert.equal(m.store.fuente(m.f.id).proxima_copia, '2026-10-13T10:00:00.000Z');
});

test('si el registro final lanza (terminarEjecucion), ejecutar no rechaza: error interno y próxima copia en el futuro', async () => {
  const m = await montar({
    envolverStore: (s) => ({ ...s, terminarEjecucion: () => { throw new Error('database is locked'); } }),
  });
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.resultado, 'error');
  assert.equal(r.motivo, 'interno');
  assert.match(r.detalle, /database is locked/);
  const f = m.store.fuente(m.f.id);
  assert.equal(f.proxima_copia, '2026-10-13T09:00:00.000Z');
  assert.equal(f.estado, 'error');
  assert.equal(f.motivo, 'interno');
  assert.deepEqual(m.store.fuentesPendientes(new Date('2026-10-12T09:01:00Z')), []);
  assert.equal(m.mensajes.length, 1);
  assert.equal(existsSync(path.join(m.datos, 'work', String(m.f.id))), false);
});

test('si el registro final lanza (actualizarFuente), ejecutar no rechaza y la próxima copia ya estaba en el futuro', async () => {
  const m = await montar({
    envolverStore: (s) => ({
      ...s,
      actualizarFuente: (id, campos) => {
        if ('estado' in campos) throw new Error('disk I/O error');
        return s.actualizarFuente(id, campos);
      },
    }),
  });
  const r = await m.runner.ejecutar(m.f.id);
  assert.equal(r.resultado, 'error');
  assert.equal(r.motivo, 'interno');
  assert.match(r.detalle, /disk I\/O error/);
  assert.equal(m.store.fuente(m.f.id).proxima_copia, '2026-10-13T09:00:00.000Z');
  assert.deepEqual(m.store.fuentesPendientes(new Date('2026-10-12T09:01:00Z')), []);
  assert.equal(m.store.ejecuciones(m.f.id)[0].resultado, 'error');
});

test('si iniciarEjecucion lanza, ejecutar no rechaza, no copia nada y la próxima copia queda en el futuro', async () => {
  const m = await montar({
    envolverStore: (s) => ({ ...s, iniciarEjecucion: () => { throw new Error('database is locked'); } }),
  });
  const r = await m.runner.ejecutar(m.f.id);
  assert.deepEqual(r, { resultado: 'error', motivo: 'interno', detalle: 'database is locked', cambios: false });
  const f = m.store.fuente(m.f.id);
  assert.equal(f.estado, 'error');
  assert.equal(f.proxima_copia, '2026-10-13T09:00:00.000Z');
  assert.deepEqual(await m.almacen.instantaneas(m.f), []);
  assert.deepEqual(m.store.ejecuciones(m.f.id), []);
});
