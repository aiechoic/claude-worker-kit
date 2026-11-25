#!/usr/bin/env node
/**
 * Deploy keys and clones of a member's repos: its state repo (team file: stateRepo, deployKey) and the repos its
 * ROLE.md lists under "## Repositories" (references/team-file.md#rolemd-repositories); with roleFile: null, the manual's
 * section. A row without a key is cloned over https with the GitHub CLI's login (token only in $GH_TOKEN).
 * Then the role's setup steps (team file: setup) for what is particular to the project.
 *
 *   node repos.mjs list  --role … [--n N]            the repos, with whether each key and clone exists
 *   node repos.mjs keys  --role … [--n N] [--yes]    make each missing deploy key in the member, add each public key to
 *                                                    its GitHub repo with the user's gh login (state repo first)
 *   node repos.mjs clone --role … [--n N] [--yes]    write the ssh Host blocks, clone the ROLE.md repos that are missing
 *   node repos.mjs setup --role … [--n N] [--yes]    the setup steps in order: check passes → skipped; else run, then
 *                                                    check again. The first failing step stops the rest
 *   node repos.mjs ensure-key --key <path> --comment <text> [--check]   (inside the member) make a key if missing, print the .pub line
 *
 * Common: --team <team.json>, --state-only (keys: only the state repo, before it is cloned).
 * Run keys on the machine with the user's gh (the docker host for a docker member: the member's side goes through
 * docker exec and the kit copied in by host.mjs copy-kit). Without --yes nothing changes.
 * Private keys never leave the member; only .pub lines are read.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { dockerHost, q } from './lib/docker.mjs'
import { addDeployKey, cloneToken, needGh, repoSlug, tokenGitArgs } from './lib/gh.mjs'
import { cloneUrl, isLocalRepo, parseRepoTable, writeSshConfig } from './lib/repos.mjs'
import { absPath, die, info, isWin, ok, parseArgs, roleFilePath, roleFromArgs, warn } from './lib/team.mjs'

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
const yes = !!args.yes
const KIT_INSIDE = process.env.WORKER_KIT_INSIDE || '/opt/worker-kit'

/** Make the key when missing (unless check); its .pub line, or 'missing'. Throws when ssh-keygen fails. */
function ensureKeyAt(keyPath, comment, check) {
  const key = absPath(keyPath)
  if (!existsSync(key)) {
    if (check) return 'missing'
    mkdirSync(dirname(key), { recursive: true, mode: 0o700 })
    const res = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', String(comment ?? 'worker-kit'), '-f', key], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' })
    if (res.status !== 0) throw new Error(`ssh-keygen failed: ${(res.stderr || res.error?.message || '').trim()}`)
  }
  const pub = readFileSync(`${key}.pub`, 'utf8').trim().split('\n')[0]
  if (!/^ssh-(ed25519|rsa) /.test(pub)) throw new Error(`${key}.pub is not a public key line`)
  return pub
}
if (cmd === 'ensure-key') {
  if (typeof args.key !== 'string') die('pass --key <path>')
  try { console.log(ensureKeyAt(args.key, args.comment, !!args.check)) } catch (e) { die(e.message) }
  process.exit(0)
}

const { r } = roleFromArgs(args)
const label = r.n ? `${r.role}-${r.n}` : r.role
const docker = r.runtimeMode === 'docker' && !args.here
const H = docker ? dockerHost(r, { yes: true }) : null
const innerTeam = typeof args['inner-team'] === 'string' ? args['inner-team'] : `${r.stateClone}/team.json`
const roleArgs = `--role ${q(r.role)}${r.n ? ` --n ${q(r.n)}` : ''}`

/** The .pub line of a key in the member (made when missing, unless check): through docker for a docker member. */
function memberKey(key, comment, check = false) {
  if (!docker) {
    try { return { status: 0, stdout: ensureKeyAt(key, comment, check) } } catch (e) { return { status: 1, stdout: '', stderr: e.message } }
  }
  return H.runScript(`node ${KIT_INSIDE}/scripts/repos.mjs ensure-key --key ${q(key)}${check ? ' --check' : ` --comment ${q(comment)}`}`, { capture: true })
}

/** The file with the "## Repositories" section: the role file, or the manual when the role has none (roleFile: null). */
function roleText() {
  const f = roleFilePath(r) ?? (r.workDir && absPath(r.manual ?? 'CLAUDE.md', r.workDir))
  if (!f) return null
  if (!docker) return existsSync(f) ? readFileSync(f, 'utf8') : null
  const res = H.runScript(`cat ${q(f)} 2>/dev/null`, { capture: true })
  return res.status === 0 ? res.stdout : null
}

/** The state repo, then the ROLE.md repos (when the state repo is cloned already). */
function repos({ stateOnly = false } = {}) {
  const list = []
  if (r.stateRepo) list.push({ repo: r.stateRepo, clone: r.stateClone, key: r.deployKey ?? null, host: null, access: 'write', state: true })
  if (stateOnly) return { list, role: false }
  const text = roleText()
  if (text === null) return { list, role: false }
  try { list.push(...parseRepoTable(text)) } catch (e) { die(e.message) }
  return { list, role: true }
}

function list() {
  const { list: rows, role } = repos()
  for (const x of rows) {
    const key = x.key ? `key ${x.key} ${memberKey(x.key, null, true).stdout === 'missing' ? '(missing)' : '(present)'}` : 'no key: https with the gh login'
    info(`${x.state ? 'state repo ' : ''}${x.repo} → ${x.clone}; ${key}; ${x.host ? `ssh Host ${x.host}; ` : ''}${x.access}`)
  }
  if (!role) info(`ROLE.md is not there yet (state repo not cloned): only the state repo is listed`)
}

function keys() {
  const { list: all, role } = repos({ stateOnly: !!args['state-only'] })
  for (const x of all.filter(x => !x.key && !isLocalRepo(x.repo))) info(`${x.repo}: no deploy key; cloned over https with the gh login`)
  const rows = all.filter(x => x.key)
  if (!rows.length) { ok('no repos with deploy keys for this member'); return }
  const gh = needGh('adding deploy keys')
  const where = docker ? H.C : hostname()
  const date = new Date().toISOString().slice(0, 10)
  let failed = 0
  for (const x of rows) {
    if (isLocalRepo(x.repo)) { info(`${x.repo}: a local repo, no deploy key`); continue }
    const slug = repoSlug(x.repo)
    if (!yes) {
      const k = memberKey(x.key, null, true).stdout
      console.log(`  [plan] ${k === 'missing' ? `make ${x.key} in ${where}, ` : ''}add its public key to ${slug} as a ${x.access === 'read' ? 'read-only' : 'writable'} deploy key "${label}@${where} ${date}"`)
      continue
    }
    const k = memberKey(x.key, `${label}@${where}`)
    if (k.status !== 0) { warn(`${x.key}: ${k.stderr || 'cannot make or read the key'}`); failed++; continue }
    const res = addDeployKey(gh, slug, k.stdout, { title: `${label}@${where} ${date}`, readOnly: x.access === 'read' })
    if (res.error) { warn(res.error); failed++ }
    else if (res.added) ok(`${slug}: deploy key added (${x.access === 'read' ? 'read-only' : 'writable'}) "${res.title}"`)
    else if (res.readOnly && x.access === 'write') { warn(`${slug}: this key is already there as "${res.title}" but read-only; remove it on GitHub and run keys again`); failed++ }
    else ok(`${slug}: deploy key already there ("${res.title}")`)
  }
  if (!yes) console.log('\nNothing changed. Add --yes to make the keys and add them.')
  if (!role && !args['state-only']) info('ROLE.md is not there yet: after state.mjs restore, run keys again for the repos it lists')
  if (failed) process.exit(1)
}

/** Clone the ROLE.md repos, in the member. */
function clone() {
  if (docker) {
    const res = H.runScript(`node ${KIT_INSIDE}/scripts/repos.mjs clone ${roleArgs} --team ${q(innerTeam)} --here${yes ? ' --yes' : ''}`)
    process.exit(res.status)
  }
  const { list: rows, role } = repos()
  if (!role) die('ROLE.md is not there: state.mjs restore first')
  const extra = rows.filter(x => !x.state)
  if (!extra.length) { ok('ROLE.md lists no other repos'); return }
  const ssh = writeSshConfig(extra, { dry: !yes })
  if (ssh.changed) (yes ? ok : info)(`${yes ? 'wrote' : '[plan] write'} ssh Host blocks for ${extra.filter(x => x.host).map(x => x.host).join(', ')} in ${ssh.file}`)
  for (const h of ssh.kept) warn(`${ssh.file} already has a Host ${h} written by hand; left as it is`)
  let failed = 0
  let token = null
  for (const x of extra) {
    const dir = absPath(x.clone)
    if (existsSync(join(dir, '.git'))) { ok(`${x.clone}: already cloned`); continue }
    const local = isLocalRepo(x.repo)
    const https = !local && !x.key
    const url = local ? x.repo : cloneUrl(x, repoSlug(x.repo))
    const sshCmd = x.key && `ssh -i ${absPath(x.key).replaceAll('\\', '/')} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
    const a = ['clone', '-q', ...(x.host || local || https ? [] : ['-c', `core.sshCommand=${sshCmd}`]), url, dir]
    if (!yes) { console.log(`  [plan] git ${a.join(' ')}${https ? '   (https with the gh login)' : ''}`); continue }
    if (!local && x.key && !existsSync(absPath(x.key))) { warn(`${x.key} is missing: repos.mjs keys first`); failed++; continue }
    // the token only in the environment of this git, read by the credential helper; the remote stays the plain URL
    if (https && token === null) token = cloneToken(x.repo)
    mkdirSync(dirname(dir), { recursive: true })
    const res = spawnSync('git', https ? [...tokenGitArgs(), ...a] : a, { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(https ? { GH_TOKEN: token } : {}) } })
    const why = (res.stderr ?? '').trim().split('\n')[0]
    if (res.status !== 0) { warn(`clone of ${x.repo} failed: ${token ? why.replaceAll(token, '***') : why} (${https ? 'does the gh login have access to it?' : 'deploy key added? repos.mjs keys'})`); failed++ }
    else ok(`${x.repo} → ${x.clone}`)
  }
  if (failed) process.exit(1)
}

/**
 * The role's setup steps (team file: setup, a list of { name, run, check?, cwd? }), in order, in the member's work
 * directory. Their output is printed as it is: a step must not print credentials.
 */
function setup() {
  if (docker) {
    const res = H.runScript(`node ${KIT_INSIDE}/scripts/repos.mjs setup ${roleArgs} --team ${q(innerTeam)} --here${yes ? ' --yes' : ''}`)
    process.exit(res.status)
  }
  const steps = [].concat(r.setup ?? [])
  if (!steps.length) { ok(`no setup steps for ${label} (team file: setup)`); return }
  const env = { ...process.env, WORKER_KIT_ROLE: r.role, WORKER_KIT_N: r.n ? String(r.n) : '', WORKER_KIT_WORK_DIR: r.workDir ?? '', WORKER_KIT_STATE_CLONE: r.stateClone ? absPath(r.stateClone) : '' }
  const sh = (line, cwd) => spawnSync(line, { shell: isWin ? true : '/bin/bash', cwd, env, stdio: ['ignore', 'inherit', 'inherit'] }).status
  steps.forEach((s, i) => {
    const name = `setup ${i + 1} of ${steps.length} "${s?.name ?? '(no name)'}"`
    if (!s || typeof s.run !== 'string') die(`${name}: needs a "run" command`)
    const cwd = absPath(s.cwd ?? '.', r.workDir)
    if (!existsSync(cwd)) die(`${name}: the directory ${cwd} is missing`)
    if (s.check) {
      console.log(`${name}: check  ${s.check}`)
      if (sh(s.check, cwd) === 0) { ok(`${name}: in place`); return }
    }
    if (!yes) { console.log(`  [plan] ${name}: run  ${s.run}`); return }
    console.log(`${name}: run  ${s.run}`)
    const st = sh(s.run, cwd)
    if (st !== 0) die(`${name} failed (exit ${st}); the steps after it did not run. Fix the cause, then run setup again`)
    if (s.check && sh(s.check, cwd) !== 0) die(`${name}: ran, but its check still fails: ${s.check}. The steps after it did not run`)
    ok(`${name}: done`)
  })
  if (!yes) console.log('\nNothing changed. Add --yes to run the steps.')
}

switch (cmd) {
  case 'setup': setup(); break
  case 'list': list(); break
  case 'keys': keys(); break
  case 'clone': clone(); break
  default:
    console.error('usage: repos.mjs list|keys|clone|setup --role leader|worker [--n N] [--team team.json] [--yes] [--state-only]\n       repos.mjs ensure-key --key <path> --comment <text> [--check]')
    process.exit(2)
}
