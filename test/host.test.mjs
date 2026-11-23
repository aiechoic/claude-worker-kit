// host.mjs against a fake `docker` on PATH: the plan changes nothing; rebuild then rollback restores the old container and image.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HOST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'host.mjs')

// fake docker: state in $FAKE_STATE (containers name → running, images list), every call appended to $FAKE_LOG
const FAKE = `#!/usr/bin/env node
const fs = require('fs')
const S = process.env.FAKE_STATE, L = process.env.FAKE_LOG
const st = JSON.parse(fs.readFileSync(S, 'utf8'))
const a = process.argv.slice(2)
fs.appendFileSync(L, a.join(' ') + '\\n')
const save = () => fs.writeFileSync(S, JSON.stringify(st))
const has = n => n in st.containers
let code = 0
if (a[0] === 'info') code = 0
else if (a[0] === 'container' && a[1] === 'inspect') {
  const n = a[a.length - 1]
  if (!has(n)) code = 1
  else if (a[2] === '-f') console.log(String(st.containers[n]))
} else if (a[0] === 'image' && a[1] === 'inspect') code = st.images.includes(a[2]) ? 0 : 1
else if (a[0] === 'tag') { if (!st.images.includes(a[1])) code = 1; else { st.images.push(a[2]); save() } }
else if (a[0] === 'build') { st.images.push('built'); save() }
else if (a[0] === 'stop') { if (!has(a[1])) code = 1; else { st.containers[a[1]] = false; save() } }
else if (a[0] === 'start') { if (!has(a[1])) code = 1; else { st.containers[a[1]] = true; save() } }
else if (a[0] === 'rename') { if (!has(a[1]) || has(a[2])) code = 1; else { st.containers[a[2]] = st.containers[a[1]]; delete st.containers[a[1]]; save() } }
else if (a[0] === 'rm') { delete st.containers[a[2]]; save() }
else if (a[0] === 'exec') code = 0
else if (a[0] === 'compose') { const i = a.indexOf('-p'); st.containers[process.env.FAKE_CONTAINER] = true; st.projects = (st.projects || []).concat(a[i + 1]); save() }
else code = 2
process.exit(code)
`

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'cwk-host-'))
  const bin = join(root, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), FAKE); chmodSync(join(bin, 'docker'), 0o755)
  const state = join(root, 'state.json'); const log = join(root, 'log.txt')
  writeFileSync(state, JSON.stringify({ containers: { 'worker-7': true }, images: ['ex-worker'] }))
  writeFileSync(log, '')
  const ctx = join(root, 'ctx'); mkdirSync(ctx)
  const team = {
    roles: {
      worker: {
        stateRepo: 'x', stateClone: join(root, 's'), dir: 'worker-{n}', workDir: root,
        runtime: { docker: { wsl: false, buildContext: ctx, dockerfile: 'Dockerfile', image: 'ex-worker', compose: 'compose.yml', composeProject: 'worker{n}', container: 'worker-{n}', env: { WORKER: '{n}' }, init: ['bash', '/opt/init.sh'] } },
      },
    },
    members: { 7: {} },
  }
  const teamFile = join(root, 'team.json'); writeFileSync(teamFile, JSON.stringify(team))
  const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, FAKE_LOG: log, FAKE_CONTAINER: 'worker-7', BASH_ENV: '' }
  const run = (...a) => spawnSync(process.execPath, [HOST, ...a, '--n', '7', '--team', teamFile], { encoding: 'utf8', env })
  const st = () => JSON.parse(readFileSync(state, 'utf8'))
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  return { root, run, st, calls }
}

const win = process.platform === 'win32' // the fake docker is a shebang script; host.mjs itself goes through WSL there
const mutating = c => /^(tag|build|stop|start|rename|rm|exec|compose)\b/.test(c)

test('plan (no --yes) only reads', { skip: win }, () => {
  const s = sandbox()
  const r = s.run('rebuild')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /\[plan\] docker tag ex-worker ex-worker:pre-/)
  assert.match(r.stdout, /\[plan\] docker rename worker-7 worker-7-old/)
  assert.match(r.stdout, /docker compose -p worker7-/)
  assert.deepEqual(s.calls().filter(mutating), [])
  assert.deepEqual(s.st().containers, { 'worker-7': true })
  assert.ok(!existsSync(join(s.root, '.claude-worker-kit', 'worker-7.json')))
})

test('rebuild --yes then rollback --yes: the old container and image are back', { skip: win }, () => {
  const s = sandbox()
  let r = s.run('rebuild', '--yes')
  assert.equal(r.status, 10, r.stderr + r.stdout) // stops for the user's Claude login
  assert.match(r.stdout, /Log in to Claude/)
  let st = s.st()
  assert.equal(st.containers['worker-7'], true)
  assert.equal(st.containers['worker-7-old'], false)
  assert.ok(st.images.some(i => i.startsWith('ex-worker:pre-')))
  assert.match(st.projects[0], /^worker7-\d{8}-\d{6}$/)
  assert.ok(s.calls().some(c => c === 'exec worker-7 bash /opt/init.sh'))

  r = s.run('rebuild', '--yes')
  assert.notEqual(r.status, 0, 'a second rebuild is refused while one is recorded')

  r = s.run('rollback') // plan first
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /\[plan\] docker rm -f worker-7/)
  assert.equal(s.st().containers['worker-7-old'], false, 'plan changes nothing')

  r = s.run('rollback', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  st = s.st()
  assert.deepEqual(st.containers, { 'worker-7': true })
  const tail = s.calls().slice(-4)
  assert.equal(tail[0], 'rm -f worker-7')
  assert.equal(tail[1], 'rename worker-7-old worker-7')
  assert.equal(tail[2], 'start worker-7')
  assert.match(tail[3], /^tag ex-worker:pre-\S+ ex-worker$/)
  assert.ok(!existsSync(join(s.root, '.claude-worker-kit', 'worker-7.json')))
})

test('a native member: each subcommand says why it does not apply, in its own words', () => {
  const root = mkdtempSync(join(tmpdir(), 'cwk-host-native-'))
  const teamFile = join(root, 'team.json')
  writeFileSync(teamFile, JSON.stringify({ roles: { worker: { workDir: root, runtime: { docker: { image: 'x', container: 'c', compose: 'c.yml', composeProject: 'p' } } } }, members: { 5: { runtime: { mode: 'native' } } } }))
  const run = sub => spawnSync(process.execPath, [HOST, sub, '--n', '5', '--team', teamFile], { encoding: 'utf8' })
  let r = run('status')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /no container to show/)
  assert.doesNotMatch(r.stderr, /rebuild/)
  r = run('rebuild')
  assert.match(r.stderr, /no container to rebuild; a native rebuild is a new work directory/)
})
