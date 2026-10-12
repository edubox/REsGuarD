import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { crearAlmacen, marcaDe, fechaDeMarca } from '../src/almacen.js';
import { FalloCopia } from '../src/errores.js';
import { tmp } from './_ayuda.js';

const F = { tipo: 'github', owner: 'o', repo: 'r' };
async function nuevo() {
  const base = await tmp();
  const almacen = crearAlmacen({ raiz: path.join(base, 'nas') });
  await almacen.preparar(path.join(base, 'nas'));
  return { base, almacen };
}

async function bundleFalso(base, nombre, contenido = 'x') {
  const f = path.join(base, nombre);
  await fs.writeFile(f, contenido);
  return f;
}

test('marcaDe y fechaDeMarca son inversas', () => {
  const d = new Date('2026-10-12T09:05:07Z');
  assert.equal(marcaDe(d), '2026-10-12T090507Z');
  assert.equal(fechaDeMarca('2026-10-12T090507Z').toISOString(), '2026-10-12T09:05:07.000Z');
  assert.equal(fechaDeMarca('basura'), null);
  assert.equal(fechaDeMarca('2026-13-45T000000Z'), null);
});

test('disponible: sin carpeta configurada falla, y rutaFuente también', async () => {
  const almacen = crearAlmacen({ raiz: () => null });
  const r = await almacen.disponible();
  assert.equal(r.ok, false);
  assert.match(r.detalle, /No hay carpeta de destino/);
  assert.equal(almacen.raiz(), null);
  assert.throws(() => almacen.rutaFuente(F), /No hay carpeta de destino/);
});

test('disponible: sin la marca falla y no crea nada (unidad sin montar)', async () => {
  const base = await tmp();
  const raiz = path.join(base, 'montaje', 'resguard');
  const almacen = crearAlmacen({ raiz });
  const r = await almacen.disponible();
  assert.equal(r.ok, false);
  assert.match(r.detalle, /marca/);
  assert.equal(existsSync(raiz), false);

  await fs.mkdir(raiz, { recursive: true }); // la carpeta existe pero está vacía: punto de montaje sin montar
  assert.equal((await almacen.disponible()).ok, false);
  assert.deepEqual(await fs.readdir(raiz), []);
});

test('preparar deja la marca y a partir de ahí está disponible', async () => {
  const base = await tmp();
  const raiz = path.join(base, 'a', 'b');
  const almacen = crearAlmacen({ raiz });
  assert.deepEqual(await almacen.preparar(`${raiz}/`), { ok: true, ruta: raiz });
  assert.deepEqual(await almacen.disponible(), { ok: true });
  assert.deepEqual(await fs.readdir(raiz), ['.resguard']);
});

test('preparar rechaza lo que no sea una ruta absoluta', async () => {
  const { almacen } = await nuevo();
  for (const mala of ['copias', './copias', '', null, 7]) {
    const r = await almacen.preparar(mala);
    assert.equal(r.ok, false, String(mala));
    assert.match(r.detalle, /ruta absoluta/);
  }
});

test('la carpeta de destino puede cambiar en caliente', async () => {
  const base = await tmp();
  let actual = path.join(base, 'uno');
  const almacen = crearAlmacen({ raiz: () => actual });
  assert.equal(almacen.rutaFuente(F), path.join(base, 'uno', 'github', 'o', 'r'));
  actual = path.join(base, 'dos');
  assert.equal(almacen.raiz(), path.join(base, 'dos'));
  assert.equal(almacen.rutaFuente(F), path.join(base, 'dos', 'github', 'o', 'r'));
});

test('rutaFuente rechaza nombres peligrosos', async () => {
  const { base, almacen } = await nuevo();
  assert.equal(almacen.rutaFuente(F), path.join(base, 'nas', 'github', 'o', 'r'));
  assert.throws(() => almacen.rutaFuente({ tipo: 'github', owner: '..', repo: 'r' }), /no válido/);
  assert.throws(() => almacen.rutaFuente({ tipo: 'github', owner: 'o', repo: 'a/b' }), /no válido/);
  assert.throws(() => almacen.rutaFuente({ tipo: '../x', owner: 'o', repo: 'r' }), /no válido/);
});

test('llevarDir y traerDir: ida y vuelta, y lo borrado en origen se borra en destino', async () => {
  const { base, almacen } = await nuevo();
  const local = path.join(base, 'local');
  await fs.mkdir(path.join(local, 'sub'), { recursive: true });
  await fs.writeFile(path.join(local, 'a'), 'uno');
  await fs.writeFile(path.join(local, 'sub', 'b'), 'dos');
  await almacen.llevarDir(local, F, 'mirror.git');

  await fs.rm(path.join(local, 'a'));
  await fs.writeFile(path.join(local, 'c'), 'tres');
  await almacen.llevarDir(local, F, 'mirror.git');

  const vuelta = path.join(base, 'vuelta');
  assert.equal(await almacen.traerDir(F, 'mirror.git', vuelta), true);
  assert.deepEqual((await fs.readdir(vuelta)).sort(), ['c', 'sub']);
  assert.equal(await fs.readFile(path.join(vuelta, 'sub', 'b'), 'utf8'), 'dos');
});

// Un rsync falso delante en el PATH que anota sus argumentos y llama al de verdad.
async function espiarRsync(t, base) {
  const real = process.env.PATH.split(path.delimiter).map((d) => path.join(d, 'rsync')).find((p) => existsSync(p));
  assert.ok(real, 'hace falta rsync');
  const bin = path.join(base, 'bin');
  const registro = path.join(base, 'rsync.args');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'rsync'), `#!/bin/sh\nprintf '%s\\n' "$@" >> '${registro}'\necho ---- >> '${registro}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const anterior = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${anterior}`;
  t.after(() => { process.env.PATH = anterior; });
  return async () => (await fs.readFile(registro, 'utf8')).split('----\n').filter(Boolean).map((b) => b.trim().split('\n'));
}

test('rsync borra DESPUÉS de transferir (--delete-after), nunca durante', async (t) => {
  const { base, almacen } = await nuevo();
  const llamadas = await espiarRsync(t, base);
  const local = path.join(base, 'local');
  await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'pack-viejo'), 'uno');
  await almacen.llevarDir(local, F, 'mirror.git');
  await fs.rm(path.join(local, 'pack-viejo'));
  await fs.writeFile(path.join(local, 'pack-nuevo'), 'dos');
  await almacen.llevarDir(local, F, 'mirror.git');
  await almacen.traerDir(F, 'mirror.git', path.join(base, 'vuelta'));
  await almacen.reemplazarDir(local, F, 'release');

  const todas = await llamadas();
  assert.equal(todas.length, 4);
  for (const args of todas) {
    assert.ok(args.includes('--delete-after'), args.join(' '));
    for (const durante of ['--delete', '--del', '--delete-during', '--delete-before', '--delete-delay']) {
      assert.equal(args.includes(durante), false, `${durante} en ${args.join(' ')}`);
    }
  }
  // Y sigue borrando en el destino lo que ya no está en el origen.
  assert.deepEqual(await fs.readdir(path.join(almacen.rutaFuente(F), 'mirror.git')), ['pack-nuevo']);
});

test('traerDir devuelve false y no crea nada si no existe en el almacén', async () => {
  const { base, almacen } = await nuevo();
  const destino = path.join(base, 'destino');
  assert.equal(await almacen.traerDir(F, 'mirror.git', destino), false);
  assert.equal(existsSync(destino), false);
});

test('instantáneas: publicar, listar en orden e ignorar temporales y basura', async () => {
  const { base, almacen } = await nuevo();
  await almacen.publicarInstantanea(F, await bundleFalso(base, '2026-10-12T090000Z.code.bundle', 'bbbb'));
  await almacen.publicarInstantanea(F, await bundleFalso(base, '2026-10-10T090000Z.code.bundle', 'aa'));
  await almacen.publicarInstantanea(F, await bundleFalso(base, '2026-10-12T090000Z.wiki.bundle', 'w'));
  const dir = path.join(almacen.rutaFuente(F), 'snapshots');
  await fs.writeFile(path.join(dir, '2026-10-13T090000Z.code.bundle.tmp'), 'a medias');
  await fs.writeFile(path.join(dir, 'notas.txt'), 'x');

  const lista = await almacen.instantaneas(F);
  assert.deepEqual(lista.map((i) => i.nombre), [
    '2026-10-10T090000Z.code.bundle',
    '2026-10-12T090000Z.code.bundle',
    '2026-10-12T090000Z.wiki.bundle',
  ]);
  assert.deepEqual(lista[0], {
    nombre: '2026-10-10T090000Z.code.bundle',
    tipo: 'code',
    marca: '2026-10-10T090000Z',
    fecha: new Date('2026-10-10T09:00:00Z'),
    bytes: 2,
  });
});

test('publicarInstantanea limpia temporales viejos y rechaza nombres raros', async () => {
  const { base, almacen } = await nuevo();
  const dir = path.join(almacen.rutaFuente(F), 'snapshots');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '2026-10-01T090000Z.code.bundle.tmp'), 'resto de una caída');
  await almacen.publicarInstantanea(F, await bundleFalso(base, '2026-10-12T090000Z.code.bundle'));
  assert.deepEqual(await fs.readdir(dir), ['2026-10-12T090000Z.code.bundle']);
  await assert.rejects(almacen.publicarInstantanea(F, await bundleFalso(base, 'otro.bundle')), /no válido/);
});

test('instantaneas de una fuente sin carpeta es una lista vacía', async () => {
  const { almacen } = await nuevo();
  assert.deepEqual(await almacen.instantaneas(F), []);
});

test('borrarInstantanea borra solo la indicada', async () => {
  const { base, almacen } = await nuevo();
  await almacen.publicarInstantanea(F, await bundleFalso(base, '2026-10-10T090000Z.code.bundle'));
  await almacen.publicarInstantanea(F, await bundleFalso(base, '2026-10-12T090000Z.code.bundle'));
  await almacen.borrarInstantanea(F, '2026-10-10T090000Z.code.bundle');
  assert.deepEqual((await almacen.instantaneas(F)).map((i) => i.marca), ['2026-10-12T090000Z']);
  await assert.rejects(almacen.borrarInstantanea(F, '../../mirror.git'), /no válido/);
});

test('reemplazarDir sustituye el contenido completo', async () => {
  const { base, almacen } = await nuevo();
  const v1 = path.join(base, 'v1');
  const v2 = path.join(base, 'v2');
  await fs.mkdir(v1);
  await fs.mkdir(v2);
  await fs.writeFile(path.join(v1, 'viejo.zip'), '1');
  await fs.writeFile(path.join(v2, 'nuevo.zip'), '22');
  await almacen.reemplazarDir(v1, F, 'release');
  await almacen.reemplazarDir(v2, F, 'release');
  assert.deepEqual((await fs.readdir(almacen.rutaFuente(F))).sort(), ['release']);
  assert.deepEqual(await fs.readdir(path.join(almacen.rutaFuente(F), 'release')), ['nuevo.zip']);
});

test('existe: solo lectura, dice si un fichero está en una carpeta de la fuente', async () => {
  const { base, almacen } = await nuevo();
  assert.equal(await almacen.existe(F, 'release', 'release.json'), false);
  assert.equal(existsSync(almacen.rutaFuente(F)), false);
  const local = path.join(base, 'local');
  await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'release.json'), '{}');
  await almacen.reemplazarDir(local, F, 'release');
  assert.equal(await almacen.existe(F, 'release', 'release.json'), true);
  assert.equal(await almacen.existe(F, 'release', 'otro.zip'), false);
  await assert.rejects(almacen.existe(F, 'snapshots', 'x'), /no válido/);
  for (const mal of ['../release/release.json', '..', '.', '', 'a/b']) {
    await assert.rejects(almacen.existe(F, 'release', mal), /no válido/, mal);
  }
});

test('medir suma por categoría y da ceros si no hay nada', async () => {
  const { base, almacen } = await nuevo();
  assert.deepEqual(await almacen.medir(F), { espejo: 0, instantaneas: 0, release: 0 });
  const local = path.join(base, 'local');
  await fs.mkdir(path.join(local, 'objects'), { recursive: true });
  await fs.writeFile(path.join(local, 'objects', 'p'), '12345');
  await almacen.llevarDir(local, F, 'mirror.git');
  await almacen.llevarDir(local, F, 'wiki.git');
  await almacen.llevarDir(local, F, 'release');
  await almacen.publicarInstantanea(F, await bundleFalso(base, '2026-10-12T090000Z.code.bundle', '123'));
  assert.deepEqual(await almacen.medir(F), { espejo: 10, instantaneas: 3, release: 5 });
});

test('borrarFuente borra solo la carpeta de esa fuente', async () => {
  const { base, almacen } = await nuevo();
  const otra = { tipo: 'github', owner: 'o', repo: 'otra' };
  await almacen.publicarInstantanea(F, await bundleFalso(base, '2026-10-12T090000Z.code.bundle'));
  await almacen.publicarInstantanea(otra, await bundleFalso(base, '2026-10-12T090000Z.code.bundle'));
  await almacen.borrarFuente(F);
  assert.equal(existsSync(almacen.rutaFuente(F)), false);
  assert.equal((await almacen.instantaneas(otra)).length, 1);
});

test('libre devuelve un número de bytes, o null sin carpeta', async () => {
  const { base, almacen } = await nuevo();
  assert.equal(await crearAlmacen({ raiz: () => null }).libre(), null);
  await almacen.preparar(path.join(base, 'nas'));
  assert.equal(typeof (await almacen.libre()), 'number');
});

test('libre es null si falta la marca: no se da por bueno el espacio del disco de debajo', async () => {
  const { base, almacen } = await nuevo();
  await fs.rm(path.join(base, 'nas', '.resguard')); // la carpeta sigue ahí: punto de montaje sin montar
  assert.equal(existsSync(path.join(base, 'nas')), true);
  assert.equal(await almacen.libre(), null);
});

test('sin la marca, las escrituras rechazan y no crean la raíz', async () => {
  const base = await tmp();
  const raiz = path.join(base, 'montaje', 'resguard');
  const almacen = crearAlmacen({ raiz });
  const local = path.join(base, 'local');
  await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'a'), 'x');
  const bundle = await bundleFalso(base, '2026-10-12T090000Z.code.bundle');
  const escrituras = {
    llevarDir: () => almacen.llevarDir(local, F, 'mirror.git'),
    reemplazarDir: () => almacen.reemplazarDir(local, F, 'release'),
    publicarInstantanea: () => almacen.publicarInstantanea(F, bundle),
    borrarFuente: () => almacen.borrarFuente(F),
  };
  for (const [nombre, fn] of Object.entries(escrituras)) {
    await assert.rejects(fn(), /marca/, nombre);
    // El runner clasifica el fallo por su motivo: tiene que ser «almacen», no un error cualquiera.
    await assert.rejects(fn(), (e) => e instanceof FalloCopia && e.motivo === 'almacen' && /marca/.test(e.detalle), nombre);
    assert.equal(existsSync(raiz), false, nombre);
  }
  await fs.mkdir(raiz, { recursive: true }); // punto de montaje vacío
  for (const [nombre, fn] of Object.entries(escrituras)) {
    await assert.rejects(fn(), /marca/, nombre);
    assert.deepEqual(await fs.readdir(raiz), [], nombre);
  }
  const sinRaiz = crearAlmacen({ raiz: () => null });
  await assert.rejects(sinRaiz.borrarFuente(F), /No hay carpeta de destino/);
});

test('traerDir y existe exigen la marca: de un punto de montaje sin montar no se lee nada', async () => {
  const { base, almacen } = await nuevo();
  const local = path.join(base, 'local');
  await fs.mkdir(local);
  await fs.writeFile(path.join(local, 'release.json'), '{}');
  await almacen.llevarDir(local, F, 'mirror.git');
  await almacen.llevarDir(local, F, 'release');
  // La unidad «se desmonta»: lo que queda debajo no es el destino, aunque tenga carpetas con esos nombres.
  await fs.rm(path.join(base, 'nas', '.resguard'));
  const vuelta = path.join(base, 'vuelta');
  await assert.rejects(almacen.traerDir(F, 'mirror.git', vuelta), (e) => e instanceof FalloCopia && e.motivo === 'almacen');
  assert.equal(existsSync(vuelta), false);
  await assert.rejects(almacen.existe(F, 'release', 'release.json'), (e) => e instanceof FalloCopia && e.motivo === 'almacen');
});

test('hayMarca: solo lectura, verdadero únicamente con la marca presente', async () => {
  const { base, almacen } = await nuevo();
  assert.equal(await almacen.hayMarca(), true);
  assert.deepEqual(await fs.readdir(path.join(base, 'nas')), ['.resguard']);
  await fs.rm(path.join(base, 'nas', '.resguard'));
  assert.equal(await almacen.hayMarca(), false);
  assert.deepEqual(await fs.readdir(path.join(base, 'nas')), []);
  assert.equal(await crearAlmacen({ raiz: () => null }).hayMarca(), false);
  assert.equal(await crearAlmacen({ raiz: path.join(base, 'no-existe') }).hayMarca(), false);
  assert.equal(existsSync(path.join(base, 'no-existe')), false);
});

test('traerDir, llevarDir y reemplazarDir solo aceptan nombres de la lista blanca', async () => {
  const { base, almacen } = await nuevo();
  const local = path.join(base, 'local');
  await fs.mkdir(local);
  for (const mal of ['../..', '..', '.', 'snapshots', 'otro', '', 'mirror.git/x']) {
    await assert.rejects(almacen.llevarDir(local, F, mal), /no válido/, mal);
    await assert.rejects(almacen.reemplazarDir(local, F, mal), /no válido/, mal);
    await assert.rejects(almacen.traerDir(F, mal, path.join(base, 'd')), /no válido/, mal);
  }
  for (const ok of ['mirror.git', 'wiki.git', 'release']) await almacen.llevarDir(local, F, ok);
});

test('disponible: llamadas concurrentes no chocan y no dejan ficheros de prueba', async () => {
  const { almacen } = await nuevo();
  const rs = await Promise.all(Array.from({ length: 50 }, () => almacen.disponible()));
  assert.deepEqual(rs, Array.from({ length: 50 }, () => ({ ok: true })));
  assert.deepEqual(await fs.readdir(almacen.raiz()), ['.resguard']);
});

test('disponible: el fichero de prueba no depende del pid (no pisa el de otra llamada)', async () => {
  const { almacen } = await nuevo();
  const ajeno = path.join(almacen.raiz(), `.prueba-${process.pid}`); // lo que usaría otra llamada en curso
  await fs.writeFile(ajeno, 'en uso');
  assert.deepEqual(await almacen.disponible(), { ok: true });
  assert.equal(await fs.readFile(ajeno, 'utf8'), 'en uso');
});

test('instantaneas descarta ficheros cuya marca no es una fecha válida', async () => {
  const { almacen } = await nuevo();
  const dir = path.join(almacen.rutaFuente(F), 'snapshots');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '2026-13-45T000000Z.code.bundle'), 'x');
  await fs.writeFile(path.join(dir, '2026-10-12T090000Z.code.bundle'), 'x');
  assert.deepEqual((await almacen.instantaneas(F)).map((i) => i.marca), ['2026-10-12T090000Z']);
});
