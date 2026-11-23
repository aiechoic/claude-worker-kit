// team file resolution: member overrides, {n}, {field.path} references, the auto App Secret entry.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveRole, secretsOf } from '../scripts/lib/team.mjs'

const LIB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'lib', 'team.mjs')
const base = () => ({
  roles: {
    worker: {
      workDir: '/w', stateClone: '/s', dir: 'worker-{n}',
      channel: { appSecretFile: '/w/{n}/secret' },
      secrets: [{ name: 'App Secret', path: '{channel.appSecretFile}', by: 'user' }, { name: 'model key', path: '/w/key' }],
    },
  },
  members: { 4: { channel: { appSecretFile: '/other/{n}/secret' } } },
})

test('a secret path can reference channel.appSecretFile; the member override wins', () => {
  const r = resolveRole(base(), 'worker', 4)
  assert.equal(r.secrets[0].path, '/other/4/secret')
  assert.equal(r.channel.appSecretFile, '/other/4/secret')
})

test('secretsOf adds the App Secret entry only when no entry names that file', () => {
  const r = resolveRole(base(), 'worker', 4)
  assert.equal(secretsOf(r).filter(s => s.path === '/other/4/secret').length, 1)
  const t = base(); t.roles.worker.secrets = [{ name: 'model key', path: '/w/key' }]
  const s = secretsOf(resolveRole(t, 'worker', 4))
  assert.equal(s[0].path, '/other/4/secret')
  assert.equal(s[0].auto, true)
  assert.equal(s.length, 2)
})

test('a reference to a missing field stops with a clear error', () => {
  const code = `import { resolveRole } from ${JSON.stringify(LIB.replaceAll('\\', '/').replace(/^([A-Za-z]):/, 'file:///$1:'))}
    resolveRole({ roles: { worker: { workDir: '/w', secrets: [{ path: '{channel.nope}' }] } }, members: { 1: {} } }, 'worker', 1)`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /\{channel\.nope\} does not name a string field/)
})

test('runtime: runtime.docker without a mode means docker on any OS; an explicit mode wins', () => {
  const t = { roles: { worker: { workDir: '/w', runtime: { docker: { image: 'x' } } } }, members: { 1: {}, 5: { runtime: { mode: 'native' } } } }
  assert.equal(resolveRole(t, 'worker', 1).runtimeMode, 'docker')
  assert.equal(resolveRole(t, 'worker', 5).runtimeMode, 'native')
  const plain = { roles: { worker: { workDir: '/w' } }, members: { 1: {} } }
  assert.equal(resolveRole(plain, 'worker', 1).runtimeMode, 'native')
})

test('contentHash: CRLF = LF for text, binary untouched', async () => {
  const { contentHash } = await import('../scripts/lib/memsync.mjs')
  assert.equal(contentHash(Buffer.from('a\r\nb\r\n')), contentHash(Buffer.from('a\nb\n')))
  assert.notEqual(contentHash(Buffer.from('a\nb\n')), contentHash(Buffer.from('a\nc\n')))
  assert.notEqual(contentHash(Buffer.from([0, 13, 10])), contentHash(Buffer.from([0, 10])))
  assert.equal(contentHash(Buffer.from('中文\r\n')), contentHash(Buffer.from('中文\n')), 'UTF-8 text too')
})
