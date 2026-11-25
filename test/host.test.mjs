// host.mjs against a fake `docker` on PATH: the plan changes nothing; rebuild then rollback restores the old container and image;
// the rebuild record follows each step, and a failed step ($FAKE_FAIL names the docker command that fails) is rerun, resumed or rolled back.
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
if (process.env.FAKE_FAIL === a[0]) {
  if (a[0] === 'build') for (let i = 1; i <= 80; i++) console.log('build line ' + i)
  console.error('fake ' + a[0] + ' failure')
  process.exit(1)
}
const save = () => fs.writeFileSync(S, JSON.stringify(st))
const has = n => n in st.containers
let code = 0
if (a[0] === 'info') code = 0
else if (a[0] === 'container' && a[1] === 'inspect') {
  const n = a[a.length - 1]
  if (!has(n)) code = 1
  else if (a[2] === '-f' && a[3].includes('.Image')) console.log((st.imageOf || {})[n] || 'sha256:old')
  else if (a[2] === '-f' && a[3].includes('compose.project')) console.log((st.labels || {})[n] || '<no value>')
  else if (a[2] === '-f') console.log(String(st.containers[n]))
} else if (a[0] === 'image' && a[1] === 'inspect') code = st.images.includes(a[2]) ? 0 : 1
else if (a[0] === 'tag') { if (!st.images.includes(a[1]) && !a[1].startsWith('sha256:')) code = 1; else { st.images.push(a[2]); save() } }
else if (a[0] === 'cp') { const [src, dest] = [a[1], a[2]]; if (dest.includes(':/')) { const k = dest.indexOf(':/'), c = dest.slice(0, k), p = dest.slice(k + 1); if (!has(c)) code = 1; else { st.copied = st.copied || {}; st.copied[p] = fs.statSync(src).isDirectory() ? 'dir' : fs.readFileSync(src, 'utf8'); save() } } }
else if (a[0] === 'build') { st.images.push('built'); save() }
else if (a[0] === 'rmi') { if (!st.images.includes(a[1])) code = 1; else { st.images = st.images.filter(i => i !== a[1]); save() } }
else if (a[0] === 'stop') { if (!has(a[1])) code = 1; else { st.containers[a[1]] = false; save() } }
else if (a[0] === 'start') { if (!has(a[1])) code = 1; else { st.containers[a[1]] = true; save() } }
else if (a[0] === 'rename') { if (!has(a[1]) || has(a[2])) code = 1; else { st.containers[a[2]] = st.containers[a[1]]; delete st.containers[a[1]]; save() } }
else if (a[0] === 'rm') { delete st.containers[a[2]]; save() }
else if (a[0] === 'exec') {
  let i = 1, user = null
  let stdin = false
  for (; i < a.length && a[i].startsWith('-'); i++) { if (a[i] === '-u') user = a[++i]; else if (a[i] === '-w') i++; else if (a[i] === '-i') stdin = true }
  if (stdin && !process.env.FAKE_EXEC_RUN) { st.stdin = (st.stdin || []).concat(fs.readFileSync(0, 'latin1')); save() }
  const rest = a.slice(i + 1)
  st.copied = st.copied || {}
  if (rest[0] === 'rm') { delete st.copied[rest[rest.length - 1]]; save() }
  else if (rest[0] === 'bash' && rest[1] === '-l' && st.copied[rest[2]] !== undefined) {
    const text = st.copied[rest[2]]
    st.ran = (st.ran || []).concat({ user, text }); save()
    if (process.env.FAKE_EXEC_RUN) {
      const r = require('child_process').spawnSync('bash', ['-c', text], { stdio: 'inherit' })
      code = r.status ?? 1
    }
  } else if (process.env.FAKE_EXEC_RUN && rest[0] === 'test') code = require('child_process').spawnSync(rest[0], rest.slice(1)).status
}
else if (a[0] === 'compose') {
  const i = a.indexOf('-p'), c = process.env.FAKE_CONTAINER
  if (a.includes('down')) { delete st.containers[c]; st.downs = (st.downs || []).concat(a[i + 1]) }
  else { st.containers[c] = true; st.labels = { ...(st.labels || {}), [c]: a[i + 1] }; st.projects = (st.projects || []).concat(a[i + 1]) }
  save()
}
else code = 2
process.exit(code)
`

function sandbox(docker = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cwk-host-'))
  const bin = join(root, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'docker'), FAKE); chmodSync(join(bin, 'docker'), 0o755)
  const state = join(root, 'state.json'); const log = join(root, 'log.txt')
  writeFileSync(state, JSON.stringify({ containers: { 'worker-7': true }, images: ['ex-worker'], imageOf: { 'worker-7': 'sha256:old' }, labels: { 'worker-7': 'worker7' } }))
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nfor a; do u=$a; done\ncase $u in *slow*) printf "200 2048 20480";; *down*) echo "curl: (6) Could not resolve host"; printf "000 0 0";; *) printf "200 1048576 10485760";; esac\n')
  chmodSync(join(bin, 'curl'), 0o755)
  writeFileSync(log, '')
  const ctx = join(root, 'ctx'); mkdirSync(ctx)
  const team = {
    roles: {
      worker: {
        stateRepo: 'x', stateClone: join(root, 's'), dir: 'worker-{n}', workDir: root,
        runtime: { docker: { wsl: false, buildContext: ctx, dockerfile: 'Dockerfile', image: 'ex-worker', compose: 'compose.yml', composeProject: 'worker{n}', container: 'worker-{n}', env: { WORKER: '{n}' }, init: ['bash', '/opt/init.sh'], ...docker } },
      },
    },
    members: { 7: {} },
  }
  const teamFile = join(root, 'team.json'); writeFileSync(teamFile, JSON.stringify(team))
  const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, FAKE_STATE: state, FAKE_LOG: log, FAKE_CONTAINER: 'worker-7', BASH_ENV: '', WORKER_KIT_GH: '/bin/false', GIT_CONFIG_GLOBAL: '/dev/null' }
  const run = (...a) => spawnSync(process.execPath, [HOST, ...a, '--n', '7', '--team', teamFile], { encoding: 'utf8', env })
  const failing = (cmd, ...a) => spawnSync(process.execPath, [HOST, ...a, '--n', '7', '--team', teamFile], { encoding: 'utf8', env: { ...env, FAKE_FAIL: cmd } })
  const st = () => JSON.parse(readFileSync(state, 'utf8'))
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
  const recFile = join(root, '.claude-worker-kit', 'worker-7.json')
  const rec = () => (existsSync(recFile) ? JSON.parse(readFileSync(recFile, 'utf8')) : null)
  const runEnv = (extra, ...a) => spawnSync(process.execPath, [HOST, ...a, '--n', '7', '--team', teamFile], { encoding: 'utf8', env: { ...env, ...extra } })
  return { root, ctx, teamFile, run, runEnv, failing, st, calls, rec }
}

const win = process.platform === 'win32' // the fake docker is a shebang script; host.mjs itself goes through WSL there
const mutating = c => /^(tag|build|stop|start|rename|rm|exec|compose)\b/.test(c)

test('plan (no --yes) only reads', { skip: win }, () => {
  const s = sandbox()
  const r = s.run('rebuild')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /\[plan\] docker tag sha256:old ex-worker:pre-/, 'the image the container runs')
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

test('rebuild --yes: the record counts the steps done', { skip: win }, () => {
  const s = sandbox()
  const r = s.run('rebuild', '--yes')
  assert.equal(r.status, 10, r.stderr + r.stdout)
  const rec = s.rec()
  assert.equal(rec.done, 5)
  assert.equal(rec.failed, null)
  assert.equal(rec.oldContainer, 'worker-7-old')
  const st = s.run('status')
  assert.match(st.stdout, /5 of 5 steps done/)
  assert.match(st.stdout, /finish after acceptance \(deletes the record file only\), or rollback/)
})

test('a failed image build leaves the container untouched: tail of the build, network hint, rerun without clearing', { skip: win }, () => {
  const s = sandbox()
  let r = s.failing('build', 'rebuild', '--yes')
  assert.equal(r.status, 1, r.stderr + r.stdout)
  const tail = r.stdout.slice(r.stdout.indexOf('--- last lines of docker build'))
  assert.match(tail, /build line 80\n/)
  assert.match(tail, /build line 22\n[\s\S]*fake build failure\n---/, 'stderr is in the log too')
  assert.doesNotMatch(tail, /build line 21\n/, 'the last 60 lines only')
  assert.match(r.stdout, /network error[\s\S]*proxy/)
  assert.match(r.stderr, /step 2 \(build the image\) failed[\s\S]*not touched/)
  assert.deepEqual(s.st().containers, { 'worker-7': true })
  assert.deepEqual(s.st().images, ['ex-worker'], 'the pre- tag of the failed attempt is removed')
  const rec = s.rec()
  assert.equal(rec.done, 1)
  assert.equal(rec.failed.step, 2)
  assert.equal(rec.oldImage, null)

  r = s.run('status')
  assert.match(r.stdout, /1 of 5 steps done/)
  assert.match(r.stdout, /failed at step 2\. build the image: docker build failed/)
  assert.match(r.stdout, /not touched: rebuild again directly/)

  r = s.run('rebuild', '--yes')
  assert.equal(r.status, 10, r.stderr + r.stdout)
  assert.equal(s.rec().done, 5)
  assert.equal(s.st().containers['worker-7-old'], false)
})

test('a failure after the old container was stopped keeps the record: refused, then rollback brings it back', { skip: win }, () => {
  const s = sandbox()
  let r = s.failing('rename', 'rebuild', '--yes')
  assert.equal(r.status, 1, r.stderr + r.stdout)
  assert.match(r.stderr, /step 3 .* failed: docker rename failed/)
  assert.match(r.stderr, /rollback --n 7 .*--yes/)
  assert.match(r.stderr, /rebuild --n 7 .*--resume --yes/)
  assert.deepEqual(s.st().containers, { 'worker-7': false }, 'stopped, not renamed')
  assert.equal(s.rec().done, 2)
  assert.equal(s.rec().failed.step, 3)

  const before = s.calls().length
  r = s.run('rebuild', '--yes')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /after the old container was touched[\s\S]*rollback[\s\S]*--resume/)
  assert.deepEqual(s.calls().slice(before).filter(mutating), [], 'refused before any step')

  r = s.run('status')
  assert.match(r.stdout, /2 of 5 steps done[\s\S]*failed at step 3[\s\S]*rebuild --resume \(continues at step 3\)/)

  r = s.run('finish', '--yes')
  assert.equal(r.status, 1, 'an unfinished rebuild is not forgotten')

  r = s.run('rollback', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const st = s.st()
  assert.deepEqual(st.containers, { 'worker-7': true })
  assert.ok(s.calls().some(c => /^tag ex-worker:pre-\S+ ex-worker$/.test(c)), 'the old image tag is put back')
  assert.equal(s.rec(), null)
})

test('--resume continues at the failed step with the recorded project', { skip: win }, () => {
  const s = sandbox()
  let r = s.failing('compose', 'rebuild', '--yes')
  assert.equal(r.status, 1, r.stderr + r.stdout)
  const rec = s.rec()
  assert.equal(rec.done, 3)
  assert.equal(rec.failed.step, 4)
  assert.equal(s.st().containers['worker-7-old'], false)
  const before = s.calls().length

  r = s.run('rebuild', '--resume') // plan
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /from step 4/)
  assert.doesNotMatch(r.stdout, /^[123]\. /m)

  r = s.run('rebuild', '--resume', '--yes')
  assert.equal(r.status, 10, r.stderr + r.stdout)
  const after = s.calls().slice(before).filter(mutating)
  assert.equal(after.length, 2, after.join('\n'))
  assert.match(after[0], /^compose -p (\S+) /)
  assert.equal(after[0].match(/-p (\S+)/)[1], rec.project)
  assert.equal(after[1], 'exec worker-7 bash /opt/init.sh')
  assert.equal(s.rec().done, 5)
  assert.equal(s.rec().failed, null)
})

test('a failed init hook resumes at the init only', { skip: win }, () => {
  const s = sandbox()
  let r = s.failing('exec', 'rebuild', '--yes')
  assert.equal(r.status, 1, r.stderr + r.stdout)
  assert.equal(s.rec().done, 4)
  const before = s.calls().length
  r = s.run('rebuild', '--resume', '--yes')
  assert.equal(r.status, 10, r.stderr + r.stdout)
  assert.deepEqual(s.calls().slice(before).filter(mutating), ['exec worker-7 bash /opt/init.sh'])
})

test('--resume without a record, and a record from an older kit', { skip: win }, () => {
  const s = sandbox()
  let r = s.run('rebuild', '--resume', '--yes')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /nothing to resume/)
  mkdirSync(join(s.root, '.claude-worker-kit'))
  writeFileSync(join(s.root, '.claude-worker-kit', 'worker-7.json'), JSON.stringify({ container: 'worker-7', oldImage: null, project: 'worker7-x', oldContainer: null, at: 't' }))
  r = s.run('status')
  assert.match(r.stdout, /older kit: progress unknown/)
  r = s.run('rebuild', '--yes')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /finish or roll it back first/)
})

test('exec --root runs the command as the container\'s root', { skip: win }, () => {
  const s = sandbox()
  let r = s.run('exec', '--root', '--', 'apt-get update && apt-get install -y age')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const ran = s.st().ran
  assert.equal(ran.at(-1).user, 'root')
  assert.match(ran.at(-1).text, /^apt-get update && apt-get install -y age /)
  assert.deepEqual(s.st().copied, {}, 'the script is removed from the container afterwards')
  r = s.run('exec', '--', 'id')
  assert.equal(s.st().ran.at(-1).user, null)
})

test('step 1 tags the image the old container runs; the compose project is noted, and rollback puts the old one back', { skip: win }, () => {
  const s = sandbox()
  let r = s.run('rebuild', '--yes')
  assert.equal(r.status, 10, r.stderr + r.stdout)
  assert.ok(s.calls().some(c => /^tag sha256:old ex-worker:pre-\S+$/.test(c)), 'tagged by image ID, not ex-worker:latest')
  const rec = s.rec()
  assert.equal(rec.oldProject, 'worker7')
  const pf = join(s.root, '.claude-worker-kit', 'worker-7.project')
  assert.equal(readFileSync(pf, 'utf8').trim(), rec.project)
  r = s.run('status')
  assert.match(r.stdout, new RegExp(`compose project: ${rec.project} \\(from .*worker-7\\.project\\)`))

  r = s.run('down', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(s.st().downs, [rec.project])
  assert.ok(!s.calls().some(c => /down -v/.test(c)), 'never -v')
  r = s.run('up', '--yes')
  assert.equal(s.st().projects.at(-1), rec.project)

  r = s.run('rollback', '--yes')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(readFileSync(pf, 'utf8').trim(), 'worker7')
})

test('finish needs no --yes and deletes only the record file', { skip: win }, () => {
  const s = sandbox()
  s.run('rebuild', '--yes')
  const before = s.calls().length
  const r = s.run('finish')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /deleted the record file .*worker-7\.json \(only that file\)/)
  assert.equal(s.rec(), null)
  assert.deepEqual(s.calls().slice(before).filter(mutating), [], 'no docker command changes anything')
  assert.ok(existsSync(join(s.root, '.claude-worker-kit', 'worker-7.project')), 'the project note stays')
})

test('exec: $, quotes and {} reach bash as written; --file runs a script', { skip: win }, () => {
  const s = sandbox()
  const line = `printf '%s|' "$FOO" '{a,b}' "it's" $((1+2)); echo`
  let r = s.runEnv({ FAKE_EXEC_RUN: '1', FOO: 'bar' }, 'exec', '--', line)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /bar\|\{a,b\}\|it's\|3\|/)
  const f = join(s.root, 'script.sh')
  writeFileSync(f, 'echo from-file\nexit 3\n')
  r = s.runEnv({ FAKE_EXEC_RUN: '1' }, 'exec', '--file', f)
  assert.equal(r.status, 3)
  assert.match(r.stdout, /from-file/)
})

test('unseal: the master key goes in on stdin, never in the command line or the output', { skip: win }, () => {
  const s = sandbox()
  const keyFile = join(s.root, 'master.key')
  const KEY = `AGE-SECRET-KEY-1${'Q'.repeat(58)}\n`
  writeFileSync(keyFile, KEY)
  let r = s.run('unseal')
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /--identity <master key file/)
  r = s.run('unseal', '--identity', keyFile)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const st = s.st()
  assert.deepEqual(st.stdin, [KEY])
  assert.match(st.ran.at(-2).text, /^node \/opt\/worker-kit\/scripts\/secrets\.mjs unseal --role worker --n 7 --team \S+\/s\/team\.json --identity -\n$/)
  assert.match(st.ran.at(-1).text, /secrets\.mjs status/)
  for (const t of [r.stdout, r.stderr, s.calls().join('\n'), JSON.stringify(st.ran)]) assert.ok(!t.includes('AGE-SECRET-KEY-1Q'), 'key not shown')
})

test('build directory from buildRepo: cloned when missing, compared with the remote, fast-forwarded when clean', { skip: win }, () => {
  const g = (cwd, ...a) => { const x = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }); assert.equal(x.status, 0, x.stderr); return x.stdout.trim() }
  const base = mkdtempSync(join(tmpdir(), 'cwk-build-'))
  const bare = join(base, 'infra.git')
  g(base, 'init', '-q', '--bare', '-b', 'main', bare)
  const seed = join(base, 'seed')
  g(base, 'clone', '-q', bare, seed)
  writeFileSync(join(seed, 'Dockerfile'), 'FROM scratch\n')
  g(seed, 'add', '.'); g(seed, 'commit', '-qm', 'one'); g(seed, 'push', '-q', 'origin', 'HEAD:main')

  const s = sandbox({ buildContext: undefined, buildRepo: { url: bare, ref: 'main' } })
  const dir = join(s.root, '.claude-worker-kit', 'build', 'infra')
  let r = s.run('status')
  assert.match(r.stdout, /build directory .*infra: not there yet; rebuild clones/)
  r = s.run('rebuild', '--yes')
  assert.equal(r.status, 10, r.stderr + r.stdout)
  assert.ok(existsSync(join(dir, 'Dockerfile')), r.stdout)
  assert.ok(s.calls().some(c => c.startsWith('build ') ), 'built')
  s.run('finish')

  writeFileSync(join(seed, 'two'), '2\n'); g(seed, 'add', '.'); g(seed, 'commit', '-qm', 'two'); g(seed, 'push', '-q', 'origin', 'HEAD:main')
  r = s.run('status')
  assert.match(r.stdout, /1 commit\(s\) behind main; rebuild fast-forwards it/)

  // the user removed the old container after acceptance
  const st = s.st(); delete st.containers['worker-7-old']; writeFileSync(join(s.root, 'state.json'), JSON.stringify(st))

  writeFileSync(join(dir, 'Dockerfile'), 'FROM changed\n')
  r = s.run('rebuild', '--yes')
  assert.equal(r.status, 1, r.stderr + r.stdout)
  assert.match(r.stderr, /step 2 .*uncommitted changes.*not touched/)
  assert.ok(!existsSync(join(dir, 'two')), 'not fast-forwarded over local changes')
  spawnSync('git', ['-C', dir, 'checkout', '--', 'Dockerfile'])
  r = s.run('rebuild', '--yes') // the record of the failed attempt does not stop it
  assert.equal(r.status, 10, r.stderr + r.stdout)
  assert.ok(existsSync(join(dir, 'two')), 'fast-forwarded')
})

test('status probes the download speed from the docker host', { skip: win }, () => {
  const s = sandbox({ probe: [{ name: 'apt', url: 'https://deb.example/fast' }, { name: 'claude', url: 'https://dl.example/slow' }, { name: 'other', url: 'https://down.example/x' }] })
  const r = s.run('status')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /download apt: 1024 KB\/s \(HTTP 200/)
  assert.match(r.stdout, /download claude: 2 KB\/s .*too slow or refused.*proxy/)
  assert.match(r.stdout, /download other: failed \(curl: \(6\) Could not resolve host/)
})
