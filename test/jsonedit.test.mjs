import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deleteKey, setKey } from '../scripts/lib/jsonedit.mjs'

const T = '{\n  "a": 1,\n  "list": ["x", "y"],\n  "obj": {\n    "k": "v, with \\"quotes\\" and }"\n  },\n  "z": true\n}\n'

test('setKey replaces one value and keeps the rest as written', () => {
  assert.equal(setKey(T, 'a', 2), T.replace('"a": 1', '"a": 2'))
  assert.equal(setKey(T, 'list', ['x']), T.replace('["x", "y"]', '["x"]'))
  const o = setKey(T, 'obj', { k: 'w', n: 1 })
  assert.deepEqual(JSON.parse(o).obj, { k: 'w', n: 1 })
  assert.ok(o.includes('"obj": {\n    "k": "w",\n    "n": 1\n  }'), 'a multi-line value stays multi-line under its key')
  assert.ok(o.endsWith('"z": true\n}\n'))
})

test('setKey adds a key at the end; deleteKey removes first, middle and last keys', () => {
  const added = setKey(T, 'new', 'v')
  assert.ok(added.endsWith('"z": true,\n  "new": "v"\n}\n'))
  for (const k of ['a', 'list', 'obj', 'z']) {
    const out = deleteKey(T, k)
    const want = JSON.parse(T); delete want[k]
    assert.deepEqual(JSON.parse(out), want, k)
  }
  assert.equal(deleteKey(T, 'missing'), T)
  assert.deepEqual(JSON.parse(deleteKey('{ "only": 1 }', 'only')), {})
})
