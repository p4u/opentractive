import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, compare } from '../scripts/check-fixtures.mjs';

test('flatten unions array elements and records JSON types', () => {
  const f = flatten({ a: [{ b: 1 }, { c: 'x' }], d: null, e: [[1, 2]] });
  assert.deepEqual([...f.keys()].sort(), ['a', 'a[]', 'a[].b', 'a[].c', 'd', 'e', 'e[]', 'e[][]']);
  assert.deepEqual([...f.get('a[].b')], ['number']);
  assert.deepEqual([...f.get('a')], ['array']);
  assert.deepEqual([...f.get('a[]')], ['object']);
  assert.deepEqual([...f.get('d')], ['null']);
});

test('compare reports missing paths and type changes; a null probe value accepts any type', () => {
  const probe = { a: 1, b: 'x', c: null, d: { e: true } };
  assert.deepEqual(compare(probe, { a: 2, b: 'y', c: 5, d: { e: false }, extra: 1 }), []);
  assert.deepEqual(compare(probe, { a: '2', b: 'y', d: {} }), [
    { kind: 'TYPE', path: 'a', probe: 'number', fixture: 'string' },
    { kind: 'MISSING', path: 'c' },
    { kind: 'MISSING', path: 'd.e' },
  ]);
  assert.deepEqual(compare({ x: 1 }, { x: null }), [{ kind: 'TYPE', path: 'x', probe: 'number', fixture: 'null' }]);
  assert.deepEqual(compare([{ p: 1 }], [{ p: 2, q: 3 }, { p: 4 }]), []);
});
