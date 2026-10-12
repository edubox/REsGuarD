import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { RAIZ } from '../src/config.js';
import { tmp } from './_ayuda.js';

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function arrancar() {
  const puerto = await puertoLibre();
  const hijo = spawn(process.execPath, ['src/server.js'], {
    cwd: RAIZ,
    env: { ...process.env, RESGUARD_PUERTO: String(puerto), RESGUARD_DATOS: await tmp() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const fin = new Promise((resolve) => hijo.on('exit', (code, signal) => resolve({ code, signal })));
  let salida = '';
  await new Promise((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error(`el servicio no arrancó: ${salida}`)), 10_000);
    const ver = (trozo) => {
      salida += trozo;
      if (salida.includes('escuchando')) {
        clearTimeout(limite);
        resolve();
      }
    };
    hijo.stdout.on('data', ver);
    hijo.stderr.on('data', ver);
    fin.then((r) => {
      clearTimeout(limite);
      reject(new Error(`el servicio terminó al arrancar (${JSON.stringify(r)}): ${salida}`));
    });
  });
  return { hijo, puerto, fin };
}

// Dentro de un contenedor el servicio es el proceso 1, y ahí Node no muere con
// SIGTERM si nadie la atiende: `docker stop` tardaría diez segundos y lo mataría.
for (const señal of ['SIGTERM', 'SIGINT']) {
  test(`al recibir ${señal} el servicio termina por sí mismo con código 0`, async () => {
    const { hijo, puerto, fin } = await arrancar();
    const r = await fetch(`http://127.0.0.1:${puerto}/api/resumen`);
    assert.equal(r.status, 200);
    await r.text();
    hijo.kill(señal);
    assert.deepEqual(await fin, { code: 0, signal: null });
  });
}
