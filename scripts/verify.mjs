#!/usr/bin/env node
/**
 * Acceptance check for one session, run inside it after setup / restore / rebuild.
 *
 *   node verify.mjs --role leader|worker [--n N] [--team team.json] [--offline]
 *
 * Checks: state repo cloned, clean and pushed; memory linked (or copied); manual imports the role file (roleFile); the session-state file (sessionState) is there;
 * leader lock held here (leader); lark-cli profile matches and (unless --offline) reads the work chat;
 * channel config and App Secret file present (never read), allow list not empty, team-claude on PATH;
 * mcp.json written for this checkout and config; every secret in the team file present (path) or passing its check
 * command; and (unless --offline) one short `claude -p` call answers (not logged in / billing / rate limit shown).
 * Exit 0 when everything passes, 1 otherwise.
 */
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launcherOnPath, pointsAt } from './lib/teamclaude.mjs'
import { absPath, claudeProjectDir, git, isWin, spawnTool, parseArgs, roleFilePath, roleFromArgs, secretsOf, sessionStatePath, stateDir, thisHost } from './lib/team.mjs'

const args = parseArgs(process.argv.slice(2))
const { r, teamFile } = roleFromArgs(args)
const results = []
const check = (name, fn) => {
  try {
    const v = fn()
    results.push(v === true || v === undefined ? [true, name, ''] : typeof v === 'string' ? [true, name, v] : [false, name, v.fail])
  } catch (e) { results.push([false, name, e.message]) }
}
const fail = msg => ({ fail: msg })

const CLONE = r.stateClone && absPath(r.stateClone)
const ME = stateDir(r)
const KEY = r.deployKey && absPath(r.deployKey)
const MEM = join(claudeProjectDir(r.workDir), 'memory')
const roleArgs = ['--role', r.role, ...(r.n ? ['--n', String(r.n)] : []), '--team', teamFile]

check('state repo cloned', () => existsSync(join(CLONE, '.git')) ? CLONE : fail(`${CLONE} missing: state.mjs restore`))
check('state repo clean', () => {
  const s = git(CLONE, ['status', '--porcelain', '--', r.dir ?? '.'], { key: KEY })
  return s.stdout.trim() === '' ? true : fail('uncommitted changes in this session\'s directory: state.mjs save')
})
check('state repo pushed', () => {
  git(CLONE, ['fetch', '-q'], { key: KEY })
  const s = git(CLONE, ['rev-list', '--count', '@{u}..HEAD'], { key: KEY })
  return s.status === 0 && s.stdout.trim() === '0' ? true : fail(`unpushed commits (${s.stdout.trim() || s.stderr.trim()}): state.mjs save`)
})
check('memory restored', () => {
  const want = resolve(join(ME, 'memory'))
  try {
    if (lstatSync(MEM).isSymbolicLink()) return resolve(join(MEM, '..'), readlinkSync(MEM)) === want ? `link → ${want}` : fail(`${MEM} links elsewhere`)
  } catch { return fail(`${MEM} missing: state.mjs restore`) }
  return existsSync(join(MEM, '.state-repo-copy')) ? 'copy (save copies it back)' : fail(`${MEM} is a plain directory: state.mjs restore`)
})
const ROLE = roleFilePath(r)
const MANUAL = absPath(r.manual ?? 'CLAUDE.md', r.workDir)
if (ROLE) {
  check('manual imports the role file', () => {
    if (!existsSync(ROLE)) return fail(`no ${ROLE}`)
    const ref = `@${ROLE.replaceAll('\\', '/')}`
    return existsSync(MANUAL) && readFileSync(MANUAL, 'utf8').includes(ref) ? true : fail(`${MANUAL} does not import ${ROLE}: state.mjs restore`)
  })
} else check('manual', () => existsSync(MANUAL) ? `${MANUAL} (no separate role file)` : fail(`${MANUAL} missing`))
check('session state', () => {
  const p = sessionStatePath(r)
  return existsSync(p) ? p : fail(`${p} missing: write what is in hand and who is waited on`)
})

if (r.lock) {
  check('leader lock held here', () => {
    const p = join(ME, 'leader.lock')
    if (!existsSync(p)) return fail('free: state.mjs lock')
    const l = JSON.parse(readFileSync(p, 'utf8'))
    return l.host === thisHost() && l.workDir === r.workDir ? true : fail(`held by ${l.host} (${l.workDir})`)
  })
}

const node = (script, a) => spawnSync(process.execPath, [join(import.meta.dirname, script), ...a], { encoding: 'utf8' })
if (r.bot?.profile) {
  check('lark-cli profile', () => { const x = node('lark.mjs', ['check', ...roleArgs]); return x.status === 0 ? true : fail((x.stderr || x.stdout).trim()) })
  if (!args.offline && (r.chats?.work || r.chats?.status)) {
    check('bot reads the work chat', () => { const x = node('lark.mjs', ['ping', ...roleArgs]); return x.status === 0 ? true : fail((x.stderr || x.stdout).trim().split('\n')[0]) })
  }
}

if (r.channel) {
  const cfgPath = absPath(r.channel.config)
  check('channel config', () => {
    if (!existsSync(cfgPath)) return fail(`${cfgPath} missing: channel.mjs place`)
    const c = JSON.parse(readFileSync(cfgPath, 'utf8'))
    if ('appSecret' in c) return fail('inline appSecret in the config: use appSecretFile')
    if (!Array.isArray(c.allow) || c.allow.length === 0) return fail('allow list is empty')
    if (r.bot?.appId && c.appId !== r.bot.appId) return fail(`appId ${c.appId} ≠ team file ${r.bot.appId}`)
    const sf = c.appSecretFile && absPath(c.appSecretFile)
    if (!sf || !existsSync(sf) || statSync(sf).size === 0) return fail(`App Secret file ${sf ?? '(unset)'} missing or empty`)
    return `${c.allow.length} allowed sender(s), secret file present (not read)`
  })
  check('channel mcp.json', () => {
    const f = join(dirname(cfgPath), 'mcp.json')
    if (!existsSync(f)) return fail(`${f} missing: channel.mjs place (runs the channel's setup.mjs)`)
    let srv
    try { srv = JSON.parse(readFileSync(f, 'utf8')).mcpServers?.feishu } catch (e) { return fail(`${f}: ${e.message}`) }
    const bridge = join(absPath(r.channel.checkout), 'src', 'bridge.mjs')
    if (!srv) return fail(`${f} has no "feishu" server: channel.mjs place`)
    if (resolve(srv.args?.[0] ?? '') !== resolve(bridge) || resolve(srv.env?.FEISHU_CHANNEL_CONFIG ?? '') !== resolve(cfgPath)) return fail(`${f} points at ${srv.args?.[0]} with ${srv.env?.FEISHU_CHANNEL_CONFIG}, not this checkout and config: channel.mjs place`)
    return true
  })
  check('channel checkout', () => existsSync(join(absPath(r.channel.checkout), 'node_modules')) ? true : fail('not installed: channel.mjs install'))
  check('team-claude points here', () => {
    const l = launcherOnPath()
    if (!l) return fail('not on PATH: channel.mjs install (after place)')
    if (l.foreign) return fail(`${l.file} was not installed by the channel repo`)
    const checkout = absPath(r.channel.checkout)
    return pointsAt(l, checkout, cfgPath)
      ? l.file
      : fail(`${l.file} runs ${l.start} with config ${l.config ?? '(none)'}; the team file says ${join(checkout, 'bin', 'start.mjs')} with ${cfgPath}: channel.mjs install --replace`)
  })
}

for (const s of secretsOf(r)) {
  if (s.path) check(`secret: ${s.name}`, () => existsSync(absPath(s.path)) ? `${s.path} present (not read)` : fail(`${s.path} missing; filled by ${s.by ?? 'the user'}`))
  else if (s.check) check(`secret: ${s.name}`, () => {
    const x = spawnSync(s.check, { shell: true, encoding: 'utf8' })
    return x.status === 0 ? `\`${s.check}\` ok` : fail(`\`${s.check}\` failed; ${s.note ?? ''} (${s.by ?? 'user'})`)
  })
}

// one short call, so an account that is not logged in, out of credit or rate limited shows here, not at the first task;
// from an empty directory, so the call is not a session of this member's work directory (team-claude would continue it)
if (!args.offline) {
  check('Claude API', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cwk-verify-'))
    try {
      const bin = process.env.WORKER_KIT_CLAUDE || (isWin ? 'claude.cmd' : 'claude')
      const x = spawnTool(bin, ['-p', 'Reply with the single word: ok', '--max-turns', '1'], { cwd, encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] })
      if (x.error?.code === 'ENOENT') return fail('claude is not on PATH')
      if (x.error?.code === 'ETIMEDOUT' || x.signal) return fail('no answer in 90 s (network or proxy?)')
      const out = `${x.stdout ?? ''}\n${x.stderr ?? ''}`.trim()
      if (x.status === 0 && /\bok\b/i.test(x.stdout ?? '')) return 'answered'
      const first = out.split('\n').find(l => l.trim()) ?? `exit ${x.status}`
      const why = /log ?in|\/login|not logged|authenticat|api key/i.test(out) ? 'not logged in' : /credit|billing|balance|payment|quota|subscription/i.test(out) ? 'billing' : /rate limit|overloaded|429|529/i.test(out) ? 'rate limited' : 'error'
      return fail(`${why}: ${first.trim().slice(0, 200)}`)
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  })
}

const label = r.n ? `${r.role}-${r.n}` : r.role
console.log(`Acceptance for ${label}:`)
for (const [pass, name, note] of results) console.log(`${pass ? '✅' : '❌'} ${name}${note ? ` — ${note}` : ''}`)
const bad = results.filter(x => !x[0]).length
console.log(bad ? `\n${bad} check(s) failed.` : '\nAll checks passed.')
process.exit(bad ? 1 : 0)
