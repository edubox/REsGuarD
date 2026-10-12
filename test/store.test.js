import test from 'node:test';
import assert from 'node:assert/strict';
import { abrirStore } from '../src/store.js';
import { cargarConfig } from '../src/config.js';

const T0 = new Date('2026-10-12T09:00:00Z');
const nueva = (s, extra = {}) =>
  s.crearFuente({ tipo: 'github', owner: 'o', repo: 'r', frecuenciaHoras: 24, diasGuardar: 30, ahora: T0, ...extra });

test('crearFuente devuelve la fila con valores por defecto', () => {
  const s = abrirStore(':memory:');
  const f = nueva(s);
  assert.equal(f.owner, 'o');
  assert.equal(f.frecuencia_horas, 24);
  assert.equal(f.dias_guardar, 30);
  assert.equal(f.estado, 'pendiente');
  assert.equal(f.activa, 1);
  assert.equal(f.proxima_copia, null);
  assert.equal(f.creada, '2026-10-12T09:00:00.000Z');
  assert.deepEqual(s.fuente(f.id), f);
  assert.equal(s.fuente(999), null);
});

test('el mismo repo con otra capitalización es un duplicado', () => {
  const s = abrirStore(':memory:');
  nueva(s, { owner: 'Torvalds', repo: 'Linux' });
  assert.throws(() => nueva(s, { owner: 'torvalds', repo: 'linux' }), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
  assert.equal(s.fuentePorRepo('github', 'TORVALDS', 'LINUX').owner, 'Torvalds');
});

test('actualizarFuente cambia campos y rechaza columnas desconocidas', () => {
  const s = abrirStore(':memory:');
  const f = nueva(s);
  s.actualizarFuente(f.id, { estado: 'ok', bytes_espejo: 10 });
  assert.equal(s.fuente(f.id).estado, 'ok');
  assert.equal(s.fuente(f.id).bytes_espejo, 10);
  assert.throws(() => s.actualizarFuente(f.id, { 'estado = 1; --': 1 }), /Campo no permitido/);
  assert.throws(() => s.actualizarFuente(f.id, { id: 7 }), /Campo no permitido/);
});

test('fuentesPendientes: sin fecha o vencida sí; futura o inactiva no', () => {
  const s = abrirStore(':memory:');
  const a = nueva(s, { repo: 'a' });
  const b = nueva(s, { repo: 'b' });
  const c = nueva(s, { repo: 'c' });
  const d = nueva(s, { repo: 'd' });
  s.actualizarFuente(b.id, { proxima_copia: '2026-10-12T08:00:00.000Z' });
  s.actualizarFuente(c.id, { proxima_copia: '2026-10-12T10:00:00.000Z' });
  s.actualizarFuente(d.id, { activa: 0 });
  assert.deepEqual(s.fuentesPendientes(T0).map((f) => f.repo).sort(), ['a', 'b']);
});

test('ejecuciones: iniciar, terminar, listar e interrumpir', () => {
  const s = abrirStore(':memory:');
  const f = nueva(s);
  const e1 = s.iniciarEjecucion(f.id, T0);
  s.terminarEjecucion(e1, { fin: new Date('2026-10-12T09:01:00Z'), resultado: 'ok', motivo: null, detalle: null, cambios: true });
  const e2 = s.iniciarEjecucion(f.id, new Date('2026-10-12T10:00:00Z'));
  const otra = s.crearFuente({ tipo: 'github', owner: 'o', repo: 'sin-copia-a-medias', frecuenciaHoras: 24, diasGuardar: 7, ahora: T0 });
  // Devuelve las fuentes afectadas: hay que saberlas antes de que dejen de estar «en_curso».
  assert.deepEqual(s.interrumpirEjecuciones(new Date('2026-10-12T11:00:00Z')), [f.id]);
  assert.deepEqual(s.ejecuciones(otra.id), []);
  assert.deepEqual(s.interrumpirEjecuciones(new Date('2026-10-12T12:00:00Z')), []);
  const lista = s.ejecuciones(f.id);
  assert.equal(lista.length, 2);
  assert.equal(lista[0].id, e2);
  assert.equal(lista[0].resultado, 'interrumpida');
  assert.equal(lista[1].resultado, 'ok');
  assert.equal(lista[1].cambios, 1);
});

test('borrarFuente borra también sus ejecuciones', () => {
  const s = abrirStore(':memory:');
  const f = nueva(s);
  s.iniciarEjecucion(f.id, T0);
  s.borrarFuente(f.id);
  assert.equal(s.fuente(f.id), null);
  assert.deepEqual(s.ejecuciones(f.id), []);
});

test('ajustes', () => {
  const s = abrirStore(':memory:');
  assert.equal(s.ajuste('telegram_token'), null);
  s.ponerAjuste('telegram_token', 'abc');
  s.ponerAjuste('telegram_token', 'def');
  assert.equal(s.ajuste('telegram_token'), 'def');
});

test('cargarConfig: valores por defecto y variables de entorno', () => {
  const d = cargarConfig({});
  assert.equal(d.puerto, 3200);
  assert.match(d.datos, /\/data$/);
  assert.deepEqual(Object.keys(d).sort(), ['datos', 'puerto']);
  const c = cargarConfig({ RESGUARD_PUERTO: '4000', RESGUARD_DATOS: '/y' });
  assert.deepEqual(c, { puerto: 4000, datos: '/y' });
});
