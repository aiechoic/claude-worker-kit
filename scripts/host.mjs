#!/usr/bin/env node
/**
 * Host side of a docker worker: rebuild it from a new image on fresh volumes, or roll back.
 * Runs on the machine that has docker (Linux, or Windows with docker inside WSL: commands go through `wsl -e bash -lc`).
 * Prints the plan and changes nothing unless --yes.
 *
 *   node host.mjs status   --n N
 *   node host.mjs rebuild  --n N [--yes] [--skip-build] [--project <compose project>] [--resume]
 *       1 tag the current image <image>:pre-<stamp>   2 build the image   3 stop the container, rename it <container>-old
 *       4 start a new one under a new compose project (⇒ new, empty volumes)   5 run the project's init hook inside it
 *       The record notes each step as it completes. A failure in step 1 or 2 leaves the container untouched: run
 *       rebuild again. A later failure keeps the record: rollback, or --resume to continue at the failed step.
 *   node host.mjs rollback --n N [--yes]
 *       remove the new container, rename <container>-old back and start it, put the old image tag back
 *   node host.mjs finish   --n N [--yes]    after acceptance: forget the rebuild record (old container and volumes stay until you remove them)
 *   node host.mjs copy-kit --n N [--yes]    copy this kit into the container at /opt/worker-kit (for the inside steps)
 *   node host.mjs exec     --n N -- <command line>   run one non-interactive command in the container (runs without --yes)
 *
 * Settings: roles.worker.runtime.docker (merged with members.<N>) in the team file.
 * The rebuild record lives at ~/.claude-worker-kit/<container>.json on this machine; the build log at
 * ~/.claude-worker-kit/<container>-build.log on the docker host.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { die, info, isWin, needUser, ok, parseArgs, roleFromArgs, warn } from './lib/team.mjs'

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
const yes = !!args.yes
const { r } = roleFromArgs({ ...args, role: 'worker' })
const NATIVE_HINT = {
  status: 'there is no container to show; check the session in its work directory',
  rebuild: 'there is no container to rebuild; a native rebuild is a new work directory (references/worker-native.md)',
  rollback: 'there is no container to roll back; start the old work directory again (references/worker-native.md#rollback)',
  finish: 'there is no rebuild record for a native worker',
  'copy-kit': 'there is no container to copy the kit into',
  exec: 'there is no container to run a command in; run it in the work directory',
}
if (r.runtimeMode === 'native') die(`worker ${r.n} runs natively (runtime.mode = native${r.runtime?.mode ? '' : ', since the team file has no runtime.docker'}): ${NATIVE_HINT[cmd] ?? 'host.mjs only manages docker workers'}`)
const d = r.runtime?.docker || die(`runtime.mode is docker but roles.worker.runtime.docker is missing in the team file`)
for (const k of ['image', 'container', 'compose', 'composeProject']) if (!d[k]) die(`runtime.docker.${k} is missing`)
const useWsl = d.wsl === true || (d.wsl !== false && isWin)
const C = d.container
const OLD = `${C}-old`
const RECORD_DIR = join(homedir(), '.claude-worker-kit')
const RECORD = join(RECORD_DIR, `${C}.json`)

/** shell-quote for bash; a leading ~/ becomes "$HOME"/… so it still expands inside quotes */
function q(s) {
  s = String(s)
  if (s === '~') return '"$HOME"'
  if (s.startsWith('~/')) return `"$HOME"/'${s.slice(2).replaceAll("'", "'\\''")}'`
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`
}
const envPrefix = Object.entries(d.env ?? {}).map(([k, v]) => `${k}=${q(v)}`).join(' ')

/** Run one bash command line on the docker host. */
function sh(line, { capture = false, mutate = true } = {}) {
  if (mutate && !yes) { console.log(`  [plan] ${line}`); return { status: 0, stdout: '' } }
  if (!capture) console.log(`  $ ${line}`)
  const [c, a] = useWsl ? ['wsl', ['-e', 'bash', '-lc', line]] : ['bash', ['-lc', line]]
  const res = spawnSync(c, a, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' })
  return { status: res.status ?? 1, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() }
}
const look = line => sh(line, { capture: true, mutate: false })
const must = (res, what) => { if (res.status !== 0) die(`${what} failed`); return res }
const check = (res, what) => { if (res.status !== 0) throw new Error(`${what} failed`); return res }
const exists = name => look(`docker container inspect ${q(name)} >/dev/null 2>&1`).status === 0
const running = name => look(`docker container inspect -f '{{.State.Running}}' ${q(name)} 2>/dev/null`).stdout === 'true'
const imageExists = ref => look(`docker image inspect ${q(ref)} >/dev/null 2>&1`).status === 0
const compose = project => `cd ${q(d.buildContext ?? '.')} && ${envPrefix} docker compose -p ${q(project)} -f ${q(d.compose)}`

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
  const rec = readRecord()
  if (!rec) { info('no rebuild record'); return }
  for (const l of describe(rec)) info(l)
  const n = doneOf(rec)
  if (rerunnable(rec)) info('the container was not touched: rebuild again directly')
  else if (n !== null && n < STEPS.length) info(`next: rollback, or rebuild --resume (continues at step ${n + 1})`)
  else info('finish after acceptance, or rollback')
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
      const tag = `${d.image}:pre-${rec.stamp}`
      if (!imageExists(d.image)) { info(`no image ${d.image} yet: nothing to keep`); return }
      check(sh(`docker tag ${q(d.image)} ${q(tag)}`), 'docker tag')
      rec.oldImage = tag
    },
    () => {
      if (args['skip-build']) { info('--skip-build: using the current image'); return }
      const log = `~/.claude-worker-kit/${C}-build.log`
      const res = sh(`mkdir -p ~/.claude-worker-kit && set -o pipefail && cd ${q(d.buildContext ?? '.')} && docker build -t ${q(d.image)} -f ${q(d.dockerfile ?? 'Dockerfile')} . 2>&1 | tee ${q(log)}`)
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
    () => check(sh(`${compose(rec.project)} up -d`), 'docker compose up'),
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
  warn(`from now on start this worker with -p ${rec.project}; the old project name mounts the old volumes`)
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
  if (rec?.project) info(`the new volumes of project ${rec.project} are left in place; remove them with: docker compose -p ${rec.project} -f ${d.compose} down -v`)
  if (yes) { rmSync(RECORD, { force: true }); ok(`${C} is the old container again`) } else console.log('\nNothing changed.')
}

function finish() {
  const rec = readRecord()
  if (!rec) { ok('no rebuild record'); return }
  const n = doneOf(rec)
  if (n !== null && n < STEPS.length && !rerunnable(rec)) die(`the rebuild of ${C} did not complete (${n} of ${STEPS.length} steps): roll it back, or rebuild --resume`)
  if (!yes) { console.log(`[plan] forget ${RECORD}; ${OLD} and image ${rec.oldImage ?? '-'} stay until you remove them`); return }
  rmSync(RECORD, { force: true })
  ok(`record removed. ${OLD} and its volumes are still there; remove them when the user decides`)
}

/** Copy this kit into the container, so the inside steps can run there before any session is started in it. */
function copyKit() {
  const kit = join(import.meta.dirname, '..')
  const src = useWsl ? `"$(wslpath -a ${q(kit.replaceAll('\\', '/'))})"` : q(kit)
  must(sh(`docker exec ${q(C)} rm -rf /opt/worker-kit && docker cp ${src} ${q(C)}:/opt/worker-kit`), 'docker cp')
  if (yes) ok(`kit copied to ${C}:/opt/worker-kit (scripts in /opt/worker-kit/scripts)`)
}

/** Run one command inside the container (non-interactive): host.mjs exec --n N -- <command line> */
function execIn() {
  const i = process.argv.indexOf('--')
  if (i < 0) die('usage: host.mjs exec --n N -- <command line>')
  const line = process.argv.slice(i + 1).join(' ')
  const res = sh(`docker exec ${d.workDir ? `-w ${q(d.workDir)} ` : ''}${q(C)} bash -lc ${q(line)}`, { mutate: false })
  process.exit(res.status)
}

switch (cmd) {
  case 'copy-kit': copyKit(); break
  case 'exec': execIn(); break
  case 'status': status(); break
  case 'rebuild': rebuild(); break
  case 'rollback': rollback(); break
  case 'finish': finish(); break
  default:
    console.error('usage: host.mjs status|rebuild|rollback|finish|copy-kit|exec --n N [--team team.json] [--yes]')
    process.exit(2)
}
