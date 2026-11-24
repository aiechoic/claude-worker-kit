// Sealed credentials: each `secrets` entry marked `sealed: true` is kept in the member's state directory as
// `secrets/<id>.age`, encrypted with the official age tool to the team's public key (`secretsRecipient`).
// Sealing needs only the public key; unsealing needs the master key, which the user keeps and hands over once.
// unseal holds the decrypted bytes in memory until every file has decrypted, then writes them; seal hashes the local
// credential to see whether it changed. The master key never goes to a file, an argument or the environment.
// What was last sealed or unsealed here is recorded per clone in <state clone>/.git/worker-kit-sealed.json
// (SHA-256 of the credential and of its .age file); it never leaves this machine.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { absPath, isWin, secretsOf, stateDir } from './team.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const isFile = f => { try { return statSync(f).isFile() } catch { return false } }

/** Whether `cmd` is on PATH (with PATHEXT on Windows); nothing is run. */
export function onPath(cmd, env = process.env, win = isWin) {
  const dirs = (env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean)
  const exts = win ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)] : ['']
  return dirs.some(d => exts.some(x => isFile(join(d, cmd + x)) || isFile(join(d, cmd + x.toLowerCase()))))
}

/**
 * Where winget put age, for a terminal or session that was open before the install and so does not have it on PATH:
 * %LOCALAPPDATA%\Microsoft\WinGet\Links, else the package folder FiloSottile.age_* under WinGet\Packages.
 * @returns {{ age: string, keygen: string } | null} absolute paths
 */
export function wingetAge(localAppData) {
  if (!localAppData) return null
  const winget = join(localAppData, 'Microsoft', 'WinGet')
  const pair = d => (isFile(join(d, 'age.exe')) && isFile(join(d, 'age-keygen.exe')) ? { age: join(d, 'age.exe'), keygen: join(d, 'age-keygen.exe') } : null)
  const found = pair(join(winget, 'Links'))
  if (found) return found
  const ls = d => { try { return readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(d, e.name)) } catch { return [] } }
  const search = (d, depth) => pair(d) ?? (depth > 0 ? ls(d).reduce((hit, sub) => hit ?? search(sub, depth - 1), null) : null)
  return ls(join(winget, 'Packages')).filter(d => basename(d).startsWith('FiloSottile.age_')).reduce((hit, d) => hit ?? search(d, 2), null)
}

/** age and age-keygen: $WORKER_KIT_AGE / $WORKER_KIT_AGE_KEYGEN, else from PATH, else (Windows) where winget put them. */
export function ageBins(env = process.env, win = isWin) {
  if (env.WORKER_KIT_AGE || env.WORKER_KIT_AGE_KEYGEN) return { age: env.WORKER_KIT_AGE || 'age', keygen: env.WORKER_KIT_AGE_KEYGEN || 'age-keygen' }
  if (onPath('age', env, win) && onPath('age-keygen', env, win)) return { age: 'age', keygen: 'age-keygen' }
  return (win && wingetAge(env.LOCALAPPDATA)) || { age: 'age', keygen: 'age-keygen' }
}
let bins = null
const AGE = () => (bins ??= ageBins()).age
const AGE_KEYGEN = () => (bins ??= ageBins()).keygen

/** The public key secrets are sealed to: the role's `secretsRecipient`, else the team file's top-level one. */
export function recipientOf(team, r) {
  const v = r.secretsRecipient ?? team.secretsRecipient
  if (v === undefined) return null
  if (typeof v !== 'string' || !/^age1[0-9a-z]{58}$/.test(v)) throw new Error('secretsRecipient must be an age public key (age1…)')
  return v
}

/**
 * The role's sealed entries with where each lives: { name, id, path (absolute), file (the .age in the state repo) }.
 * `id` defaults to the file name of `path`, without leading dots (`.feishu-app-secret` → `feishu-app-secret`). Throws on a sealed entry without a path, a bad id, or two entries with one id.
 */
export function sealedEntries(r) {
  const dir = join(stateDir(r), 'secrets')
  const out = []
  for (const s of secretsOf(r)) {
    if (s.sealed !== true) continue
    if (!s.path) throw new Error(`secret "${s.name}": sealed needs a path`)
    const path = absPath(s.path)
    const id = s.id ?? basename(path).replace(/^\.+/, '')
    if (!ID.test(id)) throw new Error(`secret "${s.name}": id "${id}" may only use letters, digits, . _ - (set "id")`)
    if (out.some(e => e.id === id)) throw new Error(`secret "${s.name}": id "${id}" is used twice (set "id")`)
    out.push({ name: s.name, id, path, file: join(dir, `${id}.age`) })
  }
  return out
}

/** Where seal / unseal keep their record: the state clone's root and, when it is a git clone, the marker file. */
export function sealPlace(r) {
  const root = absPath(r.stateClone)
  let git = false
  try { git = statSync(join(root, '.git')).isDirectory() } catch {}
  return { root, marker: git ? join(root, '.git', 'worker-kit-sealed.json') : null }
}

const sha256 = buf => createHash('sha256').update(buf).digest('hex')

function fileHash(f) {
  const b = readFileSync(f)
  try { return sha256(b) } finally { b.fill(0) }
}

function readMarker(place) {
  if (!place?.marker || !existsSync(place.marker)) return {}
  try { return JSON.parse(readFileSync(place.marker, 'utf8')) } catch { return {} }
}

function writeMarker(place, m) {
  if (!place?.marker) return
  const tmp = tmpName(place.marker)
  writeFileSync(tmp, `${JSON.stringify(m, null, 2)}\n`)
  renameSync(tmp, place.marker)
}

/**
 * Make git treat .age files as binary in the state repo (`*.age binary` in the root .gitattributes), so no
 * line-ending conversion (core.autocrlf) ever touches them. Returns true when the file was changed.
 */
export function ensureBinaryAttr(root) {
  if (!root || !existsSync(join(root, '.git'))) return false
  const f = join(root, '.gitattributes')
  const cur = existsSync(f) ? readFileSync(f, 'utf8') : ''
  if (/^\*\.age\s+binary\s*$/m.test(cur)) return false
  appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}*.age binary\n`)
  return true
}

/** age's version, or null when the age binaries are not installed. */
export function ageVersion() {
  const a = spawnSync(AGE(), ['--version'], { encoding: 'utf8' })
  const k = spawnSync(AGE_KEYGEN(), ['--version'], { encoding: 'utf8' })
  if (a.error || a.status !== 0 || k.error || k.status !== 0) return null
  return a.stdout.trim()
}

const APT = 'apt-get update && apt-get install -y age'
export const WINGET = 'winget install --id FiloSottile.age -e --accept-source-agreements --accept-package-agreements'

/**
 * How to install age where it is missing. The session runs `here` (on this machine) or `host` (on the docker host, for
 * a docker member) itself; only when neither is possible is it a step for the user (`user`).
 * @param ctx { win, has(cmd) → bool, root, sudoOk() → bool (passwordless sudo), container (docker member) | null, inContainer }
 * @returns {{ here: string | null, host: string | null, after: string[], user: string[] }}
 */
export function ageInstallPlan({ win, has, root, sudoOk, container = null, inContainer = false }) {
  if (win) {
    return {
      here: has('winget') ? WINGET : null,
      host: null,
      after: ['Terminals that were open before do not have age on PATH; the kit\'s scripts find it in WinGet\'s folder without a restart. A terminal the user runs unseal in must be opened after the install.'],
      user: ['Install the official age tool:', `  ${WINGET}`, '(no winget: an official release from https://github.com/FiloSottile/age/releases, with age.exe and age-keygen.exe on PATH)', 'Then open a new terminal.'],
    }
  }
  const apt = has('apt-get')
  const here = !apt ? null : root ? APT : has('sudo') && sudoOk() ? `sudo apt-get update && sudo apt-get install -y age` : null
  return {
    here,
    // the container's root needs no sudo; a container without apt-get cannot use it
    host: container && (!inContainer || apt) ? `docker exec -u root ${container} sh -c '${APT}'` : null,
    after: [],
    user: ['Install the official age tool (1.1 or later):', `  sudo ${APT.replace('&& apt-get', '&& sudo apt-get')}        # Debian / Ubuntu`, '  or an official release from https://github.com/FiloSottile/age/releases, with age and age-keygen on PATH', 'Then run this step again.'],
  }
}

/** ageInstallPlan for this machine; `r` (the role, may be null) says whether the member is a docker worker. */
export function ageInstallHere(r) {
  return ageInstallPlan({
    win: isWin,
    has: c => onPath(c),
    root: process.getuid?.() === 0,
    sudoOk: () => spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0,
    container: r?.runtimeMode === 'docker' ? r.runtime?.docker?.container ?? null : null,
    inContainer: existsSync('/.dockerenv'),
  })
}

function tmpName(file) {
  return join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${Date.now()}`)
}

function removeQuietly(f) {
  try { unlinkSync(f) } catch {}
}

/**
 * Encrypt each sealed entry whose local file exists into the state repo, judged by content against what this clone
 * last sealed or unsealed (the marker), never by file times. Without force an entry is skipped when:
 * - unchanged: the credential and its .age are what this clone last sealed or unsealed;
 * - elsewhere: the credential is unchanged here but the .age changed (another machine sealed a newer one; unseal to take it);
 * - foreign: a .age exists that this clone never sealed or unsealed (force to replace it with this machine's copy).
 * @param place from sealPlace(r); adds `*.age binary` to the repo's .gitattributes when needed
 * @returns {{ sealed: string[], unchanged: string[], elsewhere: string[], foreign: string[], missing: string[], attributes: boolean }}
 */
export function seal(entries, recipient, { force = false, dry = false, place = null } = {}) {
  const res = { sealed: [], unchanged: [], elsewhere: [], foreign: [], missing: [], attributes: false }
  const marker = readMarker(place)
  for (const e of entries) {
    if (!existsSync(e.path) || statSync(e.path).size === 0) { res.missing.push(e.id); continue }
    const plain = fileHash(e.path)
    const m = marker[e.id]
    if (!force && existsSync(e.file)) {
      const age = fileHash(e.file)
      if (!m) { res.foreign.push(e.id); continue }
      if (m.plain === plain) { (m.age === age ? res.unchanged : res.elsewhere).push(e.id); continue }
    }
    if (dry) { res.sealed.push(e.id); continue }
    mkdirSync(dirname(e.file), { recursive: true })
    const tmp = tmpName(e.file)
    try {
      // age reads the credential file itself; it never passes through this process
      const r = spawnSync(AGE(), ['--encrypt', '--recipient', recipient, '--output', tmp, e.path], { encoding: 'utf8' })
      if (r.error) throw new Error(`age: ${r.error.message}`)
      if (r.status !== 0) throw new Error(`age could not seal "${e.name}": ${r.stderr.trim()}`)
      renameSync(tmp, e.file)
    } finally {
      removeQuietly(tmp)
    }
    marker[e.id] = { plain, age: fileHash(e.file) }
    res.sealed.push(e.id)
  }
  if (!dry && res.sealed.length) {
    writeMarker(place, marker)
    res.attributes = ensureBinaryAttr(place?.root)
  }
  return res
}

/**
 * Decrypt every sealed file that exists, all in memory first; only when all of them decrypted and authenticated
 * are the credential files written (temporary file, mode 600, then rename). A wrong master key or a tampered file
 * writes nothing.
 * An existing credential file that differs is left alone unless force.
 * @param {Buffer} identity the master key (an age identity file's contents); zeroed before returning
 * @returns {{ written: string[], same: string[], kept: string[], notSealed: string[] }} ids
 */
export function unseal(entries, identity, { force = false, dry = false, place = null } = {}) {
  const res = { written: [], same: [], kept: [], notSealed: [] }
  const plain = []
  const tmps = []
  const marker = readMarker(place)
  let key = Buffer.alloc(0)
  try {
    // a key copied from a password manager may carry spaces or CR LF, which age rejects, and PowerShell puts a
    // UTF-8 BOM in front of what it pipes into a native program: keep the key lines, trimmed
    const lines = identity.toString('latin1').replace(/^\xEF\xBB\xBF/, '').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    if (!lines.length || !lines.every(l => /^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(l))) throw new Error('the master key is not an age identity (AGE-SECRET-KEY-1…)')
    key = Buffer.from(`${lines.join('\n')}\n`, 'latin1')
    for (const e of entries) {
      if (!existsSync(e.file)) { res.notSealed.push(e.id); continue }
      // the master key goes to age on stdin (-i -); the plaintext comes back on stdout
      const r = spawnSync(AGE(), ['--decrypt', '--identity', '-', e.file], { input: key, maxBuffer: 64 * 1024 * 1024 })
      if (r.error) throw new Error(`age: ${r.error.message}`)
      if (r.status !== 0) {
        r.stdout?.fill(0)
        throw new Error(`cannot unseal "${e.name}" (${e.id}.age): ${String(r.stderr).split('\n')[0].replace(/^age: error: /, '')}. Nothing was written.`)
      }
      plain.push({ e, data: r.stdout })
    }
    for (const { e, data } of plain) {
      if (existsSync(e.path)) {
        const cur = readFileSync(e.path)
        const same = cur.equals(data)
        cur.fill(0)
        if (same) { marker[e.id] = { plain: sha256(data), age: fileHash(e.file) }; res.same.push(e.id); continue }
        if (!force) { res.kept.push(e.id); continue }
      }
      if (dry) { res.written.push(e.id); continue }
      mkdirSync(dirname(e.path), { recursive: true, mode: 0o700 })
      const tmp = tmpName(e.path)
      tmps.push(tmp)
      const fd = openSync(tmp, 'wx', 0o600)
      try { writeSync(fd, data) } finally { closeSync(fd) }
      renameSync(tmp, e.path)
      // recorded, so the next seal sees the credential as unchanged
      marker[e.id] = { plain: sha256(data), age: fileHash(e.file) }
      res.written.push(e.id)
    }
    if (!dry) writeMarker(place, marker)
    return res
  } finally {
    identity.fill(0)
    key.fill(0)
    for (const { data } of plain) data.fill(0)
    for (const t of tmps) removeQuietly(t)
  }
}

/** Per entry: whether the local file and the sealed file exist. Never opens either. */
export function statusOf(entries) {
  return entries.map(e => ({
    name: e.name,
    id: e.id,
    path: e.path,
    local: existsSync(e.path) && statSync(e.path).size > 0,
    sealed: existsSync(e.file),
  }))
}

/** Generate a master key into `out` with age-keygen (mode 600). Returns the public key. */
export function keygen(out) {
  if (existsSync(out)) throw new Error(`${out} already exists; not overwriting a key`)
  mkdirSync(dirname(out), { recursive: true })
  const r = spawnSync(AGE_KEYGEN(), ['-o', out], { encoding: 'utf8' })
  if (r.error) throw new Error(`age-keygen: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`age-keygen failed: ${r.stderr.trim()}`)
  const y = spawnSync(AGE_KEYGEN(), ['-y', out], { encoding: 'utf8' })
  if (y.status !== 0) throw new Error(`age-keygen -y failed: ${y.stderr.trim()}`)
  return y.stdout.trim()
}
