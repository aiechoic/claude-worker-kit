// The leader's restore: the "## Repositories" section of the manual (roleFile: null), repos and the state repo cloned
// over https with the gh login (the token never in argv, output or files), setup steps, host.mjs for a leader container
// (its own record, a running leader is not stopped, gh-login), verify's GitHub check, and the whole flow from nothing
// with a temporary state repo and the fake docker.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseRepoTable } from '../scripts/lib/repos.mjs'
import { FAKE } from './fake-docker.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const S = name => join(ROOT, 'scripts', name)
const win = process.platform === 'win32'
const TOKEN = 'gho_FAKEtoken0123456789abcdefSECRET'
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()

// fake gh: logged in, `auth token` prints $FAKE_GH_TOKEN, `auth login --with-token` checks the token on stdin,
// `api -i user` shows $FAKE_GH_SCOPES, `api repos/o/r` admin from $FAKE_GH_ADMIN; every call in $FAKE_GH_LOG
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs')
const a = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, a.join(' ') + '\\n')
if (a[0] === 'auth' && a[1] === 'token') { process.stdout.write(process.env.FAKE_GH_TOKEN + '\\n'); process.exit(0) }
if (a[0] === 'auth' && a[1] === 'login') {
  const got = fs.readFileSync(0, 'utf8').trim()
  fs.appendFileSync(process.env.FAKE_GH_LOG, 'login-with-token ' + (got === process.env.FAKE_GH_TOKEN ? 'matches' : 'differs') + '\\n')
  process.exit(got ? 0 : 1)
}
if (a[0] === 'auth') { if (a[1] === 'status') console.log('github.com: Logged in (token: gho_****)'); process.exit(0) }
if (a[0] === 'api' && a[1] === '-i') { console.log('HTTP/2.0 200 OK\\nX-Oauth-Scopes: ' + (process.env.FAKE_GH_SCOPES ?? 'gist, read:org, repo') + '\\n\\n{}'); process.exit(0) }
if (a[0] === 'api' && /^repos\\/[^/]+\\/[^/]+$/.test(a[1])) { console.log(JSON.stringify({ permissions: { admin: process.env.FAKE_GH_ADMIN !== '0' } })); process.exit(0) }
if (a[0] === 'api') { console.log('[]'); process.exit(0) }
process.exit(2)
`
// git wrapper: logs every argv, and whether the token reached it through $GH_TOKEN (never the value itself)
const fakeGit = real => `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GIT_LOG"
[ -n "$GH_TOKEN" ] && { [ "$GH_TOKEN" = "$FAKE_GH_TOKEN" ] && echo "GH_TOKEN=match" >> "$FAKE_GIT_LOG" || echo "GH_TOKEN=other" >> "$FAKE_GIT_LOG"; }
exec ${real} "$@"
`

const git = (cwd, ...a) => spawnSync(REAL_GIT, a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
/** A bare repo with one commit holding the given files. */
function bareRepo(path, files) {
  const work = `${path}-work`
  mkdirSync(work, { recursive: true })
  for (const [f, text] of Object.entries(files)) { mkdirSync(dirname(join(work, f)), { recursive: true }); writeFileSync(join(work, f), text) }
  git(work, 'init', '-q', '-b', 'main')
  git(work, 'add', '-A')
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@x.example', 'commit', '-q', '-m', 'init')
  spawnSync(REAL_GIT, ['clone', '-q', '--bare', work, path], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
}
/** Every file under dir whose bytes contain the token. */
function filesWithToken(dir) {
  const hits = []
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const st = statSync(p, { throwIfNoEntry: false })
      if (!st) continue
      if (st.isDirectory()) walk(p)
      else if (st.size < 4 * 1024 * 1024 && readFileSync(p).includes(TOKEN)) hits.push(p)
    }
  }
  walk(dir)
  return hits
}

const ROLE_TABLE = `| repo | clone | key | host | access |
| --- | --- | --- | --- | --- |`

/**
 * A sandbox: remotes under <root>/remotes reached as https://github.com/example-org/<name>.git (git insteadOf),
 * fake gh / git / docker on PATH. leader: the role (merged into a team file written to <root>/team.json and the state repo).
 */
function sandbox({ leader, docker = false, stateFiles = {}, remotes = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'cwk-leader-'))
  const bin = join(root, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH); chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(bin, 'git'), fakeGit(REAL_GIT)); chmodSync(join(bin, 'git'), 0o755)
  writeFileSync(join(bin, 'docker'), FAKE); chmodSync(join(bin, 'docker'), 0o755)
  const home = join(root, 'home'); mkdirSync(home)
  const R = join(root, 'remotes'); mkdirSync(R)
  const team = { version: 1, roles: { leader: leader(root) } }
  for (const [name, files] of Object.entries(remotes)) bareRepo(join(R, `${name}.git`), files)
  bareRepo(join(R, 'leader-state.git'), { 'team.json': JSON.stringify(team, null, 2), ...stateFiles })
  const teamFile = join(root, 'team.json'); writeFileSync(teamFile, JSON.stringify(team, null, 2))
  const state = join(root, 'docker.json'); writeFileSync(state, JSON.stringify({ containers: {}, images: [] }))
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', BASH_ENV: '',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${R}/.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/example-org/',
    FAKE_GH_TOKEN: TOKEN, FAKE_GH_LOG: join(root, 'gh.log'), FAKE_GIT_LOG: join(root, 'git.log'), WORKER_KIT_GH: join(bin, 'gh'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    FAKE_STATE: state, FAKE_LOG: join(root, 'docker.log'), FAKE_CONTAINER: 'leader', WORKER_KIT_INSIDE: ROOT, KIT: ROOT,
    ...(docker ? { FAKE_EXEC_RUN: '1' } : {}),
  }
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.WORKER
  for (const f of ['gh.log', 'git.log', 'docker.log']) writeFileSync(join(root, f), '')
  const transcript = []
  const run = (script, a, { extra = {}, input } = {}) => {
    const res = spawnSync(process.execPath, [S(script), ...a], { encoding: 'utf8', env: { ...env, ...extra }, input })
    transcript.push(`$ node ${script} ${a.map(x => (/[\s"'$]/.test(x) ? JSON.stringify(x) : x)).join(' ').replaceAll(root, '$T')}\n${`${res.stdout}${res.stderr}`.replaceAll(root, '$T').trimEnd()}\n(exit ${res.status})\n`)
    return res
  }
  const read = f => readFileSync(join(root, f), 'utf8')
  return { root, home, teamFile, env, run, read, transcript, st: () => JSON.parse(readFileSync(state, 'utf8')) }
}
/** The token appears in no argv, no output and no file. */
function assertNoToken(s, outputs, { except = [] } = {}) {
  for (const o of outputs) assert.ok(!`${o.stdout}${o.stderr}`.includes(TOKEN), 'token in the output')
  for (const f of ['git.log', 'docker.log']) assert.ok(!s.read(f).includes(TOKEN), `token in ${f} (an argument)`)
  assert.ok(!s.read('gh.log').includes(TOKEN), 'token in a gh argument')
  assert.deepEqual(filesWithToken(s.root).filter(f => !except.includes(f)), [], 'token written to a file')
}

test('the Repositories table: key may be empty (https with gh), a host needs a key; no section → none', () => {
  assert.deepEqual(parseRepoTable(`## Repositories\n${ROLE_TABLE}\n| git@github.com:o/app.git | /w/app |  |  |  |\n`), [{ repo: 'git@github.com:o/app.git', clone: '/w/app', key: null, host: null, access: 'write' }])
  assert.throws(() => parseRepoTable(`## Repositories\n${ROLE_TABLE}\n| git@github.com:o/app.git | /w/app |  | gh-app |  |\n`), /host but no key/)
  assert.deepEqual(parseRepoTable('# leader manual\n\n## Rules\n\nnone\n'), [])
})

const nativeLeader = (extra = {}) => root => ({
  stateRepo: 'git@github.com:example-org/leader-state.git', stateClone: join(root, 'lead'), dir: '.', roleFile: null,
  workDir: join(root, 'lead'), manual: 'CLAUDE.md', lock: true, runtime: { mode: 'native' }, ...extra,
})

test('native leader without deploy keys: the state repo and the manual\'s repos cloned over https with the gh login; the token stays in $GH_TOKEN', { skip: win && 'shell fakes' }, () => {
  const s = sandbox({
    leader: nativeLeader(),
    stateFiles: { 'CLAUDE.md': `# leader\n\n## Repositories\n\n${ROLE_TABLE}\n| git@github.com:example-org/app.git | ${'$T'}/src/app |  |  |  |\n` },
    remotes: { app: { 'README.md': 'app\n' } },
  })
  // the table names its clone dir with the sandbox root
  const outs = []
  let r = s.run('state.mjs', ['clone', '--repo', 'git@github.com:example-org/leader-state.git', '--to', join(s.root, 'lead')]); outs.push(r)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /cloned https:\/\/github\.com\/example-org\/leader-state\.git → .* \(https, with the gh login\)/)
  const manual = join(s.root, 'lead', 'CLAUDE.md')
  writeFileSync(manual, readFileSync(manual, 'utf8').replace('$T', s.root))
  r = s.run('repos.mjs', ['keys', '--role', 'leader', '--team', s.teamFile, '--yes']); outs.push(r)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /no deploy key; cloned over https with the gh login/)
  assert.doesNotMatch(s.read('gh.log'), /POST/, 'no deploy key added')
  r = s.run('repos.mjs', ['clone', '--role', 'leader', '--team', s.teamFile]); outs.push(r)
  assert.match(r.stdout, /\[plan\] git clone -q https:\/\/github\.com\/example-org\/app\.git .*\(https with the gh login\)/)
  r = s.run('repos.mjs', ['clone', '--role', 'leader', '--team', s.teamFile, '--yes']); outs.push(r)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(existsSync(join(s.root, 'src', 'app', 'README.md')))
  // the remote is the plain https URL: later fetches use the member's own git credentials (gh auth setup-git)
  assert.equal(git(join(s.root, 'src', 'app'), 'config', '--get', 'remote.origin.url').stdout.trim(), 'https://github.com/example-org/app.git')
  assert.equal(git(join(s.root, 'src', 'app'), 'config', '--get-all', 'credential.helper').stdout.trim(), '', 'the token helper is not kept in the clone')
  assert.equal((s.read('git.log').match(/GH_TOKEN=match/g) ?? []).length, 2, 'the token reached both clones through $GH_TOKEN')
  assertNoToken(s, outs)
})

test('no gh login and no deploy key: exit 10 naming host.mjs gh-login and ! gh auth login', { skip: win && 'shell fakes' }, () => {
  const s = sandbox({ leader: nativeLeader() })
  const r = s.run('state.mjs', ['clone', '--repo', 'git@github.com:example-org/leader-state.git', '--to', join(s.root, 'lead')], { extra: { WORKER_KIT_GH: '/nonexistent/gh' } })
  assert.equal(r.status, 10, r.stdout + r.stderr)
  assert.match(r.stdout, /host\.mjs gh-login/)
  assert.match(r.stdout, /! gh auth login/)
})

test('setup: check passes → skipped; run then check; the first failing step is named by number and stops the rest; the plan runs nothing', { skip: win && 'shell fakes' }, () => {
  const s = sandbox({
    leader: root => nativeLeader({
      setup: [
        { name: 'already there', check: 'true', run: 'echo SHOULD-NOT-RUN; exit 1' },
        { name: 'workspace file', check: 'test -f made.txt', run: 'echo "$WORKER_KIT_ROLE" > made.txt' },
        { name: 'broken', check: 'false', run: 'exit 7' },
        { name: 'after', run: 'touch after.txt' },
      ],
    })(root),
  })
  mkdirSync(join(s.root, 'lead'))
  let r = s.run('repos.mjs', ['setup', '--role', 'leader', '--team', s.teamFile])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /\[plan\] setup 2 of 4 "workspace file": run/)
  assert.ok(!existsSync(join(s.root, 'lead', 'made.txt')))
  r = s.run('repos.mjs', ['setup', '--role', 'leader', '--team', s.teamFile, '--yes'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /setup 1 of 4 "already there": in place/)
  assert.doesNotMatch(r.stdout, /SHOULD-NOT-RUN/)
  assert.equal(readFileSync(join(s.root, 'lead', 'made.txt'), 'utf8'), 'leader\n')
  assert.match(r.stderr, /setup 3 of 4 "broken" failed \(exit 7\); the steps after it did not run/)
  assert.ok(!existsSync(join(s.root, 'lead', 'after.txt')))
})

test('verify: the gh login lacks a scope or admin rights → named, with gh auth refresh; no token printed', { skip: win && 'shell fakes' }, () => {
  const s = sandbox({ leader: nativeLeader({ gh: { scopes: ['repo', 'read:org'], admin: ['git@github.com:example-org/workers.git'] } }) })
  s.run('state.mjs', ['clone', '--repo', 'git@github.com:example-org/leader-state.git', '--to', join(s.root, 'lead')])
  let r = s.run('verify.mjs', ['--role', 'leader', '--team', s.teamFile, '--offline'], { extra: { FAKE_GH_SCOPES: 'gist' } })
  assert.match(r.stdout, /GitHub login.*lacks the scope\(s\) repo, read:org: run {2}gh auth refresh -h github\.com -s repo,read:org/)
  r = s.run('verify.mjs', ['--role', 'leader', '--team', s.teamFile, '--offline'], { extra: { FAKE_GH_SCOPES: 'repo, admin:org', FAKE_GH_ADMIN: '0' } })
  assert.match(r.stdout, /no admin rights on example-org\/workers/)
  r = s.run('verify.mjs', ['--role', 'leader', '--team', s.teamFile, '--offline'])
  assert.match(r.stdout, /✅.*GitHub login.*scopes gist, read:org, repo/)
  assertNoToken(s, [r])
})

const dockerLeader = (extra = {}) => root => ({
  ...nativeLeader()(root), dir: 'leader', roleFile: 'ROLE.md', runtime: {
    docker: { wsl: false, image: 'ex-leader', container: 'leader', compose: 'compose.yml', composeProject: 'leader', buildContext: join(root, 'ctx'), workDir: join(root, 'lead') },
  }, ...extra,
})

test('host.mjs --role leader: its record is its own file next to a worker\'s; a record of another member under the same name stops', { skip: win && 'shell fakes' }, () => {
  const s = sandbox({ leader: dockerLeader() })
  mkdirSync(join(s.root, 'ctx'))
  const team = JSON.parse(readFileSync(s.teamFile, 'utf8'))
  team.roles.worker = { stateRepo: 'x', stateClone: join(s.root, 'w'), dir: 'worker-{n}', workDir: s.root, runtime: { docker: { wsl: false, image: 'ex-worker', container: 'worker-{n}', compose: 'c.yml', composeProject: 'worker{n}', buildContext: join(s.root, 'ctx') } } }
  team.members = { 7: {} }
  writeFileSync(s.teamFile, JSON.stringify(team))
  writeFileSync(s.env.FAKE_STATE, JSON.stringify({ containers: { leader: false, 'worker-7': true }, images: [] }))
  const L = s.run('host.mjs', ['rebuild', '--role', 'leader', '--team', s.teamFile, '--yes', '--skip-build'])
  assert.equal(L.status, 10, L.stdout + L.stderr)
  assert.match(L.stdout, /leader\.md#leader-in-a-container/)
  const W = s.run('host.mjs', ['rebuild', '--n', '7', '--team', s.teamFile, '--yes', '--skip-build'], { extra: { FAKE_CONTAINER: 'worker-7' } })
  assert.equal(W.status, 10, W.stdout + W.stderr)
  const dir = join(s.home, '.claude-worker-kit')
  const lr = JSON.parse(readFileSync(join(dir, 'leader.json'), 'utf8'))
  const wr = JSON.parse(readFileSync(join(dir, 'worker-7.json'), 'utf8'))
  assert.equal(lr.member, 'leader'); assert.equal(lr.container, 'leader'); assert.match(lr.project, /^leader-/)
  assert.equal(wr.member, 'worker-7'); assert.equal(wr.container, 'worker-7'); assert.match(wr.project, /^worker7-/)
  assert.equal(readFileSync(join(dir, 'leader.project'), 'utf8').trim(), lr.project)
  assert.equal(readFileSync(join(dir, 'worker-7.project'), 'utf8').trim(), wr.project)
  // a worker configured with the leader's container name finds the leader's record and stops
  team.roles.worker.runtime.docker.container = 'leader'
  writeFileSync(s.teamFile, JSON.stringify(team))
  const clash = s.run('host.mjs', ['status', '--n', '7', '--team', s.teamFile])
  assert.notEqual(clash.status, 0)
  assert.match(clash.stderr, /is the rebuild record of leader, not worker-7: two members share the container name leader/)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'leader.json'), 'utf8')), lr, 'the leader\'s record is untouched')
})

test('host.mjs: a running leader container is not stopped (rebuild, rollback, down) without --stop-running', { skip: win && 'shell fakes' }, () => {
  const s = sandbox({ leader: dockerLeader() })
  mkdirSync(join(s.root, 'ctx'))
  writeFileSync(s.env.FAKE_STATE, JSON.stringify({ containers: { leader: true }, images: ['ex-leader'] }))
  for (const a of [['rebuild', '--yes', '--skip-build'], ['down', '--yes']]) {
    const r = s.run('host.mjs', [...a, '--role', 'leader', '--team', s.teamFile])
    assert.equal(r.status, 10, r.stdout + r.stderr)
    assert.match(r.stdout, /leader is running, and it may be the live leader.*Nothing was changed/s)
    assert.equal(s.st().containers.leader, true)
  }
  assert.doesNotMatch(s.read('docker.log'), /^(stop|rm|rename|compose)/m)
  const plan = s.run('host.mjs', ['rebuild', '--role', 'leader', '--team', s.teamFile])
  assert.equal(plan.status, 0, plan.stdout + plan.stderr)
  assert.match(plan.stderr + plan.stdout, /may be the live leader: with --yes the rebuild stops unless --stop-running/)
  const go = s.run('host.mjs', ['rebuild', '--role', 'leader', '--team', s.teamFile, '--yes', '--skip-build', '--stop-running'])
  assert.equal(go.status, 10, go.stdout + go.stderr) // stops for the Claude login only
  assert.equal(s.st().containers['leader-old'], false)
  // the new leader runs now: rolling back would remove it
  let rb = s.run('host.mjs', ['rollback', '--role', 'leader', '--team', s.teamFile, '--yes'])
  assert.equal(rb.status, 10, rb.stdout + rb.stderr)
  assert.equal(s.st().containers.leader, true)
  rb = s.run('host.mjs', ['rollback', '--role', 'leader', '--team', s.teamFile, '--yes', '--stop-running'])
  assert.equal(rb.status, 0, rb.stdout + rb.stderr)
  assert.equal(s.st().containers['leader-old'], undefined)
})

test('host.mjs gh-login: the token goes in on stdin, never in a docker argument or the output', { skip: win && 'shell fakes' }, () => {
  const s = sandbox({ leader: dockerLeader() })
  writeFileSync(s.env.FAKE_STATE, JSON.stringify({ containers: { leader: true }, images: [] }))
  const plan = s.run('host.mjs', ['gh-login', '--role', 'leader', '--team', s.teamFile])
  assert.equal(plan.status, 0, plan.stdout + plan.stderr)
  assert.deepEqual(s.st().stdin ?? [], [], 'the plan passes nothing')
  const r = s.run('host.mjs', ['gh-login', '--role', 'leader', '--team', s.teamFile, '--yes'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(s.st().stdin, [`${TOKEN}\n`])
  assert.match(s.st().ran.at(-1).text, /gh auth login --hostname github\.com --with-token && gh auth setup-git/)
  // the fake docker's state file is the stand-in for the container: it records the stdin the container received
  assertNoToken(s, [r], { except: [s.env.FAKE_STATE] })
})

/**
 * The whole leader flow, from nothing, in a docker container (fake docker runs the inside scripts here): rebuild,
 * copy-kit, gh-login, state repo cloned with gh (no deploy key), lock (held elsewhere: exit 3 until the user confirms),
 * restore, keys, clone, setup, verify. LEADER_FLOW_OUT=<file> writes the commands and their output.
 */
test('the leader flow from nothing, in a container, with a temporary state repo', { skip: win && 'shell fakes' }, () => {
  const T = '$T'
  const s = sandbox({
    docker: true,
    leader: root => dockerLeader({
      setup: [{ name: 'workspace file', check: 'test -f workspace.txt', run: `bash ${join(root, 'lead', 'leader', 'tools', 'workspace.sh')}` }],
      gh: { scopes: ['repo', 'read:org'] },
    })(root),
    stateFiles: {
      'leader/ROLE.md': `# leader\n\n## Repositories\n\n${ROLE_TABLE}\n| git@github.com:example-org/app.git | ${T}/src/app |  |  | write |\n| git@github.com:example-org/lib.git | ${T}/src/lib |  |  | write |\n`,
      'leader/session-state.md': 'nothing open\n',
      'leader/tools/workspace.sh': 'set -e\nls -d ../src/* > workspace.txt\necho "workspace.txt lists $(wc -l < workspace.txt) repos"\n',
      'leader/leader.lock': JSON.stringify({ host: 'old-pc', user: 'u', workDir: '/old', takenAt: '2026-01-01T00:00:00Z' }),
      'CLAUDE.md': '# leader manual\n',
    },
    remotes: { app: { 'README.md': 'app\n' }, lib: { 'README.md': 'lib\n' } },
  })
  // the ROLE.md in the remote names $T: put the sandbox path in (the remote is the user's; this edits the test fixture)
  const fix = join(s.root, 'remotes', 'leader-state.git-work')
  writeFileSync(join(fix, 'leader', 'ROLE.md'), readFileSync(join(fix, 'leader', 'ROLE.md'), 'utf8').replaceAll(T, s.root))
  spawnSync(REAL_GIT, ['-C', fix, '-c', 'user.name=t', '-c', 'user.email=t@x.example', 'commit', '-q', '-am', 'paths'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  spawnSync(REAL_GIT, ['-C', fix, 'push', '-q', join(s.root, 'remotes', 'leader-state.git'), 'main'], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
  mkdirSync(join(s.root, 'ctx'))

  const L = ['--role', 'leader', '--team', s.teamFile]
  const inner = join(s.root, 'lead', 'team.json')
  const outs = []
  const step = (script, a, want, opts) => { const r = s.run(script, a, opts); outs.push(r); assert.equal(r.status, want, `${script} ${a.join(' ')}\n${r.stdout}${r.stderr}`); return r }
  const exec = (line, want) => step('host.mjs', ['exec', ...L, '--', line], want)

  step('host.mjs', ['status', ...L], 0)
  step('host.mjs', ['rebuild', ...L, '--yes', '--skip-build'], 10) // stops for the Claude login in the container (user step 3)
  step('host.mjs', ['copy-kit', ...L, '--yes'], 0)
  step('host.mjs', ['gh-login', ...L, '--yes'], 0)
  assert.match(s.read('gh.log'), /login-with-token matches/)
  step('repos.mjs', ['keys', ...L, '--state-only', '--yes'], 0) // no deploy key: nothing to add
  exec(`node $KIT/scripts/state.mjs clone --repo git@github.com:example-org/leader-state.git --to ${join(s.root, 'lead')}`, 0)
  const held = exec(`node $KIT/scripts/state.mjs lock --role leader --team ${inner} --session leader@docker-host`, 3)
  assert.match(held.stderr, /held by old-pc/)
  // the user confirms old-pc is gone
  exec(`node $KIT/scripts/state.mjs lock --role leader --team ${inner} --session leader@docker-host --force`, 0)
  const restored = exec(`node $KIT/scripts/state.mjs restore --role leader --team ${inner}`, 0)
  assert.match(restored.stdout, /repos in .*ROLE\.md/)
  assert.match(restored.stdout, /setup steps of the team file \(workspace file\)/)
  step('repos.mjs', ['keys', ...L, '--yes'], 0)
  step('repos.mjs', ['clone', ...L, '--yes'], 0)
  step('repos.mjs', ['setup', ...L, '--yes'], 0)
  step('repos.mjs', ['setup', ...L, '--yes'], 0) // again: in place
  assert.ok(existsSync(join(s.root, 'src', 'app', 'README.md')) && existsSync(join(s.root, 'src', 'lib', 'README.md')))
  assert.equal(readFileSync(join(s.root, 'lead', 'workspace.txt'), 'utf8').trim().split('\n').length, 2)
  const v = exec(`node $KIT/scripts/verify.mjs --role leader --team ${inner} --offline`, 0)
  for (const c of ['state repo cloned', 'leader lock held here', 'repos cloned', 'setup 1: workspace file', 'GitHub login']) assert.match(v.stdout, new RegExp(`✅.*${c}`))
  exec(`node $KIT/scripts/state.mjs save --role leader --team ${inner} -m "leader restored in a container"`, 0)
  // a second rebuild while this leader runs: refused, nothing stopped
  step('host.mjs', ['finish', ...L], 0)
  step('host.mjs', ['rebuild', ...L, '--yes', '--skip-build'], 10)
  assert.equal(s.st().containers.leader, true)
  assertNoToken(s, outs)
  if (process.env.LEADER_FLOW_OUT) appendFileSync(process.env.LEADER_FLOW_OUT, s.transcript.join('\n'))
})
