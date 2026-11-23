// Shared helpers: load the team file, resolve one role / member, run commands.
// No dependencies: Node 20+ only, so the same scripts run in a Linux container and in a native Windows session.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, hostname, platform } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const isWin = platform() === 'win32'

/** Parse `--name value` / `--flag` / positionals. */
export function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (/^-[a-z]$/.test(a)) { out[a.slice(1)] = argv[++i] ?? true; continue } // short option: -m "message"
    if (!a.startsWith('--')) { out._.push(a); continue }
    const eq = a.indexOf('=')
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue }
    const k = a.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) { out[k] = next; i++ } else out[k] = true
  }
  return out
}

export function die(msg, code = 1) {
  console.error(`❌ ${msg}`)
  process.exit(code)
}

/** `~/x` → home; Windows backslashes stay as given. */
export function expandHome(p) {
  if (typeof p !== 'string') return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/** Replace `{n}` (and any `{key}` in vars) in every string of a value. */
export function fill(value, vars) {
  if (typeof value === 'string') return value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m))
  if (Array.isArray(value)) return value.map(v => fill(v, vars))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]))
  return value
}

/** Read a dotted path (`channel.appSecretFile`) from an object. */
function get(obj, path) {
  return path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj)
}

/**
 * Replace `{a.b}` references to other fields of the same (merged) role, so one value is written once:
 * `"secrets": [{ "path": "{channel.appSecretFile}" }]`. A reference to a missing or non-string field is an error.
 */
export function fillRefs(value, root, seen = []) {
  if (typeof value === 'string') {
    return value.replace(/\{([A-Za-z_]\w*(?:\.\w+)+)\}/g, (m, path) => {
      if (seen.includes(path)) die(`team file: reference cycle at {${path}}`)
      const v = get(root, path)
      if (typeof v !== 'string') die(`team file: {${path}} does not name a string field of this role`)
      return fillRefs(v, root, [...seen, path])
    })
  }
  if (Array.isArray(value)) return value.map(v => fillRefs(v, root, seen))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillRefs(v, root, seen)]))
  return value
}

/**
 * The role's secrets, with the channel's App Secret file added when no entry names that path already.
 * Each entry: { name, path?, check?, by, note? }.
 */
export function secretsOf(r) {
  const list = [...(r.secrets ?? [])]
  const f = r.channel?.appSecretFile
  if (f && !list.some(s => s.path && absPath(s.path) === absPath(f))) {
    list.unshift({ name: 'bot App Secret', path: f, by: 'user', note: 'Feishu open platform → this bot\'s app → Credentials', auto: true })
  }
  return list
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v) }

/** Deep merge: objects merge, everything else (arrays included) is replaced by the override. */
export function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v)
  return out
}

/**
 * Find the team file: --team, then $TEAM_FILE, then team.json in the current directory or any parent.
 */
export function findTeamFile(args = {}) {
  const given = args.team || process.env.TEAM_FILE
  if (given) {
    const p = resolve(expandHome(given))
    if (!existsSync(p)) die(`team file ${p} not found`)
    return p
  }
  let d = process.cwd()
  for (;;) {
    const p = join(d, 'team.json')
    if (existsSync(p)) return p
    const up = dirname(d)
    if (up === d) break
    d = up
  }
  die('no team file: pass --team <path to team.json> or set TEAM_FILE (see examples/team.json)')
}

export function loadTeam(file) {
  let t
  try { t = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { die(`cannot parse ${file}: ${e.message}`) }
  if (!isObj(t.roles)) die(`${file}: "roles" is missing`)
  return t
}

/**
 * Resolve one session's settings: roles.<role> merged with members.<n> (workers), `{n}` filled in,
 * and the runtime ("docker" | "native") picked.
 * @returns {object} with role, n, runtime, and every field of the role (stateRepo, dir, workDir, …)
 */
export function resolveRole(team, role, n) {
  const base = team.roles[role]
  if (!isObj(base)) die(`team file has no roles.${role}`)
  let r = base
  // numbered roles (workers, and any later role marked "numbered": true) take per-number overrides from members
  if (role === 'worker' || base.numbered) {
    if (n === undefined || n === null || n === '' || n === true) die(`${role} number missing: pass --n <N>${role === 'worker' ? ' (or set WORKER)' : ''}`)
    const m = (base.members ?? team.members)?.[String(n)]
    if (!isObj(m)) die(`team file has no members."${n}" for ${role}`)
    r = merge(base, m)
  }
  const vars = { n: n ?? '', project: team.project ?? '' }
  r = fill(r, vars)
  r = fillRefs(r, r)
  // an explicit runtime.mode wins; otherwise a role with runtime.docker is a docker member, wherever this script runs
  // (a Windows host manages docker workers too), and one without it is native
  const runtime = r.runtime?.mode ?? (isObj(r.runtime?.docker) ? 'docker' : 'native')
  if (!['docker', 'native'].includes(runtime)) die(`runtime.mode must be docker or native, not ${runtime}`)
  const wd = typeof r.workDir === 'object' ? (isWin ? r.workDir.windows : r.workDir.linux) : r.workDir
  return { ...r, role, n: n ?? null, runtimeMode: runtime, workDir: wd && resolve(expandHome(wd)) }
}

/** Role + member from args / env (WORKER). */
export function roleFromArgs(args) {
  const role = args.role || (args.n || process.env.WORKER ? 'worker' : null)
  if (!role) die('pass --role leader|worker (workers also --n <N>)')
  const n = args.n ?? (role === 'worker' ? process.env.WORKER : null)
  const file = findTeamFile(args)
  const team = loadTeam(file)
  return { team, teamFile: file, r: resolveRole(team, role, n) }
}

/** Claude Code names a project's directory after the absolute working directory, every non-alphanumeric → '-'. */
export function claudeProjectDir(workDir) {
  const root = process.env.CLAUDE_CONFIG_DIR ? resolve(expandHome(process.env.CLAUDE_CONFIG_DIR)) : join(homedir(), '.claude')
  return join(root, 'projects', workDir.replace(/[^A-Za-z0-9]/g, '-'))
}

/**
 * Run a command. dry: only print it. Returns { status, stdout, stderr }.
 * opts.quiet: do not echo the command. opts.capture: capture output instead of inheriting.
 */
export function run(cmd, cmdArgs, opts = {}) {
  const shown = [cmd, ...cmdArgs].map(a => (/[\s"'$]/.test(a) ? JSON.stringify(a) : a)).join(' ')
  if (opts.dry) { console.log(`  [dry-run] ${shown}`); return { status: 0, stdout: '', stderr: '' } }
  if (!opts.quiet) console.log(`  $ ${shown}`)
  const r = spawnTool(cmd, cmdArgs, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: 'utf8',
    stdio: opts.stdio ?? (opts.capture ? ['ignore', 'pipe', 'pipe'] : (opts.input !== undefined ? ['pipe', 'inherit', 'inherit'] : 'inherit')),
    input: opts.input,
  })
  if (r.error) return { status: 127, stdout: '', stderr: r.error.message }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// ── Windows .cmd shims without a shell ───────────────────────────────────
// Node refuses to spawn .cmd / .bat directly, and shell: true with an args array is deprecated (DEP0190).
// So a .cmd runs as `cmd.exe /d /s /c "<line>"` with every argument escaped the way cross-spawn does:
// quoted for the C runtime, then cmd's metacharacters caret-escaped (twice for a shim that hands %* on to node).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

export function winQuoteArg(arg, doubleEscape = true) {
  let a = String(arg)
  a = a.replace(/(\\*)"/g, '$1$1\\"') // backslashes before a quote are doubled, the quote escaped
  a = a.replace(/(\\*)$/, '$1$1') // trailing backslashes doubled (they precede the closing quote)
  a = `"${a}"`
  a = a.replace(CMD_META, '^$1')
  if (doubleEscape) a = a.replace(CMD_META, '^$1')
  return a
}

/** The cmd.exe argument list that runs `cmd args…` (a .cmd / .bat). */
export function winCmdLine(cmd, args) {
  const exe = String(cmd).replace(CMD_META, '^$1')
  return ['/d', '/s', '/c', `"${[exe, ...args.map(a => winQuoteArg(a))].join(' ')}"`]
}

/** spawnSync that runs .cmd / .bat shims on Windows through cmd.exe without shell: true. */
export function spawnTool(cmd, args, opts = {}, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    return spawnSync(process.env.ComSpec || 'cmd.exe', winCmdLine(cmd, args), { ...opts, windowsVerbatimArguments: true })
  }
  return spawnSync(cmd, args, opts)
}

/** git with an optional deploy key (ssh -i … IdentitiesOnly). */
export function git(repoDir, gitArgs, { key, capture = true, quiet = true, env } = {}) {
  const e = { ...(env || {}) }
  const k = key && resolve(expandHome(key))
  if (k && existsSync(k)) e.GIT_SSH_COMMAND = `ssh -i "${k.replaceAll('\\', '/')}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
  const a = repoDir ? ['-C', repoDir, ...gitArgs] : gitArgs
  return run('git', a, { capture, quiet, env: e })
}

export function absPath(p, base) {
  const x = expandHome(p)
  return isAbsolute(x) ? x : resolve(base ?? process.cwd(), x)
}

export const thisHost = () => hostname()

export function ok(msg) { console.log(`✅ ${msg}`) }
export function warn(msg) { console.log(`⚠️  ${msg}`) }
export function info(msg) { console.log(`   ${msg}`) }

/** A step only a human can do: print it and exit 10 so the skill knows to stop and wait. */
export function needUser(lines) {
  console.log('\n🖐  This step needs you (not the session):')
  for (const l of [].concat(lines)) console.log(`   ${l}`)
  console.log('   Tell the session when it is done.')
  process.exit(10)
}

/** Where this session's directory in the state repo lives. */
export function stateDir(r) {
  if (!r.stateClone) die(`roles.${r.role}.stateClone is missing`)
  return join(absPath(r.stateClone), r.dir ?? '.')
}

/** Print how the user can write a secret file without it showing on screen or in the session. */
export function secretFileHowTo(file) {
  return isWin
    ? [
        'In a separate PowerShell window (not inside this session):',
        `  $s = Read-Host -AsSecureString "paste"; [IO.File]::WriteAllText("${file}", [Net.NetworkCredential]::new("", $s).Password)`,
      ]
    : [
        'In a separate terminal (not inside this session, so the secret never reaches the conversation):',
        `  mkdir -p "$(dirname "${file}")" && (umask 077; read -rsp "paste: " s && printf '%s' "$s" > "${file}"; echo)`,
      ]
}

/** The member's session-state file: `sessionState` (relative to its state directory), default session-state.md. */
export function sessionStatePath(r) {
  return join(stateDir(r), r.sessionState ?? 'session-state.md')
}

/**
 * The member's ROLE.md, imported into the manual: `roleFile` (relative to its state directory), default ROLE.md.
 * null: there is no separate role file (the manual itself lives in the state repo), nothing to import.
 */
export function roleFilePath(r) {
  return r.roleFile === null ? null : join(stateDir(r), r.roleFile ?? 'ROLE.md')
}
