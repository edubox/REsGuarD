import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git } from '../src/git.js';
import { FalloCopia } from '../src/errores.js';
import { commit, borrarRama } from './_ayuda.js';
import { escenario, copiarUna } from './_escenario.js';

const M1 = '2026-10-12T090000Z';
const M2 = '2026-10-13T090000Z';
const M3 = '2026-10-14T090000Z';

const nombres = async (e) => (await e.almacen.instantaneas(e.fuente)).map((i) => i.nombre);
const rutaBundle = (e, nombre) => path.join(e.almacen.rutaFuente(e.fuente), 'snapshots', nombre);
const espejo = (e, nombre = 'mirror.git') => path.join(e.almacen.rutaFuente(e.fuente), nombre);

test('primera copia: espejo en el almacén, instantánea restaurable y nada en local', async () => {
  const e = await escenario();
  const r = await copiarUna(e, M1);
  assert.equal(r.cambios, true);
  assert.deepEqual(r.avisos, []);
  assert.match(r.parche.huella_refs, /^[0-9a-f]{64}$/);
  assert.deepEqual(await nombres(e), [`${M1}.code.bundle`]);

  const restaurado = path.join(e.base, 'restaurado');
  await git(['clone', '-q', rutaBundle(e, `${M1}.code.bundle`), restaurado]);
  assert.equal(await fs.readFile(path.join(restaurado, 'a.txt'), 'utf8'), 'uno');

  assert.match(await git(['for-each-ref'], { cwd: espejo(e) }), /refs\/heads\/main/);
  assert.deepEqual(await fs.readdir(e.dirTrabajo), []);
});

test('sin cambios en el origen no se duplica la instantánea', async () => {
  const e = await escenario();
  await copiarUna(e, M1);
  const r = await copiarUna(e, M2);
  assert.equal(r.cambios, false);
  assert.deepEqual(await nombres(e), [`${M1}.code.bundle`]);
});

test('con cambios se crea una instantánea nueva', async () => {
  const e = await escenario();
  await copiarUna(e, M1);
  await commit(e.origen, 'a.txt', 'dos');
  const r = await copiarUna(e, M2);
  assert.equal(r.cambios, true);
  assert.deepEqual(await nombres(e), [`${M1}.code.bundle`, `${M2}.code.bundle`]);
});

test('si la instantánea desapareció del almacén se vuelve a crear aunque no haya cambios', async () => {
  const e = await escenario();
  await copiarUna(e, M1);
  await e.almacen.borrarInstantanea(e.fuente, `${M1}.code.bundle`);
  await copiarUna(e, M2);
  assert.deepEqual(await nombres(e), [`${M2}.code.bundle`]);
});

test('una rama borrada en el origen sigue en el espejo y en las instantáneas nuevas', async () => {
  const e = await escenario();
  await commit(e.origen, 'extra.txt', 'x', 'extra');
  await copiarUna(e, M1);
  await borrarRama(e.origen, 'extra');
  await commit(e.origen, 'a.txt', 'dos', 'main');
  await copiarUna(e, M2);
  assert.match(await git(['for-each-ref'], { cwd: espejo(e) }), /refs\/heads\/extra/);
  assert.match(await git(['bundle', 'list-heads', rutaBundle(e, `${M2}.code.bundle`)]), /refs\/heads\/extra/);
});

const refsDe = async (dir) => (await git(['for-each-ref', '--format=%(objectname) %(refname)'], { cwd: dir })).trim().split('\n');
const cabezasDe = async (bundle) => (await git(['bundle', 'list-heads', bundle])).trim().split('\n');

// Quita una rama del origen y de la copia de trabajo que le empuja.
async function quitarRama(origen, rama) {
  await git(['checkout', '-q', 'main'], { cwd: origen.wt });
  await git(['branch', '-q', '-D', rama], { cwd: origen.wt });
  await borrarRama(origen, rama);
}

test('una rama borrada sin conflicto se queda exactamente en refs/heads/<nombre>, no se mueve', async () => {
  const e = await escenario();
  const extra = await commit(e.origen, 'extra.txt', 'x', 'extra');
  await copiarUna(e, M1);
  await quitarRama(e.origen, 'extra');
  await commit(e.origen, 'a.txt', 'dos', 'main');
  await copiarUna(e, M2);
  const refs = await refsDe(espejo(e));
  assert.ok(refs.includes(`${extra} refs/heads/extra`), refs.join('\n'));
  assert.deepEqual(refs.filter((r) => r.includes('refs/conservadas/')), []);
  assert.ok((await cabezasDe(rutaBundle(e, `${M2}.code.bundle`))).includes(`${extra} refs/heads/extra`));
});

test('conflicto de referencias a → a/b: la copia no falla y la rama antigua se conserva aparte', async () => {
  const e = await escenario();
  const viejo = await commit(e.origen, 'vieja.txt', 'solo en la rama a', 'a');
  await copiarUna(e, M1);
  await quitarRama(e.origen, 'a');
  const nuevo = await commit(e.origen, 'nueva.txt', 'rama a/b', 'a/b');
  const r = await copiarUna(e, M2);
  assert.deepEqual(r.avisos, []);
  assert.equal(r.cambios, true);

  const refs = await refsDe(espejo(e));
  assert.ok(refs.includes(`${nuevo} refs/heads/a/b`), refs.join('\n'));
  assert.ok(refs.includes(`${viejo} refs/conservadas/${M2}/heads/a`), refs.join('\n'));
  assert.equal(refs.some((l) => l.endsWith(' refs/heads/a')), false);
  await git(['cat-file', '-e', `${viejo}^{commit}`], { cwd: espejo(e) });
  await git(['fsck', '--connectivity-only'], { cwd: espejo(e) });

  const cabezas = await cabezasDe(rutaBundle(e, `${M2}.code.bundle`));
  assert.ok(cabezas.includes(`${viejo} refs/conservadas/${M2}/heads/a`), cabezas.join('\n'));
  assert.ok(cabezas.includes(`${nuevo} refs/heads/a/b`), cabezas.join('\n'));

  // Y la copia siguiente, ya sin conflicto, no mueve nada más.
  await commit(e.origen, 'nueva.txt', 'otra vez', 'a/b');
  await copiarUna(e, M3);
  const despues = await refsDe(espejo(e));
  assert.deepEqual(despues.filter((l) => l.includes('refs/conservadas/')), [`${viejo} refs/conservadas/${M2}/heads/a`]);
});

test('conflicto de referencias y la copia falla después: el espejo del destino queda como estaba', async () => {
  let romper = false;
  const e = await escenario({ verificar: async () => { if (romper) throw new Error('bundle roto'); } });
  const viejo = await commit(e.origen, 'vieja.txt', 'solo en la rama a', 'a');
  await copiarUna(e, M1);
  const antes = await refsDe(espejo(e));
  await quitarRama(e.origen, 'a');
  await commit(e.origen, 'nueva.txt', 'rama a/b', 'a/b');
  romper = true;
  await assert.rejects(copiarUna(e, M2), (err) => err instanceof FalloCopia && err.motivo === 'bundle_invalido');
  assert.deepEqual(await refsDe(espejo(e)), antes);
  assert.ok(antes.includes(`${viejo} refs/heads/a`));
  assert.deepEqual(await nombres(e), [`${M1}.code.bundle`]);
});

test('conflicto de referencias a/b → a: la copia no falla y la rama antigua se conserva aparte', async () => {
  const e = await escenario();
  const viejo = await commit(e.origen, 'vieja.txt', 'solo en la rama a/b', 'a/b');
  await copiarUna(e, M1);
  await quitarRama(e.origen, 'a/b');
  const nuevo = await commit(e.origen, 'nueva.txt', 'rama a', 'a');
  const r = await copiarUna(e, M2);
  assert.deepEqual(r.avisos, []);

  const refs = await refsDe(espejo(e));
  assert.ok(refs.includes(`${nuevo} refs/heads/a`), refs.join('\n'));
  assert.ok(refs.includes(`${viejo} refs/conservadas/${M2}/heads/a/b`), refs.join('\n'));
  assert.equal(refs.some((l) => l.endsWith(' refs/heads/a/b')), false);
  await git(['cat-file', '-e', `${viejo}^{commit}`], { cwd: espejo(e) });
  await git(['fsck', '--connectivity-only'], { cwd: espejo(e) });

  const cabezas = await cabezasDe(rutaBundle(e, `${M2}.code.bundle`));
  assert.ok(cabezas.includes(`${viejo} refs/conservadas/${M2}/heads/a/b`), cabezas.join('\n'));
  assert.ok(cabezas.includes(`${nuevo} refs/heads/a`), cabezas.join('\n'));
});

test('conflicto de referencias con una etiqueta v1 → v1/x: la etiqueta antigua se conserva aparte', async () => {
  const e = await escenario();
  const wt = e.origen.wt;
  // Un commit al que solo llega la etiqueta (anotada), para que conservarla sea lo único que lo salva.
  await git(['checkout', '-q', '--detach'], { cwd: wt });
  await fs.writeFile(path.join(wt, 'etiquetado.txt'), 'solo en v1');
  await git(['add', '-A'], { cwd: wt });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'solo en v1'], { cwd: wt });
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'tag', '-a', '-m', 'v1', 'v1'], { cwd: wt });
  await git(['push', '-q', 'origin', 'refs/tags/v1'], { cwd: wt });
  const viejo = (await git(['rev-parse', 'v1^{commit}'], { cwd: wt })).trim();
  const etiqueta = (await git(['rev-parse', 'v1'], { cwd: wt })).trim();
  await git(['checkout', '-q', 'main'], { cwd: wt });
  await copiarUna(e, M1);

  await git(['tag', '-d', 'v1'], { cwd: wt });
  await git(['update-ref', '-d', 'refs/tags/v1'], { cwd: e.origen.bare });
  await git(['tag', 'v1/x'], { cwd: wt });
  await git(['push', '-q', 'origin', 'refs/tags/v1/x'], { cwd: wt });
  const nuevo = (await git(['rev-parse', 'v1/x'], { cwd: wt })).trim();
  const r = await copiarUna(e, M2);
  assert.deepEqual(r.avisos, []);

  const refs = await refsDe(espejo(e));
  assert.ok(refs.includes(`${nuevo} refs/tags/v1/x`), refs.join('\n'));
  assert.ok(refs.includes(`${etiqueta} refs/conservadas/${M2}/tags/v1`), refs.join('\n'));
  assert.equal(refs.some((l) => l.endsWith(' refs/tags/v1')), false);
  await git(['cat-file', '-e', `${viejo}^{commit}`], { cwd: espejo(e) });
  await git(['fsck', '--connectivity-only'], { cwd: espejo(e) });

  const cabezas = await cabezasDe(rutaBundle(e, `${M2}.code.bundle`));
  assert.ok(cabezas.includes(`${etiqueta} refs/conservadas/${M2}/tags/v1`), cabezas.join('\n'));
});

test('si reescriben el historial, la instantánea anterior conserva el antiguo', async () => {
  const e = await escenario();
  const viejo = await commit(e.origen, 'a.txt', 'dos');
  await copiarUna(e, M1);
  await git(['reset', '-q', '--hard', 'HEAD~1'], { cwd: e.origen.wt });
  const nuevo = await commit(e.origen, 'a.txt', 'reescrito');
  await copiarUna(e, M2);

  const antes = path.join(e.base, 'antes');
  await git(['clone', '-q', rutaBundle(e, `${M1}.code.bundle`), antes]);
  await git(['cat-file', '-e', `${viejo}^{commit}`], { cwd: antes });
  const despues = path.join(e.base, 'despues');
  await git(['clone', '-q', rutaBundle(e, `${M2}.code.bundle`), despues]);
  assert.equal((await git(['rev-parse', 'HEAD'], { cwd: despues })).trim(), nuevo);
});

test('una instantánea que no verifica no llega al almacén', async () => {
  const e = await escenario({ verificar: async () => { throw new Error('bundle roto'); } });
  const c = await e.gh.comprobar(e.fuente);
  await fs.mkdir(e.dirTrabajo, { recursive: true });
  await assert.rejects(
    e.gh.copiar(e.fuente, { almacen: e.almacen, dirTrabajo: e.dirTrabajo, marca: M1, huella: c.huella }),
    (err) => err instanceof FalloCopia && err.motivo === 'bundle_invalido',
  );
  assert.deepEqual(await nombres(e), []);
});

test('si el origen deja de responder a media copia: FalloCopia red y el almacén intacto', async () => {
  const e = await escenario();
  await copiarUna(e, M1);
  const antes = await git(['for-each-ref'], { cwd: espejo(e) });
  const c = await e.gh.comprobar(e.fuente);
  await fs.rm(e.origen.bare, { recursive: true });
  await fs.mkdir(e.dirTrabajo, { recursive: true });
  await assert.rejects(
    e.gh.copiar(e.fuente, { almacen: e.almacen, dirTrabajo: e.dirTrabajo, marca: M2, huella: 'otra' }),
    (err) => err instanceof FalloCopia && err.motivo === 'red',
  );
  assert.equal(c.ok, true);
  assert.equal(await git(['for-each-ref'], { cwd: espejo(e) }), antes);
  assert.deepEqual(await nombres(e), [`${M1}.code.bundle`]);
});

test('un espejo dañado en el almacén se reconstruye y se avisa', async () => {
  const e = await escenario();
  await copiarUna(e, M1);
  await fs.rm(path.join(espejo(e), 'objects'), { recursive: true });
  await fs.mkdir(path.join(espejo(e), 'objects'));
  await commit(e.origen, 'a.txt', 'dos');
  const r = await copiarUna(e, M2);
  assert.deepEqual(r.avisos.map((a) => a.motivo), ['espejo_dañado']);
  await git(['fsck', '--connectivity-only'], { cwd: espejo(e) });
  assert.deepEqual(await nombres(e), [`${M1}.code.bundle`, `${M2}.code.bundle`]);
});

test('sin wiki no hay aviso ni huella de wiki', async () => {
  const e = await escenario();
  const r = await copiarUna(e, M1);
  assert.deepEqual(r.avisos, []);
  assert.equal('huella_wiki' in r.parche, false);
});

test('con wiki: espejo e instantánea propios, y sin duplicar si no cambia', async () => {
  const e = await escenario({ wiki: true });
  const r1 = await copiarUna(e, M1);
  assert.match(r1.parche.huella_wiki, /^[0-9a-f]{64}$/);
  assert.deepEqual(await nombres(e), [`${M1}.code.bundle`, `${M1}.wiki.bundle`]);
  assert.match(await git(['for-each-ref'], { cwd: espejo(e, 'wiki.git') }), /refs\/heads\/main/);

  await commit(e.origenWiki, 'Home.md', 'cambiada');
  const r2 = await copiarUna(e, M2);
  assert.equal(r2.cambios, true);
  assert.deepEqual(await nombres(e), [`${M1}.code.bundle`, `${M1}.wiki.bundle`, `${M2}.wiki.bundle`]);

  const r3 = await copiarUna(e, M3);
  assert.equal(r3.cambios, false);
});

test('la instantánea se puede clonar con la rama por defecto del origen', async () => {
  const e = await escenario();
  await copiarUna(e, M1);
  const restaurado = path.join(e.base, 'restaurado');
  await git(['clone', '-q', rutaBundle(e, `${M1}.code.bundle`), restaurado]);
  assert.equal((await git(['symbolic-ref', '--short', 'HEAD'], { cwd: restaurado })).trim(), 'main');
});
