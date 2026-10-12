const DIA = 24 * 60 * 60 * 1000;

export function aBorrar(instantaneas, diasGuardar, ahora) {
  const corte = ahora.getTime() - diasGuardar * DIA;
  const borrar = [];
  for (const tipo of new Set(instantaneas.map((i) => i.tipo))) {
    const viejas = instantaneas
      .filter((i) => i.tipo === tipo && i.fecha.getTime() < corte)
      .sort((a, b) => a.fecha - b.fecha);
    viejas.pop(); // la más reciente anterior al corte era la vigente hace N días
    borrar.push(...viejas.map((i) => i.nombre));
  }
  return borrar;
}
