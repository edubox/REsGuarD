export class FalloCopia extends Error {
  constructor(motivo, detalle) {
    super(`${motivo}: ${detalle}`);
    this.motivo = motivo;
    this.detalle = detalle;
  }
}
