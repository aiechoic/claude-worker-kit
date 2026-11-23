// state.mjs against a local bare repository: restore → save → restore elsewhere, copy mode, the leader lock.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'

const win = process.platform === 'win32' // symlinks need developer mode there; Windows uses copy mode
import { fileURLToPath } from 'node:url'

const STATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'state.mjs')
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts })
const projName = p => p.replace(/[^A-Za-z0-9]/g, '-')

function sandbox(memory) {
  const root = mkdtempSync(join(tmpdir(), 'cwk-state-'))
  const bare = join(root, 'remote.git')
  sh('git', ['init', '-q', '--bare', '-b', 'main', bare])
  // seed the remote with one commit so clones have a branch to push to
  const seed = join(root, 'seed')
  sh('git', ['clone', '-q', bare, seed])
  writeFileSync(join(seed, 'README.md'), 'state\n')
  sh('git', ['-C', seed, 'add', '.'])
  sh('git', ['-C', seed, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init'])
  sh('git', ['-C', seed, 'push', '-q', 'origin', 'HEAD:main'])
  const mk = (name) => {
    const work = join(root, name, 'work')
    const claude = join(root, name, 'claude')
    mkdirSync(work, { recursive: true })
    const team = {
      roles: {
        leader: { stateRepo: bare, stateClone: join(root, name, 'state'), dir: 'leader', workDir: work, lock: true, memory },
        worker: { stateRepo: bare, stateClone: join(root, name, 'state'), dir: 'worker-{n}', workDir: work, memory },
      },
      members: { 7: {} },
    }
    const teamFile = join(root, name, 'team.json')
    writeFileSync(teamFile, JSON.stringify(team))
    const env = { ...process.env, CLAUDE_CONFIG_DIR: claude, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
    const run = (...a) => sh(process.execPath, [STATE, ...a, '--team', teamFile], { env })
    const mem = join(claude, 'projects', projName(work), 'memory')
    return { work, claude, mem, run, state: join(root, name, 'state') }
  }
  return { root, bare, mk }
}

test('restore links memory, merges what was there, imports ROLE.md; save round-trips to another machine', { skip: win }, () => {
  const s = sandbox('link')
  const a = s.mk('a')
  mkdirSync(a.mem, { recursive: true })
  writeFileSync(join(a.mem, 'old.md'), 'old memory\n')
  writeFileSync(join(a.work, 'CLAUDE.md'), '# manual\n')

  let r = a.run('restore', '--role', 'worker', '--n', '7')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(lstatSync(a.mem).isSymbolicLink())
  assert.equal(resolve(readlinkSync(a.mem)), join(a.state, 'worker-7', 'memory'))
  assert.equal(readFileSync(join(a.state, 'worker-7', 'memory', 'old.md'), 'utf8'), 'old memory\n')

  writeFileSync(join(a.state, 'worker-7', 'ROLE.md'), '# role\n')
  writeFileSync(join(a.mem, 'new.md'), 'new memory\n')
  r = a.run('restore', '--role', 'worker', '--n', '7') // second run: idempotent, now imports ROLE.md
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const manual = readFileSync(join(a.work, 'CLAUDE.md'), 'utf8')
  assert.ok(manual.includes(`@${join(a.state, 'worker-7', 'ROLE.md')}`))
  a.run('restore', '--role', 'worker', '--n', '7')
  assert.equal(readFileSync(join(a.work, 'CLAUDE.md'), 'utf8'), manual, 'import is added once')

  r = a.run('save', '--role', 'worker', '--n', '7', '-m', 'test')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /pushed/)

  const b = s.mk('b') // a fresh machine: nothing but the team file
  r = b.run('restore', '--role', 'worker', '--n', '7')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.equal(readFileSync(join(b.mem, 'new.md'), 'utf8'), 'new memory\n')
  assert.equal(readFileSync(join(b.mem, 'old.md'), 'utf8'), 'old memory\n')
  assert.ok(readFileSync(join(b.work, 'CLAUDE.md'), 'utf8').includes('ROLE.md'))
  const log = sh('git', ['-C', b.state, 'log', '--format=%s', '-1']).stdout.trim()
  assert.equal(log, 'worker-7: test')
})

test('copy mode (Windows): restore copies in, save copies back including deletions', () => {
  const s = sandbox('copy')
  const a = s.mk('a')
  assert.equal(a.run('restore', '--role', 'worker', '--n', '7').status, 0)
  assert.ok(!lstatSync(a.mem).isSymbolicLink())
  writeFileSync(join(a.mem, 'x.md'), 'x\n')
  writeFileSync(join(a.mem, 'y.md'), 'y\n')
  assert.equal(a.run('save', '--role', 'worker', '--n', '7').status, 0)
  assert.ok(existsSync(join(a.state, 'worker-7', 'memory', 'x.md')))
  assert.ok(!existsSync(join(a.state, 'worker-7', 'memory', '.state-repo-copy')), 'marker stays local')

  rmSync(join(a.mem, 'y.md'))
  assert.equal(a.run('save', '--role', 'worker', '--n', '7').status, 0)
  assert.ok(!existsSync(join(a.state, 'worker-7', 'memory', 'y.md')), 'deleted memory is deleted in the repo')

  const b = s.mk('b')
  assert.equal(b.run('restore', '--role', 'worker', '--n', '7').status, 0)
  assert.equal(readFileSync(join(b.mem, 'x.md'), 'utf8'), 'x\n')
  assert.ok(!existsSync(join(b.mem, 'y.md')))
})

test('leader lock: take, refuse a second holder, --force takes over, release', () => {
  const s = sandbox(win ? 'copy' : 'link')
  const a = s.mk('a')
  assert.equal(a.run('restore', '--role', 'leader').status, 0)
  let r = a.run('lock', '--role', 'leader', '--session', 'first')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const held = JSON.parse(readFileSync(join(a.state, 'leader', 'leader.lock'), 'utf8'))
  assert.equal(held.host, hostname())
  assert.equal(held.session, 'first')

  // taking it again from the same place is fine (restart of the same leader)
  assert.equal(a.run('lock', '--role', 'leader').status, 0)

  // another machine (different workDir counts as another place) is refused
  const b = s.mk('b')
  assert.equal(b.run('restore', '--role', 'leader').status, 0)
  r = b.run('lock', '--role', 'leader')
  assert.equal(r.status, 3, r.stdout + r.stderr)
  assert.match(r.stderr, /held by/)
  assert.match(r.stderr, /--force/)
  r = b.run('release', '--role', 'leader')
  assert.equal(r.status, 3, 'cannot release someone else\'s lock')

  // save refreshes the time but keeps the holder
  const before = JSON.parse(readFileSync(join(a.state, 'leader', 'leader.lock'), 'utf8'))
  assert.equal(a.run('save', '--role', 'leader').status, 0)
  const after = JSON.parse(readFileSync(join(a.state, 'leader', 'leader.lock'), 'utf8'))
  assert.equal(after.takenAt, before.takenAt)
  assert.ok(after.refreshedAt >= before.refreshedAt)

  r = b.run('lock', '--role', 'leader', '--force')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /taking the lock over/)
  r = a.run('lock', '--role', 'leader')
  assert.equal(r.status, 3, 'the old leader is now refused')

  assert.equal(b.run('release', '--role', 'leader').status, 0)
  assert.equal(a.run('lock', '--role', 'leader').status, 0, 'free again after release')
})

test('dry-run changes nothing', () => {
  const s = sandbox(win ? 'copy' : 'link')
  const a = s.mk('a')
  const r = a.run('restore', '--role', 'worker', '--n', '7', '--dry-run')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.ok(!existsSync(a.state))
  assert.ok(!existsSync(a.mem))
})

test('sessionState and roleFile: null (a leader whose manual and session state live in the repo root)', () => {
  const s = sandbox(win ? 'copy' : 'link')
  const a = s.mk('a')
  const VERIFY = STATE.replace('state.mjs', 'verify.mjs')
  // rewrite the team file: leader with dir ".", the manual inside the clone, session state under memory/
  const teamFile = join(dirname(a.work), 'team.json')
  const t = JSON.parse(readFileSync(teamFile, 'utf8'))
  Object.assign(t.roles.leader, { dir: '.', workDir: a.state, manual: 'CLAUDE.md', roleFile: null, sessionState: 'memory/session-state.md', lock: false })
  writeFileSync(teamFile, JSON.stringify(t))
  let r = a.run('restore', '--role', 'leader')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /no separate role file/)
  assert.ok(r.stdout.includes(join(a.state, 'memory', 'session-state.md')), 'restore points at sessionState')
  writeFileSync(join(a.state, 'CLAUDE.md'), '# leader manual\n')
  const env = { ...process.env, CLAUDE_CONFIG_DIR: a.claude }
  r = sh(process.execPath, [VERIFY, '--role', 'leader', '--team', teamFile, '--offline'], { env })
  assert.match(r.stdout, /❌ session state — .*memory[\\/]session-state\.md missing/)
  assert.match(r.stdout, /✅ manual — .*no separate role file/)
  writeFileSync(join(a.state, 'memory', 'session-state.md'), '# now\n')
  r = sh(process.execPath, [VERIFY, '--role', 'leader', '--team', teamFile, '--offline'], { env })
  assert.match(r.stdout, /✅ session state/)
  assert.ok(!/ROLE\.md/.test(r.stdout))
})

// ── copy mode: restore mirrors, unsaved local changes stop it, save is three-way ──
function copyPair() {
  const s = sandbox('copy')
  const a = s.mk('a'); const b = s.mk('b')
  assert.equal(a.run('restore', '--role', 'worker', '--n', '7').status, 0)
  writeFileSync(join(a.mem, 'keep.md'), 'keep\n')
  writeFileSync(join(a.mem, 'gone.md'), 'gone\n')
  assert.equal(a.run('save', '--role', 'worker', '--n', '7').status, 0)
  assert.equal(b.run('restore', '--role', 'worker', '--n', '7').status, 0)
  return { a, b }
}

test('copy restore deletes what the repo deleted (mirror)', () => {
  const { a, b } = copyPair()
  rmSync(join(b.mem, 'gone.md'))
  assert.equal(b.run('save', '--role', 'worker', '--n', '7').status, 0)
  const r = a.run('restore', '--role', 'worker', '--n', '7')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(!existsSync(join(a.mem, 'gone.md')), 'deleted in the repo ⇒ deleted here')
  assert.equal(a.run('save', '--role', 'worker', '--n', '7').status, 0)
  assert.ok(!existsSync(join(a.state, 'worker-7', 'memory', 'gone.md')), 'and the next save does not bring it back')
})

test('copy restore stops on local changes made after the last save; --force discards them', () => {
  const { a } = copyPair()
  writeFileSync(join(a.mem, 'keep.md'), 'edited here, not saved\n')
  writeFileSync(join(a.mem, 'fresh.md'), 'new here\n')
  rmSync(join(a.mem, 'gone.md'))
  let r = a.run('restore', '--role', 'worker', '--n', '7')
  assert.equal(r.status, 10, r.stdout + r.stderr)
  assert.match(r.stdout, /changed keep\.md/)
  assert.match(r.stdout, /new\s+fresh\.md/)
  assert.match(r.stdout, /deleted gone\.md/)
  assert.match(r.stdout, /run save first/)
  assert.equal(readFileSync(join(a.mem, 'keep.md'), 'utf8'), 'edited here, not saved\n', 'nothing overwritten before the user picks')
  r = a.run('restore', '--role', 'worker', '--n', '7', '--force')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(readFileSync(join(a.mem, 'keep.md'), 'utf8'), 'keep\n')
  assert.ok(!existsSync(join(a.mem, 'fresh.md')))
  assert.ok(existsSync(join(a.mem, 'gone.md')))
})

test('copy restore into a memory directory it did not create: stops, --adopt takes the local files in', () => {
  const s = sandbox('copy')
  const a = s.mk('a')
  mkdirSync(a.mem, { recursive: true })
  writeFileSync(join(a.mem, 'mine.md'), 'written before restore\n')
  let r = a.run('restore', '--role', 'worker', '--n', '7')
  assert.equal(r.status, 10, r.stdout + r.stderr)
  assert.match(r.stdout, /not created by restore/)
  assert.match(r.stdout, /--adopt/)
  r = a.run('restore', '--role', 'worker', '--n', '7', '--adopt')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(readFileSync(join(a.state, 'worker-7', 'memory', 'mine.md'), 'utf8'), 'written before restore\n')
  assert.equal(a.run('save', '--role', 'worker', '--n', '7').status, 0)
  const b = s.mk('b')
  assert.equal(b.run('restore', '--role', 'worker', '--n', '7').status, 0)
  assert.equal(readFileSync(join(b.mem, 'mine.md'), 'utf8'), 'written before restore\n')
})

test('copy save keeps what another machine saved; both sides changed ⇒ stop, --force keeps local', () => {
  const { a, b } = copyPair()
  writeFileSync(join(b.mem, 'keep.md'), 'from b\n')
  assert.equal(b.run('save', '--role', 'worker', '--n', '7').status, 0)
  writeFileSync(join(a.mem, 'other.md'), 'a adds a file\n')
  let r = a.run('save', '--role', 'worker', '--n', '7') // a never touched keep.md: b's version must survive
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(readFileSync(join(a.state, 'worker-7', 'memory', 'keep.md'), 'utf8'), 'from b\n')
  assert.equal(readFileSync(join(a.mem, 'keep.md'), 'utf8'), 'from b\n', 'and it is copied here too')
  assert.ok(existsSync(join(a.state, 'worker-7', 'memory', 'other.md')))

  writeFileSync(join(b.mem, 'keep.md'), 'b again\n')
  assert.equal(b.run('restore', '--role', 'worker', '--n', '7', '--force').status, 0) // b picks up a's file, discards its edit
  writeFileSync(join(b.mem, 'keep.md'), 'b again\n')
  assert.equal(b.run('save', '--role', 'worker', '--n', '7').status, 0)
  writeFileSync(join(a.mem, 'keep.md'), 'a differently\n')
  r = a.run('save', '--role', 'worker', '--n', '7')
  assert.equal(r.status, 10, r.stdout + r.stderr)
  assert.match(r.stdout, /changed both here and in the repo/)
  assert.match(r.stdout, /keep\.md/)
  r = a.run('save', '--role', 'worker', '--n', '7', '--force')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(readFileSync(join(a.state, 'worker-7', 'memory', 'keep.md'), 'utf8'), 'a differently\n')
})

test('line endings: CRLF and LF copies of the same text are the same file; clones get core.autocrlf=input', () => {
  const s = sandbox('copy')
  const a = s.mk('a')
  assert.equal(a.run('restore', '--role', 'worker', '--n', '7').status, 0)
  assert.equal(sh('git', ['-C', a.state, 'config', 'core.autocrlf']).stdout.trim(), 'input')
  // the repo holds CRLF (as a clone with core.autocrlf=true would), Claude Code wrote the same text with LF
  const repoMem = join(a.state, 'worker-7', 'memory')
  writeFileSync(join(repoMem, 'same.md'), 'line one\r\nline two\r\n')
  writeFileSync(join(a.mem, 'same.md'), 'line one\nline two\n')
  rmSync(join(a.mem, '.state-repo-copy')) // a directory restore did not create: the --adopt listing case
  let r = a.run('restore', '--role', 'worker', '--n', '7')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.doesNotMatch(r.stdout, /changed\s+same\.md/)
  // a real difference is still one
  writeFileSync(join(a.mem, 'same.md'), 'line one\nline 2\n')
  r = a.run('restore', '--role', 'worker', '--n', '7')
  assert.equal(r.status, 10, r.stdout + r.stderr)
  assert.match(r.stdout, /changed same\.md/)
})
