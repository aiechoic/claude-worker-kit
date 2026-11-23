#!/usr/bin/env node
/**
 * Open-source boundary check: fails when a tracked file holds something that must not be published.
 *
 *   node scripts/check-public.mjs
 *
 * Built in: Feishu ids (cli_ / oc_ / ou_ followed by real-looking hex), private keys, age master keys, sealed .age files,
 * App-Secret-like assignments, hostnames that are not example ones. Project words (names of the team, its business, internal hosts) go into an
 * untracked `.public-denylist` file (one regex per line), or into the PUBLIC_DENYLIST env var (newline-separated)
 * in CI, so the list itself is not published.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
const rules = [
  [/\b(cli|oc|ou|on)_[0-9a-f]{16,}\b/g, 'Feishu id (use cli_example… / oc_example…)'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'private key'],
  [/AGE-SECRET-KEY-1[0-9A-Z]{20,}/g, 'age master key'],
  [/\bssh-(ed25519|rsa) AAAA[0-9A-Za-z+/]{20,}/g, 'public key (fine to send, but not to keep in this repo)'],
  [/"app_?secret"\s*:\s*"[^"<]{8,}"/gi, 'inline App Secret'],
  [/\bsk-[A-Za-z0-9]{20,}\b/g, 'API key'],
  [/\b(?:[a-z0-9-]+\.)+(?:com|cn|net|io|org|dev|cloud)\b/gi, 'hostname', h => !ALLOWED_HOSTS.some(a => h.toLowerCase() === a || h.toLowerCase().endsWith(`.${a}`))],
]
// hosts every user of this kit talks to; anything else must be an *.example name
const ALLOWED_HOSTS = ['github.com', 'githubusercontent.com', 'claude.ai', 'claude.com', 'anthropic.com', 'nodejs.org', 'feishu.cn', 'larksuite.com', 'npmjs.com', 'docker.com', 'microsoft.com', 'opensource.org']

const extra = [
  ...(existsSync('.public-denylist') ? readFileSync('.public-denylist', 'utf8').split('\n') : []),
  ...(process.env.PUBLIC_DENYLIST ?? '').split('\n'),
].map(s => s.trim()).filter(s => s && !s.startsWith('#'))
for (const e of extra) rules.push([new RegExp(e, 'gi'), 'denylisted word'])

let bad = 0
for (const f of files) {
  if (f === 'scripts/check-public.mjs') continue
  if (f.endsWith('.age')) { bad++; console.log(`${f}: sealed credential file (belongs in a private state repo)`); continue }
  let text
  try { text = readFileSync(f, 'utf8') } catch { continue }
  text.split('\n').forEach((line, i) => {
    for (const [re, what, keep] of rules) {
      for (const m of line.matchAll(re)) {
        if (keep && !keep(m[0])) continue
        bad++
        console.log(`${f}:${i + 1}: ${what}: ${m[0].slice(0, 40)}`)
      }
    }
  })
}
if (extra.length === 0) console.log('note: no project denylist (.public-denylist or PUBLIC_DENYLIST); only built-in rules ran')
console.log(bad ? `\n❌ ${bad} finding(s)` : `✅ ${files.length} tracked files clean`)
process.exit(bad ? 1 : 0)
