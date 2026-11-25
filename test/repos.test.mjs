// repos.mjs: the ROLE.md table, ssh Host blocks, deploy keys added with a fake gh, clones; for a native and a docker member.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseRepoTable, withSshBlocks } from '../scripts/lib/repos.mjs'
import { FAKE } from './fake-docker.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOS = join(ROOT, 'scripts', 'repos.mjs')
const win = process.platform === 'win32'

const TABLE = `# worker-7

## Environment

stuff

## Repositories

| repo | clone | key | host | access |
| --- | --- | --- | --- | --- |
| \`git@github.com:example-org/tool.git\` | /w/src/tool | /w/.ssh/tool | gh-tool | write |
| https://github.com/example-org/docs | /w/src/docs | /w/.ssh/docs |  | read |

## Flows
`

test('the ROLE.md table: columns by name, backticks stripped, access default write; no section → none', () => {
  assert.deepEqual(parseRepoTable(TABLE), [
    { repo: 'git@github.com:example-org/tool.git', clone: '/w/src/tool', key: '/w/.ssh/tool', host: 'gh-tool', access: 'write' },
    { repo: 'https://github.com/example-org/docs', clone: '/w/src/docs', key: '/w/.ssh/docs', host: null, access: 'read' },
  ])
  assert.deepEqual(parseRepoTable('# x\n\n## Other\n| a |\n'), [])
  assert.deepEqual(parseRepoTable('## Repositories\n\nnone yet\n\n## Next\n| repo | clone | key |\n|---|---|---|\n| a | b | c |\n'), [])
  assert.deepEqual(parseRepoTable('## repositories\n| key | repo | clone |\n|-|-|-|\n| k | r | c |\n'), [{ repo: 'r', clone: 'c', key: 'k', host: null, access: 'write' }])
  assert.throws(() => parseRepoTable('## Repositories\n| repo | clone |\n|---|---|\n| a | b |\n'), /missing "key"/)
  assert.throws(() => parseRepoTable('## Repositories\n| repo | clone | key |\n|---|---|---|\n| a |  | c |\n'), /has no clone/)
  assert.throws(() => parseRepoTable('## Repositories\n| repo | clone | key | access |\n|---|---|---|---|\n| a | b | c | admin |\n'), /read or write/)
})

test('ssh config: our block is added once and replaced, a Host written by hand is kept', () => {
  const rows = [{ host: 'gh-tool', key: '/w/.ssh/tool' }, { host: 'gh-x', key: '/w/.ssh/x' }]
  let r = withSshBlocks('Host gh-x\n  HostName github.com\n', rows)
  assert.ok(r.changed)
  assert.deepEqual(r.kept, ['gh-x'])
  assert.match(r.text, /^Host gh-x\n {2}HostName github\.com\n\n# >>> worker-kit: gh-tool\nHost gh-tool\n[\s\S]*IdentityFile \/w\/\.ssh\/tool\n[\s\S]*# <<< worker-kit: gh-tool\n$/)
  const again = withSshBlocks(r.text, rows)
  assert.equal(again.changed, false)
  const moved = withSshBlocks(r.text, [{ host: 'gh-tool', key: '/w/.ssh/tool2' }])
  assert.ok(moved.changed)
  assert.equal((moved.text.match(/Host gh-tool/g) ?? []).length, 1)
  assert.match(moved.text, /IdentityFile \/w\/\.ssh\/tool2/)
})

// fake gh: deploy keys per repo in $FAKE_GH_STATE, every call in $FAKE_GH_LOG
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs')
const S = process.env.FAKE_GH_STATE
const st = fs.existsSync(S) ? JSON.parse(fs.readFileSync(S, 'utf8')) : {}
const a = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_GH_LOG, a.join(' ') + '\\n')
if (a[0] === 'auth') process.exit(process.env.FAKE_GH_LOGGED_OUT ? 1 : 0)
if (a[0] === 'api') {
  const repo = a[1].match(/^repos\\/([^/]+\\/[^/?]+)\\/keys/)[1]
  if (a.includes('POST')) {
    const f = k => (a[a.indexOf('-f', a.findIndex(x => x.startsWith(k)) - 1) + 1] || '').slice(k.length + 1)
    const field = k => { const i = a.findIndex(x => x.startsWith(k + '=')); return a[i].slice(k.length + 1) }
    st[repo] = (st[repo] || []).concat({ title: field('title'), key: field('key'), read_only: field('read_only') === 'true' })
    fs.writeFileSync(S, JSON.stringify(st))
    console.log('{}')
  } else console.log(JSON.stringify(st[repo] || []))
  process.exit(0)
}
process.exit(2)
`

function sandbox({ docker = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cwk-repos-'))
  const bin = join(root, 'bin'); mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH); chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(bin, 'docker'), FAKE); chmodSync(join(bin, 'docker'), 0o755)
  const home = join(root, 'home'); mkdirSync(home)
  const w = join(root, 'w')
  const stateClone = join(w, 'state')
  // a local repo for the clone step
  const bare = join(root, 'local.git')
  spawnSync('git', ['init', '-q', '--bare', bare])
  mkdirSync(join(stateClone, 'worker-7'), { recursive: true })
  writeFileSync(join(stateClone, 'worker-7', 'ROLE.md'), `# worker-7\n\n## Repositories\n\n| repo | clone | key | host | access |\n| --- | --- | --- | --- | --- |\n| git@github.com:example-org/tool.git | ${w}/src/tool | ${w}/.ssh/tool | gh-tool | write |\n| https://github.com/example-org/docs.git | ${w}/src/docs | ${w}/.ssh/docs | | read |\n| ${bare} | ${w}/src/local | ${w}/.ssh/local | | write |\n`)
  // the two GitHub repos are "cloned" already, so the test needs no network
  for (const d of ['tool', 'docs']) mkdirSync(join(w, 'src', d, '.git'), { recursive: true })
  const worker = { stateRepo: 'git@github.com:example-org/state.git', stateClone, deployKey: join(w, '.ssh', 'state'), dir: 'worker-{n}', workDir: w }
  if (docker) worker.runtime = { docker: { wsl: false, image: 'ex', container: 'worker-{n}', compose: 'c.yml', composeProject: 'w{n}' } }
  const teamFile = join(root, 'team.json')
  writeFileSync(teamFile, JSON.stringify({ roles: { worker }, members: { 7: docker ? {} : { runtime: { mode: 'native' } } } }))
  // inside the member the team file is the one in the state repo
  writeFileSync(join(stateClone, 'team.json'), readFileSync(teamFile))
  const state = join(root, 'docker.json'); writeFileSync(state, JSON.stringify({ containers: { 'worker-7': true }, images: [] }))
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: '/dev/null', BASH_ENV: '',
    FAKE_GH_STATE: join(root, 'gh.json'), FAKE_GH_LOG: join(root, 'gh.log'), WORKER_KIT_GH: join(bin, 'gh'),
    FAKE_STATE: state, FAKE_LOG: join(root, 'docker.log'), FAKE_CONTAINER: 'worker-7', FAKE_EXEC_RUN: '1', WORKER_KIT_INSIDE: ROOT,
  }
  writeFileSync(env.FAKE_GH_LOG, ''); writeFileSync(env.FAKE_LOG, '')
  const run = (extra, ...a) => spawnSync(process.execPath, [REPOS, ...a, '--role', 'worker', '--n', '7', '--team', teamFile], { encoding: 'utf8', env: { ...env, ...extra } })
  const gh = () => (existsSync(env.FAKE_GH_STATE) ? JSON.parse(readFileSync(env.FAKE_GH_STATE, 'utf8')) : {})
  const ghCalls = () => readFileSync(env.FAKE_GH_LOG, 'utf8').trim().split('\n').filter(Boolean)
  return { root, home, w, run, gh, ghCalls }
}

for (const docker of [false, true]) {
  test(`keys then clone, ${docker ? 'a docker member (through docker exec)' : 'a native member'}: deploy keys added with the user's gh, ssh Host block, local clone`, { skip: win && 'shell fakes' }, () => {
    const s = sandbox({ docker })
    let r = s.run({}, 'keys')
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /\[plan\] make .*\.ssh\/state .*add its public key to example-org\/state as a writable deploy key "worker-7@/)
    assert.match(r.stdout, /example-org\/docs as a read-only deploy key/)
    assert.ok(!existsSync(join(s.w, '.ssh', 'state')), 'the plan makes no key')
    assert.deepEqual(s.gh(), {})

    r = s.run({ FAKE_GH_LOGGED_OUT: '1' }, 'keys', '--yes')
    assert.equal(r.status, 10, 'not logged in: the user runs gh auth login')
    assert.match(r.stdout, /! gh auth login/)

    r = s.run({}, 'keys', '--yes')
    assert.equal(r.status, 0, r.stderr + r.stdout)
    const keys = s.gh()
    assert.deepEqual(Object.keys(keys).sort(), ['example-org/docs', 'example-org/state', 'example-org/tool'])
    assert.equal(keys['example-org/state'][0].read_only, false)
    assert.equal(keys['example-org/docs'][0].read_only, true)
    assert.equal(keys['example-org/state'][0].key, readFileSync(join(s.w, '.ssh', 'state.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' '))
    assert.equal(statSync(join(s.w, '.ssh', 'state')).mode & 0o777, 0o600)
    for (const c of s.ghCalls()) assert.doesNotMatch(c, /PRIVATE KEY/)

    r = s.run({}, 'keys', '--yes')
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /example-org\/state: deploy key already there/)
    assert.equal(s.ghCalls().filter(c => c.includes('POST')).length, 3, 'nothing added twice')

    r = s.run({}, 'clone')
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /\[plan\] git clone/)
    assert.ok(!existsSync(join(s.w, 'src', 'local')))
    r = s.run({}, 'clone', '--yes')
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.ok(existsSync(join(s.w, 'src', 'local', '.git')))
    const cfg = readFileSync(join(s.home, '.ssh', 'config'), 'utf8')
    assert.match(cfg, new RegExp(`Host gh-tool\\n {2}HostName github\\.com\\n {2}User git\\n {2}IdentityFile ${s.w}/\\.ssh/tool`))
    assert.doesNotMatch(cfg, /docs/, 'no Host for a row without one')
  })
}

test('keys --state-only: before the state repo is cloned, only its key', { skip: win && 'shell fakes' }, () => {
  const s = sandbox()
  const r = s.run({}, 'keys', '--yes', '--state-only')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.deepEqual(Object.keys(s.gh()), ['example-org/state'])
})
