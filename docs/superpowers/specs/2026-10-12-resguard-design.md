# REsGuarD — diseño

Fecha: 2026-10-12

## Propósito

Conservar copias propias de cosas que pueden desaparecer de Internet. La
primera fuente son repositorios públicos de GitHub («por si los cierran»);
el diseño deja sitio para otros tipos de fuente más adelante.

Uso personal, un solo usuario, accesible solo desde la LAN. Sin login.

Éxito significa:

- Añadir un repo es rellenar tres campos.
- De un vistazo se sabe qué hay copiado, de cuándo, cuánto ocupa y si algo
  va mal.
- Pase lo que pase en el origen (borrado, vaciado, historial reescrito),
  lo ya guardado no se pierde, y el usuario se entera por Telegram.

## Fuera de alcance (v1)

- Repos privados y token de GitHub.
- Issues, pull requests, discusiones.
- Releases anteriores al último.
- Otros tipos de fuente (solo se deja preparada la interfaz).
- Autenticación de la web.
- Restaurar desde la web (se restaura a mano con `git clone <bundle>`; la
  web muestra la ruta).

## Arquitectura

Un único proceso Node 20 bajo pm2 (`resguard`, puerto 3200) con:

- API HTTP (Express).
- Planificador interno.
- Web estática servida por el mismo proceso, sin paso de build.

El proyecto es el propio clon del repositorio.

### Almacenamiento

| Qué | Dónde |
|---|---|
| Código | el clon del repositorio (git) |
| SQLite: fuentes, ejecuciones, ajustes | `data/resguard.db` (ignorado por git) |
| Carpeta de trabajo temporal | `data/work/` (se vacía al terminar y al arrancar) |
| Espejo, instantáneas, wiki y release | `<carpeta de destino>/github/<owner>/<repo>/` |

**La carpeta de destino no está en el código.** Se elige en «Ajustes» de la
web y se guarda en SQLite. El código no contiene rutas, IP ni puntos de
montaje de ninguna máquina, para que el software sirva tal cual en otra. Solo
el puerto (`RESGUARD_PUERTO`, 3200) y la carpeta de datos locales
(`RESGUARD_DATOS`, `./data`) son variables de entorno.

Al guardar la carpeta se crea dentro un fichero de marca `.resguard`. Una
copia solo arranca si la marca está: si la carpeta es una unidad de red y no
está montada, la marca falta y no se escribe nada en el disco local. Vale
para cualquier tipo de montaje sin tener que configurarlo.

Cambiar la carpeta no mueve las copias ya hechas; la siguiente copia empieza
de cero en la nueva. No se permite con una copia en curso.

Disposición por repo en la carpeta de destino (en adelante «el NAS»):

```
github/<owner>/<repo>/
  mirror.git/                      espejo del código (ficheros, no se opera aquí)
  wiki.git/                        espejo de la wiki, si existe
  snapshots/
    2026-10-12T090000Z.code.bundle
    2026-10-12T090000Z.wiki.bundle  solo si hay wiki
  release/
    release.json                   metadatos del último release
    <adjuntos>
```

**Regla dura: git nunca opera sobre el NAS.** SMB no da las garantías de
bloqueo y renombrado que git necesita. El NAS solo recibe y entrega ficheros.

### Módulos

Cada uno con un propósito y testeable por separado:

- `store` — SQLite: fuentes, ejecuciones, ajustes.
- `scheduler` — decide qué fuente toca y lanza copias de una en una.
- `runner` — orquesta el ciclo de una copia y registra el resultado.
- `sources/github` — todo lo específico de GitHub.
- `almacen` — traer/llevar carpetas y ficheros al NAS, medir tamaños,
  listar y borrar instantáneas, comprobar que el NAS está disponible.
- `retencion` — decide qué instantáneas borrar (función pura).
- `notifier` — Telegram, con lógica de cambio de estado.
- `api` — rutas HTTP.
- `public/` — la web.

### Interfaz de un tipo de fuente

```
comprobar(fuente)            → { ok } | { ok:false, motivo:'no_encontrado'|'vacio'|'red', detalle }
copiar(fuente, dirTrabajo)   → { cambios:boolean, artefactos:[...] }
```

`comprobar` no escribe nada. `copiar` solo se llama si `comprobar` dio ok.
Añadir un tipo nuevo es añadir un módulo en `sources/` y registrarlo.

## Ciclo de una copia (GitHub)

1. **Carpeta de destino disponible.** Si no hay carpeta configurada, falta
   el fichero de marca o no se puede escribir, se aborta con estado `error`
   y motivo `almacen`, sin crear nada.
2. **Comprobación previa.**
   - `GET https://api.github.com/repos/<owner>/<repo>`: 404, 410 o 451 →
     `no_encontrado`. Cualquier otro fallo de la API (403/429 por límite de
     peticiones, 5xx, sin red) **no** es un 404: decide el paso siguiente.
   - `git ls-remote --heads --tags <url>`: cero referencias → `vacio`; si
     falla → `red`; si responde con referencias, el repo existe y se sigue
     aunque la API estuviera limitada.
   - Solo se copian ramas y etiquetas; las referencias de pull requests
     (`refs/pull/*`) quedan fuera.
   - Cualquiera de los dos aborta **sin tocar nada de lo guardado**.
3. **Traer el espejo.** Si existe `mirror.git` en el NAS se copia a
   `data/work/` y se valida (`git fsck --connectivity-only`). Si no existe o
   está dañado, se hace `git clone --mirror` desde cero; el dañado se avisa.
4. **Actualizar.** `git fetch` con `+refs/*:refs/*` y **sin `--prune`**: las
   ramas y etiquetas borradas en origen se conservan en el espejo.
5. **Instantánea.** Se calcula una huella de las referencias del origen
   (salida ordenada de `ls-remote`). Si coincide con la de la última
   instantánea, no se crea otra: la ejecución queda como «sin cambios». Si
   difiere, `git bundle create --all` en local, `git bundle verify`, copia al
   NAS con nombre temporal y renombrado final. Un bundle que no verifica no
   llega al NAS y la ejecución es `error`.
6. **Devolver el espejo** al NAS (sincronización de ficheros) y borrar el
   temporal local.
7. **Wiki.** Pasos 3–6 sobre `<repo>.wiki.git`. Que no exista o esté vacía
   es normal: se omite sin aviso. Si existía y deja de existir, se conserva
   lo guardado y no se avisa (el aviso lo da el repo principal).
8. **Último release.** `GET /repos/<owner>/<repo>/releases/latest`. Si su id
   difiere del guardado, se descargan adjuntos y `release.json` a una carpeta
   temporal del NAS y, completa la descarga, se sustituye la anterior. Si no
   hay releases (404 en este endpoint), se conserva lo que hubiera.
9. **Retención.** Solo si la ejecución ha sido correcta.
10. **Registro** de la ejecución (inicio, fin, resultado, motivo, cambios) y
    recálculo de tamaños.

Un fallo en wiki o release no invalida la copia del código: la ejecución
queda en `aviso` con el detalle.

## Retención

Función pura `(instantáneas, díasAGuardar, ahora) → aBorrar`:

- Código y wiki se evalúan por separado.
- Se conservan todas las instantáneas de los últimos N días **y además la
  más reciente anterior a ese límite**, que es la que estaba vigente hace
  N días. Así cualquier día dentro del plazo se puede restaurar, y un repo
  que lleva meses sin cambios nunca pierde su única instantánea.
- El resto se borra.
- No se ejecuta tras una copia fallida ni abortada.

«Días disponibles» en la web = días entre la instantánea más antigua y hoy.

## Planificador

- Cada minuto busca fuentes activas cuya `próxima_copia` ya pasó.
- Ejecuta de una en una (la máquina tiene 2 vCPU y ~6 GB).
- `próxima_copia` = fin de la última ejecución + frecuencia, también si
  falló (no se reintenta en bucle).
- «Copiar ahora» encola la fuente; si ya está en curso, no hace nada.
- Al arrancar, las ejecuciones que quedaron «en curso» se marcan como
  interrumpidas y `data/work/` se vacía.

## Avisos por Telegram

Estados de una fuente: `pendiente` (recién añadida, sin copiar aún), `ok`,
`aviso`, `error`.

Se envía mensaje cuando **cambia** el motivo del estado, no en cada intento.
Se recuerda el último estado avisado con éxito, de modo que un aviso que no
pudo enviarse se reintenta en la copia siguiente:

- `no_encontrado` (404), `vacio`, `red`, `almacen`, `bundle_invalido`,
  `espejo_dañado`, fallo de wiki/release.
- Recuperación: al volver a `ok` desde `aviso`/`error`.

El mensaje incluye repo, motivo, hora y qué se conserva (fecha de la última
instantánea válida).

Ajustes (en SQLite, editables desde la web): carpeta de destino, token del
bot, ID de conversación. Botón «enviar prueba». El token nunca se devuelve completo por
la API (enmascarado) ni se escribe en logs. Sin token configurado, los avisos
se registran pero no se envían, y la web lo indica.

Si Telegram falla no bloquea la copia; el aviso se reintenta en la siguiente.

## Web

Minimalista, una sola página más un panel de ajustes. HTML, CSS y JS
propios, sin framework ni build. Tema claro y oscuro según el sistema.

**Home**

- Cabecera con totales: fuentes, espacio total, espacio libre en la carpeta
  de destino. Si aún no hay carpeta configurada, un aviso lo dice.
- Una tarjeta por repo:
  - `owner/repo` (enlace a GitHub) y estado con color y texto.
  - Última copia correcta y hace cuánto.
  - Próxima copia.
  - Espacio: total, con desglose espejo / instantáneas / release.
  - Días disponibles y número de instantáneas.
  - Último release guardado (etiqueta), si hay.
  - Si está en `aviso`/`error`: el motivo en claro y desde cuándo.
  - Acciones: copiar ahora, editar frecuencia y días, quitar.
- Estado vacío con invitación a añadir el primero.
- Se refresca sola mientras hay una copia en curso.

**Añadir**

- Campo único que acepta `owner/repo` o una URL de GitHub.
- Frecuencia en horas (por defecto 24) y días a guardar (por defecto 30).
- Al guardar se valida el formato y se lanza la primera copia. Si el repo no
  existe se dice en el formulario, no se crea la fuente.

**Quitar**

Deja de copiar. Los datos del NAS se conservan salvo que se marque
expresamente «borrar también las copias», con confirmación.

## API

```
GET    /api/fuentes                 lista con estado y métricas
POST   /api/fuentes                 { repo, frecuenciaHoras, diasGuardar }
PATCH  /api/fuentes/:id             { frecuenciaHoras?, diasGuardar?, activa? }
DELETE /api/fuentes/:id?borrarDatos=1
POST   /api/fuentes/:id/copiar
GET    /api/fuentes/:id/ejecuciones últimas ejecuciones
GET    /api/ajustes                 carpeta de destino, token enmascarado
PUT    /api/ajustes
POST   /api/ajustes/probar
GET    /api/resumen                 totales y espacio libre
```

Validación: `owner` y `repo` contra `^[A-Za-z0-9._-]+$`; nunca se construye
una ruta ni un comando con texto sin validar. Los comandos git se lanzan con
lista de argumentos, sin shell.

## Datos

```
fuentes(id, tipo, owner, repo, frecuencia_horas, dias_guardar, activa,
        estado, motivo, estado_desde, ultima_ok, proxima_copia,
        huella_refs, huella_wiki, release_id, release_tag, clave_avisada,
        bytes_espejo, bytes_instantaneas, bytes_release,
        num_instantaneas, primera_instantanea, ultima_instantanea, creada)
ejecuciones(id, fuente_id, inicio, fin, resultado, motivo, detalle, cambios)
ajustes(clave, valor)
```

## Tests

TDD con `node:test`. Sin red: el origen es un repo git local creado en cada
test, el almacén es una carpeta temporal, y GitHub y Telegram se inyectan
como funciones falsas.

Casos que deben existir y que deben poder ponerse en rojo:

- Origen vaciado → no se crea instantánea, no se borra ninguna, espejo
  intacto, aviso `vacio`.
- 404 → ídem con `no_encontrado`. 403 por límite → `red`, no `no_encontrado`.
- Rama borrada en origen → sigue en el espejo.
- Historial reescrito → la instantánea anterior sigue restaurando el
  historial antiguo.
- Sin cambios → no se duplica instantánea.
- Bundle corrupto → no llega al almacén.
- Carpeta de destino sin marca o sin configurar → no se escribe nada, aviso
  `almacen`.
- Cambiar la carpeta de destino: se prepara y las fuentes pasan a usarla; se
  rechaza con una copia en curso.
- Retención: nunca borra la más reciente; no corre tras un fallo.
- Avisos: uno por cambio de estado, no uno por intento; recuperación.
- Token enmascarado en la API.
- Validación de `owner/repo` rechaza rutas y metacaracteres.

Cada test de salvaguarda se verifica rompiendo el código a propósito y
comprobando qué test cae.

## Despliegue

- `pm2 start` con nombre `resguard`, `pm2 save`.
- `web_project.md` en la raíz, actualizado al cerrar cada tarea.
- La carpeta de destino de cada instalación se indica en «Ajustes» tras el
  primer arranque.
