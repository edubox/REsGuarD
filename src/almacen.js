import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { nombreValido } from './nombres.js';
import { FalloCopia } from './errores.js';

const ejecutar = promisify(execFile);
const RE_INSTANTANEA = /^(\d{4}-\d{2}-\d{2}T\d{6}Z)\.(code|wiki)\.bundle$/;
const MARCA = '.resguard';
const DIRS = new Set(['mirror.git', 'wiki.git', 'release']);

function dirValido(nombre) {
  if (!DIRS.has(nombre)) throw new Error(`Nombre de carpeta no válido: ${nombre}`);
}

export function marcaDe(fecha) {
  return fecha.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '');
}

export function fechaDeMarca(marca) {
  const m = String(marca).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  const fecha = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

// --delete-after: lo que sobra en el destino se borra al final, con todo lo
// nuevo ya transferido. Borrando durante la transferencia, un corte tras un
// `git gc` dejaría el espejo sin los packs viejos y sin el nuevo.
async function rsync(origen, destino) {
  await fs.mkdir(destino, { recursive: true });
  await ejecutar('rsync', ['-rt', '--delete-after', `${origen}/`, `${destino}/`], { maxBuffer: 16 * 1024 * 1024 });
}

async function tamano(dir) {
  let entradas;
  try {
    entradas = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  let total = 0;
  for (const e of entradas) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await tamano(p);
    else if (e.isFile()) total += (await fs.stat(p)).size;
  }
  return total;
}

export function crearAlmacen({ raiz }) {
  const leerRaiz = typeof raiz === 'function' ? raiz : () => raiz;
  const raizActual = () => leerRaiz() || null;

  function rutaFuente(f) {
    const base = raizActual();
    if (!base) throw new Error('No hay carpeta de destino configurada');
    if (!/^[a-z]+$/.test(f.tipo ?? '') || !nombreValido(f.owner) || !nombreValido(f.repo)) {
      throw new Error('Nombre de fuente no válido');
    }
    return path.join(base, f.tipo, f.owner, f.repo);
  }

  // La marca es lo que distingue la carpeta de verdad de un punto de montaje
  // vacío: si la unidad de red no está montada, la marca no está. Única
  // comprobación de la marca; solo lee, nunca crea la carpeta.
  async function comprobarMarca() {
    const base = raizActual();
    if (!base) return { ok: false, detalle: 'No hay carpeta de destino configurada' };
    try {
      await fs.access(path.join(base, MARCA));
    } catch {
      return { ok: false, detalle: `${base} no tiene la marca de REsGuarD: la unidad no está montada o no es la carpeta configurada` };
    }
    return { ok: true };
  }

  const hayMarca = async () => (await comprobarMarca()).ok;

  // Toda escritura (y el borrado de una fuente, y traer algo del destino) exige
  // la marca: si la unidad se desmonta entre disponible() y la operación, no se
  // crea nada en local ni se toma por destino lo que haya debajo del montaje.
  async function exigirMarca() {
    const m = await comprobarMarca();
    if (!m.ok) throw new FalloCopia('almacen', m.detalle);
  }

  // Se llama al elegir la carpeta en los ajustes: la crea y deja una marca dentro.
  async function preparar(ruta) {
    if (typeof ruta !== 'string' || !path.isAbsolute(ruta) || ruta.includes('\0')) {
      return { ok: false, detalle: 'La carpeta de destino debe ser una ruta absoluta' };
    }
    const destino = path.resolve(ruta);
    try {
      await fs.mkdir(destino, { recursive: true });
      await fs.writeFile(path.join(destino, MARCA), 'Carpeta de destino de REsGuarD. No borres este fichero.\n');
    } catch (e) {
      return { ok: false, detalle: `No se puede escribir en ${destino} (${e.code})` };
    }
    return { ok: true, ruta: destino };
  }

  // Sin la marca no se escribe nada en el disco local: por eso aquí nunca se
  // crea la carpeta.
  async function disponible() {
    const m = await comprobarMarca();
    if (!m.ok) return m;
    const base = raizActual();
    const prueba = path.join(base, `.prueba-${randomUUID()}`);
    try {
      await fs.writeFile(prueba, '');
      await fs.rm(prueba);
    } catch (e) {
      return { ok: false, detalle: `No se puede escribir en ${base} (${e.code})` };
    }
    return { ok: true };
  }

  async function traerDir(f, nombre, destino) {
    dirValido(nombre);
    await exigirMarca();
    const origen = path.join(rutaFuente(f), nombre);
    if (!existsSync(origen)) return false;
    await rsync(origen, destino);
    return true;
  }

  // Solo lectura: si un fichero está en una de las carpetas de la fuente.
  // Exige la marca: con la unidad sin montar no se puede saber, y no vale «no está».
  async function existe(f, nombre, fichero) {
    dirValido(nombre);
    if (typeof fichero !== 'string' || !nombreValido(fichero)) throw new Error(`Nombre de fichero no válido: ${fichero}`);
    await exigirMarca();
    return existsSync(path.join(rutaFuente(f), nombre, fichero));
  }

  async function llevarDir(origen, f, nombre) {
    dirValido(nombre);
    await exigirMarca();
    await rsync(origen, path.join(rutaFuente(f), nombre));
  }

  async function reemplazarDir(origen, f, nombre) {
    dirValido(nombre);
    await exigirMarca();
    const final = path.join(rutaFuente(f), nombre);
    const nuevo = `${final}.nuevo`;
    const viejo = `${final}.viejo`;
    await fs.rm(nuevo, { recursive: true, force: true });
    await rsync(origen, nuevo);
    await fs.rm(viejo, { recursive: true, force: true });
    if (existsSync(final)) await fs.rename(final, viejo);
    await fs.rename(nuevo, final);
    await fs.rm(viejo, { recursive: true, force: true });
  }

  async function publicarInstantanea(f, fichero) {
    await exigirMarca();
    const nombre = path.basename(fichero);
    if (!RE_INSTANTANEA.test(nombre)) throw new Error(`Nombre de instantánea no válido: ${nombre}`);
    const dir = path.join(rutaFuente(f), 'snapshots');
    await fs.mkdir(dir, { recursive: true });
    for (const resto of await fs.readdir(dir)) {
      if (resto.endsWith('.tmp')) await fs.rm(path.join(dir, resto), { force: true });
    }
    const temporal = path.join(dir, `${nombre}.tmp`);
    await fs.copyFile(fichero, temporal);
    const [a, b] = await Promise.all([fs.stat(fichero), fs.stat(temporal)]);
    if (a.size !== b.size) {
      await fs.rm(temporal, { force: true });
      throw new Error(`Copia incompleta de ${nombre}`);
    }
    await fs.rename(temporal, path.join(dir, nombre));
  }

  async function instantaneas(f) {
    const dir = path.join(rutaFuente(f), 'snapshots');
    let nombres;
    try {
      nombres = await fs.readdir(dir);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const lista = [];
    for (const nombre of nombres) {
      const m = nombre.match(RE_INSTANTANEA);
      if (!m) continue;
      const fecha = fechaDeMarca(m[1]);
      if (!fecha) continue;
      const { size } = await fs.stat(path.join(dir, nombre));
      lista.push({ nombre, tipo: m[2], marca: m[1], fecha, bytes: size });
    }
    return lista.sort((a, b) => a.fecha - b.fecha || a.nombre.localeCompare(b.nombre));
  }

  async function borrarInstantanea(f, nombre) {
    if (!RE_INSTANTANEA.test(nombre)) throw new Error(`Nombre de instantánea no válido: ${nombre}`);
    await fs.rm(path.join(rutaFuente(f), 'snapshots', nombre), { force: true });
  }

  async function medir(f) {
    const base = rutaFuente(f);
    return {
      espejo: (await tamano(path.join(base, 'mirror.git'))) + (await tamano(path.join(base, 'wiki.git'))),
      instantaneas: await tamano(path.join(base, 'snapshots')),
      release: await tamano(path.join(base, 'release')),
    };
  }

  // Sin la marca, lo que hay en esa ruta es el disco de debajo del punto de
  // montaje: su espacio libre no es el del destino.
  async function libre() {
    try {
      if (!(await hayMarca())) return null;
      const s = await fs.statfs(raizActual());
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }

  async function borrarFuente(f) {
    await exigirMarca();
    await fs.rm(rutaFuente(f), { recursive: true, force: true });
  }

  return {
    raiz: raizActual, preparar, disponible, hayMarca, rutaFuente, existe, traerDir, llevarDir, reemplazarDir, publicarInstantanea,
    instantaneas, borrarInstantanea, medir, libre, borrarFuente,
  };
}
