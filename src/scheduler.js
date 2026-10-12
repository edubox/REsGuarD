export function crearPlanificador({ store, runner, ahora = () => new Date(), intervaloMs = 60_000, log = console }) {
  const cola = [];
  let enCurso = null;
  let drenando = null;
  let temporizador = null;

  // Un log que falle no puede dejar al planificador atascado.
  function avisarError(mensaje) {
    try {
      log.error(mensaje);
    } catch {
      // nada más que hacer
    }
  }

  // Una copia cada vez: la máquina tiene poca RAM y los espejos comparten carpeta de trabajo.
  async function drenar() {
    while (cola.length > 0) {
      enCurso = cola.shift();
      try {
        await runner.ejecutar(enCurso);
      } catch (e) {
        avisarError(`Fallo inesperado copiando la fuente ${enCurso}: ${e?.message ?? e}`);
      } finally {
        enCurso = null;
      }
    }
    drenando = null;
  }

  function encolar(id) {
    const n = Number(id);
    if (enCurso === n || cola.includes(n)) return false;
    cola.push(n);
    if (!drenando) drenando = drenar();
    return true;
  }

  const esperar = () => drenando ?? Promise.resolve();

  function tic() {
    // Si lanzara dentro del setInterval, mataría el proceso entero.
    try {
      for (const f of store.fuentesPendientes(ahora())) encolar(f.id);
    } catch (e) {
      avisarError(`No se pudieron leer las fuentes pendientes: ${e?.message ?? e}`);
    }
    return esperar();
  }

  function iniciar() {
    tic();
    temporizador = setInterval(tic, intervaloMs);
  }

  function parar() {
    clearInterval(temporizador);
    temporizador = null;
  }

  return { encolar, tic, esperar, estado: () => ({ enCurso, cola: [...cola] }), iniciar, parar };
}
