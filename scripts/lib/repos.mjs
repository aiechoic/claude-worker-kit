// The repos a member works in besides its state repo, listed in its ROLE.md under a fixed heading:
//
//   ## Repositories
//
//   | repo | clone | key | host | access |
//   | --- | --- | --- | --- | --- |
//   | git@github.com:owner/tool.git | /work/src/tool | /work/.ssh/tool | gh-tool | write |
//
// repo: the git URL. clone: where it is cloned. key: the deploy key (private key path; .pub next to it).
// host: an ssh Host alias written to ~/.ssh/config (empty: the clone gets core.sshCommand instead).
// access: write (default) or read, for the deploy key.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const HEADING = 'Repositories'
const COLS = ['repo', 'clone', 'key', 'host', 'access']

const cell = c => c.trim().replace(/^`(.*)`$/, '$1').trim()
const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell)

/**
 * The table under `## Repositories` in a ROLE.md (or a manual). Returns [] when there is no such section.
 * Throws on a table without the columns repo, clone and key, or a row missing repo or clone.
 */
export function parseRepoTable(markdown) {
  const lines = String(markdown).split(/\r?\n/)
  const at = lines.findIndex(l => new RegExp(`^##\\s+${HEADING}\\s*$`, 'i').test(l.trim()))
  if (at < 0) return []
  let i = at + 1
  while (i < lines.length && !lines[i].trim().startsWith('|')) {
    if (/^#{1,2}\s/.test(lines[i].trim())) return []
    i++
  }
  if (i >= lines.length) return []
  const head = splitRow(lines[i]).map(h => h.toLowerCase())
  for (const c of ['repo', 'clone', 'key']) if (!head.includes(c)) throw new Error(`ROLE.md "## ${HEADING}": the table needs the columns ${COLS.join(', ')} (missing "${c}")`)
  const out = []
  for (i += 1; i < lines.length && lines[i].trim().startsWith('|'); i++) {
    const cells = splitRow(lines[i])
    if (cells.every(c => /^:?-+:?$/.test(c))) continue
    const row = Object.fromEntries(head.map((h, k) => [h, cells[k] ?? '']))
    for (const c of ['repo', 'clone']) if (!row[c]) throw new Error(`ROLE.md "## ${HEADING}": row "${lines[i].trim()}" has no ${c}`)
    const access = (row.access || 'write').toLowerCase()
    if (!['read', 'write'].includes(access)) throw new Error(`ROLE.md "## ${HEADING}": access must be read or write, not "${row.access}"`)
    if (row.host && !/^[\w.-]+$/.test(row.host)) throw new Error(`ROLE.md "## ${HEADING}": host "${row.host}" is not an ssh Host name`)
    if (row.host && !row.key) throw new Error(`ROLE.md "## ${HEADING}": row "${lines[i].trim()}" has a host but no key (the ssh Host needs the key)`)
    out.push({ repo: row.repo, clone: row.clone, key: row.key || null, host: row.host || null, access })
  }
  return out
}

/** A local path or file:// URL (tests, mirrors): cloned without ssh. */
export const isLocalRepo = url => /^file:\/\//.test(url) || /^[A-Za-z]:[\\/]/.test(url) || url.startsWith('/')

/** The URL a row is cloned from: through its ssh Host alias when it has one; https for a row without a key. */
export function cloneUrl(row, slug) {
  if (isLocalRepo(row.repo)) return row.repo
  if (!row.key) return /^https?:\/\//.test(row.repo) ? row.repo : `https://github.com/${slug}.git`
  if (!row.host) return row.repo
  return `git@${row.host}:${slug}.git`
}

const begin = host => `# >>> worker-kit: ${host}`
const end = host => `# <<< worker-kit: ${host}`

/** The ~/.ssh/config block for a row with a host alias. */
export function sshBlock(row) {
  return [begin(row.host), `Host ${row.host}`, '  HostName github.com', '  User git', `  IdentityFile ${row.key}`, '  IdentitiesOnly yes', '  StrictHostKeyChecking accept-new', end(row.host)].join('\n')
}

/**
 * Put the block for each row with a host into the ssh config text: a block this kit wrote is replaced, a Host the user
 * wrote by hand is left alone (reported in `kept`). Returns { text, changed, kept }.
 */
export function withSshBlocks(text, rows) {
  let out = String(text ?? '')
  const kept = []
  let changed = false
  for (const row of rows.filter(x => x.host)) {
    const block = sshBlock(row)
    const re = new RegExp(`${begin(row.host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end(row.host).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    if (re.test(out)) {
      const next = out.replace(re, block)
      if (next !== out) { out = next; changed = true }
    } else if (new RegExp(`^\\s*Host\\s+(.*\\s)?${row.host.replace(/[.]/g, '\\.')}(\\s|$)`, 'm').test(out)) {
      kept.push(row.host)
    } else {
      out = `${out}${out && !out.endsWith('\n') ? '\n' : ''}${out ? '\n' : ''}${block}\n`
      changed = true
    }
  }
  return { text: out, changed, kept }
}

export function sshConfigPath(home = homedir()) { return join(home, '.ssh', 'config') }

/** Write the ssh config blocks (mode 600, ~/.ssh mode 700). */
export function writeSshConfig(rows, { home = homedir(), dry = false } = {}) {
  const file = sshConfigPath(home)
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const res = withSshBlocks(cur, rows)
  if (res.changed && !dry) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, res.text, { mode: 0o600 })
  }
  return { file, ...res }
}
