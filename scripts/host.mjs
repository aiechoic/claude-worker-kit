#!/usr/bin/env node
/**
 * Host side of a docker worker: rebuild it from a new image on fresh volumes, or roll back.
 * Runs on the machine that has docker (Linux, or Windows with docker inside WSL: commands go through `wsl -e bash -lc`).
 * Prints the plan and changes nothing unless --yes.
 *
 *   node host.mjs status   --n N
 *   node host.mjs rebuild  --n N [--yes] [--skip-build] [--project <compose project>]
 *       1 tag the current image <image>:pre-<stamp>   2 build the image   3 stop the container, rename it <container>-old
 *       4 start a new one under a new compose project (⇒ new, empty volumes)   5 run the project's init hook inside it
 *   node host.mjs rollback --n N [--yes]
 *       remove the new container, rename <container>-old back and start it, put the old image tag back
 *   node host.mjs finish   --n N [--yes]    after acceptance: forget the rollback record (old container and volumes stay until you remove them)
 *   node host.mjs copy-kit --n N [--yes]    copy this kit into the container at /opt/worker-kit (for the inside steps)
 *   node host.mjs exec     --n N -- <command line>   run one non-interactive command in the container (runs without --yes)
 *
 * Settings: roles.worker.runtime.docker (merged with members.<N>) in the team file.
 * The rollback record lives at ~/.claude-worker-kit/<container>.json on this machine.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  finish: 'there is no rollback record for a native worker',
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
const exists = name => look(`docker container inspect ${q(name)} >/dev/null 2>&1`).status === 0
const running = name => look(`docker container inspect -f '{{.State.Running}}' ${q(name)} 2>/dev/null`).stdout === 'true'
const imageExists = ref => look(`docker image inspect ${q(ref)} >/dev/null 2>&1`).status === 0
const compose = project => `cd ${q(d.buildContext ?? '.')} && ${envPrefix} docker compose -p ${q(project)} -f ${q(d.compose)}`

function readRecord() { return existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : null }

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
  info(rec ? `rollback record: old image ${rec.oldImage ?? '(none)'}, new project ${rec.project}, at ${rec.at}` : 'no rollback record')
}

function rebuild() {
  preflight()
  if (readRecord()) die(`a rebuild of ${C} is already recorded (${RECORD}): finish or roll it back first`)
  if (exists(OLD)) die(`${OLD} already exists: a previous rebuild was kept; remove or rename it before rebuilding again`)
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
  const project = typeof args.project === 'string' ? args.project : `${d.composeProject}-${stamp.toLowerCase()}`
  const oldTag = `${d.image}:pre-${stamp}`
  console.log(`${yes ? 'Rebuilding' : 'Plan (add --yes to run)'}: ${C}, new compose project ${project}\n`)

  console.log('1. keep the current image for rollback')
  const hadImage = imageExists(d.image)
  if (hadImage) must(sh(`docker tag ${q(d.image)} ${q(oldTag)}`), 'docker tag')
  else info(`no image ${d.image} yet: nothing to keep`)

  if (yes) {
    mkdirSync(RECORD_DIR, { recursive: true })
    writeFileSync(RECORD, `${JSON.stringify({ container: C, oldImage: hadImage ? oldTag : null, project, oldContainer: exists(C) ? OLD : null, at: new Date().toISOString() }, null, 2)}\n`)
  }

  console.log('2. build the image')
  if (args['skip-build']) info('--skip-build: using the current image')
  else must(sh(`cd ${q(d.buildContext ?? '.')} && docker build -t ${q(d.image)} -f ${q(d.dockerfile ?? 'Dockerfile')} .`), 'docker build')

  console.log('3. set the old container aside (kept, with its volumes)')
  if (exists(C)) {
    must(sh(`docker stop ${q(C)}`), 'docker stop')
    must(sh(`docker rename ${q(C)} ${q(OLD)}`), 'docker rename')
  } else info(`${C} does not exist: nothing to set aside`)

  console.log('4. start the new container on new volumes')
  must(sh(`${compose(project)} up -d`), 'docker compose up')

  console.log('5. project init inside the container')
  if (d.init) must(sh(`docker exec ${q(C)} ${[].concat(d.init).map(q).join(' ')}`), 'init hook')
  else info('no runtime.docker.init in the team file')

  if (!yes) { console.log(`\nNothing changed. Rollback afterwards: node host.mjs rollback --n ${r.n} --team <team.json> --yes`); return }
  ok(`${C} rebuilt (compose project ${project}). Rollback: node host.mjs rollback --n ${r.n} --team <team.json> --yes`)
  warn(`from now on start this worker with -p ${project}; the old project name mounts the old volumes`)
  needUser([
    `Log in to Claude inside the new container: docker exec -it ${C} bash, then run claude, log in, exit.`,
    'Then continue with the inside steps (references/worker-inside.md).',
  ])
}

function rollback() {
  const rec = readRecord()
  if (!rec && !exists(OLD)) die(`nothing to roll back: no record at ${RECORD} and no ${OLD}`)
  console.log(`${yes ? 'Rolling back' : 'Plan (add --yes to run)'}: ${C}\n`)
  if (exists(OLD)) {
    if (exists(C)) must(sh(`docker rm -f ${q(C)}`), 'docker rm')
    must(sh(`docker rename ${q(OLD)} ${q(C)}`), 'docker rename')
    must(sh(`docker start ${q(C)}`), 'docker start')
  } else warn(`${OLD} is gone: the old container cannot be brought back`)
  if (rec?.oldImage) must(sh(`docker tag ${q(rec.oldImage)} ${q(d.image)}`), 'docker tag')
  if (rec?.project) info(`the new volumes of project ${rec.project} are left in place; remove them with: docker compose -p ${rec.project} -f ${d.compose} down -v`)
  if (yes) { rmSync(RECORD, { force: true }); ok(`${C} is the old container again`) } else console.log('\nNothing changed.')
}

function finish() {
  const rec = readRecord()
  if (!rec) { ok('no rollback record'); return }
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
