import fs from 'node:fs/promises';
import path from 'node:path';
import { RAIZ } from './config.js';
import { abrirStore } from './store.js';
import { crearAlmacen } from './almacen.js';
import { crearGithub } from './sources/github.js';
import { crearNotificador } from './notifier.js';
import { crearRunner } from './runner.js';
import { crearPlanificador } from './scheduler.js';
import { crearApp } from './api.js';

const HORA = 60 * 60 * 1000;

export async function crearServicio({ config, tipos = { github: crearGithub() }, fetchTelegram, ahora = () => new Date() }) {
  await fs.mkdir(config.datos, { recursive: true });
  // Restos de una copia que no terminó (reinicio, OOM): no sirven y ocupan disco local.
  await fs.rm(path.join(config.datos, 'work'), { recursive: true, force: true });

  const store = abrirStore(path.join(config.datos, 'resguard.db'));
  const interrumpidas = store.interrumpirEjecuciones(ahora());

  // La carpeta de destino se consulta en cada uso: cambiarla en los ajustes surte efecto sin reiniciar.
  const almacen = crearAlmacen({ raiz: () => store.ajuste('almacen_raiz') });
  const notificador = crearNotificador({ store, ...(fetchTelegram ? { fetch: fetchTelegram } : {}) });

  // Una copia que quedó a medias (el proceso murió) se deja a la vista como
  // error y con la próxima copia en el futuro: si lo que mata al proceso es la
  // propia copia, relanzarla nada más arrancar sería un bucle silencioso.
  const momento = ahora();
  const avisos = [];
  for (const id of interrumpidas) {
    try {
      const f = store.fuente(id);
      if (!f) continue;
      const campos = { estado: 'error', motivo: 'interrumpida' };
      if (f.estado !== 'error' || f.motivo !== 'interrumpida') campos.estado_desde = momento.toISOString();
      if (!f.proxima_copia || f.proxima_copia <= momento.toISOString()) {
        campos.proxima_copia = new Date(momento.getTime() + f.frecuencia_horas * HORA).toISOString();
      }
      store.actualizarFuente(id, campos);
      // Sin await: un Telegram lento o caído no retrasa ni impide el arranque.
      avisos.push(Promise.resolve().then(() => notificador.avisar(store.fuente(id))).catch(() => {}));
    } catch (e) {
      console.error(`No se pudo anotar la copia interrumpida de la fuente ${id}: ${e?.message ?? e}`);
    }
  }

  const runner = crearRunner({ store, almacen, tipos, notificador, datos: config.datos, ahora });
  const planificador = crearPlanificador({ store, runner, ahora });
  const app = crearApp({ store, almacen, planificador, notificador, tipos, publico: path.join(RAIZ, 'public'), ahora });

  return { app, store, almacen, planificador, runner, avisosDeArranque: Promise.all(avisos) };
}
