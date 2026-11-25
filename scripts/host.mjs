#!/usr/bin/env node
/**
 * Host side of a docker worker: rebuild it from a new image on fresh volumes, or roll back.
 * Runs on the machine that has docker (Linux, or Windows with docker inside WSL: commands go through `wsl -e bash -lc`).
 * Prints the plan and changes nothing unless --yes.
 *
 *   node host.mjs status   --n N               containers, compose project, rebuild record, build directory, download speed (probe)
 *   node host.mjs rebuild  --n N [--yes] [--skip-build] [--project <compose project>] [--resume]
 *       1 tag the image the container runs <image>:pre-<stamp>   2 bring the build directory up to date, build the image
 *       3 stop the container, rename it <container>-old
 *       4 start a new one under a new compose project (⇒ new, empty volumes)   5 run the project's init hook inside it
 *       The record notes each step as it completes. A failure in step 1 or 2 leaves the container untouched: run
 *       rebuild again. A later failure keeps the record: rollback, or --resume to continue at the failed step.
 *   node host.mjs rollback --n N [--yes]
 *       remove the new container, rename <container>-old back and start it, put the old image tag back
 *   node host.mjs finish   --n N             after acceptance: delete the rebuild record file only (no container, volume or image is touched)
 *   node host.mjs up|down  --n N [--yes]     docker compose up -d / down (never -v) under the member's current compose project
 *   node host.mjs copy-kit --n N [--yes]    copy this kit into the container at /opt/worker-kit (for the inside steps)
 *   node host.mjs exec     --n N [--root] [--file <script>] [-- <command line>]
 *       run a command line (or a script file) in the container with bash -l (runs without --yes). It goes in as a file
 *       (docker cp), so $, quotes and {} reach bash as written. --root runs it as the container's root.
 *   node host.mjs unseal   --n N --identity <master key file on this machine> [--force]
 *       the script reads the file and pipes it into secrets.mjs unseal in the container; then secrets.mjs status
 *
 * The build directory: runtime.docker.buildContext, or with runtime.docker.buildRepo ({ url, ref }) and no buildContext
 * ~/.claude-worker-kit/build/<repo name> on this machine. A missing one is cloned with the GitHub CLI's login; an
 * existing one is compared with the remote, and rebuild fast-forwards it when it is clean.
 *
 * Settings: roles.worker.runtime.docker (merged with members.<N>) in the team file.
 * The rebuild record lives at ~/.claude-worker-kit/<container>.json on this machine, the current compose project at
 * ~/.claude-worker-kit/<container>.project (a rebuild changes it: the old name mounts the old volumes); the build log at
 * ~/.claude-worker-kit/<container>-build.log on the docker host.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { dockerHost, q } from './lib/docker.mjs'
import { ghToken, needGh, repoSlug } from './lib/gh.mjs'
import { absPath, die, info, isWin, needUser, ok, parseArgs, roleFromArgs, warn } from './lib/team.mjs'

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
const yes = !!args.yes
const { r, teamFile } = roleFromArgs({ ...args, role: 'worker' })
const NATIVE_HINT = {
  status: 'there is no container to show; check the session in its work directory',
  rebuild: 'there is no container to rebuild; a native rebuild is a new work directory (references/worker-native.md)',
  rollback: 'there is no container to roll back; start the old work directory again (references/worker-native.md#rollback)',
  finish: 'there is no rebuild record for a native worker',
  'copy-kit': 'there is no container to copy the kit into',
  exec: 'there is no container to run a command in; run it in the work directory',
  unseal: 'run secrets.mjs unseal --identity <file> in the work directory',
}
if (r.runtimeMode === 'native') die(`worker ${r.n} runs natively (runtime.mode = native${r.runtime?.mode ? '' : ', since the team file has no runtime.docker'}): ${NATIVE_HINT[cmd] ?? 'host.mjs only manages docker workers'}`)
const H = dockerHost(r, { yes })
const { d, C, useWsl, sh, look, exists, running, imageExists } = H
const OLD = `${C}-old`
const RECORD_DIR = join(homedir(), '.claude-worker-kit')
const RECORD = join(RECORD_DIR, `${C}.json`)
const PROJECT_FILE = join(RECORD_DIR, `${C}.project`)
const KIT_INSIDE = '/opt/worker-kit'

/** The build directory and the repo it comes from. local: a path on this machine (cloned here), else one on the docker host. */
function buildDir() {
  const repo = d.buildRepo ? (typeof d.buildRepo === 'string' ? { url: d.buildRepo } : d.buildRepo) : null
  if (d.buildContext) return { dir: d.buildContext, local: !useWsl, repo }
  if (repo) return { dir: join(RECORD_DIR, 'build', basename(repoSlug(repo.url))), local: true, repo }
  return { dir: '.', local: !useWsl, repo: null }
}
const BUILD = buildDir()
/** The build directory as the docker host sees it. */
const buildHost = () => (BUILD.local ? H.hostPath(absPath(BUILD.dir)) : q(BUILD.dir))
const envPrefix = Object.entries(d.env ?? {}).map(([k, v]) => `${k}=${q(v)}`).join(' ')
const must = (res, what) => { if (res.status !== 0) die(`${what} failed`); return res }
const check = (res, what) => { if (res.status !== 0) throw new Error(`${what} failed`); return res }
const compose = project => `cd ${buildHost()} && ${envPrefix} docker compose -p ${q(project)} -f ${q(d.compose)}`

/** The member's compose project now: what the last rebuild started, else the container's label, else the team file's. */
function currentProject() {
  if (existsSync(PROJECT_FILE)) return { project: readFileSync(PROJECT_FILE, 'utf8').trim(), from: PROJECT_FILE }
  const label = exists(C) ? H.projectOf(C) : ''
  if (label) return { project: label, from: `the label of ${C}` }
  return { project: d.composeProject, from: 'the team file' }
}
function writeProject(project) {
  if (!yes) return
  mkdirSync(RECORD_DIR, { recursive: true })
  if (project) writeFileSync(PROJECT_FILE, `${project}\n`)
  else rmSync(PROJECT_FILE, { force: true })
}

// ── build directory: clone or compare with the remote, with the GitHub CLI's login ──
const CRED_HELPER = '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'
// a local path or file:// URL (tests, a mirror) is used as it is
const httpsUrl = url => (/^(https?|file):\/\//.test(url) || url.startsWith('/') ? url : `https://github.com/${repoSlug(url)}.git`)

/** git in the build directory's place, the token only in $GH_TOKEN (never an argument, a file or the output). */
function buildGit(gitArgs, { capture = true, mutate = false } = {}) {
  const env = { GH_TOKEN: ghToken(), GIT_TERMINAL_PROMPT: '0' }
  const a = ['-c', 'credential.helper=', '-c', `credential.helper=${CRED_HELPER}`, ...gitArgs]
  if (!BUILD.local) return sh(`git ${a.map(q).join(' ')}`, { capture, mutate, env })
  if (mutate && !yes) { console.log(`  [plan] git ${gitArgs.join(' ')}`); return { status: 0, stdout: '', stderr: '' } }
  if (!capture) console.log(`  $ git ${gitArgs.join(' ')}`)
  const res = spawnSync('git', a, { encoding: 'utf8', env: { ...process.env, ...env }, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
  return { status: res.status ?? 1, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() }
}

/** What the build directory needs: { state: 'none' | 'missing' | 'current' | 'behind' | 'dirty' | 'diverged' | 'unknown', behind, ahead } */
function buildState() {
  const { dir, repo } = BUILD
  if (!repo) return { state: 'none' }
  const ref = repo.ref ?? 'main'
  const has = BUILD.local ? existsSync(join(absPath(dir), '.git')) : look(`test -d ${q(dir)}/.git`).status === 0
  if (!has) return { state: 'missing', ref }
  const C_ = ['-C', BUILD.local ? absPath(dir) : dir]
  const f = buildGit([...C_, 'fetch', '-q', httpsUrl(repo.url), `+refs/heads/${ref}:refs/remotes/origin/${ref}`])
  if (f.status !== 0) return { state: 'unknown', ref, why: f.stderr.split('\n')[0] }
  const dirty = buildGit([...C_, 'status', '--porcelain', '--untracked-files=no']).stdout !== ''
  const counts = buildGit([...C_, 'rev-list', '--left-right', '--count', `HEAD...origin/${ref}`]).stdout.split(/\s+/).map(Number)
  const [ahead, behind] = counts
  if (dirty) return { state: 'dirty', ref, ahead, behind }
  if (ahead > 0) return { state: behind ? 'diverged' : 'ahead', ref, ahead, behind }
  return { state: behind ? 'behind' : 'current', ref, ahead, behind }
}
function describeBuild(b) {
  const where = `${BUILD.dir}${BUILD.local && useWsl ? ' (on this machine, seen from WSL)' : ''}`
  switch (b.state) {
    case 'none': return `build directory ${where}`
    case 'missing': return `build directory ${where}: not there yet; rebuild clones ${BUILD.repo.url} (${b.ref})`
    case 'current': return `build directory ${where}: up to date with ${b.ref}`
    case 'behind': return `build directory ${where}: ${b.behind} commit(s) behind ${b.ref}; rebuild fast-forwards it`
    case 'ahead': return `build directory ${where}: ${b.ahead} local commit(s) not on ${b.ref}; built as it is`
    case 'dirty': return `build directory ${where}: uncommitted changes${b.behind ? `, ${b.behind} behind ${b.ref}` : ''}; rebuild stops until they are committed or dropped`
    case 'diverged': return `build directory ${where}: diverged from ${b.ref} (${b.ahead} ahead, ${b.behind} behind); rebuild stops`
    default: return `build directory ${where}: cannot compare with the remote (${b.why})`
  }
}
/** Step 2a: clone a missing build directory, fast-forward a clean one that is behind. Throws on dirty / diverged. */
function updateBuild() {
  const b = buildState()
  info(describeBuild(b))
  if (b.state === 'missing') {
    const dir = BUILD.local ? absPath(BUILD.dir) : BUILD.dir
    if (BUILD.local && yes) mkdirSync(join(dir, '..'), { recursive: true })
    const c = buildGit(['clone', '-q', '--branch', b.ref, httpsUrl(BUILD.repo.url), dir], { capture: false, mutate: true })
    // a private repo needs the user's GitHub login; ask for it only then
    if (c.status !== 0 && !ghToken()) needGh('cloning the build directory')
    check(c, 'git clone of the build directory')
  } else if (b.state === 'behind') {
    check(buildGit(['-C', BUILD.local ? absPath(BUILD.dir) : BUILD.dir, 'merge', '-q', '--ff-only', `origin/${b.ref}`], { capture: false, mutate: true }), 'fast-forward of the build directory')
  } else if (b.state === 'dirty' || b.state === 'diverged') throw new Error(describeBuild(b))
}

// ── download speed from the docker host ──
function probe() {
  for (const p of [].concat(d.probe ?? [])) {
    if (!p?.url) continue
    const res = look(`curl -sS -L -o /dev/null --max-time ${p.seconds ?? 15} -w '%{http_code} %{speed_download} %{size_download}' ${q(p.url)} 2>&1; true`)
    const m = /(\d{3}) ([\d.]+) ([\d.]+)$/.exec(res.stdout)
    if (!m || m[1] === '000') { warn(`download ${p.name ?? p.url}: failed (${res.stdout.split('\n')[0] || 'no answer'}); check the network or the proxy before a rebuild`); continue }
    const kbps = Number(m[2]) / 1024
    const min = p.minKBps ?? 200
    const line = `download ${p.name ?? p.url}: ${kbps.toFixed(0)} KB/s (HTTP ${m[1]}, ${(Number(m[3]) / 1048576).toFixed(1)} MB in the test)`
    if (Number(m[1]) >= 400 || kbps < min) warn(`${line}: too slow or refused for a build; set a proxy for docker before rebuilding`)
    else info(line)
  }
}

/** Rebuild steps, in order; a record's `done` counts how many of them completed. */
const STEPS = [
  'keep the current image for rollback',
  'build the image',
  'set the old container aside (kept, with its volumes)',
  'start the new container on new volumes',
  'project init inside the container',
]
const TOUCHED = 2 // from step 3 on the old container may be stopped or renamed

function readRecord() { return existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : null }
/** Steps a record says completed; a record without `done` comes from a kit that wrote it once, before step 2: progress unknown. */
const doneOf = rec => (Number.isInteger(rec.done) ? rec.done : null)
/** Nothing past the image build was reached: the container is untouched and a rebuild may simply start again. */
const rerunnable = rec => doneOf(rec) !== null && doneOf(rec) < TOUCHED
function writeRecord(rec) {
  if (!yes) return
  mkdirSync(RECORD_DIR, { recursive: true })
  const tmp = `${RECORD}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`)
  renameSync(tmp, RECORD)
}
function describe(rec) {
  const n = doneOf(rec)
  const lines = [n === null
    ? `rebuild record from ${rec.at} (written by an older kit: progress unknown)`
    : `rebuild record from ${rec.at}: ${n} of ${STEPS.length} steps done${n ? ` (last: ${n}. ${STEPS[n - 1]})` : ''}`]
  if (rec.failed) lines.push(`failed at step ${rec.failed.step}. ${STEPS[rec.failed.step - 1]}: ${rec.failed.what} (${rec.failed.at})`)
  lines.push(`old image ${rec.oldImage ?? '(none)'}, new compose project ${rec.project}`)
  return lines
}
/** Untag the pre-rebuild tag a rerunnable record kept: the image itself is still tagged <image>, since no build replaced it. */
function dropOldTag(rec) {
  if (!rec?.oldImage || !imageExists(rec.oldImage)) return
  if (sh(`docker rmi ${q(rec.oldImage)}`).status !== 0) warn(`could not remove the tag ${rec.oldImage}; remove it by hand`)
}

function preflight() {
  if (look('docker info >/dev/null 2>&1').status !== 0) die(`docker is not reachable${useWsl ? ' inside WSL' : ''}`)
  if (d.credDir) {
    const ls = look(`ls -1 ${q(d.credDir)} 2>/dev/null`)
    if (ls.status !== 0) needUser([`The host credential directory ${d.credDir} is missing. Create it and put this worker's files there (names only are checked).`])
    info(`credential directory ${d.credDir}: ${ls.stdout.split('\n').filter(Boolean).join(', ') || '(empty)'} (names only)`)
  }
}

function status() {
  preflight()
  for (const name of [C, OLD]) info(`${name}: ${exists(name) ? (running(name) ? 'running' : 'stopped') : 'absent'}`)
  const cp = currentProject()
  info(`compose project: ${cp.project} (from ${cp.from}); host.mjs up / down use it`)
  info(describeBuild(buildState()))
  probe()
  const rec = readRecord()
  if (!rec) { info('no rebuild record'); return }
  for (const l of describe(rec)) info(l)
  const n = doneOf(rec)
  if (rerunnable(rec)) info('the container was not touched: rebuild again directly')
  else if (n !== null && n < STEPS.length) info(`next: rollback, or rebuild --resume (continues at step ${n + 1})`)
  else info('finish after acceptance (deletes the record file only), or rollback')
}

function rebuild() {
  preflight()
  const resume = !!args.resume
  let rec = readRecord()
  const again = `node host.mjs rebuild --n ${r.n} --team <team.json>`
  if (rec && !rerunnable(rec)) {
    const n = doneOf(rec)
    if (n === null || n >= STEPS.length) die(`a rebuild of ${C} is already recorded (${RECORD}): finish or roll it back first`)
    if (!resume) {
      console.error([`❌ a rebuild of ${C} stopped after the old container was touched:`, ...describe(rec).map(l => `   ${l}`),
        '   Either go back to the old container:',
        `     node host.mjs rollback --n ${r.n} --team <team.json> --yes`,
        `   or continue at step ${n + 1} once its cause is fixed:`,
        `     ${again} --resume --yes`].join('\n'))
      process.exit(1)
    }
  } else {
    if (resume && !rec) die(`nothing to resume: no rebuild record at ${RECORD}`)
    if (resume) info('the last rebuild stopped before touching the container: starting it again')
    if (exists(OLD)) die(`${OLD} already exists: a previous rebuild was kept; remove or rename it before rebuilding again`)
    if (rec && yes) dropOldTag(rec)
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
    const project = typeof args.project === 'string' ? args.project : `${d.composeProject}-${stamp.toLowerCase()}`
    rec = { container: C, oldImage: null, project, oldContainer: null, at: new Date().toISOString(), stamp, done: 0, failed: null }
  }
  const first = doneOf(rec) + 1
  console.log(`${yes ? (first > 1 ? 'Resuming' : 'Rebuilding') : 'Plan (add --yes to run)'}: ${C}, new compose project ${rec.project}${first > 1 ? `, from step ${first}` : ''}\n`)
  writeRecord(rec)

  const step = [
    () => {
      // the image the container actually runs, which may no longer be <image>:latest
      const tag = `${d.image}:pre-${rec.stamp}`
      const id = exists(C) ? H.imageOf(C) : ''
      const src = id || (imageExists(d.image) ? d.image : '')
      if (!src) { info(`no container and no image ${d.image} yet: nothing to keep`); return }
      if (exists(C)) rec.oldProject = H.projectOf(C) || null
      check(sh(`docker tag ${q(src)} ${q(tag)}`), 'docker tag')
      rec.oldImage = tag
    },
    () => {
      updateBuild()
      if (args['skip-build']) { info('--skip-build: using the current image'); return }
      const log = `~/.claude-worker-kit/${C}-build.log`
      // a line every minute, so a long silent download does not look like a hang
      // a line every minute, so a long silent download does not look like a hang; sleep holds no output pipe
      const beat = `while sleep 60 </dev/null >/dev/null 2>&1; do echo "[still building: $((SECONDS / 60)) min, log $(du -h ${q(log)} 2>/dev/null | cut -f1)]"; done & hb=$!; trap 'kill $hb 2>/dev/null' EXIT`
      const res = sh(`mkdir -p ~/.claude-worker-kit; set -o pipefail; ${beat}; cd ${buildHost()} && docker build -t ${q(d.image)} -f ${q(d.dockerfile ?? 'Dockerfile')} . 2>&1 | tee ${q(log)}`)
      if (res.status === 0) return
      const tail = look(`tail -n 60 ${q(log)}`).stdout
      console.log(`\n--- last lines of docker build (full log: ${log} on the docker host) ---\n${tail}\n---`)
      warn('If the lines above show a network error (timeout, TLS handshake, connection reset, cannot resolve): the build downloads base images and toolchains such as Go, Node and the Playwright browsers. Set a proxy for docker (the "proxies" entry in ~/.docker/config.json on the docker host, or HTTP_PROXY / HTTPS_PROXY for the docker daemon), then run the rebuild again.')
      throw new Error('docker build failed')
    },
    () => {
      if (exists(OLD)) { info(`${OLD} is already set aside`); return }
      if (!exists(C)) { info(`${C} does not exist: nothing to set aside`); return }
      rec.oldContainer = OLD
      check(sh(`docker stop ${q(C)}`), 'docker stop')
      check(sh(`docker rename ${q(C)} ${q(OLD)}`), 'docker rename')
    },
    () => {
      check(sh(`${compose(rec.project)} up -d`), 'docker compose up')
      writeProject(rec.project)
    },
    () => {
      if (d.init) check(sh(`docker exec ${q(C)} ${[].concat(d.init).map(q).join(' ')}`), 'init hook')
      else info('no runtime.docker.init in the team file')
    },
  ]
  for (let i = first; i <= STEPS.length; i++) {
    console.log(`${i}. ${STEPS[i - 1]}`)
    try {
      step[i - 1]()
    } catch (e) {
      if (!yes) throw e
      rec.failed = { step: i, what: e.message, at: new Date().toISOString() }
      if (i <= TOUCHED) {
        dropOldTag(rec)
        rec.oldImage = null
        writeRecord(rec)
        die(`step ${i} (${STEPS[i - 1]}) failed: ${e.message}. ${C} was not touched; once the cause is fixed, run the same rebuild again: ${again} --yes`)
      }
      writeRecord(rec)
      console.error([`❌ step ${i} (${STEPS[i - 1]}) failed: ${e.message}`, `   The record ${RECORD} keeps the progress. Either go back to the old container:`,
        `     node host.mjs rollback --n ${r.n} --team <team.json> --yes`,
        `   or continue at step ${i} once the cause is fixed:`,
        `     ${again} --resume --yes`].join('\n'))
      process.exit(1)
    }
    rec.done = i
    rec.failed = null
    writeRecord(rec)
  }

  if (!yes) { console.log(`\nNothing changed. Rollback afterwards: node host.mjs rollback --n ${r.n} --team <team.json> --yes`); return }
  ok(`${C} rebuilt (compose project ${rec.project}). Rollback: node host.mjs rollback --n ${r.n} --team <team.json> --yes`)
  info(`compose project ${rec.project} is noted in ${PROJECT_FILE}; host.mjs up / down use it (the old name mounts the old volumes)`)
  needUser([
    `Log in to Claude inside the new container: docker exec -it ${C} bash, then run claude, log in, exit.`,
    'Then continue with the inside steps (references/worker-inside.md).',
  ])
}

function rollback() {
  const rec = readRecord()
  if (rec && rerunnable(rec)) {
    console.log(`${yes ? 'Clearing' : 'Plan (add --yes to run)'}: the last rebuild of ${C} stopped at step ${doneOf(rec) + 1}, before touching the container; nothing to roll back`)
    if (yes) { dropOldTag(rec); rmSync(RECORD, { force: true }); ok('record removed') } else console.log(`  [plan] forget ${RECORD}`)
    return
  }
  if (!rec && !exists(OLD)) die(`nothing to roll back: no record at ${RECORD} and no ${OLD}`)
  console.log(`${yes ? 'Rolling back' : 'Plan (add --yes to run)'}: ${C}\n`)
  if (exists(OLD)) {
    if (exists(C)) must(sh(`docker rm -f ${q(C)}`), 'docker rm')
    must(sh(`docker rename ${q(OLD)} ${q(C)}`), 'docker rename')
    must(sh(`docker start ${q(C)}`), 'docker start')
  } else if (rec && doneOf(rec) !== null && doneOf(rec) < 3 && exists(C)) {
    // step 3 failed between stop and rename: the old container is still under its own name
    if (!running(C)) must(sh(`docker start ${q(C)}`), 'docker start')
    else info(`${C} is the old container and still running`)
  } else warn(`${OLD} is gone: the old container cannot be brought back`)
  if (rec?.oldImage) must(sh(`docker tag ${q(rec.oldImage)} ${q(d.image)}`), 'docker tag')
  if (rec && doneOf(rec) !== 0) writeProject(rec.oldProject ?? null)
  if (rec?.project) info(`the new volumes of project ${rec.project} are left in place; remove them with: docker compose -p ${rec.project} -f ${d.compose} down -v`)
  if (yes) { rmSync(RECORD, { force: true }); ok(`${C} is the old container again`) } else console.log('\nNothing changed.')
}

/** Deletes the rebuild record file and nothing else: containers, volumes and image tags stay. No --yes needed. */
function finish() {
  const rec = readRecord()
  if (!rec) { ok('no rebuild record'); return }
  const n = doneOf(rec)
  if (n !== null && n < STEPS.length && !rerunnable(rec)) die(`the rebuild of ${C} did not complete (${n} of ${STEPS.length} steps): roll it back, or rebuild --resume`)
  rmSync(RECORD, { force: true })
  ok(`deleted the record file ${RECORD} (only that file). ${OLD}, its volumes and the image ${rec.oldImage ?? '-'} are untouched; remove them when the user decides`)
}

function upDown(which) {
  const { project, from } = currentProject()
  info(`compose project ${project} (from ${from})`)
  must(sh(`${compose(project)} ${which === 'up' ? 'up -d' : 'down'}`), `docker compose ${which}`)
  if (yes) ok(which === 'up' ? `${C} is up (project ${project})` : `${C} is down (project ${project}); its volumes stay`)
}

/** Copy this kit into the container, so the inside steps can run there before any session is started in it. */
function copyKit() {
  const kit = join(import.meta.dirname, '..')
  must(sh(`docker exec -u root ${q(C)} rm -rf ${KIT_INSIDE} && docker cp ${H.hostPath(kit)} ${q(C)}:${KIT_INSIDE} && docker exec -u root ${q(C)} chmod -R a+rX ${KIT_INSIDE}`), 'docker cp')
  if (yes) ok(`kit copied to ${C}:${KIT_INSIDE} (scripts in ${KIT_INSIDE}/scripts)`)
}

/** Run a command line or a script file inside the container (non-interactive), as a file copied in: no quoting is lost. */
function execIn() {
  const i = process.argv.indexOf('--')
  const before = i < 0 ? process.argv : process.argv.slice(0, i)
  let text
  if (typeof args.file === 'string') text = readFileSync(absPath(args.file), 'utf8')
  else if (i >= 0) text = process.argv.slice(i + 1).join(' ')
  else die('usage: host.mjs exec --n N [--root] [--file <script>] [-- <command line>]')
  const res = H.runScript(text, { root: before.includes('--root') })
  process.exit(res.status)
}

/** The master key, read here from the file the user named and piped into secrets.mjs unseal in the container. */
function unsealIn() {
  if (typeof args.identity !== 'string') die('pass --identity <master key file on this machine> (the user says where it is; the session never opens it)')
  const file = absPath(args.identity)
  if (!existsSync(file)) die(`no file at ${file}`)
  const team = typeof args['inner-team'] === 'string' ? args['inner-team'] : `${r.stateClone}/team.json`
  const kit = `${KIT_INSIDE}/scripts`
  if (look(`docker exec ${q(C)} test -f ${q(`${kit}/secrets.mjs`)}`).status !== 0) die(`the kit is not in ${C}: host.mjs copy-kit --yes first`)
  const A = `--role worker --n ${q(r.n)} --team ${q(team)}`
  const key = readFileSync(file)
  let res
  try {
    console.log(`unseal in ${C} with the master key from ${file} (read by this script, piped in, never shown)`)
    res = H.runScript(`node ${kit}/secrets.mjs unseal ${A} --identity -${args.force ? ' --force' : ''}`, { input: key })
  } finally { key.fill(0) }
  if (res.status !== 0) die(`unseal failed (exit ${res.status}); nothing was written if the key or a file was wrong`, res.status === 10 || res.status === 11 ? res.status : 1)
  console.log('\ncheck:')
  H.runScript(`node ${kit}/secrets.mjs status ${A}`)
}

switch (cmd) {
  case 'copy-kit': copyKit(); break
  case 'exec': execIn(); break
  case 'status': status(); break
  case 'rebuild': rebuild(); break
  case 'rollback': rollback(); break
  case 'finish': finish(); break
  case 'up': upDown('up'); break
  case 'down': upDown('down'); break
  case 'unseal': unsealIn(); break
  default:
    console.error('usage: host.mjs status|rebuild|rollback|finish|up|down|copy-kit|exec|unseal --n N [--team team.json] [--yes]')
    process.exit(2)
}
