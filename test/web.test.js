import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bytes, relativo, fecha } from '../public/formato.js';
import { RAIZ } from '../src/config.js';

const AHORA = new Date('2026-10-12T12:00:00Z');
const leer = (f) => fs.readFile(path.join(RAIZ, 'public', f), 'utf8');

test('bytes', () => {
  assert.equal(bytes(0), '0 B');
  assert.equal(bytes(null), '0 B');
  assert.equal(bytes(500), '500 B');
  assert.equal(bytes(1536), '1,5 KB');
  assert.equal(bytes(1048576), '1,0 MB');
  assert.equal(bytes(250 * 1024 * 1024), '250 MB');
  assert.equal(bytes(3.4 * 1024 ** 4), '3,4 TB');
});

test('relativo', () => {
  assert.equal(relativo(null, AHORA), 'nunca');
  assert.equal(relativo('2026-10-12T11:59:40Z', AHORA), 'hace un momento');
  assert.equal(relativo('2026-10-12T11:15:00Z', AHORA), 'hace 45 min');
  assert.equal(relativo('2026-10-12T10:00:00Z', AHORA), 'hace 2 h');
  assert.equal(relativo('2026-10-09T12:00:00Z', AHORA), 'hace 3 d');
  assert.equal(relativo('2026-10-12T12:00:20Z', AHORA), 'enseguida');
  assert.equal(relativo('2026-10-12T18:00:00Z', AHORA), 'en 6 h');
  assert.equal(relativo('2026-10-14T12:00:00Z', AHORA), 'en 2 d');
});

test('fecha', () => {
  assert.equal(fecha(null), '—');
  assert.match(fecha('2026-10-12T09:00:00Z'), /2026/);
});

test('la página lleva el nombre, el formulario de alta y carga el script como módulo', async () => {
  const html = await leer('index.html');
  assert.match(html, /<title>REsGuarD<\/title>/);
  assert.match(html, /<html lang="es">/);
  assert.match(html, /id="alta"/);
  assert.match(html, /name="repo"/);
  assert.match(html, /name="frecuencia"[^>]*value="24"/);
  assert.match(html, /name="dias"[^>]*value="30"/);
  assert.match(html, /<script type="module" src="app\.js">/);
  assert.match(html, /id="ajustes"/);
  assert.match(html, /name="carpeta"/);
});

test('el script nunca inyecta HTML: los textos ajenos se pintan como texto', async () => {
  const js = await leer('app.js');
  for (const prohibido of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.equal(js.includes(prohibido), false, prohibido);
  }
});

test('la hoja de estilos tiene tema oscuro', async () => {
  assert.match(await leer('style.css'), /prefers-color-scheme:\s*dark/);
});

test('claveDePintado: igual para los mismos datos en el mismo minuto, distinta si cambian los datos o el minuto', async () => {
  const { claveDePintado, haCambiado } = await import('../public/estado.js');
  const datos = [{ id: 1, estado: 'ok' }];
  const t = new Date('2026-10-12T12:00:10Z');
  const mismoMinuto = new Date('2026-10-12T12:00:50Z');
  const otroMinuto = new Date('2026-10-12T12:01:10Z');
  const k = claveDePintado(datos, t);
  assert.equal(claveDePintado(structuredClone(datos), mismoMinuto), k);
  assert.notEqual(claveDePintado(datos, otroMinuto), k);
  assert.notEqual(claveDePintado([{ id: 1, estado: 'error' }], t), k);
  assert.equal(haCambiado(k, claveDePintado(structuredClone(datos), mismoMinuto)), false);
  assert.equal(haCambiado(k, claveDePintado(datos, otroMinuto)), true);
  assert.equal(haCambiado(null, k), true);
});

test('textoDeBanda: aviso manual reciente gana, caduca a los 8 s, el error de carga gana al aviso de estado', async () => {
  const { textoDeBanda } = await import('../public/estado.js');
  const t0 = 1_000_000;
  const manual = { texto: 'Fallo al copiar', desde: t0 };
  const base = { manual: null, errorDeCarga: '', falta: '' };
  assert.equal(textoDeBanda({ ...base, manual, errorDeCarga: 'E', falta: 'F' }, t0 + 1000), 'Fallo al copiar');
  assert.equal(textoDeBanda({ ...base, manual, falta: 'F' }, t0 + 7999), 'Fallo al copiar');
  assert.equal(textoDeBanda({ ...base, manual, falta: 'F' }, t0 + 8000), 'F');
  assert.equal(textoDeBanda({ ...base, manual }, t0 + 60000), '');
  assert.equal(textoDeBanda({ ...base, errorDeCarga: 'E', falta: 'F' }, t0), 'E');
  assert.equal(textoDeBanda({ ...base, falta: 'F' }, t0), 'F');
  assert.equal(textoDeBanda(base, t0), '');
});

test('avisoDeEstado: falta la carpeta > carpeta no disponible > falta Telegram > nada', async () => {
  const { avisoDeEstado, textoDeBanda } = await import('../public/estado.js');
  const bien = { destino: '/copias', destino_disponible: true, telegram_configurado: true };
  assert.equal(avisoDeEstado(bien), '');
  assert.match(avisoDeEstado({ ...bien, destino: null, destino_disponible: false, telegram_configurado: false }), /Falta indicar la carpeta de destino/);
  // Con destino configurado pero sin montar, eso gana al aviso de Telegram.
  const sinMontar = avisoDeEstado({ ...bien, destino_disponible: false, telegram_configurado: false });
  assert.match(sinMontar, /La carpeta de destino no está disponible ahora mismo/);
  assert.doesNotMatch(sinMontar, /Telegram/);
  assert.match(avisoDeEstado({ ...bien, destino_disponible: false }), /no está disponible ahora mismo/);
  assert.match(avisoDeEstado({ ...bien, telegram_configurado: false }), /Telegram no están configurados/);
  // Y llega a la banda como aviso de estado.
  assert.equal(textoDeBanda({ manual: null, errorDeCarga: '', falta: sinMontar }, 0), sinMontar);
});

test('la tarjeta pinta el detalle del fallo como texto, con el texto completo en title', async () => {
  const js = await leer('app.js');
  assert.match(js, /conProblema && f\.detalle && h\('p', \{ class: 'detalle', title: f\.detalle \}, f\.detalle\)/);
  assert.match(js, /banda\.falta = avisoDeEstado\(resumen\)/);
  const css = await leer('style.css');
  assert.match(css, /\.detalle \{[^}]*line-clamp: 2;[^}]*overflow: hidden/);
});
