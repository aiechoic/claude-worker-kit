// secrets.mjs with the official age tool: seal on one machine → unseal on a new one, byte for byte;
// a wrong master key or a tampered file writes nothing; status and seal never show a credential.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SECRETS = join(ROOT, 'scripts', 'secrets.mjs')
const STATE = join(ROOT, 'scripts', 'state.mjs')
const win = process.platform === 'win32'
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })
const hasAge = sh('age', ['--version']).status === 0 && sh('age-keygen', ['--version']).status === 0
const skip = hasAge ? false : 'age / age-keygen not installed (winget install FiloSottile.age, or apt install age)'

// credentials with bytes that a text round trip would break: no trailing newline, CR LF, NUL, non-UTF-8
const APP_SECRET = Buffer.from('appsecret-example-0123456789abcdef')
const MODEL_KEY = Buffer.concat([Buffer.from('model-key-example\r\n'), Buffer.from([0, 0xff, 0xfe, 0x80, 0x0a])])

function machine(root, name, recipient, stateClone, n = 7) {
  const home = join(root, name)
  const creds = join(home, 'creds')
  mkdirSync(home, { recursive: true })
  const team = {
    secretsRecipient: recipient,
    roles: {
      worker: {
        stateRepo: join(root, 'remote.git'),
        stateClone: stateClone ?? join(home, 'state'),
        dir: 'worker-{n}',
        workDir: home,
        channel: { appSecretFile: join(creds, 'app-secret') },
        secrets: [
          { name: 'bot App Secret', path: '{channel.appSecretFile}', by: 'user', sealed: true },
          { name: 'model key', id: 'model', path: join(creds, 'nested', 'model.key'), by: 'user', sealed: true },
          { name: 'GitHub login', check: 'gh auth status', by: 'user' },
        ],
      },
    },
    members: { 7: {}, 8: {} },
  }
  const teamFile = join(home, 'team.json')
  writeFileSync(teamFile, JSON.stringify(team))
  const env = { ...process.env, CLAUDE_CONFIG_DIR: join(home, 'claude'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
  const run = (script, args, opts = {}) => spawnSync(process.execPath, [script, ...args, '--role', 'worker', '--n', String(n), '--team', teamFile], { encoding: 'utf8', env, ...opts })
  return {
    home, creds, teamFile,
    state: join(team.roles.worker.stateClone, `worker-${n}`),
    appSecret: join(creds, 'app-secret'),
    modelKey: join(creds, 'nested', 'model.key'),
    secrets: (args, opts) => run(SECRETS, args, opts),
    stateCmd: (args, opts) => run(STATE, args, opts),
  }
}

/** The member's state clone as a git repository, so seal / unseal keep their record in its .git. */
function gitInit(m) {
  const clone = dirname(m.state)
  mkdirSync(clone, { recursive: true })
  assert.equal(sh('git', ['init', '-q', clone]).status, 0)
  return clone
}

function setup({ git = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cwk-secrets-'))
  const keyFile = join(root, 'master.key')
  const kg = sh(process.execPath, [SECRETS, 'keygen', '--out', keyFile])
  assert.equal(kg.status, 0, kg.stderr + kg.stdout)
  const recipient = kg.stdout.match(/age1[0-9a-z]{58}/)[0]
  assert.doesNotMatch(kg.stdout + kg.stderr, /AGE-SECRET-KEY/, 'keygen does not print the master key')
  if (!win) assert.equal(statSync(keyFile).mode & 0o777, 0o600)
  const a = machine(root, 'a', recipient)
  mkdirSync(join(a.creds, 'nested'), { recursive: true })
  writeFileSync(a.appSecret, APP_SECRET)
  writeFileSync(a.modelKey, MODEL_KEY)
  if (git) gitInit(a)
  return { root, keyFile, recipient, a }
}

/** A new machine: the sealed files arrive with the state repo, the credentials are not there yet. */
function newMachine(s, name = 'b') {
  const b = machine(s.root, name, s.recipient)
  gitInit(b)
  cpSync(join(s.a.state, 'secrets'), join(b.state, 'secrets'), { recursive: true })
  return b
}

const leftovers = dir => existsSync(dir) ? readdirSync(dir, { recursive: true }).filter(f => /\.tmp-/.test(String(f))) : []

test('seal on one machine, unseal on a new one: byte for byte, mode 600, master key from stdin or a file', { skip }, () => {
  const s = setup()
  const sealed = s.a.secrets(['seal'])
  assert.equal(sealed.status, 0, sealed.stderr + sealed.stdout)
  assert.ok(existsSync(join(s.a.state, 'secrets', 'app-secret.age')))
  assert.ok(existsSync(join(s.a.state, 'secrets', 'model.age')))
  assert.ok(!readFileSync(join(s.a.state, 'secrets', 'app-secret.age')).includes(APP_SECRET), 'sealed file holds no plaintext')

  const b = newMachine(s)
  const r = b.secrets(['unseal', '--identity', '-'], { input: readFileSync(s.keyFile) })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(readFileSync(b.appSecret), APP_SECRET)
  assert.deepEqual(readFileSync(b.modelKey), MODEL_KEY)
  if (!win) {
    assert.equal(statSync(b.appSecret).mode & 0o777, 0o600)
    assert.equal(statSync(b.modelKey).mode & 0o777, 0o600)
  }
  assert.deepEqual(leftovers(b.creds), [])
  assert.doesNotMatch(r.stdout + r.stderr, /AGE-SECRET-KEY|appsecret-example|model-key-example/)

  const c = newMachine(s, 'c')
  const rf = c.secrets(['unseal', '--identity', s.keyFile])
  assert.equal(rf.status, 0, rf.stderr + rf.stdout)
  assert.deepEqual(readFileSync(c.modelKey), MODEL_KEY)

  // a key pasted from a password manager: only the key line, with spaces and CR LF around it
  const d = newMachine(s, 'd')
  const line = readFileSync(s.keyFile, 'utf8').split('\n').find(l => l.startsWith('AGE-SECRET-KEY-1'))
  const rc = d.secrets(['unseal', '--identity', '-'], { input: `  ${line}  \r\n` })
  assert.equal(rc.status, 0, rc.stderr + rc.stdout)
  assert.deepEqual(readFileSync(d.appSecret), APP_SECRET)

  // PowerShell's Get-Clipboard | node … puts a UTF-8 BOM in front
  const e = newMachine(s, 'e')
  const rb = e.secrets(['unseal', '--identity', '-'], { input: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${line}\r\n`)]) })
  assert.equal(rb.status, 0, rb.stderr + rb.stdout)
  assert.deepEqual(readFileSync(e.modelKey), MODEL_KEY)

  // unsealed files count as unchanged for the next seal, whatever the file times say
  const past = new Date(Date.now() - 60_000)
  utimesSync(join(b.state, 'secrets', 'model.age'), past, past)
  const again = b.secrets(['seal'])
  assert.equal(again.status, 0)
  assert.match(again.stdout, /unchanged since the last seal: app-secret, model/)
})

test('a wrong master key or a tampered file writes nothing, not even the files that did decrypt', { skip }, () => {
  const s = setup()
  assert.equal(s.a.secrets(['seal']).status, 0)

  const otherKey = join(s.root, 'other.key')
  assert.equal(sh('age-keygen', ['-o', otherKey]).status, 0)
  const b = newMachine(s)
  const wrong = b.secrets(['unseal', '--identity', '-'], { input: readFileSync(otherKey) })
  assert.notEqual(wrong.status, 0)
  assert.match(wrong.stderr, /cannot unseal .*Nothing was written/)
  assert.ok(!existsSync(b.appSecret) && !existsSync(b.modelKey))
  assert.deepEqual(leftovers(b.home), [])

  const notAKey = b.secrets(['unseal', '--identity', '-'], { input: 'not a key\n' })
  assert.notEqual(notAKey.status, 0)
  assert.match(notAKey.stderr, /not an age identity/)
  assert.ok(!existsSync(b.appSecret))

  // app-secret.age is fine, model.age is damaged in its last chunk: app-secret must not be written either
  const damaged = join(b.state, 'secrets', 'model.age')
  const bytes = readFileSync(damaged)
  bytes[bytes.length - 3] ^= 0x01
  writeFileSync(damaged, bytes)
  const tampered = b.secrets(['unseal', '--identity', '-'], { input: readFileSync(s.keyFile) })
  assert.notEqual(tampered.status, 0)
  assert.match(tampered.stderr, /model key/)
  assert.ok(!existsSync(b.appSecret) && !existsSync(b.modelKey))
  assert.deepEqual(leftovers(b.home), [])
})

test('status and seal name credentials but never show them; seal skips unchanged files and reseals changed ones', { skip }, () => {
  const s = setup()
  const before = s.a.secrets(['status'])
  assert.equal(before.status, 0, before.stderr)
  assert.match(before.stdout, /app-secret: bot App Secret .* local: present {3}sealed: not yet/)
  assert.match(before.stdout, /model: model key .* local: present {3}sealed: not yet/)

  const first = s.a.secrets(['seal'])
  assert.match(first.stdout, /sealed: app-secret, model/)
  const after = s.a.secrets(['status'])
  assert.match(after.stdout, /sealed: in the repo/)
  for (const out of [before, first, after]) assert.doesNotMatch(out.stdout + out.stderr, /appsecret-example|model-key-example|AGE-SECRET-KEY/)

  const second = s.a.secrets(['seal'])
  assert.match(second.stdout, /unchanged since the last seal: app-secret, model/)
  const old = readFileSync(join(s.a.state, 'secrets', 'model.age'))
  // a changed credential is sealed again even when its time is older than the .age
  writeFileSync(s.a.modelKey, 'model-key-example-rotated')
  const past = new Date(Date.now() - 60_000)
  utimesSync(s.a.modelKey, past, past)
  const third = s.a.secrets(['seal'])
  assert.match(third.stdout, /sealed: model/)
  assert.match(third.stdout, /unchanged since the last seal: app-secret/)
  assert.ok(!readFileSync(join(s.a.state, 'secrets', 'model.age')).equals(old))
})

test('unseal keeps a different credential already in place unless --force', { skip }, () => {
  const s = setup()
  assert.equal(s.a.secrets(['seal']).status, 0)
  const b = newMachine(s)
  mkdirSync(b.creds, { recursive: true })
  writeFileSync(b.appSecret, 'appsecret-example-local')
  const kept = b.secrets(['unseal', '--identity', '-'], { input: readFileSync(s.keyFile) })
  assert.equal(kept.status, 0, kept.stderr)
  assert.match(kept.stdout, /kept: app-secret/)
  assert.equal(readFileSync(b.appSecret, 'utf8'), 'appsecret-example-local')
  assert.deepEqual(readFileSync(b.modelKey), MODEL_KEY)

  const forced = b.secrets(['unseal', '--identity', '-', '--force'], { input: readFileSync(s.keyFile) })
  assert.equal(forced.status, 0, forced.stderr)
  assert.deepEqual(readFileSync(b.appSecret), APP_SECRET)
})

test('bad team file entries are refused before anything runs; a dot file gets an id without the dot', { skip }, () => {
  const s = setup()
  const team = JSON.parse(readFileSync(s.a.teamFile, 'utf8'))
  team.roles.worker.secrets.push({ name: 'dot file', path: join(s.a.creds, '.example-token'), sealed: true })
  writeFileSync(s.a.teamFile, JSON.stringify(team))
  const st = s.a.secrets(['status'])
  assert.equal(st.status, 0, st.stderr)
  assert.match(st.stdout, /example-token: dot file .* local: missing/)
  team.roles.worker.secrets.pop()
  team.roles.worker.secrets.push({ name: 'same id', path: join(s.a.creds, 'other', 'app-secret'), sealed: true })
  writeFileSync(s.a.teamFile, JSON.stringify(team))
  const dup = s.a.secrets(['seal'])
  assert.notEqual(dup.status, 0)
  assert.match(dup.stderr, /id "app-secret" is used twice/)

  team.roles.worker.secrets.pop()
  team.secretsRecipient = 'not-a-key'
  writeFileSync(s.a.teamFile, JSON.stringify(team))
  const bad = s.a.secrets(['seal'])
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /secretsRecipient must be an age public key/)
})

test('state.mjs save seals changed credentials and commits them with *.age binary; restore elsewhere points at unseal; the next save adds nothing', { skip: skip || (win && 'state round trip is covered on Linux') }, () => {
  const s = setup({ git: false })
  const bare = join(s.root, 'remote.git')
  sh('git', ['init', '-q', '--bare', '-b', 'main', bare])
  const seed = join(s.root, 'seed')
  sh('git', ['clone', '-q', bare, seed])
  writeFileSync(join(seed, 'README.md'), 'state\n')
  sh('git', ['-C', seed, 'add', '.'])
  sh('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init'])
  sh('git', ['-C', seed, 'push', '-q', 'origin', 'HEAD:main'])

  assert.equal(s.a.stateCmd(['restore']).status, 0)
  const saved = s.a.stateCmd(['save', '-m', 'creds'])
  assert.equal(saved.status, 0, saved.stderr + saved.stdout)
  assert.match(saved.stdout, /sealed: app-secret, model/)
  const files = sh('git', ['-C', join(s.root, 'a', 'state'), 'ls-files']).stdout
  assert.match(files, /worker-7\/secrets\/app-secret\.age/)
  assert.match(files, /worker-7\/secrets\/model\.age/)
  assert.match(files, /^\.gitattributes$/m)
  assert.match(readFileSync(join(s.root, 'a', 'state', '.gitattributes'), 'utf8'), /^\*\.age binary$/m)
  const attr = sh('git', ['-C', join(s.root, 'a', 'state'), 'check-attr', 'binary', 'worker-7/secrets/model.age']).stdout
  assert.match(attr, /binary: set/)

  const b = machine(s.root, 'b', s.recipient)
  const restored = b.stateCmd(['restore'])
  assert.equal(restored.status, 0, restored.stderr + restored.stdout)
  assert.match(restored.stdout, /sealed credentials \(app-secret, model\): .*secrets\.mjs unseal/)
  assert.match(restored.stdout, /GitHub login/)
  assert.doesNotMatch(restored.stdout, /bot App Secret: /, 'a sealed credential is not listed again to fill by hand')
  const r = b.secrets(['unseal', '--identity', '-'], { input: readFileSync(s.keyFile) })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(readFileSync(b.modelKey), MODEL_KEY)

  // the new machine's first save seals nothing and commits nothing
  const head = sh('git', ['-C', join(s.root, 'b', 'state'), 'rev-parse', 'HEAD']).stdout
  const bSaved = b.stateCmd(['save', '-m', 'first save'])
  assert.equal(bSaved.status, 0, bSaved.stderr + bSaved.stdout)
  assert.doesNotMatch(bSaved.stdout, /sealed:/)
  assert.equal(sh('git', ['-C', join(s.root, 'b', 'state'), 'rev-parse', 'HEAD']).stdout, head)
})

test('seal does not overwrite a .age this clone did not seal, or a newer one sealed on another machine, unless --force', { skip }, () => {
  const s = setup()
  assert.equal(s.a.secrets(['seal']).status, 0)

  // b got the same credentials by hand, not by unseal: the .age in the repo is not this clone's
  const b = newMachine(s)
  mkdirSync(join(b.creds, 'nested'), { recursive: true })
  writeFileSync(b.appSecret, APP_SECRET)
  writeFileSync(b.modelKey, MODEL_KEY)
  const before = readFileSync(join(b.state, 'secrets', 'model.age'))
  const foreign = b.secrets(['seal'])
  assert.equal(foreign.status, 0, foreign.stderr)
  assert.match(foreign.stdout, /already sealed, but not by this clone: app-secret, model/)
  assert.ok(readFileSync(join(b.state, 'secrets', 'model.age')).equals(before))
  assert.match(b.secrets(['seal', '--force']).stdout, /sealed: app-secret, model/)

  // c unsealed; then a rotates the model key and seals; c pulls that .age: c's unchanged copy does not win
  const c = newMachine(s, 'c')
  assert.equal(c.secrets(['unseal', '--identity', '-'], { input: readFileSync(s.keyFile) }).status, 0)
  writeFileSync(s.a.modelKey, 'model-key-example-rotated')
  assert.match(s.a.secrets(['seal']).stdout, /sealed: model/)
  cpSync(join(s.a.state, 'secrets', 'model.age'), join(c.state, 'secrets', 'model.age'))
  const elsewhere = c.secrets(['seal'])
  assert.match(elsewhere.stdout, /sealed again on another machine, local copy unchanged: model/)
  assert.match(elsewhere.stdout, /unchanged since the last seal: app-secret/)
  assert.ok(readFileSync(join(c.state, 'secrets', 'model.age')).equals(readFileSync(join(s.a.state, 'secrets', 'model.age'))))
})

test('check-public flags an age master key and a committed .age file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cwk-public-'))
  sh('git', ['init', '-q', dir])
  writeFileSync(join(dir, 'notes.md'), `key: AGE-SECRET-KEY-1${'Q'.repeat(58)}\n`)
  writeFileSync(join(dir, 'app-secret.age'), 'sealed bytes\n')
  sh('git', ['-C', dir, 'add', '.'])
  const r = sh(process.execPath, [join(ROOT, 'scripts', 'check-public.mjs')], { cwd: dir })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /notes\.md:1: age master key/)
  assert.match(r.stdout, /app-secret\.age: sealed credential file/)
})

test('without age, seal and unseal stop for the user with how to install it', () => {
  const root = mkdtempSync(join(tmpdir(), 'cwk-noage-'))
  const a = machine(root, 'a', `age1${'q'.repeat(58)}`)
  const env = { ...process.env, WORKER_KIT_AGE: join(root, 'no-such-age'), WORKER_KIT_AGE_KEYGEN: join(root, 'no-such-age-keygen') }
  for (const args of [['seal'], ['unseal', '--identity', '-']]) {
    const r = a.secrets(args, { env, input: '' })
    assert.equal(r.status, 10, r.stderr + r.stdout)
    assert.match(r.stdout, /age .*not on PATH/)
    assert.match(r.stdout, win ? /winget install FiloSottile\.age/ : /apt install age/)
  }
  const st = a.secrets(['status'], { env })
  assert.equal(st.status, 0)
  assert.match(st.stdout, /age: not installed/)
})

test('a .gitattributes written by seal does not stop the next pull when another member already pushed one', { skip: skip || (win && 'state round trip is covered on Linux') }, () => {
  const s = setup({ git: false })
  const bare = join(s.root, 'remote.git')
  sh('git', ['init', '-q', '--bare', '-b', 'main', bare])
  const seed = join(s.root, 'seed')
  sh('git', ['clone', '-q', bare, seed])
  writeFileSync(join(seed, 'README.md'), 'state\n')
  sh('git', ['-C', seed, 'add', '.'])
  sh('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init'])
  sh('git', ['-C', seed, 'push', '-q', 'origin', 'HEAD:main'])

  // worker 8 on machine b clones first; then worker 7 on machine a seals and pushes .gitattributes
  const b = machine(s.root, 'b', s.recipient, undefined, 8)
  assert.equal(b.stateCmd(['restore']).status, 0)
  mkdirSync(join(b.creds, 'nested'), { recursive: true })
  writeFileSync(b.appSecret, 'appsecret-example-worker8')
  writeFileSync(b.modelKey, 'model-key-example-worker8')
  assert.equal(s.a.stateCmd(['restore']).status, 0)
  assert.equal(s.a.stateCmd(['save', '-m', 'a creds']).status, 0)

  // b seals by hand: an untracked .gitattributes appears, with one line of b's own
  const sealed = b.secrets(['seal'])
  assert.match(sealed.stdout, /added "\*\.age binary"/)
  const bClone = join(s.root, 'b', 'state')
  writeFileSync(join(bClone, '.gitattributes'), '*.age binary\n*.example-bin binary\n')
  const saved = b.stateCmd(['save', '-m', 'b creds'])
  assert.equal(saved.status, 0, saved.stderr + saved.stdout)
  assert.doesNotMatch(saved.stdout + saved.stderr, /pull failed|would be overwritten/)

  const check = join(s.root, 'check')
  sh('git', ['clone', '-q', bare, check])
  const attrs = readFileSync(join(check, '.gitattributes'), 'utf8')
  assert.equal(attrs.match(/^\*\.age binary$/gm).length, 1, attrs)
  assert.match(attrs, /^\*\.example-bin binary$/m)
  const files = sh('git', ['-C', check, 'ls-files']).stdout
  assert.match(files, /worker-7\/secrets\/model\.age/)
  assert.match(files, /worker-8\/secrets\/model\.age/)
})
