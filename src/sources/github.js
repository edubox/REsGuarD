import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { git } from '../git.js';
import { FalloCopia } from '../errores.js';

const NO_EXISTE = [404, 410, 451];
const REFSPECS = ['+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'];

// Nombre de fichero plano y sin sorpresas para un adjunto cuyo nombre viene de fuera.
export function nombreSeguro(nombre) {
  const n = String(nombre).replaceAll('\\', '/').split('/').pop().replace(/[^A-Za-z0-9._+-]/g, '_');
  if (n === '') return '_adjunto';
  if (n === '.' || n === '..' || n.toLowerCase() === 'release.json') return `_${n}`;
  return n;
}

export function crearGithub({
  fetch = globalThis.fetch,
  api = 'https://api.github.com',
  urlRepo = (owner, repo) => `https://github.com/${owner}/${repo}.git`,
  urlWiki = (owner, repo) => `https://github.com/${owner}/${repo}.wiki.git`,
  verificar = (bundle, cwd) => git(['bundle', 'verify', '-q', bundle], { cwd }),
  inactividadMs = 120_000,
} = {}) {
  const cabeceras = { 'User-Agent': 'resguard', Accept: 'application/vnd.github+json' };

  // Solo ramas y etiquetas: las referencias de pull requests quedan fuera.
  async function refs(url) {
    const salida = await git(['ls-remote', '--heads', '--tags', url], { timeout: 120_000 });
    return salida.split('\n').filter(Boolean).sort();
  }

  const huellaDe = (lineas) => createHash('sha256').update(lineas.join('\n')).digest('hex');

  async function comprobar(fuente) {
    let fallosApi = null;
    try {
      const r = await fetch(`${api}/repos/${fuente.owner}/${fuente.repo}`, {
        headers: cabeceras,
        signal: AbortSignal.timeout(30_000),
      });
      const { status, ok } = r;
      await r.body?.cancel().catch(() => {});
      if (NO_EXISTE.includes(status)) {
        return { ok: false, motivo: 'no_encontrado', detalle: `GitHub responde HTTP ${status}` };
      }
      if (!ok) fallosApi = `HTTP ${status}`;
    } catch (e) {
      fallosApi = e.message;
    }
    // Un fallo de la API que no sea «no existe» (límite de peticiones, 5xx, sin red)
    // no decide nada: manda lo que diga git.
    let lineas;
    try {
      lineas = await refs(urlRepo(fuente.owner, fuente.repo));
    } catch (e) {
      const detalle = [fallosApi && `API: ${fallosApi}`, e.message].filter(Boolean).join(' · ');
      return { ok: false, motivo: 'red', detalle };
    }
    if (lineas.length === 0) return { ok: false, motivo: 'vacio', detalle: 'El repositorio no tiene ramas ni etiquetas' };
    return { ok: true, huella: huellaDe(lineas) };
  }

  // El HEAD del espejo apunta a la rama por defecto del origen para que
  // `git clone <bundle>` saque esa rama.
  async function fijarHead(local, url) {
    try {
      const salida = await git(['ls-remote', '--symref', url, 'HEAD'], { timeout: 120_000 });
      const m = salida.match(/^ref: (refs\/heads\/\S+)\tHEAD/m);
      if (m) await git(['symbolic-ref', 'HEAD', m[1]], { cwd: local });
    } catch {
      // sin HEAD el bundle sigue conteniendo todas las ramas
    }
  }

  // Sin --prune, una rama o etiqueta que el origen borró sigue en el espejo. Si
  // el origen crea después otra que choca con ella (`a` frente a `a/b`: git no
  // puede tener las dos), el fetch fallaría para siempre. La antigua se aparta,
  // sin perderla, a refs/conservadas/<marca>/…; las que no chocan no se tocan.
  // Todo ocurre en la copia local: el almacén solo cambia si la copia termina.
  async function apartarConflictos(local, remotas, marca) {
    const salida = await git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/tags'], { cwd: local });
    for (const linea of salida.split('\n').filter(Boolean)) {
      const corte = linea.indexOf(' ');
      const sha = linea.slice(0, corte);
      const ref = linea.slice(corte + 1);
      if (remotas.has(ref)) continue;
      let choca = false;
      for (const r of remotas) {
        if (r.startsWith(`${ref}/`) || ref.startsWith(`${r}/`)) {
          choca = true;
          break;
        }
      }
      if (!choca) continue;
      // Primero se crea la conservada y solo después se borra la original.
      await git(['update-ref', `refs/conservadas/${marca}/${ref.slice('refs/'.length)}`, sha], { cwd: local });
      await git(['update-ref', '-d', ref, sha], { cwd: local });
    }
  }

  // Trae el espejo del almacén, lo actualiza en local, publica una instantánea
  // si hay cambios y devuelve el espejo. Git nunca toca el almacén.
  async function espejar({ fuente, almacen, dirTrabajo, nombre, tipo, url, huella, huellaAnterior, marca }) {
    const local = path.join(dirTrabajo, nombre);
    let dañado = false;
    if (await almacen.traerDir(fuente, nombre, local)) {
      try {
        await git(['fsck', '--connectivity-only'], { cwd: local });
      } catch {
        dañado = true;
        await fs.rm(local, { recursive: true, force: true });
      }
    }
    if (!existsSync(local)) await git(['init', '--bare', '-q', local]);
    let remotas;
    try {
      remotas = new Set((await refs(url)).map((l) => l.split('\t')[1]).filter((r) => r && !r.endsWith('^{}')));
    } catch (e) {
      throw new FalloCopia('red', e.message);
    }
    await apartarConflictos(local, remotas, marca);
    try {
      // Sin --prune: lo que se borra en el origen se conserva aquí.
      // gc.auto=0: el gc automático corre en segundo plano y chocaría con la copia al almacén.
      await git(['-c', 'gc.auto=0', 'fetch', '-q', url, ...REFSPECS], { cwd: local });
    } catch (e) {
      throw new FalloCopia('red', e.message);
    }
    await git(['-c', 'gc.autoDetach=false', 'gc', '--auto', '-q'], { cwd: local });
    await fijarHead(local, url);

    const hayInstantanea = (await almacen.instantaneas(fuente)).some((i) => i.tipo === tipo);
    let cambios = false;
    if (huella !== huellaAnterior || !hayInstantanea) {
      const bundle = path.join(dirTrabajo, `${marca}.${tipo}.bundle`);
      await git(['bundle', 'create', '-q', bundle, '--all'], { cwd: local });
      try {
        await verificar(bundle, local);
      } catch (e) {
        throw new FalloCopia('bundle_invalido', e.message);
      }
      await almacen.publicarInstantanea(fuente, bundle);
      await fs.rm(bundle, { force: true });
      cambios = true;
    }
    await almacen.llevarDir(local, fuente, nombre);
    await fs.rm(local, { recursive: true, force: true });
    return { cambios, dañado };
  }

  // Que no haya wiki es lo normal: se omite sin avisar.
  async function copiarWiki(fuente, { almacen, dirTrabajo, marca }) {
    const url = urlWiki(fuente.owner, fuente.repo);
    let lineas;
    try {
      lineas = await refs(url);
    } catch {
      return null;
    }
    if (lineas.length === 0) return null;
    const huella = huellaDe(lineas);
    const r = await espejar({
      fuente, almacen, dirTrabajo, nombre: 'wiki.git', tipo: 'wiki', url,
      huella, huellaAnterior: fuente.huella_wiki, marca,
    });
    return { cambios: r.cambios, huella };
  }

  // Descarga un adjunto a disco. Si pasan inactividadMs sin recibir ni un byte se aborta.
  async function descargar(url, destino, nombre) {
    const ac = new AbortController();
    let t;
    const armar = () => {
      clearTimeout(t);
      t = setTimeout(() => ac.abort(), inactividadMs);
    };
    armar();
    try {
      const d = await fetch(url, { headers: { 'User-Agent': 'resguard' }, signal: ac.signal });
      if (!d.ok || !d.body) {
        await d.body?.cancel();
        throw new FalloCopia('release', `HTTP ${d.status} al descargar ${nombre}`);
      }
      const entrada = Readable.fromWeb(d.body);
      entrada.on('data', armar);
      await pipeline(entrada, createWriteStream(destino), { signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) {
        throw new FalloCopia('release', `${nombre}: la descarga se quedó sin datos durante ${inactividadMs} ms`);
      }
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  // Devuelve { id, tag } si ha descargado el release; null si no hay nada que hacer.
  // Un repo sin releases (404) no borra el que ya esté guardado.
  async function copiarRelease(fuente, { almacen, dirTrabajo }) {
    const r = await fetch(`${api}/repos/${fuente.owner}/${fuente.repo}/releases/latest`, {
      headers: cabeceras,
      signal: AbortSignal.timeout(30_000),
    });
    if (r.status === 404) {
      await r.body?.cancel();
      return null;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw new FalloCopia('release', `HTTP ${r.status} al consultar el último release`);
    }
    const rel = await r.json();
    // Aunque sea el mismo release, si ya no está en el destino (carpeta nueva,
    // o alguien lo borró) hay que volver a guardarlo.
    if (String(rel.id) === String(fuente.release_id) && await almacen.existe(fuente, 'release', 'release.json')) return null;

    const dir = path.join(dirTrabajo, 'release');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const adjuntos = [];
    const usados = new Set(['release.json']);
    for (const a of rel.assets ?? []) {
      const nombre = nombreSeguro(a.name);
      // Sin tope de tiempo total (puede pesar gigas), pero sí de inactividad.
      let nombreFinal = nombre;
      for (let i = 2; usados.has(nombreFinal.toLowerCase()); i++) nombreFinal = `${i}-${nombre}`;
      usados.add(nombreFinal.toLowerCase());
      const destino = path.join(dir, nombreFinal);
      await descargar(a.browser_download_url, destino, nombreFinal);
      const { size } = await fs.stat(destino);
      if (typeof a.size === 'number' && size !== a.size) {
        throw new FalloCopia('release', `${nombreFinal}: ${size} bytes descargados, se esperaban ${a.size}`);
      }
      adjuntos.push({ nombre: nombreFinal, bytes: size });
    }
    const meta = {
      id: rel.id, tag: rel.tag_name ?? '', nombre: rel.name ?? '', publicado: rel.published_at ?? null,
      url: rel.html_url ?? '', notas: rel.body ?? '', adjuntos,
    };
    await fs.writeFile(path.join(dir, 'release.json'), JSON.stringify(meta, null, 2));
    await almacen.reemplazarDir(dir, fuente, 'release');
    await fs.rm(dir, { recursive: true, force: true });
    return { id: String(rel.id), tag: meta.tag };
  }

  async function copiar(fuente, { almacen, dirTrabajo, marca, huella }) {
    const avisos = [];
    const codigo = await espejar({
      fuente, almacen, dirTrabajo, nombre: 'mirror.git', tipo: 'code',
      url: urlRepo(fuente.owner, fuente.repo), huella, huellaAnterior: fuente.huella_refs, marca,
    });
    const parche = { huella_refs: huella };
    let cambios = codigo.cambios;
    if (codigo.dañado) {
      avisos.push({ motivo: 'espejo_dañado', detalle: 'El espejo guardado no superó la verificación y se ha vuelto a clonar' });
    }
    try {
      const w = await copiarWiki(fuente, { almacen, dirTrabajo, marca });
      if (w) {
        cambios = cambios || w.cambios;
        parche.huella_wiki = w.huella;
      }
    } catch (e) {
      avisos.push({ motivo: 'wiki', detalle: e.detalle ?? e.message });
    }
    try {
      const rel = await copiarRelease(fuente, { almacen, dirTrabajo });
      if (rel) {
        cambios = true;
        parche.release_id = rel.id;
        parche.release_tag = rel.tag;
      }
    } catch (e) {
      await fs.rm(path.join(dirTrabajo, 'release'), { recursive: true, force: true });
      avisos.push({ motivo: 'release', detalle: e.detalle ?? e.message });
    }
    return { cambios, avisos, parche };
  }

  return { comprobar, copiar };
}
