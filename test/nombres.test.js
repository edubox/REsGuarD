import test from 'node:test';
import assert from 'node:assert/strict';
import { nombreValido, parsearRepo } from '../src/nombres.js';

test('nombreValido', () => {
  for (const ok of ['torvalds', 'Hello-World', 'a.b_c', 'x']) assert.equal(nombreValido(ok), true, ok);
  for (const mal of ['', '.', '..', 'a/b', 'a b', 'a;b', '$(x)', 'ñ', 'a'.repeat(101), null, 7]) {
    assert.equal(nombreValido(mal), false, String(mal));
  }
});

test('parsearRepo acepta owner/repo y las formas habituales de URL', () => {
  const esperado = { owner: 'octocat', repo: 'Hello-World' };
  for (const t of [
    'octocat/Hello-World',
    '  octocat/Hello-World  ',
    'https://github.com/octocat/Hello-World',
    'https://github.com/octocat/Hello-World/',
    'https://github.com/octocat/Hello-World.git',
    'http://www.github.com/octocat/Hello-World',
    'github.com/octocat/Hello-World',
    'https://github.com/octocat/Hello-World/tree/main/src',
    'https://github.com/octocat/Hello-World?tab=readme#uso',
    'git@github.com:octocat/Hello-World.git',
  ]) {
    assert.deepEqual(parsearRepo(t), esperado, t);
  }
});

test('parsearRepo rechaza lo que no es un repo de GitHub', () => {
  for (const t of [
    '', 'octocat', 'a/..', '../b', 'a/.', 'a/b/c', 'a/b/../c', 'a//b', 'a/b c', 'a/$(reboot)',
    'https://gitlab.com/a/b', 'https://github.com/a', 'https://github.com/a/../b', null, 42,
  ]) {
    assert.equal(parsearRepo(t), null, String(t));
  }
});
