import test from 'node:test';
import assert from 'node:assert/strict';
import { aBorrar } from '../src/retencion.js';

const AHORA = new Date('2026-10-31T12:00:00Z');
const i = (dia, tipo = 'code') => ({
  nombre: `2026-10-${String(dia).padStart(2, '0')}T090000Z.${tipo}.bundle`,
  tipo,
  fecha: new Date(`2026-10-${String(dia).padStart(2, '0')}T09:00:00Z`),
});

test('sin instantáneas no hay nada que borrar', () => {
  assert.deepEqual(aBorrar([], 7, AHORA), []);
});

test('las que están dentro del plazo no se tocan', () => {
  assert.deepEqual(aBorrar([i(25), i(28), i(30)], 7, AHORA), []);
});

test('una única instantánea vieja nunca se borra', () => {
  assert.deepEqual(aBorrar([i(1)], 7, AHORA), []);
});

test('de las anteriores al plazo solo sobrevive la más reciente', () => {
  const lista = [i(1), i(5), i(10), i(28)];
  assert.deepEqual(aBorrar(lista, 7, AHORA).sort(), [i(1).nombre, i(5).nombre]);
});

test('todas viejas: se queda la última', () => {
  assert.deepEqual(aBorrar([i(3), i(1), i(2)], 7, AHORA).sort(), [i(1).nombre, i(2).nombre]);
});

test('código y wiki se evalúan por separado', () => {
  const lista = [i(1), i(2), i(29), i(1, 'wiki'), i(3, 'wiki')];
  assert.deepEqual(aBorrar(lista, 7, AHORA).sort(), [i(1).nombre, i(1, 'wiki').nombre].sort());
});

test('el límite exacto cuenta como dentro del plazo', () => {
  const justo = { nombre: 'j', tipo: 'code', fecha: new Date('2026-10-24T12:00:00Z') };
  assert.deepEqual(aBorrar([i(1), i(2), justo], 7, AHORA), [i(1).nombre]);
});
