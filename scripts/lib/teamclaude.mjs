// The `team-claude` launcher the channel repo installs: where it is, and which checkout and config it points at.
// It is one per machine (on PATH), so two work directories on one machine share it: read it before replacing it.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const MARK = 'team-claude: feishu-channel-for-claude-code'
const ENV = 'TEAM_CLAUDE_INSTALLED_CONFIG'

/** Parse an installed launcher (sh or cmd). null when the file is not one the channel repo installed. */
export function parseLauncher(text) {
  if (!text.includes(MARK)) return null
  let start = null; let config = null
  let m = /exec node '((?:[^']|'\\'')*)'/.exec(text) // sh: exec node '<start>' "$@"
  if (m) start = m[1].replaceAll("'\\''", "'")
  m = new RegExp(`${ENV}='((?:[^']|'\\\\'')*)'`).exec(text)
  if (m) config = m[1].replaceAll("'\\''", "'")
  m = /^node "([^"]*)" %\*/m.exec(text) // cmd: node "<start>" %*
  if (m) start = m[1].replaceAll('%%', '%')
  m = new RegExp(`set "${ENV}=([^"]*)"`).exec(text)
  if (m) config = m[1].replaceAll('%%', '%')
  return { start, config }
}

/** npm's global prefix without parsing `npm prefix -g` (newer npm masks UUID-like path parts as ***). */
export function npmPrefix(env = process.env) {
  if (env.npm_config_prefix) return env.npm_config_prefix
  const dir = dirname(process.execPath)
  const cli = [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(existsSync)
  if (cli) {
    const r = spawnSync(process.execPath, [cli, 'config', 'get', 'prefix', '--json'], { encoding: 'utf8' })
    let v = (r.stdout ?? '').trim()
    try { v = JSON.parse(v) } catch { /* plain path */ }
    if (r.status === 0 && typeof v === 'string' && v && !v.includes('***')) return v
  }
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'npm')
  return null
}

/** The directories install.mjs would write to, in its order (or just --dir). */
export function installDirs(dirArg, platform = process.platform) {
  if (dirArg) return [resolve(dirArg)]
  if (platform === 'win32') { const p = npmPrefix(); return p ? [p] : [] }
  return ['/usr/local/bin', join(homedir(), '.local', 'bin')]
}

/** Launchers in the given directories (the ones an install would overwrite): [{ file, start, config }]. */
export function findLaunchers(dirs, platform = process.platform) {
  const name = platform === 'win32' ? 'team-claude.cmd' : 'team-claude'
  const files = new Set(dirs.map(d => join(d, name)))
  const out = []
  for (const file of files) {
    if (!existsSync(file)) continue
    const p = parseLauncher(readFileSync(file, 'utf8'))
    out.push(p ? { file, ...p } : { file, foreign: true })
  }
  return out
}

/** The first launcher on PATH (what `team-claude` actually runs). */
export function launcherOnPath(platform = process.platform) {
  const name = platform === 'win32' ? 'team-claude.cmd' : 'team-claude'
  const sep = platform === 'win32' ? ';' : ':'
  for (const d of (process.env.PATH ?? process.env.Path ?? '').split(sep).filter(Boolean)) {
    const file = join(d, name)
    if (existsSync(file)) { const p = parseLauncher(readFileSync(file, 'utf8')); return p ? { file, ...p } : { file, foreign: true } }
  }
  return null
}

const norm = p => (p ? resolve(p).replaceAll('\\', '/').replace(/\/+$/, '') : p)
const normCase = (p, platform = process.platform) => (platform === 'win32' ? norm(p)?.toLowerCase() : norm(p))

/** Does a launcher point at this checkout and config? */
export function pointsAt(l, checkout, config, platform = process.platform) {
  return !!l && !l.foreign && normCase(l.start, platform) === normCase(join(checkout, 'bin', 'start.mjs'), platform)
    && normCase(l.config, platform) === normCase(config, platform)
}
