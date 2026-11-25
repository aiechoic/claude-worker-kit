// channel.mjs place / capture / allow on files only (no clone, no npm).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const CH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'channel.mjs')

function sandbox({ secret = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cwk-ch-'))
  const me = join(root, 'state', 'worker-7')
  mkdirSync(join(me, 'tools', 'feishu-channel'), { recursive: true })
  const secretFile = join(root, 'creds', 'app-secret')
  if (secret) { mkdirSync(dirname(secretFile), { recursive: true }); writeFileSync(secretFile, 'not-a-real-secret') }
  const live = join(root, 'live', 'config.json')
  const team = {
    roles: { worker: { stateRepo: 'x', stateClone: join(root, 'state'), dir: 'worker-{n}', workDir: root, bot: { appId: 'cli_example7', profile: 'p7' }, channel: { repo: 'x', checkout: join(root, 'co'), config: live, saved: 'tools/feishu-channel/config.json', appSecretFile: secretFile } } },
    members: { 7: {} },
  }
  const teamFile = join(root, 'team.json'); writeFileSync(teamFile, JSON.stringify(team))
  const run = (...a) => spawnSync(process.execPath, [CH, ...a, '--n', '7', '--team', teamFile], { encoding: 'utf8' })
  return { root, me, live, secretFile, run, saved: join(me, 'tools', 'feishu-channel', 'config.json') }
}

test('capture drops an inline secret; place puts the config back with appSecretFile and the scopes file', () => {
  const s = sandbox()
  mkdirSync(dirname(s.live), { recursive: true })
  writeFileSync(join(dirname(s.live), 'scopes.json'), '["im:message"]')
  writeFileSync(s.live, JSON.stringify({ appId: 'cli_example7', appSecret: 'inline-should-not-travel', allow: ['ou_example'], expectedScopesFile: join(dirname(s.live), 'scopes.json') }))
  let r = s.run('capture')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const saved = JSON.parse(readFileSync(s.saved, 'utf8'))
  assert.ok(!('appSecret' in saved))
  assert.ok(!readFileSync(s.saved, 'utf8').includes('inline-should-not-travel'))
  assert.ok(existsSync(join(dirname(s.saved), 'scopes.json')))

  // a new machine: nothing live yet
  rmSync(dirname(s.live), { recursive: true, force: true })
  r = s.run('place')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const live = JSON.parse(readFileSync(s.live, 'utf8'))
  assert.equal(live.appSecretFile, s.secretFile)
  assert.equal(live.expectedScopesFile, join(dirname(s.live), 'scopes.json'))
  assert.ok(existsSync(live.expectedScopesFile))
  assert.ok(!r.stdout.includes('not-a-real-secret'), 'secret is never printed')
})

test('place stops for the user when the secret file is missing', () => {
  const s = sandbox({ secret: false })
  writeFileSync(s.saved, JSON.stringify({ appId: 'cli_example7', allow: ['ou_example'] }))
  const r = s.run('place')
  assert.equal(r.status, 10, r.stderr + r.stdout)
  assert.match(r.stdout, /needs you/)
})

test('place refuses a saved config with an inline secret or another appId', () => {
  const s = sandbox()
  writeFileSync(s.saved, JSON.stringify({ appId: 'cli_example7', appSecret: 'x', allow: [] }))
  assert.notEqual(s.run('place').status, 0)
  writeFileSync(s.saved, JSON.stringify({ appId: 'cli_other', allow: [] }))
  assert.notEqual(s.run('place').status, 0)
})

test('allow adds to both the live and the saved config, once', () => {
  const s = sandbox()
  mkdirSync(dirname(s.live), { recursive: true })
  for (const p of [s.live, s.saved]) writeFileSync(p, JSON.stringify({ appId: 'cli_example7', allow: ['ou_example'] }))
  assert.equal(s.run('allow', 'cli_exampleboss', '--name', 'leader').status, 0)
  assert.equal(s.run('allow', 'cli_exampleboss').status, 0)
  for (const p of [s.live, s.saved]) {
    const c = JSON.parse(readFileSync(p, 'utf8'))
    assert.deepEqual(c.allow, ['ou_example', 'cli_exampleboss'])
    assert.equal(c.names.cli_exampleboss, 'leader')
  }
})

test('capture writes back only portable fields that changed, in place; place-time paths stay as saved', () => {
  const s = sandbox()
  const savedText = '{\n    "appId": "cli_example7",\n    "appSecretFile": "/saved/path/secret",\n    "allow": ["ou_example", "cli_exampleboss"],\n    "stateDir": "/saved/state",\n    "name": "w7"\n}\n'
  writeFileSync(s.saved, savedText)
  assert.equal(s.run('place').status, 0)
  // place set this machine's paths; nothing portable changed ⇒ capture leaves the file byte-for-byte alone
  let r = s.run('capture')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /already matches/)
  assert.equal(readFileSync(s.saved, 'utf8'), savedText)

  // a portable change (a new sender, a new field) plus a different local stateDir
  const live = JSON.parse(readFileSync(s.live, 'utf8'))
  live.allow.push('cli_examplenew'); live.timezone = 'UTC'; live.stateDir = '/this/machine/state'
  writeFileSync(s.live, JSON.stringify(live))
  r = s.run('capture')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const after = readFileSync(s.saved, 'utf8')
  assert.equal(after, '{\n    "appId": "cli_example7",\n    "appSecretFile": "/saved/path/secret",\n    "allow": ["ou_example", "cli_exampleboss", "cli_examplenew"],\n    "stateDir": "/saved/state",\n    "name": "w7",\n    "timezone": "UTC"\n}\n')
})

// ── team-claude: one per machine ──
const MARK = 'team-claude: feishu-channel-for-claude-code'
function launcherBox() {
  const s = sandbox()
  // a fake channel checkout whose install.mjs writes a launcher the way the real one does
  mkdirSync(join(s.root, 'co', 'bin'), { recursive: true })
  writeFileSync(join(s.root, 'co', 'bin', 'install.mjs'), `
    import { writeFileSync } from 'node:fs'; import { join } from 'node:path'
    const a = process.argv.slice(2); const v = k => a[a.indexOf(k) + 1]
    writeFileSync(join(v('--dir'), 'team-claude'), "#!/bin/sh\\n# ${MARK}\\nTEAM_CLAUDE_INSTALLED_CONFIG='" + v('--config') + "' exec node '" + ${JSON.stringify(join(s.root, 'co', 'bin', 'start.mjs'))} + "' \\"$@\\"\\n")
    writeFileSync(join(v('--dir'), 'args.json'), JSON.stringify(a))
  `)
  const bin = join(s.root, 'bin'); mkdirSync(bin)
  mkdirSync(dirname(s.live), { recursive: true }); writeFileSync(s.live, JSON.stringify({ appId: 'cli_example7', allow: ['ou_example'] }))
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  const run = (...a) => spawnSync(process.execPath, [CH, ...a, '--n', '7', '--team', join(s.root, 'team.json')], { encoding: 'utf8', env })
  return { ...s, bin, run }
}

test('launcher: --dir passes through; one pointing at another checkout stops the install until --replace', { skip: process.platform === 'win32' }, () => {
  const s = launcherBox()
  writeFileSync(join(s.bin, 'team-claude'), `#!/bin/sh\n# ${MARK}\nTEAM_CLAUDE_INSTALLED_CONFIG='/old/config.json' exec node '/old/checkout/bin/start.mjs' "$@"\n`)
  let r = s.run('launcher', '--dir', s.bin)
  assert.equal(r.status, 10, r.stdout + r.stderr)
  assert.match(r.stdout, /checkout: \/old\/checkout\/bin\/start\.mjs/)
  assert.match(r.stdout, /config: {3}\/old\/config\.json/)
  assert.match(r.stdout, /--replace/)
  assert.ok(readFileSync(join(s.bin, 'team-claude'), 'utf8').includes('/old/checkout'), 'not touched')

  r = s.run('launcher', '--dir', s.bin, '--replace')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(s.bin, 'args.json'), 'utf8')), ['--config', s.live, '--dir', s.bin])
  assert.match(r.stdout, /repointed .* it was \/old\/checkout/)

  r = s.run('launcher', '--dir', s.bin) // now it points here: no question asked
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('verify: team-claude must point at the team file\'s checkout and config, not just be on PATH', { skip: process.platform === 'win32' }, () => {
  const s = launcherBox()
  const VERIFY = CH.replace('channel.mjs', 'verify.mjs')
  const env = { ...process.env, PATH: `${s.bin}:${process.env.PATH}` }
  const v = () => spawnSync(process.execPath, [VERIFY, '--n', '7', '--team', join(s.root, 'team.json'), '--offline'], { encoding: 'utf8', env }).stdout
  writeFileSync(join(s.bin, 'team-claude'), `#!/bin/sh\n# ${MARK}\nTEAM_CLAUDE_INSTALLED_CONFIG='/old/config.json' exec node '/old/checkout/bin/start.mjs' "$@"\n`)
  assert.match(v(), /❌ team-claude points here — .*runs \/old\/checkout\/bin\/start\.mjs with config \/old\/config\.json/)
  assert.equal(s.run('launcher', '--dir', s.bin, '--replace').status, 0)
  assert.match(v(), /✅ team-claude points here/)
})

test('place runs the channel\'s own setup.mjs for mcp.json; without the checkout it says to install first', () => {
  const s = sandbox()
  writeFileSync(s.saved, JSON.stringify({ appId: 'cli_example7', allow: ['ou_example'] }))
  let r = s.run('place')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /not installed .*channel\.mjs install, then place again/)
  const bin = join(s.root, 'co', 'bin'); mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'setup.mjs'), "import { writeFileSync } from 'node:fs'\nimport { dirname, join } from 'node:path'\nwriteFileSync(join(dirname(process.argv[2]), 'mcp.json'), JSON.stringify({ by: 'setup', config: process.argv[2], env: process.env.FEISHU_CHANNEL_CONFIG }))\n")
  r = s.run('place')
  assert.equal(r.status, 0, r.stderr + r.stdout)
  assert.match(r.stdout, /written next to the config by the channel's setup\.mjs/)
  assert.deepEqual(JSON.parse(readFileSync(join(dirname(s.live), 'mcp.json'), 'utf8')), { by: 'setup', config: s.live, env: s.live })
})

test('verify: one claude -p call shows not logged in / billing / ok, run outside the work directory; --offline skips it', { skip: process.platform === 'win32' && 'shell fake' }, () => {
  const s = sandbox()
  const VERIFY = CH.replace('channel.mjs', 'verify.mjs')
  const fake = join(s.root, 'claude')
  const where = join(s.root, 'claude-cwd')
  writeFileSync(fake, `#!/bin/sh\npwd > "${where}"\ncase "$FAKE_CLAUDE" in\n ok) echo ok;;\n login) echo "Invalid API key · Please run /login" >&2; exit 1;;\n bill) echo "Credit balance is too low"; exit 1;;\nesac\n`)
  spawnSync('chmod', ['+x', fake])
  const v = (mode, ...a) => spawnSync(process.execPath, [VERIFY, '--n', '7', '--team', join(s.root, 'team.json'), ...a], { encoding: 'utf8', env: { ...process.env, WORKER_KIT_CLAUDE: fake, FAKE_CLAUDE: mode } })
  assert.match(v('ok').stdout, /✅ Claude API — answered/)
  assert.notEqual(readFileSync(where, 'utf8').trim(), s.root, 'not a session in the work directory')
  assert.match(v('login').stdout, /❌ Claude API — not logged in: Invalid API key/)
  assert.match(v('bill').stdout, /❌ Claude API — billing: Credit balance is too low/)
  assert.doesNotMatch(v('ok', '--offline').stdout, /Claude API/)
})
