import Database from 'better-sqlite3';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS fuentes(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL,
  owner TEXT NOT NULL COLLATE NOCASE,
  repo TEXT NOT NULL COLLATE NOCASE,
  frecuencia_horas INTEGER NOT NULL,
  dias_guardar INTEGER NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  motivo TEXT,
  estado_desde TEXT,
  ultima_ok TEXT,
  proxima_copia TEXT,
  huella_refs TEXT,
  huella_wiki TEXT,
  release_id TEXT,
  release_tag TEXT,
  clave_avisada TEXT,
  bytes_espejo INTEGER NOT NULL DEFAULT 0,
  bytes_instantaneas INTEGER NOT NULL DEFAULT 0,
  bytes_release INTEGER NOT NULL DEFAULT 0,
  num_instantaneas INTEGER NOT NULL DEFAULT 0,
  primera_instantanea TEXT,
  ultima_instantanea TEXT,
  creada TEXT NOT NULL,
  UNIQUE(tipo, owner, repo)
);
CREATE TABLE IF NOT EXISTS ejecuciones(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuente_id INTEGER NOT NULL REFERENCES fuentes(id) ON DELETE CASCADE,
  inicio TEXT NOT NULL,
  fin TEXT,
  resultado TEXT NOT NULL DEFAULT 'en_curso',
  motivo TEXT,
  detalle TEXT,
  cambios INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ajustes(clave TEXT PRIMARY KEY, valor TEXT NOT NULL);
`;

const CAMPOS = new Set([
  'frecuencia_horas', 'dias_guardar', 'activa', 'estado', 'motivo', 'estado_desde', 'ultima_ok',
  'proxima_copia', 'huella_refs', 'huella_wiki', 'release_id', 'release_tag', 'clave_avisada',
  'bytes_espejo', 'bytes_instantaneas', 'bytes_release', 'num_instantaneas',
  'primera_instantanea', 'ultima_instantanea',
]);

export function abrirStore(ruta) {
  const db = new Database(ruta);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(ESQUEMA);

  const fuente = (id) => db.prepare('SELECT * FROM fuentes WHERE id = ?').get(id) ?? null;

  return {
    fuente,
    crearFuente({ tipo, owner, repo, frecuenciaHoras, diasGuardar, ahora }) {
      const r = db
        .prepare('INSERT INTO fuentes(tipo, owner, repo, frecuencia_horas, dias_guardar, creada) VALUES (?,?,?,?,?,?)')
        .run(tipo, owner, repo, frecuenciaHoras, diasGuardar, ahora.toISOString());
      return fuente(r.lastInsertRowid);
    },
    fuentes: () => db.prepare('SELECT * FROM fuentes ORDER BY owner, repo').all(),
    fuentePorRepo: (tipo, owner, repo) =>
      db.prepare('SELECT * FROM fuentes WHERE tipo = ? AND owner = ? AND repo = ?').get(tipo, owner, repo) ?? null,
    fuentesPendientes: (ahora) =>
      db
        .prepare('SELECT * FROM fuentes WHERE activa = 1 AND (proxima_copia IS NULL OR proxima_copia <= ?) ORDER BY proxima_copia')
        .all(ahora.toISOString()),
    actualizarFuente(id, campos) {
      const claves = Object.keys(campos);
      if (claves.length === 0) return;
      for (const c of claves) if (!CAMPOS.has(c)) throw new Error(`Campo no permitido: ${c}`);
      db.prepare(`UPDATE fuentes SET ${claves.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
        ...claves.map((c) => campos[c]),
        id,
      );
    },
    borrarFuente: (id) => db.prepare('DELETE FROM fuentes WHERE id = ?').run(id),
    iniciarEjecucion: (fuenteId, inicio) =>
      Number(db.prepare('INSERT INTO ejecuciones(fuente_id, inicio) VALUES (?, ?)').run(fuenteId, inicio.toISOString()).lastInsertRowid),
    terminarEjecucion: (id, { fin, resultado, motivo, detalle, cambios }) =>
      db
        .prepare('UPDATE ejecuciones SET fin = ?, resultado = ?, motivo = ?, detalle = ?, cambios = ? WHERE id = ?')
        .run(fin.toISOString(), resultado, motivo, detalle, cambios ? 1 : 0, id),
    ejecuciones: (fuenteId, limite = 20) =>
      db.prepare('SELECT * FROM ejecuciones WHERE fuente_id = ? ORDER BY id DESC LIMIT ?').all(fuenteId, limite),
    // El detalle de la última ejecución que terminó (la que está en curso no cuenta), o null.
    ultimoDetalle: (fuenteId) =>
      db
        .prepare("SELECT detalle FROM ejecuciones WHERE fuente_id = ? AND resultado <> 'en_curso' ORDER BY id DESC LIMIT 1")
        .get(fuenteId)?.detalle ?? null,
    // Devuelve los id de las fuentes que tenían una copia a medias.
    interrumpirEjecuciones: (ahora) => [
      ...new Set(
        db
          .prepare("UPDATE ejecuciones SET resultado = 'interrumpida', fin = ? WHERE resultado = 'en_curso' RETURNING fuente_id")
          .all(ahora.toISOString())
          .map((e) => e.fuente_id),
      ),
    ],
    ajuste: (clave) => db.prepare('SELECT valor FROM ajustes WHERE clave = ?').get(clave)?.valor ?? null,
    ponerAjuste: (clave, valor) =>
      db.prepare('INSERT INTO ajustes(clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor').run(clave, valor),
    cerrar: () => db.close(),
  };
}
