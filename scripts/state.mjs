#!/usr/bin/env node
/**
 * State repository: one directory per session (ROLE.md, session-state.md, memory/, tools/, data/;
 * the role and session-state file names come from roleFile / sessionState in the team file).
 *
 *   node state.mjs restore  --role worker --n 3     clone or pull, link (or copy) memory, import ROLE.md into the manual
 *   node state.mjs save     --role worker --n 3 [-m "message"]   seal changed credentials (secrets.mjs), commit this session's directory and push
 *   node state.mjs lock     --role leader [--force] [--session <label>]   take the single-leader lock
 *   node state.mjs release  --role leader [--force]                     hand the lock over
 *   node state.mjs status   --role leader|worker [--n N]
 *
 * Common: --team <team.json> (else $TEAM_FILE, else team.json up from the cwd), --dry-run.
 * Workers may set WORKER=<N> instead of --role worker --n N.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseRepoTable } from './lib/repos.mjs'
import { applySave, listFiles, MARK, mirrorDir, readMarker, savePlan, unsavedLocal, writeMarker } from './lib/memsync.mjs'
import { ageVersion, recipientOf, seal, sealedEntries, sealPlace } from './lib/secrets.mjs'
import { absPath, claudeProjectDir, commitMessage, die, git, info, isWin, needUser, ok, parseArgs, roleFilePath, roleFromArgs, secretsOf, sessionStatePath, thisHost, warn } from './lib/team.mjs'

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
const dry = !!args['dry-run']

// `clone` comes before the team file exists (the team file lives in the state repo):
//   node state.mjs clone --repo <git url> --to <dir> [--key <deploy key>]
if (cmd === 'clone') {
  const to = typeof args.to === 'string' ? absPath(args.to) : die('pass --to <directory>')
  if (typeof args.repo !== 'string') die('pass --repo <git url of the state repo>')
  const key = typeof args.key === 'string' ? absPath(args.key) : null
  if (existsSync(join(to, '.git'))) { ok(`${to} already cloned`); process.exit(0) }
  if (key && !existsSync(key)) {
    die(`no deploy key at ${key}: run repos.mjs keys --state-only --yes first (it makes the key and adds it to the repo with the user's gh login)`)
  }
  // core.autocrlf=input: memory files stay LF in the working tree whatever the global setting (Claude Code writes LF)
  const res = git(null, ['clone', '-q', '-c', 'core.autocrlf=input', args.repo, to], { key })
  if (res.status !== 0) die(`clone failed: ${res.stderr.trim()}${key ? ' (deploy key added and writable?)' : ''}`)
  ok(`cloned ${args.repo} → ${to}; the team file is ${join(to, 'team.json')}${existsSync(join(to, 'team.json')) ? '' : ' (missing: write one from examples/team.json)'}`)
  process.exit(0)
}

const { team, r } = roleFromArgs(args)

if (!r.stateRepo) die(`roles.${r.role}.stateRepo is missing`)
if (!r.stateClone) die(`roles.${r.role}.stateClone (where to clone the state repo) is missing`)
const CLONE = absPath(r.stateClone)
const ME = join(CLONE, r.dir ?? '.')
const KEY = r.deployKey && absPath(r.deployKey)
const WORK = r.workDir || die(`roles.${r.role}.workDir is missing`)
const MANUAL = absPath(r.manual ?? 'CLAUDE.md', WORK)
const MEM = join(claudeProjectDir(WORK), 'memory')
const memoryMode = r.memory ?? (isWin ? 'copy' : 'link')
const LOCK = join(ME, 'leader.lock')
const label = r.n ? `${r.role}-${r.n}` : r.role

function g(a, opts = {}) { return git(CLONE, a, { key: KEY, ...opts }) }
function must(res, what) {
  if (res.status !== 0) die(`${what} failed:\n${(res.stderr || res.stdout).trim()}`)
  return res
}

function identityArgs() {
  const name = g(['config', 'user.name']).stdout.trim()
  return name ? [] : ['-c', `user.name=${label}`, '-c', `user.email=${label}@users.noreply.github.com`]
}

function pull() {
  if (dry) { info(`[dry-run] git pull --rebase --autostash (${CLONE})`); return }
  // seal may have written a .gitattributes that is not committed yet, while another member already pushed one;
  // an untracked file in the way stops the pull. Move it aside, pull, then add back the lines the pulled one lacks.
  const attrs = join(CLONE, '.gitattributes')
  const aside = existsSync(attrs) && g(['ls-files', '--error-unmatch', '--', '.gitattributes']).status !== 0 ? readFileSync(attrs, 'utf8') : null
  if (aside !== null) unlinkSync(attrs)
  try {
    const p = g(['pull', '-q', '--rebase', '--autostash'])
    if (p.status !== 0) warn(`pull failed, continuing with the local copy: ${p.stderr.trim()}`)
  } finally {
    if (aside !== null) {
      const cur = existsSync(attrs) ? readFileSync(attrs, 'utf8') : ''
      const have = new Set(cur.split(/\r?\n/).map(l => l.trim()))
      const add = [...new Set(aside.split(/\r?\n/).map(l => l.trim()).filter(l => l && !have.has(l)))]
      if (add.length) writeFileSync(attrs, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`)
    }
  }
}

function commitAndPush(paths, message) {
  message = commitMessage(label, message)
  if (dry) { info(`[dry-run] git add ${paths.join(' ')} && git commit -m "${message}" && git push`); return true }
  must(g(['add', '-A', '--', ...paths]), 'git add')
  if (g(['diff', '--cached', '--quiet']).status === 0) info('nothing to commit')
  else must(g([...identityArgs(), 'commit', '-q', '-m', message]), 'git commit')
  for (let i = 0; i < 5; i++) {
    const p = g(['push', '-q'])
    if (p.status === 0) { ok('pushed'); return true }
    g(['pull', '-q', '--rebase', '--autostash'])
  }
  console.error('❌ push failed (network or deploy key); run save again later')
  return false
}

// ── memory ───────────────────────────────────────────────────────────────
function isLink(p) { try { return lstatSync(p).isSymbolicLink() } catch { return false } }

/** Copy files from src into dst (top level and subdirectories); existing files in dst are kept unless overwrite. */
function copyInto(src, dst, overwrite) {
  mkdirSync(dst, { recursive: true })
  for (const name of readdirSync(src)) {
    if (name === MARK) continue
    const s = join(src, name); const d = join(dst, name)
    if (statSync(s).isDirectory()) copyInto(s, d, overwrite)
    else if (overwrite || !existsSync(d)) copyFileSync(s, d)
  }
}

function restoreMemory() {
  const repoMem = join(ME, 'memory')
  if (dry) { info(`[dry-run] memory (${memoryMode}): ${MEM} ⇄ ${repoMem}`); return }
  mkdirSync(repoMem, { recursive: true })
  mkdirSync(join(MEM, '..'), { recursive: true })
  if (memoryMode === 'link') {
    if (isLink(MEM)) {
      const t = resolve(join(MEM, '..'), readlinkSync(MEM))
      if (t === resolve(repoMem)) { ok(`memory already linked: ${MEM} → ${repoMem}`); return }
      die(`${MEM} links to ${t}, not ${repoMem}; move it away and run restore again`)
    }
    if (existsSync(MEM)) {
      copyInto(MEM, repoMem, false) // keep what was there; the repo wins on name clashes
      const bak = `${MEM}.bak-${Date.now()}`
      renameSync(MEM, bak)
      info(`old memory directory merged into the repo and kept as ${bak}`)
    }
    symlinkSync(repoMem, MEM, 'dir')
    ok(`memory linked: ${MEM} → ${repoMem}`)
  } else {
    // copy mode (Windows: no symlinks without developer mode): repo → local, deletions included,
    // after checking nothing saved only here would be lost (see lib/memsync.mjs)
    const base = readMarker(MEM)
    let local = listFiles(MEM)
    const adopting = !existsSync(join(MEM, MARK)) && local.size > 0
    if (adopting && args.adopt) {
      for (const rel of local.keys()) copyFileSync(join(MEM, rel), mkdirp(join(repoMem, rel)))
      info(`adopted ${local.size} file(s) from ${MEM} into ${repoMem}: run save to push them`)
      local = listFiles(MEM)
    }
    const unsaved = unsavedLocal(adopting && args.adopt ? null : base, local, listFiles(repoMem))
    if (unsaved.length && !args.force) {
      console.log(`\n⚠️  ${MEM} has memory the repo does not have${base ? ' (changed here since the last save or restore)' : adopting ? ' (this directory was not created by restore)' : ''}:`)
      for (const u of unsaved) console.log(`   ${u.what.padEnd(7)} ${u.rel}`)
      needUser([
        'Pick one:',
        `  keep them: run save first (state.mjs save …), then restore again${adopting ? '; for a directory restore did not create, use restore --adopt (local files go into the repo, then save)' : ''}`,
        '  drop them: run restore again with --force (the repo version replaces them)',
      ])
    }
    if (unsaved.length) warn(`--force: discarding ${unsaved.length} local change(s)`)
    mirrorDir(repoMem, MEM)
    writeMarker(MEM, repoMem, listFiles(repoMem))
    ok(`memory copied: ${repoMem} → ${MEM} (save copies it back)`)
  }
}

function mkdirp(file) { mkdirSync(dirname(file), { recursive: true }); return file }

function saveMemoryCopy() {
  if (memoryMode !== 'copy') return
  if (!existsSync(MEM)) { warn(`no memory directory at ${MEM}; nothing copied`); return }
  const repoMem = join(ME, 'memory')
  const base = readMarker(MEM)
  const { plan, conflicts } = savePlan(base, listFiles(MEM), listFiles(repoMem))
  if (conflicts.length && !args.force) {
    console.log(`\n⚠️  changed both here and in the repo since the last sync (another machine saved too):`)
    for (const c of conflicts) console.log(`   ${c}`)
    needUser(['Compare the two versions and merge by hand, or run save with --force to keep this machine\'s versions.'])
  }
  if (dry) { info(`[dry-run] sync ${MEM} ⇄ ${repoMem}: ${[...plan.values()].filter(v => v === 'local').length} from here, ${[...plan.values()].filter(v => v === 'repo').length} from the repo`); return }
  writeMarker(MEM, repoMem, applySave(plan, MEM, repoMem))
  const fromRepo = [...plan.values()].filter(v => v === 'repo').length
  info(`memory copied back: ${MEM} → ${repoMem}${fromRepo ? ` (${fromRepo} file(s) newer in the repo kept and copied here)` : ''}`)
}

// ── manual ───────────────────────────────────────────────────────────────
function importRole() {
  const role = roleFilePath(r)
  if (!role) { info(`no separate role file (roleFile: null): the manual ${MANUAL} is the member's own`); return }
  if (!existsSync(role)) { info(`no ${role} yet; the manual will import it once it exists (run restore again)`); return }
  const ref = `@${role.replaceAll('\\', '/')}`
  const cur = existsSync(MANUAL) ? readFileSync(MANUAL, 'utf8') : ''
  if (cur.includes(ref)) { ok(`manual ${MANUAL} already imports ROLE.md`); return }
  if (dry) { info(`[dry-run] append "${ref}" to ${MANUAL}`); return }
  writeFileSync(MANUAL, `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}\n## My role and workflows\n\n${ref}\n`)
  ok(`manual ${MANUAL} now imports ROLE.md`)
}

// ── lock (single leader) ─────────────────────────────────────────────────
function readLock() {
  if (!existsSync(LOCK)) return null
  try { return JSON.parse(readFileSync(LOCK, 'utf8')) } catch { return { broken: true } }
}
const me = () => ({ host: thisHost(), user: userInfo().username, workDir: WORK })
const isMine = l => l && l.host === thisHost() && l.workDir === WORK
function age(t) {
  const m = Math.round((Date.now() - Date.parse(t)) / 60000)
  return Number.isFinite(m) ? (m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`) : 'unknown'
}
function describe(l) {
  if (!l) return 'free'
  if (l.broken) return 'unreadable lock file'
  return `${l.host} (${l.user}, ${l.workDir}${l.session ? `, ${l.session}` : ''}) since ${l.takenAt}, refreshed ${age(l.refreshedAt ?? l.takenAt)}`
}

function lock() {
  if (!r.lock) die(`roles.${r.role} has no "lock": true; only the leader takes the lock`)
  pull()
  const cur = readLock()
  if (cur && !isMine(cur) && !args.force) {
    console.error(`❌ the leader lock is held by ${describe(cur)}.`)
    console.error('   Do not start a second leader. If that machine is really gone (or the lock looks stale),')
    console.error('   ask the user to confirm, then run lock again with --force.')
    process.exit(3)
  }
  const now = new Date().toISOString()
  const next = { ...me(), session: typeof args.session === 'string' ? args.session : undefined, takenAt: isMine(cur) ? cur.takenAt : now, refreshedAt: now }
  if (cur && !isMine(cur)) warn(`taking the lock over from ${describe(cur)} (--force)`)
  if (!dry) writeFileSync(LOCK, `${JSON.stringify(next, null, 2)}\n`)
  if (!commitAndPush([LOCK], `leader lock: ${next.host}`)) process.exit(1)
  // someone may have pushed a lock between our pull and push: the rebase would have shown it
  if (!dry) {
    const after = readLock()
    if (!isMine(after)) { console.error(`❌ lost the race: the lock is now held by ${describe(after)}`); process.exit(3) }
  }
  ok(`leader lock held by ${next.host}`)
}

function release() {
  pull()
  const cur = readLock()
  if (!cur) { ok('lock already free'); return }
  if (!isMine(cur) && !args.force) die(`lock is held by ${describe(cur)}, not this session; --force to remove anyway`, 3)
  if (!dry) unlinkSync(LOCK)
  if (commitAndPush([LOCK], 'leader lock: release')) ok('leader lock released')
}

function refreshLock() {
  const cur = readLock()
  if (!isMine(cur) || dry) return
  writeFileSync(LOCK, `${JSON.stringify({ ...cur, refreshedAt: new Date().toISOString() }, null, 2)}\n`)
}

// ── commands ─────────────────────────────────────────────────────────────
function restore() {
  if (!existsSync(join(CLONE, '.git'))) {
    if (KEY && !existsSync(KEY)) {
      die(`no deploy key at ${KEY}: run repos.mjs keys --state-only --yes first (on the machine with the user's gh login; it makes the key here and adds it to the state repo)`)
    }
    info(`cloning ${r.stateRepo} → ${CLONE}`)
    if (!dry) must(git(null, ['clone', '-q', '-c', 'core.autocrlf=input', r.stateRepo, CLONE], { key: KEY }), 'git clone')
  } else pull()
  if (!dry) for (const d of ['memory', 'tools', 'data']) mkdirSync(join(ME, d), { recursive: true })
  restoreMemory()
  importRole()
  const manual = []
  if (r.bot?.profile) manual.push(`lark-cli profile ${r.bot.profile} (check: node scripts/lark.mjs check …)`)
  if (r.channel) manual.push('Feishu channel: node scripts/channel.mjs install, then place (it checks the App Secret file) …')
  try {
    const rf = roleFilePath(r)
    const extra = rf && existsSync(rf) ? parseRepoTable(readFileSync(rf, 'utf8')) : []
    if (extra.length) manual.push(`repos in ROLE.md (${extra.map(x => x.clone).join(', ')}): node scripts/repos.mjs keys --yes, then repos.mjs clone --yes`)
  } catch (e) { warn(e.message) }
  // credentials sealed in the repo come back in one step with the master key; the rest are filled one by one
  let sealed = []
  try { sealed = sealedEntries(r).filter(e => existsSync(e.file)) } catch (e) { warn(e.message) }
  if (sealed.length) manual.push(`sealed credentials (${sealed.map(e => e.id).join(', ')}): unseal with the master key file the user names (host.mjs unseal --identity <file> for a docker member, secrets.mjs unseal --identity <file> here); the session never opens that file`)
  for (const s of secretsOf(r)) {
    if (s.path && sealed.some(e => e.path === absPath(s.path))) continue
    manual.push(`${s.name}: ${s.path ?? '(see note)'}, filled by ${s.by ?? 'the user'}${s.note ? ` (${s.note})` : ''}`)
  }
  if (manual.length) {
    console.log('\nStill to do by hand (credentials never live in the state repo):')
    for (const m of manual) console.log(`  - ${m}`)
  }
  console.log(`\nThen read ${sessionStatePath(r)} to pick up where the last session stopped.`)
}

function save() {
  if (!existsSync(join(CLONE, '.git'))) die(`${CLONE} is not cloned yet; run restore first`)
  pull() // first, so copy-mode memory is compared with what other machines saved
  saveMemoryCopy()
  sealChanged()
  if (r.lock) refreshLock()
  const msg = typeof args.m === 'string' ? args.m : (args._[1] || 'state')
  // .gitattributes holds "*.age binary" (seal adds it), so it goes with the member's directory
  const paths = [r.dir ?? '.', ...(existsSync(join(CLONE, '.gitattributes')) ? ['.gitattributes'] : [])]
  if (!commitAndPush(paths, msg)) process.exit(1)
}

/** Seal credentials that changed since the last seal, so save carries them. A problem here warns; it does not stop the save. */
function sealChanged() {
  let entries, recipient
  try { entries = sealedEntries(r); recipient = recipientOf(team, r) } catch (e) { warn(`sealed credentials skipped: ${e.message}`); return }
  if (!entries.length) return
  if (!recipient) { warn('sealed credentials skipped: the team file has no secretsRecipient'); return }
  if (!ageVersion()) { warn('sealed credentials skipped: age is not installed (secrets.mjs age prints the command that installs it)'); return }
  try {
    const res = seal(entries, recipient, { dry, place: sealPlace(r) })
    if (res.sealed.length) ok(`sealed: ${res.sealed.join(', ')}`)
    const other = [...res.elsewhere, ...res.foreign]
    if (other.length) warn(`sealed elsewhere, not sealed again from here: ${other.join(', ')} (see secrets.mjs seal)`)
  } catch (e) { warn(`sealed credentials skipped: ${e.message}`) }
}

function status() {
  console.log(`role: ${label}   runtime: ${r.runtimeMode}   memory: ${memoryMode}`)
  console.log(`state repo: ${r.stateRepo} → ${CLONE}${existsSync(join(CLONE, '.git')) ? '' : ' (not cloned)'}`)
  console.log(`directory: ${ME}`)
  console.log(`memory: ${MEM}${isLink(MEM) ? ` → ${readlinkSync(MEM)}` : existsSync(join(MEM, MARK)) ? ' (copy)' : existsSync(MEM) ? ' (plain directory, not restored)' : ' (missing)'}`)
  console.log(`manual: ${MANUAL}`)
  if (r.lock) console.log(`leader lock: ${describe(readLock())}${isMine(readLock()) ? ' ← this session' : ''}`)
}

switch (cmd) {
  case 'restore': restore(); break
  case 'save': save(); break
  case 'lock': lock(); break
  case 'release': release(); break
  case 'status': status(); break
  default:
    console.error('usage: state.mjs restore|save|lock|release|status --role leader|worker [--n N] [--team team.json] [--dry-run]')
    process.exit(2)
}
