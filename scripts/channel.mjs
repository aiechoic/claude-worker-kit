#!/usr/bin/env node
/**
 * Feishu channel (feishu-channel-for-claude-code) for one session.
 *
 *   node channel.mjs install  --role … [--n N] [--dir <bin dir>] [--replace]
 *                                                  clone (or fast-forward) the channel repo, npm ci, install `team-claude`
 *   node channel.mjs launcher --role … [--n N] [--dir …] [--replace]   only (re)install `team-claude`
 *   node channel.mjs place    --role … [--n N]    put the saved config back (state repo → live path), check the secret file
 *   node channel.mjs capture  --role … [--n N]    copy the live config's portable fields into the state repo
 *                                                  (never the secret; not the paths place sets; the saved file keeps its layout)
 *   node channel.mjs allow    --role … [--n N] <id> [--name <display name>]   add a sender (user open_id or bot app id)
 *   node channel.mjs doctor   --role … [--n N]    the channel's own permission check
 *   node channel.mjs show     --role … [--n N]    print the live config with the secret fields hidden
 *
 * The team file gives roles.<role>.channel: { repo, checkout, config, saved, appSecretFile, stateDir? }.
 * The App Secret is never read or printed: only appSecretFile (a path) goes into the config.
 * `team-claude` regenerates mcp.json / settings.json next to the config when they are missing or stale,
 * so only config.json (and an expected-scopes file, if any) is kept in the state repo.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { deleteKey, setKey } from './lib/jsonedit.mjs'
import { findLaunchers, installDirs, launcherOnPath, pointsAt } from './lib/teamclaude.mjs'
import { absPath, die, info, isWin, needUser, ok, parseArgs, roleFromArgs, run, secretFileHowTo, stateDir, warn } from './lib/team.mjs'

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
const dry = !!args['dry-run']
const { r } = roleFromArgs(args)
const ch = r.channel || die(`roles.${r.role}.channel is missing in the team file`)
const CHECKOUT = absPath(ch.checkout || die('channel.checkout is missing'))
const CONFIG = absPath(ch.config || die('channel.config is missing'))
const SAVED = join(stateDir(r), ch.saved ?? 'tools/feishu-channel/config.json')
const SECRET = ch.appSecretFile && absPath(ch.appSecretFile)
const SECRET_KEYS = ['appSecret']

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch (e) { die(`cannot read ${p}: ${e.message}`) }
}
function writeJson(p, v) {
  if (dry) { info(`[dry-run] write ${p}`); return }
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`)
}
function hidden(c) { return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, SECRET_KEYS.includes(k) ? '<hidden>' : v])) }

function install() {
  if (!ch.repo) die('channel.repo is missing')
  if (existsSync(join(CHECKOUT, '.git'))) {
    info(`channel repo already at ${CHECKOUT}; fast-forwarding`)
    const p = run('git', ['-C', CHECKOUT, 'pull', '-q', '--ff-only'], { dry, env: { GIT_CONFIG_GLOBAL: isWin ? 'NUL' : '/dev/null' } })
    if (p.status !== 0) warn('pull failed; keeping the current checkout')
  } else {
    // public repo over https; a global url.insteadOf (https → ssh) would make the clone ask for a key, so skip global config
    const c = run('git', ['clone', '-q', ch.repo, CHECKOUT], { dry, env: { GIT_CONFIG_GLOBAL: isWin ? 'NUL' : '/dev/null' } })
    if (c.status !== 0) die(`git clone ${ch.repo} failed`)
  }
  const npm = run(isWin ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-fund', '--no-audit'], { cwd: CHECKOUT, dry })
  if (npm.status !== 0) die('npm ci failed')
  ok(`channel installed at ${CHECKOUT}`)
  if (existsSync(CONFIG) || dry) installCommand()
  else info(`no config at ${CONFIG} yet: run place, then install again to get team-claude`)
}

/**
 * Install `team-claude` for this checkout and config. It is one per machine (on PATH): when one is already there and
 * points at another checkout or config (another work directory on this machine), stop and show it; --replace to repoint.
 * --dir passes through to the channel's install.mjs. On Windows the npm prefix is looked up here and passed as --dir
 * (older install.mjs parse `npm prefix -g`, which newer npm masks).
 */
function installCommand() {
  const dirArg = typeof args.dir === 'string' ? args.dir : null
  const dirs = installDirs(dirArg)
  const others = findLaunchers(dirs).filter(l => !pointsAt(l, CHECKOUT, CONFIG))
  if (others.length && !args.replace) {
    console.log('\n⚠️  team-claude is already installed and points elsewhere:')
    for (const l of others) console.log(l.foreign ? `   ${l.file}: not installed by the channel repo` : `   ${l.file}\n      checkout: ${l.start}\n      config:   ${l.config ?? '(none: looked up at start)'}`)
    console.log(`   this install would point it at:\n      checkout: ${join(CHECKOUT, 'bin', 'start.mjs')}\n      config:   ${CONFIG}`)
    needUser([
      'team-claude is shared by every work directory on this machine; repointing it moves them all to this one.',
      'Confirm with the user, then run install again with --replace (go back later by running install in the old directory with --replace).',
      'Or pass --dir <a directory on PATH> to install a separate one.',
    ])
  }
  const a = [join(CHECKOUT, 'bin', 'install.mjs'), '--config', CONFIG]
  const dir = dirArg ?? (isWin ? dirs[0] : null)
  if (dir) a.push('--dir', dir)
  if (others.some(l => l.foreign) && args.replace) a.push('--force')
  const res = run(process.execPath, a, { dry })
  if (res.status !== 0) die('team-claude install failed (see above)')
  for (const l of others) if (!l.foreign) info(`repointed ${l.file}; it was ${l.start} with ${l.config ?? 'no config'}`)
  ok('team-claude installed: start sessions with `team-claude` in the work directory')
  const first = dry ? null : launcherOnPath()
  if (first && !pointsAt(first, CHECKOUT, CONFIG)) warn(`but ${first.file} comes first on PATH and still runs ${first.start ?? 'something else'}: put ${dir ?? 'the install directory'} earlier on PATH, or install there`)
}

function place() {
  if (!existsSync(SAVED)) die(`no saved channel config at ${SAVED}: run capture on the old machine, or write one from the channel's config.example.json`)
  const saved = readJson(SAVED)
  for (const k of SECRET_KEYS) if (k in saved) die(`${SAVED} contains "${k}"; remove it from the state repo and use appSecretFile`)
  const live = { ...saved }
  if (SECRET) live.appSecretFile = SECRET
  if (r.bot?.appId && live.appId !== r.bot.appId) die(`saved config appId ${live.appId} does not match the team file bot.appId ${r.bot.appId}`)
  // expectedScopesFile next to the saved config travels along
  if (typeof saved.expectedScopesFile === 'string') {
    const name = saved.expectedScopesFile.split(/[\\/]/).pop()
    const src = join(dirname(SAVED), name)
    if (existsSync(src)) {
      const dst = join(dirname(CONFIG), name)
      if (!dry) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst) }
      live.expectedScopesFile = dst
    }
  }
  if (ch.stateDir) live.stateDir = absPath(ch.stateDir) // else keep the saved one (same paths on a rebuilt volume)
  writeJson(CONFIG, live)
  ok(`channel config placed: ${CONFIG}`)
  checkSecret()
}

function checkSecret() {
  const file = absPath(readJson(CONFIG).appSecretFile ?? SECRET ?? '')
  if (!file) die('config has no appSecretFile')
  if (!existsSync(file) || statSync(file).size === 0) {
    needUser([`The App Secret file ${file} is missing or empty.`, 'Copy the secret from the Feishu open platform (this bot\'s app → Credentials) and write it there:', ...secretFileHowTo(file)])
  }
  ok(`App Secret file present: ${file} (not read)`)
}

/**
 * Fields place() sets from the team file for this machine. capture never writes them back:
 * the saved config keeps whatever it had for them, so a capture on one machine does not leak its paths.
 */
const MACHINE_KEYS = ['appSecretFile', 'stateDir', 'expectedScopesFile']
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)

function capture() {
  if (!existsSync(CONFIG)) die(`no live config at ${CONFIG}`)
  const live = readJson(CONFIG)
  if (SECRET_KEYS.some(k => k in live)) warn('the live config has an inline appSecret: not saved; use appSecretFile')
  const portable = Object.keys(live).filter(k => !SECRET_KEYS.includes(k) && !MACHINE_KEYS.includes(k))
  let text
  let changed = []
  if (existsSync(SAVED)) {
    // edit the saved file in place: only keys whose value changed, the rest stays as written
    text = readFileSync(SAVED, 'utf8')
    const saved = JSON.parse(text)
    for (const k of portable) if (!same(saved[k], live[k])) { text = setKey(text, k, live[k]); changed.push(k) }
    for (const k of Object.keys(saved)) {
      if (!(k in live) && !MACHINE_KEYS.includes(k)) { text = deleteKey(text, k); changed.push(`-${k}`) }
      if (SECRET_KEYS.includes(k)) { text = deleteKey(text, k); changed.push(`-${k}`) }
    }
  } else {
    const first = Object.fromEntries(Object.entries(live).filter(([k]) => !SECRET_KEYS.includes(k)))
    text = `${JSON.stringify(first, null, 2)}\n`
    changed = Object.keys(first)
  }
  if (!changed.length) ok(`${SAVED} already matches the live config (machine paths ${MACHINE_KEYS.join(', ')} are not compared)`)
  else if (dry) info(`[dry-run] ${SAVED}: ${changed.join(', ')}`)
  else {
    mkdirSync(dirname(SAVED), { recursive: true })
    writeFileSync(SAVED, text)
    ok(`saved ${SAVED}: ${changed.join(', ')} (run state.mjs save to push it)`)
  }
  if (typeof live.expectedScopesFile === 'string' && existsSync(absPath(live.expectedScopesFile))) {
    const src = absPath(live.expectedScopesFile)
    const dst = join(dirname(SAVED), src.split(/[\\/]/).pop())
    if (!existsSync(dst) || readFileSync(dst, 'utf8') !== readFileSync(src, 'utf8')) {
      if (!dry) copyFileSync(src, dst)
      ok(`saved ${dst}`)
    }
  }
}

function allow() {
  const id = args._[1] || die('usage: channel.mjs allow <open_id or app id> [--name <display name>]')
  if (!/^(ou_|cli_|on_)/.test(id)) warn(`${id} does not look like an open_id (ou_…) or app id (cli_…)`)
  for (const p of [CONFIG, SAVED]) {
    if (!existsSync(p)) { info(`skip ${p} (missing)`); continue }
    const c = readJson(p)
    c.allow = Array.from(new Set([...(c.allow ?? []), id]))
    if (typeof args.name === 'string') c.names = { ...(c.names ?? {}), [id]: args.name }
    writeJson(p, c)
    ok(`${id} allowed in ${p}`)
  }
  info('the running channel reads the allow list at start: restart it (node <checkout>/bin/restart.mjs) for the change to apply')
}

function doctor() {
  const res = run(process.execPath, [join(CHECKOUT, 'bin', 'doctor.mjs')], { env: { FEISHU_CHANNEL_CONFIG: CONFIG }, dry })
  process.exit(res.status)
}

function show() {
  console.log(JSON.stringify(hidden(readJson(CONFIG)), null, 2))
}

switch (cmd) {
  case 'install': install(); break
  case 'launcher': installCommand(); break
  case 'place': place(); break
  case 'capture': capture(); break
  case 'allow': allow(); break
  case 'doctor': doctor(); break
  case 'show': show(); break
  case 'check-secret': checkSecret(); break
  default:
    console.error('usage: channel.mjs install|launcher|place|capture|allow|doctor|show|check-secret --role leader|worker [--n N] [--team team.json] [--dry-run]')
    process.exit(2)
}
