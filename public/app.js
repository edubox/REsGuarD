import { bytes, relativo, fecha } from './formato.js';
import { claveDePintado, haCambiado, textoDeBanda, avisoDeEstado, CADUCIDAD_AVISO } from './estado.js';

const $ = (selector) => document.querySelector(selector);
const ESTADOS = { ok: 'Al día', aviso: 'Con avisos', error: 'Fallo', pendiente: 'Pendiente', pausada: 'En pausa' };

// Crea elementos sin pasar nunca por HTML: todo texto ajeno (nombres, errores de
// git o de Telegram) entra como nodo de texto.
function h(etiqueta, atributos = {}, ...hijos) {
  const el = document.createElement(etiqueta);
  for (const [clave, valor] of Object.entries(atributos)) {
    if (valor == null || valor === false) continue;
    if (clave.startsWith('on')) el.addEventListener(clave.slice(2), valor);
    else el.setAttribute(clave, valor === true ? '' : valor);
  }
  for (const hijo of hijos.flat()) if (hijo != null && hijo !== false) el.append(hijo);
  return el;
}

async function api(metodo, ruta, cuerpo) {
  let r;
  try {
    r = await fetch(ruta, {
      method: metodo,
      headers: cuerpo ? { 'Content-Type': 'application/json' } : undefined,
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
  } catch {
    throw new Error('No se pudo contactar con el servidor');
  }
  const datos = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) throw new Error(datos?.error ?? `Error ${r.status}`);
  return datos;
}

function decir(el, texto, bien = false) {
  el.textContent = texto;
  el.classList.toggle('bien', bien);
}

const dato = (etiqueta, valor, nota) => h('div', {}, h('dt', {}, etiqueta), h('dd', {}, valor, nota && h('small', {}, nota)));

function tarjeta(f) {
  const trabajando = f.en_curso || f.en_cola;
  const estado = f.activa ? f.estado : 'pausada';
  const total = f.bytes_espejo + f.bytes_instantaneas + f.bytes_release;
  const conProblema = f.activa && (f.estado === 'aviso' || f.estado === 'error');
  return h('article', { class: `tarjeta estado-${estado}${trabajando ? ' trabajando' : ''}` },
    h('header', {},
      h('a', { class: 'nombre', href: `https://github.com/${f.owner}/${f.repo}`, target: '_blank', rel: 'noreferrer' },
        h('span', { class: 'owner' }, `${f.owner}/`), f.repo),
      h('span', { class: 'estado' }, f.en_curso ? 'Copiando…' : f.en_cola ? 'En cola' : ESTADOS[estado] ?? estado)),
    conProblema && h('p', { class: 'motivo' },
      `${f.motivo_texto.charAt(0).toUpperCase()}${f.motivo_texto.slice(1)}`,
      f.estado_desde ? ` · desde el ${fecha(f.estado_desde)}` : ''),
    // El detalle viene de git, de GitHub o del sistema: siempre como texto.
    conProblema && f.detalle && h('p', { class: 'detalle', title: f.detalle }, f.detalle),
    h('dl', { class: 'datos' },
      dato('Última copia', relativo(f.ultima_ok), f.ultima_ok && fecha(f.ultima_ok)),
      dato('Próxima', f.activa ? relativo(f.proxima_copia ?? new Date().toISOString()) : '—', `cada ${f.frecuencia_horas} h`),
      dato('Espacio', bytes(total), `${bytes(f.bytes_instantaneas)} en instantáneas`),
      dato('Días disponibles', String(f.dias_disponibles), `${f.num_instantaneas} instantáneas · guarda ${f.dias_guardar} d`),
      dato('Último release', f.release_tag || '—', f.bytes_release ? bytes(f.bytes_release) : null)),
    h('footer', {},
      h('p', { class: 'ruta', title: f.ruta }, f.ruta ?? 'Sin carpeta de destino'),
      h('button', { type: 'button', class: 'discreto', 'data-id': f.id, 'data-accion': 'copiar', disabled: trabajando, onclick: (ev) => copiar(f, ev.currentTarget) }, 'Copiar ahora'),
      h('button', { type: 'button', class: 'discreto', 'data-id': f.id, 'data-accion': 'editar', onclick: () => abrirEditar(f) }, 'Editar'),
      h('button', { type: 'button', class: 'discreto', 'data-id': f.id, 'data-accion': 'quitar', onclick: () => abrirQuitar(f) }, 'Quitar')));
}

const botonDe = (id, accion) => $(`#fuentes button[data-id="${id}"][data-accion="${accion}"]`);

function enfocarBoton(id, accion) {
  const b = botonDe(id, accion);
  if (b && !b.disabled) b.focus();
  return Boolean(b && !b.disabled);
}

let clavePintada = { fuentes: null, resumen: null };

// Textos de la banda: el aviso de estado lo calcula pintar; el manual lo pone
// una acción del usuario y caduca; el error de carga dura mientras las cargas fallen.
const banda = { manual: null, errorDeCarga: '', falta: '', caduca: null };

function pintarBanda() {
  const texto = textoDeBanda(banda, Date.now());
  $('#banda').hidden = texto === '';
  $('#banda').textContent = texto;
}

function avisar(texto) {
  banda.manual = { texto, desde: Date.now() };
  clearTimeout(banda.caduca);
  banda.caduca = setTimeout(pintarBanda, CADUCIDAD_AVISO);
  pintarBanda();
}

// Toda acción del usuario descarta el aviso manual anterior y, al terminar,
// fuerza el repintado de las tarjetas: el DOM no debe conservar estado puesto a mano.
function empezarAccion() {
  banda.manual = null;
  pintarBanda();
}
function terminarAccion() {
  clavePintada.fuentes = null;
}

function pintar(fuentes, resumen) {
  const ahora = new Date();
  const claves = { fuentes: claveDePintado(fuentes, ahora), resumen: claveDePintado(resumen, ahora) };

  if (haCambiado(clavePintada.resumen, claves.resumen)) {
    $('#totales').replaceChildren(
      dato('Repositorios', String(resumen.fuentes)),
      dato('Ocupado', bytes(resumen.bytes_total)),
      dato('Libre en destino', resumen.libre == null ? '—' : bytes(resumen.libre)));

    banda.falta = avisoDeEstado(resumen);
  }
  banda.errorDeCarga = '';
  pintarBanda();

  if (haCambiado(clavePintada.fuentes, claves.fuentes)) {
    // Se anota el botón con el foco para devolvérselo tras sustituir las tarjetas.
    const activo = document.activeElement;
    const foco = activo?.closest?.('#fuentes') && activo.dataset?.accion
      ? { id: activo.dataset.id, accion: activo.dataset.accion }
      : null;
    $('#fuentes').replaceChildren(...(fuentes.length
      ? fuentes.map(tarjeta)
      : [h('div', { class: 'vacio' }, h('strong', {}, 'Todavía no hay nada que guardar'), 'Añade arriba tu primer repositorio.')]));
    if (foco && !enfocarBoton(foco.id, foco.accion) && !enfocarBoton(foco.id, 'editar')) $('#alta').repo.focus();
  }
  clavePintada = claves;
}

let temporizador = null;
let generacion = 0;
async function cargar() {
  clearTimeout(temporizador);
  const mia = ++generacion;
  let ocupado = false;
  try {
    const [fuentes, resumen] = await Promise.all([api('GET', '/api/fuentes'), api('GET', '/api/resumen')]);
    if (mia !== generacion) return; // otra llamada más reciente se encarga
    pintar(fuentes, resumen);
    ocupado = resumen.en_curso;
  } catch (e) {
    if (mia !== generacion) return;
    banda.errorDeCarga = `No se pudo cargar: ${e.message}`;
    pintarBanda();
  }
  temporizador = setTimeout(cargar, ocupado ? 2500 : 30000);
}

async function copiar(f, boton) {
  empezarAccion();
  boton.disabled = true;
  try {
    await api('POST', `/api/fuentes/${f.id}/copiar`);
  } catch (e) {
    avisar(e.message);
  } finally {
    terminarAccion();
    cargar();
  }
}

// ---- Alta ----
$('#alta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const boton = form.querySelector('button[type="submit"]');
  const mensaje = $('#alta-mensaje');
  empezarAccion();
  decir(mensaje, '');
  boton.disabled = true;
  try {
    await api('POST', '/api/fuentes', {
      repo: form.repo.value,
      frecuenciaHoras: Number(form.frecuencia.value),
      diasGuardar: Number(form.dias.value),
    });
    form.repo.value = '';
    terminarAccion();
    await cargar();
  } catch (e) {
    decir(mensaje, e.message);
    terminarAccion();
    cargar();
  } finally {
    boton.disabled = false;
  }
});

// ---- Diálogos ----
for (const boton of document.querySelectorAll('[data-cerrar]')) {
  boton.addEventListener('click', () => boton.closest('dialog').close());
}

function alEnviar(idForm, idMensaje, accion) {
  $(idForm).addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.currentTarget;
    const mensaje = $(idMensaje);
    const boton = form.querySelector('button[type="submit"]');
    empezarAccion();
    decir(mensaje, '');
    boton.disabled = true;
    try {
      await accion(form);
      form.closest('dialog').close();
      terminarAccion();
      await cargar();
    } catch (e) {
      decir(mensaje, e.message);
      // Una acción fallida puede haber cambiado la lista (p. ej. un 500 al quitar
      // tras haber borrado la fila): se refresca sin cerrar el diálogo.
      terminarAccion();
      cargar();
    } finally {
      boton.disabled = false;
    }
  });
}

let enEdicion = null;
let accionAbierta = null;

// Al cerrar editar o quitar, el foco vuelve al botón que abrió el diálogo
// (o al campo del alta si la fuente ya no existe).
for (const [id, accion] of [['#editar', 'editar'], ['#quitar', 'quitar']]) {
  $(id).addEventListener('close', () => {
    if (!enEdicion || accionAbierta !== accion) return;
    if (!enfocarBoton(enEdicion.id, accion)) $('#alta').repo.focus();
  });
}

function abrirEditar(f) {
  enEdicion = f;
  accionAbierta = 'editar';
  const form = $('#form-editar');
  $('#editar-titulo').textContent = `${f.owner}/${f.repo}`;
  form.frecuencia.value = f.frecuencia_horas;
  form.dias.value = f.dias_guardar;
  form.activa.checked = Boolean(f.activa);
  decir($('#editar-mensaje'), '');
  $('#editar').showModal();
}

alEnviar('#form-editar', '#editar-mensaje', (form) =>
  api('PATCH', `/api/fuentes/${enEdicion.id}`, {
    frecuenciaHoras: Number(form.frecuencia.value),
    diasGuardar: Number(form.dias.value),
    activa: form.activa.checked,
  }));

function abrirQuitar(f) {
  enEdicion = f;
  accionAbierta = 'quitar';
  $('#quitar-titulo').textContent = `Quitar ${f.owner}/${f.repo}`;
  $('#form-quitar').borrar.checked = false;
  decir($('#quitar-mensaje'), '');
  $('#quitar').showModal();
}

alEnviar('#form-quitar', '#quitar-mensaje', (form) =>
  api('DELETE', `/api/fuentes/${enEdicion.id}${form.borrar.checked ? '?borrarDatos=1' : ''}`));

// ---- Ajustes ----
// El token no se rellena: se muestra enmascarado como pista y solo se envía si se escribe uno nuevo.
function cuerpoAjustes(form) {
  const cuerpo = { carpetaDestino: form.carpeta.value.trim(), telegramChat: form.chat.value.trim() };
  if (form.token.value.trim() !== '') cuerpo.telegramToken = form.token.value.trim();
  return cuerpo;
}

$('#abrir-ajustes').addEventListener('click', async () => {
  const form = $('#form-ajustes');
  empezarAccion();
  decir($('#ajustes-mensaje'), '');
  form.token.value = '';
  try {
    const a = await api('GET', '/api/ajustes');
    form.token.placeholder = a.telegramToken || '123456:ABC…';
    form.chat.value = a.telegramChat;
    form.carpeta.value = a.carpetaDestino;
  } catch (e) {
    // Sin los valores guardados, guardar vacíos borraría los ajustes: no se abre.
    avisar(`No se pudieron leer los ajustes: ${e.message}`);
    return;
  }
  $('#ajustes').showModal();
});

alEnviar('#form-ajustes', '#ajustes-mensaje', (form) => api('PUT', '/api/ajustes', cuerpoAjustes(form)));

$('#probar').addEventListener('click', async (ev) => {
  const boton = ev.currentTarget;
  const form = $('#form-ajustes');
  const mensaje = $('#ajustes-mensaje');
  empezarAccion();
  decir(mensaje, '');
  boton.disabled = true;
  try {
    await api('PUT', '/api/ajustes', cuerpoAjustes(form));
    await api('POST', '/api/ajustes/probar');
    decir(mensaje, 'Mensaje enviado. Compruébalo en Telegram.', true);
  } catch (e) {
    decir(mensaje, e.message);
  } finally {
    boton.disabled = false;
  }
});

cargar();
