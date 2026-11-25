// The docker host of a docker member: bash command lines on this machine, or inside WSL on Windows
// (`wsl -e bash -lc`). host.mjs and repos.mjs both use it.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { die, isWin } from './team.mjs'

/** shell-quote for bash; a leading ~/ becomes "$HOME"/… so it still expands inside quotes */
export function q(s) {
  s = String(s)
  if (s === '~') return '"$HOME"'
  if (s.startsWith('~/')) return `"$HOME"/'${s.slice(2).replaceAll("'", "'\\''")}'`
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`
}

/**
 * The docker settings of a worker role and the helpers that run on its docker host.
 * @param r the resolved role (runtimeMode docker)
 * @param opts { yes } without yes, mutating lines are only printed as the plan
 */
export function dockerHost(r, { yes = false } = {}) {
  const d = r.runtime?.docker || die('runtime.mode is docker but roles.worker.runtime.docker is missing in the team file')
  for (const k of ['image', 'container', 'compose', 'composeProject']) if (!d[k]) die(`runtime.docker.${k} is missing`)
  const useWsl = d.wsl === true || (d.wsl !== false && isWin)
  const C = d.container

  /** Run one bash command line on the docker host. input: bytes for its stdin (never shown). env: extra variables (WSLENV passes them on). */
  function sh(line, { capture = false, mutate = true, input, env } = {}) {
    if (mutate && !yes) { console.log(`  [plan] ${line}`); return { status: 0, stdout: '', stderr: '' } }
    if (!capture) console.log(`  $ ${line}`)
    const [c, a] = useWsl ? ['wsl', ['-e', 'bash', '-lc', line]] : ['bash', ['-lc', line]]
    let e
    if (env) {
      e = { ...process.env, ...env }
      if (useWsl) e.WSLENV = [process.env.WSLENV, ...Object.keys(env).map(k => `${k}/u`)].filter(Boolean).join(':')
    }
    const stdio = [input !== undefined ? 'pipe' : 'ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit']
    const res = spawnSync(c, a, { encoding: input !== undefined ? undefined : 'utf8', stdio, input, env: e, maxBuffer: 64 * 1024 * 1024 })
    const text = v => (v == null ? '' : Buffer.isBuffer(v) ? v.toString('utf8') : v).trim()
    return { status: res.status ?? 1, stdout: text(res.stdout), stderr: text(res.stderr) }
  }
  const look = line => sh(line, { capture: true, mutate: false })
  /** A path on this machine as the docker host sees it (wslpath inside WSL). */
  const hostPath = p => (useWsl ? `"$(wslpath -a ${q(String(p).replaceAll('\\', '/'))})"` : q(p))

  /**
   * Run a script inside the container: it is written to a file here, copied in with docker cp and run with bash -l,
   * so no quoting of it passes through PowerShell, wsl or bash -c. Returns { status, stdout, stderr }.
   */
  function runScript(text, { root = false, workDir = d.workDir, capture = false, mutate = false, input } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'cwk-exec-'))
    const local = join(dir, 'run.sh')
    writeFileSync(local, text.endsWith('\n') ? text : `${text}\n`)
    const inside = `/tmp/cwk-exec-${randomBytes(6).toString('hex')}.sh`
    try {
      const u = root ? '-u root ' : ''
      const w = workDir ? `-w ${q(workDir)} ` : ''
      return sh(`docker cp ${hostPath(local)} ${q(C)}:${inside} && docker exec ${input !== undefined ? '-i ' : ''}${u}${w}${q(C)} bash -l ${inside}; s=$?; docker exec -u root ${q(C)} rm -f ${inside}; exit $s`, { capture, mutate, input })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return {
    d, C, useWsl, sh, look, hostPath, runScript,
    exists: name => look(`docker container inspect ${q(name)} >/dev/null 2>&1`).status === 0,
    running: name => look(`docker container inspect -f '{{.State.Running}}' ${q(name)} 2>/dev/null`).stdout === 'true',
    imageExists: ref => look(`docker image inspect ${q(ref)} >/dev/null 2>&1`).status === 0,
    /** The image ID a container runs (sha256:…), or '' */
    imageOf: name => look(`docker container inspect -f '{{.Image}}' ${q(name)} 2>/dev/null`).stdout,
    /** The compose project a container was started under, or '' */
    projectOf: name => look(`docker container inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' ${q(name)} 2>/dev/null`).stdout.replace(/^<no value>$/, ''),
  }
}
