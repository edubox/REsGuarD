# REsGuarD

Copias periódicas de repositorios públicos de GitHub, por si un día
desaparecen: código, wiki y último release. Guarda instantáneas fechadas en la
carpeta que elijas, no borra nada si el origen desaparece o se vacía, y avisa
por Telegram.

Es un servicio pequeño para alojar en tu propia máquina: un proceso Node con
una web para gestionarlo, sin cuentas ni servicios externos.

## Qué hace

- **Copia cada repositorio con la frecuencia que elijas** (en horas): un espejo
  git con todas las ramas y etiquetas, la wiki si tiene, y los adjuntos del
  último release.
- **Instantáneas fechadas**: cada vez que el repositorio cambia se guarda un
  fichero `.bundle` con el repo entero tal como estaba. Eliges cuántos días
  conservar, y cualquier día dentro de ese plazo se puede restaurar con un
  `git clone`.
- **No destruye lo guardado**: antes de copiar comprueba el origen. Si el
  repositorio ha desaparecido (404), está vacío o no hay conexión, no toca nada
  de lo que ya tiene. Las ramas borradas en GitHub se conservan en el espejo.
- **Avisa por Telegram** cuando un repositorio desaparece, se vacía o falla la
  copia, y otra vez cuando se recupera. Un aviso por cambio de estado, no uno
  por intento.
- **Pensado para una unidad de red**: si el destino es un NAS y no está
  montado, no copia nada en vez de llenar el disco local.
- **Web sencilla**: qué hay copiado, de cuándo es la última copia, cuánto
  ocupa, cuántos días hay disponibles y si algo va mal.

## Requisitos

Linux, Node 20 o superior, `git` y `rsync`.

`npm install` descarga un binario ya compilado de `better-sqlite3`. Si no hay
uno para tu sistema lo compila en el momento, y entonces hacen falta las
herramientas de compilación (en Debian/Ubuntu: `build-essential` y `python3`).

## Puesta en marcha

```bash
npm install
npm start          # o: pm2 start ecosystem.config.cjs && pm2 save
```

Abre `http://<tu-servidor>:3200` y entra en **Ajustes**:

- **Carpeta de destino**: ruta absoluta donde se guardan las copias. Puede ser
  una unidad de red montada.
- **Token del bot** e **ID de conversación** de Telegram, para los avisos.

Al guardar la carpeta se crea dentro un fichero `.resguard`. No lo borres: es
lo que permite distinguir la carpeta de verdad de un punto de montaje vacío.
Si la unidad de red no está montada, el fichero no está y no se copia nada (en
vez de llenar el disco local).

**Configura la carpeta con la unidad ya montada.** Al guardar, la carpeta y el
fichero `.resguard` se crean allí donde apunte la ruta en ese momento: si la
unidad no está montada, se crean en el disco local, debajo del punto de
montaje. Tras guardar, la cabecera muestra «Libre en destino»: comprueba que es
el espacio libre de la unidad que esperas; es la forma de confirmar que la ruta
apunta a la unidad correcta.

Si más adelante la unidad deja de estar montada, la web lo dice en una banda
(«La carpeta de destino no está disponible ahora mismo»), «Libre en destino»
queda en «—» y las copias fallan con aviso, sin escribir nada, hasta que vuelva.

### Con Docker

Si prefieres no instalar Node, el repositorio trae un `Dockerfile` y un
`docker-compose.yml`. La imagen ya incluye `git` y `rsync`.

```bash
cp .env.example .env       # y edita RESGUARD_COPIAS: la carpeta donde guardar las copias
docker compose up -d --build
```

Abre `http://<tu-servidor>:3200`, entra en **Ajustes** y pon **`/copias`** como
carpeta de destino: es el nombre con el que el contenedor ve la carpeta que
indicaste en `RESGUARD_COPIAS`. Todas las rutas que muestre la web serán las
del contenedor (`/copias/github/...`); en el anfitrión están bajo la carpeta
que pusiste en `.env`.

| Dentro del contenedor | Qué es | En el `docker-compose.yml` |
|---|---|---|
| `/copias` | Las copias | La carpeta de `RESGUARD_COPIAS` |
| `/data` | Base de datos (repositorios, ajustes, token de Telegram) y carpeta de trabajo | El volumen `resguard-datos` |

Sin compose:

```bash
docker build -t resguard .
docker run -d --name resguard --restart unless-stopped -p 3200:3200 \
  -v resguard-datos:/data -v /ruta/de/tus/copias:/copias resguard
```

Para actualizar: `git pull && docker compose up -d --build`. Los datos y las
copias están en los volúmenes y no se pierden.

Si la carpeta de las copias es una **unidad de red**:

- Móntala en el anfitrión **antes** de arrancar el contenedor. Si no lo está,
  el contenedor ve una carpeta vacía; como le falta el fichero `.resguard`, no
  copia nada y avisa.
- Si la unidad se monta después de arrancar el contenedor, este no la ve hasta
  que lo reinicies (`docker compose restart`), salvo que montes el volumen con
  propagación (`/ruta:/copias:rslave`).
- El contenedor se ejecuta como `root`, que es lo que suele hacer falta para
  escribir en una unidad SMB montada por el sistema.

`docker stop` detiene el servicio al momento. Si había una copia a medias, pasa
lo descrito en «Si el servicio se reinicia a mitad de una copia».

### Sin Docker: arranque con la máquina y actualización

Con pm2, para que el servicio arranque solo tras un reinicio de la máquina:

```bash
pm2 start ecosystem.config.cjs
pm2 startup        # si imprime una orden, ejecútala
pm2 save
```

Para actualizar:

```bash
git pull && npm install && pm2 restart resguard
```

La web no tiene autenticación: no la expongas a Internet; úsala en una red de confianza o detrás de un proxy con acceso restringido.

## Qué guarda de cada repositorio

En `<carpeta de destino>/github/<owner>/<repo>/`:

| Carpeta | Contenido |
|---|---|
| `mirror.git/` | Espejo con todas las ramas y etiquetas. Lo que se borra en GitHub aquí se conserva (ver «Ramas y etiquetas borradas»). |
| `wiki.git/` | Espejo de la wiki, si tiene. |
| `snapshots/` | Un `.code.bundle` (y un `.wiki.bundle` si la wiki cambió) por cada vez que hubo cambios: el repo entero tal como estaba ese día. |
| `release/` | Adjuntos del último release y `release.json`. |

### Ramas y etiquetas borradas

Una rama o etiqueta borrada en GitHub sigue en el espejo, en su sitio
(`refs/heads/<nombre>`, `refs/tags/<nombre>`), y en las instantáneas nuevas.
La excepción es cuando choca con una nueva: git no puede tener a la vez `a` y
`a/b`. En ese caso la antigua se guarda bajo
`refs/conservadas/<fecha de la copia>/heads/<nombre>` (o `/tags/<nombre>`) y la
nueva ocupa su lugar. No se pierde nada, y también viaja en las instantáneas;
para traerla de una instantánea a un clon:

```bash
git fetch <instantánea>.code.bundle 'refs/conservadas/*:refs/conservadas/*'
```

## Restaurar

Una instantánea es un fichero autosuficiente:

```bash
git clone <carpeta de destino>/github/OWNER/REPO/snapshots/2026-10-12T090000Z.code.bundle recuperado
```

Para el estado de un día concreto, usa la instantánea más reciente que sea
anterior o igual a ese día.

## Retención

Se conservan todas las instantáneas de los últimos N días y, además, la más
reciente anterior a ese plazo. Solo se borra tras una copia correcta.
Si una instantánea antigua no se puede borrar (por ejemplo, está abierta desde
otro equipo), la copia cuenta igualmente como hecha y queda un aviso; se
reintenta en la copia siguiente.

## Avisos

Se avisa cuando un repo deja de existir (404), se vacía, no hay conexión, la
carpeta de destino no está disponible o falla la wiki o el release; y otra vez
cuando se recupera. Un aviso por cambio de estado, no uno por intento.

En la web, la tarjeta de un repositorio con aviso o fallo muestra el motivo y,
debajo, el detalle técnico de la última copia.

### Si el servicio se reinicia a mitad de una copia

Las instantáneas ya guardadas no se tocan, y el espejo se termina de
actualizar en la copia siguiente. Al arrancar, ese repositorio queda en fallo con el motivo «la copia se interrumpió por un
reinicio del servicio» y se avisa por Telegram. No se relanza nada más
arrancar: se reintenta cuando le toque la siguiente copia según su frecuencia,
o antes con «Copiar ahora».

### Límite de la API de GitHub

REsGuarD no usa token. Sin token, la API de GitHub admite 60 peticiones por
hora desde una misma dirección, y cada copia gasta 2 (una para comprobar que el
repositorio sigue existiendo y otra para consultar el último release). Con
muchos repositorios y frecuencias cortas se puede agotar: el código se copia
igual (va por git, no por la API), pero alguna copia puede quedar con el aviso
«falló la descarga del último release» y recuperarse sola en la siguiente.

## Cambiar la carpeta de destino

Se puede cambiar en Ajustes cuando no haya una copia en curso. Las copias ya
hechas no se mueven: quedan en la carpeta anterior y la siguiente copia empieza
de cero en la nueva. Para conservarlas, mueve tú el contenido antes de cambiar.

## Variables de entorno

| Variable | Por defecto | Para qué |
|---|---|---|
| `RESGUARD_PUERTO` | `3200` | Puerto de la web |
| `RESGUARD_DATOS` | `./data` | Base de datos y carpeta de trabajo temporal |

## Limitaciones conocidas

- Solo repositorios **públicos** de GitHub. No se copian issues, pull requests
  ni releases anteriores al último.
- La web **no tiene autenticación**. Úsala en una red de confianza.
- Si el destino es una unidad de red que no distingue mayúsculas de minúsculas
  (SMB, por ejemplo), dos ramas cuyo nombre solo difiera en eso (`Foo` y `foo`)
  pueden chocar en el espejo. Las instantáneas no se ven afectadas.
- Los adjuntos del release se descargan primero al disco local y después se
  llevan al destino: un release de muchos gigas ocupa ese espacio mientras
  dura la copia.
- Un montaje de red que se queda colgado (no caído) puede detener la cola de
  copias hasta que el sistema lo dé por perdido.
- El token de Telegram se puede cambiar desde la web, pero no borrar.

## Desarrollo

```bash
npm install
npm test
```

Los tests no usan red ni la carpeta de destino real: trabajan con
repositorios git locales y carpetas temporales.

El diseño está en `docs/superpowers/specs/` y el plan de implementación
original en `docs/superpowers/plans/`. El plan es un documento histórico: el
código ha cambiado después de escribirse.

## Licencia

Copyright © 2026 Eduardo Ruiz

REsGuarD es software libre: puedes redistribuirlo y modificarlo bajo los
términos de la **Licencia Pública General de GNU, versión 3 o (a tu elección)
cualquier versión posterior**, publicada por la Free Software Foundation.

Se distribuye con la esperanza de que sea útil, pero SIN NINGUNA GARANTÍA; ni
siquiera la garantía implícita de COMERCIALIZACIÓN o IDONEIDAD PARA UN FIN
DETERMINADO. El texto completo de la licencia está en el fichero
[`LICENSE`](LICENSE).
