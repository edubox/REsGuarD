import fs from 'node:fs/promises';
import path from 'node:path';
import { marcaDe } from './almacen.js';
import { aBorrar } from './retencion.js';
import { FalloCopia } from './errores.js';

const HORA = 60 * 60 * 1000;

export function crearRunner({ store, almacen, tipos, notificador, datos, ahora = () => new Date() }) {
  async function medidas(fuente) {
    const m = await almacen.medir(fuente);
    const codigo = (await almacen.instantaneas(fuente)).filter((i) => i.tipo === 'code');
    return {
      bytes_espejo: m.espejo,
      bytes_instantaneas: m.instantaneas,
      bytes_release: m.release,
      num_instantaneas: codigo.length,
      primera_instantanea: codigo[0]?.fecha.toISOString() ?? null,
      ultima_instantanea: codigo.at(-1)?.fecha.toISOString() ?? null,
    };
  }

  async function ejecutar(id) {
    const fuente = store.fuente(id);
    if (!fuente) return null;
    const inicio = ahora();
    // Lo primero: la próxima copia queda en el futuro. Si el proceso muere a
    // mitad (OOM, reinicio), al volver la fuente no está vencida y no se
    // relanza en bucle.
    store.actualizarFuente(id, { proxima_copia: new Date(inicio.getTime() + fuente.frecuencia_horas * HORA).toISOString() });
    let ejecucion = null;
    const dirTrabajo = path.join(datos, 'work', String(id));
    let resultado = 'ok';
    let motivo = null;
    let detalle = null;
    let cambios = false;
    let parche = {};

    try {
      ejecucion = store.iniciarEjecucion(id, inicio);
      await fs.rm(dirTrabajo, { recursive: true, force: true });
      await fs.mkdir(dirTrabajo, { recursive: true });

      const d = await almacen.disponible();
      if (!d.ok) throw new FalloCopia('almacen', d.detalle);
      const tipo = tipos[fuente.tipo];
      if (!tipo) throw new FalloCopia('interno', `Tipo de fuente desconocido: ${fuente.tipo}`);

      // Salvaguarda: si el origen no existe o está vacío, se aborta aquí,
      // antes de tocar nada de lo guardado.
      const c = await tipo.comprobar(fuente);
      if (!c.ok) throw new FalloCopia(c.motivo, c.detalle);

      const r = await tipo.copiar(fuente, { almacen, dirTrabajo, marca: marcaDe(inicio), huella: c.huella });
      cambios = r.cambios;
      parche = r.parche;
      const avisos = [...r.avisos];

      // La retención solo corre cuando el código se ha copiado bien. Si falla,
      // lo copiado ya está guardado: es un aviso, no un error, y el parche se
      // conserva. Los días a guardar se leen ahora, por si han cambiado mientras.
      try {
        const dias = (store.fuente(id) ?? fuente).dias_guardar;
        const lista = await almacen.instantaneas(fuente);
        const sinBorrar = [];
        for (const nombre of aBorrar(lista, dias, ahora())) {
          try {
            await almacen.borrarInstantanea(fuente, nombre);
          } catch (e) {
            sinBorrar.push(`${nombre}: ${e.message}`);
          }
        }
        if (sinBorrar.length > 0) {
          const resto = sinBorrar.length > 1 ? ` (y ${sinBorrar.length - 1} más)` : '';
          avisos.push({ motivo: 'retencion', detalle: `No se pudo borrar ${sinBorrar[0]}${resto}` });
        }
      } catch (e) {
        avisos.push({ motivo: 'retencion', detalle: e.message });
      }

      if (avisos.length > 0) {
        resultado = 'aviso';
        motivo = avisos.map((a) => a.motivo).join('+');
        detalle = avisos.map((a) => a.detalle).join(' · ');
      }
    } catch (e) {
      resultado = 'error';
      cambios = false;
      parche = {};
      motivo = e instanceof FalloCopia ? e.motivo : 'interno';
      detalle = e instanceof FalloCopia ? e.detalle : e.message;
    } finally {
      await fs.rm(dirTrabajo, { recursive: true, force: true }).catch(() => {});
    }

    // El registro final no puede dejar la función a medias: si lanza, la
    // próxima copia ya está en el futuro y el resultado es un error interno.
    let fin = inicio;
    try {
      fin = ahora();
      const actual = store.fuente(id) ?? fuente;
      const campos = {
        ...parche,
        estado: resultado,
        motivo,
        proxima_copia: new Date(fin.getTime() + actual.frecuencia_horas * HORA).toISOString(),
      };
      if (fuente.estado !== resultado || fuente.motivo !== motivo) campos.estado_desde = fin.toISOString();
      if (resultado !== 'error') campos.ultima_ok = fin.toISOString();
      // Solo se mide con el destino a la vista: con la unidad desmontada todo
      // «pesa» cero, y eso no es verdad. Si no se puede medir se conservan las
      // cifras anteriores.
      try {
        if (await almacen.hayMarca()) Object.assign(campos, await medidas(fuente));
      } catch {
        // se conservan las cifras anteriores
      }
      store.actualizarFuente(id, campos);
      if (ejecucion !== null) store.terminarEjecucion(ejecucion, { fin, resultado, motivo, detalle, cambios });
    } catch (e) {
      resultado = 'error';
      motivo = 'interno';
      detalle = `No se pudo registrar el resultado de la copia: ${e?.message ?? e}`;
      cambios = false;
      // Se intenta dejar constancia; si tampoco se puede, no hay más que hacer.
      try {
        store.actualizarFuente(id, { estado: resultado, motivo, estado_desde: fin.toISOString() });
      } catch { /* nada */ }
      try {
        if (ejecucion !== null) store.terminarEjecucion(ejecucion, { fin, resultado, motivo, detalle, cambios });
      } catch { /* nada */ }
    }
    try {
      const f = store.fuente(id);
      if (f) await notificador.avisar(f, { detalle });
    } catch { /* un aviso que no sale no es motivo para rechazar */ }
    return { resultado, motivo, detalle, cambios };
  }

  return { ejecutar };
}
