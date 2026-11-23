// Sealed credentials: each `secrets` entry marked `sealed: true` is kept in the member's state directory as
// `secrets/<id>.age`, encrypted with the official age tool to the team's public key (`secretsRecipient`).
// Sealing needs only the public key; unsealing needs the master key, which the user keeps and hands over once.
// Nothing here reads a credential into this process except unseal, which holds the decrypted bytes in memory
// until every file has decrypted, then writes them. The master key never goes to a file, an argument or the environment.
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { absPath, isWin, secretsOf, stateDir } from './team.mjs'

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const AGE = process.env.WORKER_KIT_AGE || 'age'
const AGE_KEYGEN = process.env.WORKER_KIT_AGE_KEYGEN || 'age-keygen'

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

/** age's version, or null when the age binaries are not installed. */
export function ageVersion() {
  const a = spawnSync(AGE, ['--version'], { encoding: 'utf8' })
  const k = spawnSync(AGE_KEYGEN, ['--version'], { encoding: 'utf8' })
  if (a.error || a.status !== 0 || k.error || k.status !== 0) return null
  return a.stdout.trim()
}

export function ageInstallHint() {
  return isWin
    ? ['Install the official age tool, then open a new terminal so PATH picks it up:', '  winget install FiloSottile.age']
    : ['Install the official age tool (1.1 or later):', '  sudo apt install age        # Debian / Ubuntu', '  or download a release from https://github.com/FiloSottile/age/releases and put age and age-keygen on PATH']
}

function tmpName(file) {
  return join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${Date.now()}`)
}

function removeQuietly(f) {
  try { unlinkSync(f) } catch {}
}

/**
 * Encrypt each sealed entry whose local file exists into the state repo.
 * An entry is skipped when its .age is newer than the local file (unchanged since the last seal or unseal), unless force.
 * @returns {{ sealed: string[], unchanged: string[], missing: string[] }} ids
 */
export function seal(entries, recipient, { force = false, dry = false } = {}) {
  const res = { sealed: [], unchanged: [], missing: [] }
  for (const e of entries) {
    if (!existsSync(e.path) || statSync(e.path).size === 0) { res.missing.push(e.id); continue }
    if (!force && existsSync(e.file) && statSync(e.file).mtimeMs >= statSync(e.path).mtimeMs) { res.unchanged.push(e.id); continue }
    if (dry) { res.sealed.push(e.id); continue }
    mkdirSync(dirname(e.file), { recursive: true })
    const tmp = tmpName(e.file)
    try {
      // age reads the credential file itself; it never passes through this process
      const r = spawnSync(AGE, ['--encrypt', '--recipient', recipient, '--output', tmp, e.path], { encoding: 'utf8' })
      if (r.error) throw new Error(`age: ${r.error.message}`)
      if (r.status !== 0) throw new Error(`age could not seal "${e.name}": ${r.stderr.trim()}`)
      renameSync(tmp, e.file)
    } finally {
      removeQuietly(tmp)
    }
    res.sealed.push(e.id)
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
export function unseal(entries, identity, { force = false, dry = false } = {}) {
  const res = { written: [], same: [], kept: [], notSealed: [] }
  const plain = []
  const tmps = []
  let key = Buffer.alloc(0)
  try {
    // a key copied from a password manager may carry spaces or CR LF, which age rejects: keep the key lines, trimmed
    const lines = identity.toString('latin1').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    if (!lines.length || !lines.every(l => /^AGE-SECRET-KEY-1[0-9A-Z]+$/.test(l))) throw new Error('the master key is not an age identity (AGE-SECRET-KEY-1…)')
    key = Buffer.from(`${lines.join('\n')}\n`, 'latin1')
    for (const e of entries) {
      if (!existsSync(e.file)) { res.notSealed.push(e.id); continue }
      // the master key goes to age on stdin (-i -); the plaintext comes back on stdout
      const r = spawnSync(AGE, ['--decrypt', '--identity', '-', e.file], { input: key, maxBuffer: 64 * 1024 * 1024 })
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
        if (same) { res.same.push(e.id); continue }
        if (!force) { res.kept.push(e.id); continue }
      }
      if (dry) { res.written.push(e.id); continue }
      mkdirSync(dirname(e.path), { recursive: true, mode: 0o700 })
      const tmp = tmpName(e.path)
      tmps.push(tmp)
      const fd = openSync(tmp, 'wx', 0o600)
      try { writeSync(fd, data) } finally { closeSync(fd) }
      renameSync(tmp, e.path)
      // the .age is now newer than the file, so the next seal sees it as unchanged
      const now = new Date()
      try { utimesSync(e.file, now, now) } catch {}
      res.written.push(e.id)
    }
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
  const r = spawnSync(AGE_KEYGEN, ['-o', out], { encoding: 'utf8' })
  if (r.error) throw new Error(`age-keygen: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`age-keygen failed: ${r.stderr.trim()}`)
  const y = spawnSync(AGE_KEYGEN, ['-y', out], { encoding: 'utf8' })
  if (y.status !== 0) throw new Error(`age-keygen -y failed: ${y.stderr.trim()}`)
  return y.stdout.trim()
}
