// Copy-mode memory (Windows): keep Claude Code's memory directory and the repo's memory/ in step without symlinks.
//
// A marker file in the local memory directory records what both sides held at the last sync (restore or save):
// a hash per file. With it, every file is compared three ways (base = last sync, local, repo), so neither direction
// silently overwrites the other:
//   restore (repo → local): a local file changed or deleted since the last sync, and not already equal to the repo,
//            is "unsaved". If there is any, stop and list them (save first, or --force to discard).
//   save    (local → repo): a file changed only in the repo since the last sync (another machine saved) keeps the repo
//            version; a file changed on both sides differently is a conflict. Stop and list (--force: local wins).
// Without a marker (a memory directory that restore did not create), restore treats every local file that differs
// from the repo as unsaved, and `--adopt` takes the local files into the repo first.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'

export const MARK = '.state-repo-copy'

/**
 * Content hash with line endings unified: a clone made with core.autocrlf=true has CRLF where Claude Code wrote LF,
 * and the same text must count as the same file. Binary files (with a NUL byte) are hashed as they are.
 */
export function contentHash(buf) {
  const b = buf.includes(0) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
  return createHash('sha256').update(b).digest('hex')
}
const sha = p => contentHash(readFileSync(p))

/** rel path (with /) → sha256, for every file under dir except the marker. */
export function listFiles(dir) {
  const out = new Map()
  if (!existsSync(dir)) return out
  const walk = d => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else {
        const rel = relative(dir, p).split(sep).join('/')
        if (rel !== MARK) out.set(rel, sha(p))
      }
    }
  }
  walk(dir)
  return out
}

/** The last sync's file hashes, or null when there is no usable marker. */
export function readMarker(localDir) {
  const p = join(localDir, MARK)
  if (!existsSync(p)) return null
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'))
    return m && typeof m.files === 'object' ? new Map(Object.entries(m.files)) : null
  } catch { return null } // an old plain-text marker: no hashes
}

export function writeMarker(localDir, repoDir, files) {
  mkdirSync(localDir, { recursive: true })
  writeFileSync(join(localDir, MARK), `${JSON.stringify({ repo: repoDir, syncedAt: new Date().toISOString(), files: Object.fromEntries([...files].sort()) }, null, 1)}\n`)
}

const union = (...maps) => new Set(maps.flatMap(m => (m ? [...m.keys()] : [])))

/** Local changes the repo does not have: [{ rel, what: 'changed' | 'new' | 'deleted' }]. */
export function unsavedLocal(base, local, repo) {
  const out = []
  for (const rel of union(base, local, repo)) {
    const b = base?.get(rel); const l = local.get(rel); const r = repo.get(rel)
    if (l === r) continue
    if (base) {
      if (l === b) continue // untouched here since the last sync: the repo's version is newer, take it
      out.push({ rel, what: l === undefined ? 'deleted' : b === undefined ? 'new' : 'changed' })
    } else if (l !== undefined) {
      out.push({ rel, what: r === undefined ? 'new' : 'changed' })
    }
  }
  return out.sort((x, y) => x.rel.localeCompare(y.rel))
}

/**
 * What save should make both sides hold: Map rel → 'local' | 'repo' | null (deleted), plus conflicts.
 * Without a base (first save after adopting), local wins and repo-only files are kept.
 */
export function savePlan(base, local, repo) {
  const plan = new Map(); const conflicts = []
  for (const rel of union(base, local, repo)) {
    const b = base?.get(rel); const l = local.get(rel); const r = repo.get(rel)
    let take
    if (l === r) take = l === undefined ? null : 'local'
    else if (!base) take = l === undefined ? 'repo' : 'local'
    else if (l === b) take = r === undefined ? null : 'repo' // changed only in the repo
    else if (r === b) take = l === undefined ? null : 'local' // changed only here
    else { conflicts.push(rel); take = l === undefined ? null : 'local' }
    plan.set(rel, take)
  }
  return { plan, conflicts: conflicts.sort() }
}

function put(src, dst) { mkdirSync(dirname(dst), { recursive: true }); writeFileSync(dst, readFileSync(src)) }

/** Make dst hold exactly src's files (deletions included), the marker aside. */
export function mirrorDir(src, dst) {
  const s = listFiles(src); const d = listFiles(dst)
  for (const rel of d.keys()) if (!s.has(rel)) rmSync(join(dst, rel), { force: true })
  for (const [rel, h] of s) if (d.get(rel) !== h) put(join(src, rel), join(dst, rel))
}

/** Apply a save plan to both directories; returns the resulting file map (for the marker). */
export function applySave(plan, localDir, repoDir) {
  for (const [rel, take] of plan) {
    const l = join(localDir, rel); const r = join(repoDir, rel)
    if (take === null) { rmSync(l, { force: true }); rmSync(r, { force: true }) }
    else if (take === 'local') put(l, r)
    else put(r, l)
  }
  return listFiles(repoDir)
}
