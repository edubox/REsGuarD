import test from 'node:test';
import assert from 'node:assert/strict';
import { crearPlanificador } from '../src/scheduler.js';

function runnerFalso() {
  const pendientes = [];
  const hechas = [];
  let simultaneas = 0;
  let maximo = 0;
  return {
    hechas,
    get maximo() { return maximo; },
    liberar() { pendientes.shift()?.(); },
    ejecutar(id) {
      simultaneas += 1;
      maximo = Math.max(maximo, simultaneas);
      return new Promise((resolve) => {
        pendientes.push(() => {
          simultaneas -= 1;
          hechas.push(id);
          resolve();
        });
      });
    },
  };
}
const turno = () => new Promise((r) => setImmediate(r));
const sinLog = { error() {} };

test('ejecuta de una en una y en orden de llegada', async () => {
  const runner = runnerFalso();
  const p = crearPlanificador({ store: { fuentesPendientes: () => [] }, runner, log: sinLog });
  assert.equal(p.encolar(1), true);
  assert.equal(p.encolar(2), true);
  await turno();
  assert.deepEqual(p.estado(), { enCurso: 1, cola: [2] });
  runner.liberar();
  await turno();
  assert.deepEqual(p.estado(), { enCurso: 2, cola: [] });
  runner.liberar();
  await p.esperar();
  assert.deepEqual(runner.hechas, [1, 2]);
  assert.equal(runner.maximo, 1);
  assert.deepEqual(p.estado(), { enCurso: null, cola: [] });
});

test('no encola dos veces la misma fuente, ni en cola ni en curso', async () => {
  const runner = runnerFalso();
  const p = crearPlanificador({ store: { fuentesPendientes: () => [] }, runner, log: sinLog });
  p.encolar(1);
  p.encolar(2);
  await turno();
  assert.equal(p.encolar(1), false);
  assert.equal(p.encolar('1'), false);
  assert.equal(p.encolar(2), false);
  runner.liberar();
  runner.liberar();
  await turno();
  runner.liberar();
  await p.esperar();
  assert.deepEqual(runner.hechas, [1, 2]);
});

test('tic encola las fuentes vencidas que devuelve el store', async () => {
  const runner = runnerFalso();
  const ahora = new Date('2026-10-12T09:00:00Z');
  let visto = null;
  const store = { fuentesPendientes: (a) => { visto = a; return [{ id: 7 }, { id: 9 }]; } };
  const p = crearPlanificador({ store, runner, ahora: () => ahora, log: sinLog });
  const fin = p.tic();
  await turno();
  runner.liberar();
  await turno();
  runner.liberar();
  await fin;
  assert.equal(visto, ahora);
  assert.deepEqual(runner.hechas, [7, 9]);
});

test('un fallo del runner no detiene la cola', async () => {
  const hechas = [];
  const runner = { ejecutar: async (id) => { if (id === 1) throw new Error('pum'); hechas.push(id); } };
  const p = crearPlanificador({ store: { fuentesPendientes: () => [] }, runner, log: sinLog });
  p.encolar(1);
  p.encolar(2);
  await p.esperar();
  assert.deepEqual(hechas, [2]);
  assert.equal(p.encolar(1), true);
  await p.esperar();
});

test('esperar con la cola vacía se resuelve enseguida, y se puede volver a encolar después', async () => {
  const hechas = [];
  const runner = { ejecutar: async (id) => { hechas.push(id); } };
  const p = crearPlanificador({ store: { fuentesPendientes: () => [] }, runner, log: sinLog });
  await p.esperar();
  await p.tic();
  p.encolar(3);
  await p.esperar();
  p.encolar(4);
  await p.esperar();
  assert.deepEqual(hechas, [3, 4]);
});

test('iniciar hace un tic inmediato y parar detiene el temporizador', async () => {
  const hechas = [];
  const runner = { ejecutar: async (id) => { hechas.push(id); } };
  let llamadas = 0;
  const store = { fuentesPendientes: () => { llamadas += 1; return llamadas === 1 ? [{ id: 5 }] : []; } };
  const p = crearPlanificador({ store, runner, intervaloMs: 5, log: sinLog });
  p.iniciar();
  await p.esperar();
  assert.deepEqual(hechas, [5]);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(llamadas >= 2);
  p.parar();
  const tras = llamadas;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(llamadas, tras);
});

test('si el store lanza, tic no lanza y registra el error', async () => {
  const errores = [];
  const store = { fuentesPendientes: () => { throw new Error('SQLITE_BUSY'); } };
  const p = crearPlanificador({ store, runner: { ejecutar: async () => {} }, log: { error: (m) => errores.push(m) } });
  await p.tic();
  assert.equal(errores.length, 1);
  assert.match(errores[0], /SQLITE_BUSY/);
});

test('iniciar sigue vivo si el primer tic falla', async () => {
  const hechas = [];
  const runner = { ejecutar: async (id) => { hechas.push(id); } };
  let llamadas = 0;
  const store = { fuentesPendientes: () => { llamadas += 1; if (llamadas === 1) throw new Error('SQLITE_BUSY'); return llamadas === 2 ? [{ id: 8 }] : []; } };
  const p = crearPlanificador({ store, runner, intervaloMs: 5, log: sinLog });
  try {
    p.iniciar();
    await new Promise((r) => setTimeout(r, 40));
    await p.esperar();
    assert.deepEqual(hechas, [8]);
  } finally {
    p.parar();
  }
});

test('un runner que lanza null y un log que lanza no dejan el planificador atascado', async () => {
  const hechas = [];
  let primera = true;
  const runner = { ejecutar: async (id) => { if (primera) { primera = false; throw null; } hechas.push(id); } };
  const p = crearPlanificador({ store: { fuentesPendientes: () => [] }, runner, log: { error() { throw new Error('log roto'); } } });
  p.encolar(1);
  await p.esperar().catch(() => {});
  assert.deepEqual(p.estado(), { enCurso: null, cola: [] });
  assert.equal(p.encolar(2), true);
  await p.esperar();
  assert.deepEqual(hechas, [2]);
});
