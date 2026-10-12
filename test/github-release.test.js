import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as esperar } from 'node:timers/promises';
import { nombreSeguro } from '../src/sources/github.js';
import { escenario, copiarUna } from './_escenario.js';

const M1 = '2026-10-12T090000Z';
const M2 = '2026-10-13T090000Z';
const LATEST = '/repos/o/r/releases/latest';

const release = (id, tag, adjuntos) => ({
  json: {
    id, tag_name: tag, name: `Versión ${tag}`, published_at: '2026-10-01T00:00:00Z',
    html_url: `https://github.com/o/r/releases/tag/${tag}`, body: 'notas',
    assets: adjuntos.map(([name, contenido]) => ({
      name, size: contenido.length, browser_download_url: `https://descargas.test/${id}/${name}`,
    })),
  },
});
const descargas = (id, adjuntos) =>
  Object.fromEntries(adjuntos.map(([name, contenido]) => [`https://descargas.test/${id}/${name}`, { cuerpo: contenido }]));
const dirRelease = (e) => path.join(e.almacen.rutaFuente(e.fuente), 'release');

test('nombreSeguro', () => {
  assert.equal(nombreSeguro('app-1.0.tar.gz'), 'app-1.0.tar.gz');
  assert.equal(nombreSeguro('../../etc/passwd'), 'passwd');
  assert.equal(nombreSeguro('a\\b\\c.exe'), 'c.exe');
  assert.equal(nombreSeguro('con espacio.zip'), 'con_espacio.zip');
  assert.equal(nombreSeguro('..'), '_..');
  assert.equal(nombreSeguro(''), '_adjunto');
  assert.equal(nombreSeguro('release.json'), '_release.json');
});

test('release nuevo: adjuntos y metadatos en el almacén', async () => {
  const adj = [['app.zip', 'ZIPZIP'], ['sumas.txt', 'abc']];
  const e = await escenario({ rutas: { [LATEST]: release(10, 'v1.0', adj), ...descargas(10, adj) } });
  const r = await copiarUna(e, M1);
  assert.deepEqual(r.avisos, []);
  assert.equal(r.cambios, true);
  assert.equal(r.parche.release_id, '10');
  assert.equal(r.parche.release_tag, 'v1.0');
  assert.deepEqual((await fs.readdir(dirRelease(e))).sort(), ['app.zip', 'release.json', 'sumas.txt']);
  assert.equal(await fs.readFile(path.join(dirRelease(e), 'app.zip'), 'utf8'), 'ZIPZIP');
  const meta = JSON.parse(await fs.readFile(path.join(dirRelease(e), 'release.json'), 'utf8'));
  assert.equal(meta.tag, 'v1.0');
  assert.deepEqual(meta.adjuntos, [{ nombre: 'app.zip', bytes: 6 }, { nombre: 'sumas.txt', bytes: 3 }]);
});

test('mismo release: no se vuelve a descargar', async () => {
  const adj = [['app.zip', 'ZIPZIP']];
  const e = await escenario({ rutas: { [LATEST]: release(10, 'v1.0', adj), ...descargas(10, adj) } });
  await copiarUna(e, M1);
  const antes = e.fetch.llamadas.filter((u) => u.includes('descargas.test')).length;
  const r = await copiarUna(e, M2);
  assert.equal(r.cambios, false);
  assert.equal('release_id' in r.parche, false);
  assert.equal(e.fetch.llamadas.filter((u) => u.includes('descargas.test')).length, antes);
});

test('mismo release pero la carpeta release ya no está en el destino: se vuelve a guardar, sin aviso', async () => {
  const adj = [['app.zip', 'ZIPZIP']];
  const e = await escenario({ rutas: { [LATEST]: release(10, 'v1.0', adj), ...descargas(10, adj) } });
  await copiarUna(e, M1);
  await fs.rm(dirRelease(e), { recursive: true });
  const r = await copiarUna(e, M2);
  assert.deepEqual(r.avisos, []);
  assert.equal(r.parche.release_id, '10');
  assert.equal(r.parche.release_tag, 'v1.0');
  assert.deepEqual((await fs.readdir(dirRelease(e))).sort(), ['app.zip', 'release.json']);
  assert.equal(await fs.readFile(path.join(dirRelease(e), 'app.zip'), 'utf8'), 'ZIPZIP');
});

test('un release más nuevo sustituye al anterior', async () => {
  const v1 = [['app-1.zip', 'UNO']];
  const v2 = [['app-2.zip', 'DOSDOS']];
  const e = await escenario({ rutas: { [LATEST]: release(10, 'v1.0', v1), ...descargas(10, v1), ...descargas(11, v2) } });
  await copiarUna(e, M1);
  e.fetch.rutas[LATEST] = release(11, 'v2.0', v2);
  const r = await copiarUna(e, M2);
  assert.equal(r.parche.release_tag, 'v2.0');
  assert.deepEqual((await fs.readdir(dirRelease(e))).sort(), ['app-2.zip', 'release.json']);
});

test('si el repo deja de tener releases se conserva el guardado', async () => {
  const adj = [['app.zip', 'ZIPZIP']];
  const e = await escenario({ rutas: { [LATEST]: release(10, 'v1.0', adj), ...descargas(10, adj) } });
  await copiarUna(e, M1);
  delete e.fetch.rutas[LATEST];
  const r = await copiarUna(e, M2);
  assert.deepEqual(r.avisos, []);
  assert.deepEqual((await fs.readdir(dirRelease(e))).sort(), ['app.zip', 'release.json']);
  assert.equal(e.fuente.release_id, '10');
});

test('repo sin releases: ni carpeta ni aviso', async () => {
  const e = await escenario();
  const r = await copiarUna(e, M1);
  assert.deepEqual(r.avisos, []);
  await assert.rejects(fs.readdir(dirRelease(e)), { code: 'ENOENT' });
});

test('descarga incompleta: aviso, release anterior intacto y el código copiado igualmente', async () => {
  const v1 = [['app-1.zip', 'UNO']];
  const e = await escenario({ rutas: { [LATEST]: release(10, 'v1.0', v1), ...descargas(10, v1) } });
  await copiarUna(e, M1);
  const roto = release(11, 'v2.0', [['app-2.zip', 'DOSDOS']]);
  e.fetch.rutas[LATEST] = roto;
  e.fetch.rutas['https://descargas.test/11/app-2.zip'] = { cuerpo: 'DOS' };
  const r = await copiarUna(e, M2);
  assert.deepEqual(r.avisos.map((a) => a.motivo), ['release']);
  assert.match(r.avisos[0].detalle, /app-2\.zip/);
  assert.equal('release_id' in r.parche, false);
  assert.deepEqual((await fs.readdir(dirRelease(e))).sort(), ['app-1.zip', 'release.json']);
  assert.equal((await e.almacen.instantaneas(e.fuente)).length, 1);
});

test('la API de releases falla (500): aviso y nada más', async () => {
  const e = await escenario({ rutas: { [LATEST]: { status: 500 } } });
  const r = await copiarUna(e, M1);
  assert.deepEqual(r.avisos.map((a) => a.motivo), ['release']);
  assert.match(r.avisos[0].detalle, /HTTP 500/);
});

test('la consulta a releases/latest lleva límite de tiempo; la descarga solo uno de inactividad', async () => {
  const adj = [['app.zip', 'ZIPZIP']];
  const e = await escenario({ rutas: { [LATEST]: release(10, 'v1.0', adj), ...descargas(10, adj) } });
  await copiarUna(e, M1);
  const op = (fragmento) => e.fetch.opciones[e.fetch.llamadas.findIndex((u) => u.includes(fragmento))];
  assert.ok(op('/releases/latest').signal instanceof AbortSignal);
  // La descarga lleva un signal de inactividad, no un límite de tiempo total: sigue sin abortar al terminar.
  const sd = op('descargas.test').signal;
  assert.ok(sd instanceof AbortSignal);
  assert.equal(sd.aborted, false);
});

const sinResto = async (ruta) => {
  try {
    return await fs.readdir(ruta);
  } catch {
    return [];
  }
};

test('nombre de adjunto con ../ pasa saneado por copiar y no escapa de release', async () => {
  const adj = [['../../fuera.txt', 'FUERA']];
  const e = await escenario({ rutas: { [LATEST]: release(10, 'v1.0', adj), ...descargas(10, adj) } });
  const r = await copiarUna(e, M1);
  assert.deepEqual(r.avisos, []);
  assert.deepEqual((await fs.readdir(dirRelease(e))).sort(), ['fuera.txt', 'release.json']);
  const meta = JSON.parse(await fs.readFile(path.join(dirRelease(e), 'release.json'), 'utf8'));
  assert.deepEqual(meta.adjuntos, [{ nombre: 'fuera.txt', bytes: 5 }]);
  const fuente = e.almacen.rutaFuente(e.fuente);
  for (const dir of [fuente, path.dirname(fuente), e.dirTrabajo, path.dirname(e.dirTrabajo)]) {
    assert.equal((await sinResto(dir)).includes('fuera.txt'), false, `fuera.txt en ${dir}`);
  }
});

test('nombreSeguro: RELEASE.JSON no choca con release.json', () => {
  assert.notEqual(nombreSeguro('RELEASE.JSON').toLowerCase(), 'release.json');
});

test('colisión por saneado: ambos adjuntos quedan en disco', async () => {
  const adj = [['a b.zip', 'UNO'], ['a_b.zip', 'DOSDOS']];
  const e = await escenario({ rutas: { [LATEST]: release(10, 'v1.0', adj), ...descargas(10, adj) } });
  const r = await copiarUna(e, M1);
  assert.deepEqual(r.avisos, []);
  assert.deepEqual((await fs.readdir(dirRelease(e))).sort(), ['2-a_b.zip', 'a_b.zip', 'release.json']);
  assert.equal(await fs.readFile(path.join(dirRelease(e), 'a_b.zip'), 'utf8'), 'UNO');
  assert.equal(await fs.readFile(path.join(dirRelease(e), '2-a_b.zip'), 'utf8'), 'DOSDOS');
  const meta = JSON.parse(await fs.readFile(path.join(dirRelease(e), 'release.json'), 'utf8'));
  assert.deepEqual(meta.adjuntos, [{ nombre: 'a_b.zip', bytes: 3 }, { nombre: '2-a_b.zip', bytes: 6 }]);
});

test('colisión solo por mayúsculas (destino SMB): ambos adjuntos quedan', async () => {
  const adj = [['App.zip', 'UNO'], ['app.zip', 'DOSDOS'], ['RELEASE.JSON', 'X']];
  const e = await escenario({ rutas: { [LATEST]: release(10, 'v1.0', adj), ...descargas(10, adj) } });
  const r = await copiarUna(e, M1);
  assert.deepEqual(r.avisos, []);
  const nombres = (await fs.readdir(dirRelease(e))).sort();
  assert.equal(new Set(nombres.map((n) => n.toLowerCase())).size, nombres.length);
  assert.equal(nombres.length, 4);
  assert.equal(await fs.readFile(path.join(dirRelease(e), 'App.zip'), 'utf8'), 'UNO');
  assert.equal(await fs.readFile(path.join(dirRelease(e), '2-app.zip'), 'utf8'), 'DOSDOS');
  const meta = JSON.parse(await fs.readFile(path.join(dirRelease(e), 'release.json'), 'utf8'));
  assert.equal(meta.tag, 'v1.0');
  assert.equal(meta.adjuntos.length, 3);
});

const flujo = (trozos, pausaMs, colgar = false) =>
  new ReadableStream({
    async start(c) {
      for (const t of trozos) {
        c.enqueue(new TextEncoder().encode(t));
        await esperar(pausaMs);
      }
      if (!colgar) c.close();
    },
  });

test('descarga colgada sin datos: aviso, release anterior intacto y sin restos', async () => {
  const v1 = [['app-1.zip', 'UNO']];
  const e = await escenario({
    rutas: { [LATEST]: release(10, 'v1.0', v1), ...descargas(10, v1) },
    opcionesGithub: { inactividadMs: 150 },
  });
  await copiarUna(e, M1);
  e.fetch.rutas[LATEST] = release(11, 'v2.0', [['app-2.zip', 'DOSDOS']]);
  e.fetch.rutas['https://descargas.test/11/app-2.zip'] = { cuerpo: flujo(['DOS'], 10, true) };
  const r = await copiarUna(e, M2);
  assert.deepEqual(r.avisos.map((a) => a.motivo), ['release']);
  assert.match(r.avisos[0].detalle, /app-2\.zip.*sin datos/);
  assert.equal('release_id' in r.parche, false);
  assert.deepEqual((await fs.readdir(dirRelease(e))).sort(), ['app-1.zip', 'release.json']);
  assert.equal((await sinResto(e.dirTrabajo)).includes('release'), false);
});

test('descarga lenta pero con datos: no se aborta aunque supere el límite en total', async () => {
  const adj = [['lento.bin', 'AAABBBCCCDDD']];
  const e = await escenario({
    rutas: { [LATEST]: release(10, 'v1.0', adj) },
    opcionesGithub: { inactividadMs: 200 },
  });
  e.fetch.rutas['https://descargas.test/10/lento.bin'] = { cuerpo: flujo(['AAA', 'BBB', 'CCC', 'DDD'], 80) };
  const t0 = Date.now();
  const r = await copiarUna(e, M1);
  assert.ok(Date.now() - t0 > 300);
  assert.deepEqual(r.avisos, []);
  assert.equal(await fs.readFile(path.join(dirRelease(e), 'lento.bin'), 'utf8'), 'AAABBBCCCDDD');
});
