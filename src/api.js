import path from 'node:path';
import express from 'express';
import { parsearRepo } from './nombres.js';
import { describirMotivo } from './motivos.js';

const DIA = 24 * 60 * 60 * 1000;
const HORA = 60 * 60 * 1000;
const RE_TOKEN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const RE_CHAT = /^(-?\d{1,20}|@[A-Za-z0-9_]{3,64})$/;

const entero = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const enmascarar = (t) => (t ? `••••${t.slice(-4)}` : '');

class ErrorHttp extends Error {
  constructor(status, mensaje) {
    super(mensaje);
    this.status = status;
  }
}

export function crearApp({ store, almacen, planificador, notificador, tipos, publico, ahora = () => new Date() }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  const ruta = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  function vista(f) {
    const e = planificador.estado();
    return {
      ...f,
      en_curso: e.enCurso === f.id,
      en_cola: e.cola.includes(f.id),
      motivo_texto: describirMotivo(f.motivo),
      detalle: store.ultimoDetalle(f.id),
      dias_disponibles: f.primera_instantanea ? Math.floor((ahora() - new Date(f.primera_instantanea)) / DIA) : 0,
      ruta: almacen.raiz() ? almacen.rutaFuente(f) : null,
    };
  }

  function fuenteDe(req) {
    const f = store.fuente(Number(req.params.id));
    if (!f) throw new ErrorHttp(404, 'Esa fuente no existe');
    return f;
  }

  function ajustes() {
    const token = store.ajuste('telegram_token');
    const chat = store.ajuste('telegram_chat');
    return {
      carpetaDestino: almacen.raiz() ?? '',
      telegramToken: enmascarar(token),
      telegramChat: chat ?? '',
      configurado: Boolean(token && chat),
    };
  }

  app.get('/api/fuentes', ruta((req, res) => res.json(store.fuentes().map(vista))));

  app.post('/api/fuentes', ruta(async (req, res) => {
    const { repo, frecuenciaHoras, diasGuardar } = req.body ?? {};
    const r = parsearRepo(repo);
    if (!r) throw new ErrorHttp(400, 'Escribe el repositorio como owner/repo o pega su URL de GitHub');
    if (!entero(frecuenciaHoras, 1, 8760)) throw new ErrorHttp(400, 'La frecuencia debe ser un número entero de horas entre 1 y 8760');
    if (!entero(diasGuardar, 1, 3650)) throw new ErrorHttp(400, 'Los días a guardar deben ser un número entero entre 1 y 3650');
    if (store.fuentePorRepo('github', r.owner, r.repo)) throw new ErrorHttp(409, `${r.owner}/${r.repo} ya está en la lista`);

    const c = await tipos.github.comprobar({ tipo: 'github', ...r });
    if (!c.ok) {
      if (c.motivo === 'no_encontrado') throw new ErrorHttp(404, `${r.owner}/${r.repo} no existe o no es público`);
      if (c.motivo === 'vacio') throw new ErrorHttp(422, `${r.owner}/${r.repo} está vacío: no hay nada que copiar`);
      throw new ErrorHttp(502, `No se pudo comprobar el repositorio: ${c.detalle}`);
    }
    const f = store.crearFuente({ tipo: 'github', ...r, frecuenciaHoras, diasGuardar, ahora: ahora() });
    planificador.encolar(f.id);
    res.status(201).json(vista(f));
  }));

  app.patch('/api/fuentes/:id', ruta((req, res) => {
    const f = fuenteDe(req);
    const { frecuenciaHoras, diasGuardar, activa } = req.body ?? {};
    const campos = {};
    if (frecuenciaHoras !== undefined) {
      if (!entero(frecuenciaHoras, 1, 8760)) throw new ErrorHttp(400, 'La frecuencia debe ser un número entero de horas entre 1 y 8760');
      campos.frecuencia_horas = frecuenciaHoras;
      // Acortar la frecuencia adelanta la próxima copia; alargarla no la retrasa.
      const nueva = new Date(ahora().getTime() + frecuenciaHoras * HORA).toISOString();
      if (f.proxima_copia && nueva < f.proxima_copia) campos.proxima_copia = nueva;
    }
    if (diasGuardar !== undefined) {
      if (!entero(diasGuardar, 1, 3650)) throw new ErrorHttp(400, 'Los días a guardar deben ser un número entero entre 1 y 3650');
      campos.dias_guardar = diasGuardar;
    }
    if (activa !== undefined) {
      if (typeof activa !== 'boolean') throw new ErrorHttp(400, 'El campo «activa» debe ser verdadero o falso');
      campos.activa = activa ? 1 : 0;
    }
    store.actualizarFuente(f.id, campos);
    res.json(vista(store.fuente(f.id)));
  }));

  app.delete('/api/fuentes/:id', ruta(async (req, res) => {
    const f = fuenteDe(req);
    const ocupada = () => {
      const e = planificador.estado();
      return e.enCurso === f.id || e.cola.includes(f.id);
    };
    const ESPERA = 'Se está copiando ahora mismo; espera a que termine';
    if (ocupada()) throw new ErrorHttp(409, ESPERA);
    const borrarDatos = req.query.borrarDatos === '1' && Boolean(almacen.raiz());
    if (borrarDatos) {
      // Antes de tocar nada: si la unidad no está, borrar solo la fila haría creer
      // que las copias se han borrado cuando siguen en el almacén.
      const d = await almacen.disponible();
      if (!d.ok) throw new ErrorHttp(503, `No se pueden borrar las copias: ${d.detalle}`);
    }
    // Durante los await de arriba la fuente pudo encolarse: se repite el control.
    if (ocupada()) throw new ErrorHttp(409, ESPERA);
    // Síncrono: desde aquí ya no puede arrancar una copia de esta fuente.
    store.borrarFuente(f.id);
    if (borrarDatos) {
      try {
        await almacen.borrarFuente(f);
      } catch (e) {
        throw new ErrorHttp(500, `El repositorio se ha quitado de la lista, pero sus copias no se han podido borrar y siguen en ${almacen.rutaFuente(f)} (${e.detalle ?? e.message})`);
      }
    }
    res.status(204).end();
  }));

  app.post('/api/fuentes/:id/copiar', ruta((req, res) => {
    const f = fuenteDe(req);
    res.status(202).json({ encolada: planificador.encolar(f.id) });
  }));

  app.get('/api/fuentes/:id/ejecuciones', ruta((req, res) => res.json(store.ejecuciones(fuenteDe(req).id))));

  app.get('/api/ajustes', ruta((req, res) => res.json(ajustes())));

  app.put('/api/ajustes', ruta(async (req, res) => {
    const { carpetaDestino, telegramToken, telegramChat } = req.body ?? {};
    const cambios = [];
    if (telegramChat !== undefined) {
      const chat = typeof telegramChat === 'string' ? telegramChat.trim() : null;
      if (chat === null || (chat !== '' && !RE_CHAT.test(chat))) {
        throw new ErrorHttp(400, 'El ID de conversación debe ser un número (puede ser negativo) o un @canal');
      }
      cambios.push(['telegram_chat', chat]);
    }
    // El formulario recibe el token enmascarado; si vuelve tal cual, no se toca.
    if (telegramToken !== undefined && telegramToken !== enmascarar(store.ajuste('telegram_token'))) {
      const token = typeof telegramToken === 'string' ? telegramToken.trim() : null;
      if (token === null || (token !== '' && !RE_TOKEN.test(token))) {
        throw new ErrorHttp(400, 'El token no tiene el formato de un token de bot de Telegram');
      }
      cambios.push(['telegram_token', token]);
    }
    // La carpeta va la última: prepararla crea ficheros, y eso solo debe ocurrir
    // si el resto de la petición es válido.
    let carpeta = typeof carpetaDestino === 'string' ? carpetaDestino.trim().replace(/(.)\/+$/, '$1') : carpetaDestino;
    // Normalizada para comparar; las rutas no absolutas llegan tal cual a preparar() para su 400.
    if (typeof carpeta === 'string' && path.isAbsolute(carpeta)) carpeta = path.resolve(carpeta);
    if (carpeta !== undefined && carpeta !== (almacen.raiz() ?? '')) {
      const libre = () => {
        const e = planificador.estado();
        return e.enCurso === null && e.cola.length === 0;
      };
      const OCUPADO = 'Hay una copia en curso; cambia la carpeta de destino cuando termine';
      if (!libre()) throw new ErrorHttp(409, OCUPADO);
      const p = await almacen.preparar(carpeta);
      if (!p.ok) throw new ErrorHttp(400, p.detalle);
      // Preparar puede tardar (unidad de red): se repite el control antes de guardar.
      if (!libre()) throw new ErrorHttp(409, OCUPADO);
      cambios.push(['almacen_raiz', p.ruta]);
    }
    for (const [clave, valor] of cambios) store.ponerAjuste(clave, valor);
    res.json(ajustes());
  }));

  app.post('/api/ajustes/probar', ruta(async (req, res) => {
    const r = await notificador.enviar('🔔 REsGuarD: mensaje de prueba. Los avisos llegarán a esta conversación.');
    if (!r.enviado) throw new ErrorHttp(502, r.detalle);
    res.json({ ok: true });
  }));

  app.get('/api/resumen', ruta(async (req, res) => {
    const fuentes = store.fuentes();
    const e = planificador.estado();
    res.json({
      fuentes: fuentes.length,
      bytes_total: fuentes.reduce((s, f) => s + f.bytes_espejo + f.bytes_instantaneas + f.bytes_release, 0),
      libre: await almacen.libre(),
      destino: almacen.raiz(),
      destino_disponible: await almacen.hayMarca(),
      en_curso: e.enCurso !== null || e.cola.length > 0,
      telegram_configurado: ajustes().configurado,
    });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  app.use(express.static(publico));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ErrorHttp) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: 'La petición no es un JSON válido' });
    }
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Ese repositorio ya está en la lista' });
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  });

  return app;
}
