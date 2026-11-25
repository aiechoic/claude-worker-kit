// The GitHub CLI on this machine, logged in as the user: deploy keys and private clones go through its login.
// Missing gh is installed by the session (exit 11); logging in is the user's step (exit 10).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { onPath } from './secrets.mjs'
import { die, isWin, needUser, run, selfStep } from './team.mjs'

/** owner/repo from a GitHub URL: git@github.com:o/r.git, git@<ssh alias>:o/r.git, ssh://…/o/r.git, https://github.com/o/r */
export function repoSlug(url) {
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(\.git)?\/?$/.exec(String(url ?? ''))
  if (!m) die(`cannot read owner/repo from ${url}`)
  return `${m[1]}/${m[2]}`
}

/** gh: on PATH, else (Windows) where its installer puts it, for a terminal that predates the install. */
export function ghBin(env = process.env, win = isWin) {
  if (env.WORKER_KIT_GH) return env.WORKER_KIT_GH
  if (onPath('gh', env, win)) return win ? 'gh.exe' : 'gh'
  if (win) {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
      const p = base && join(base, 'GitHub CLI', 'gh.exe')
      if (p && existsSync(p)) return p
    }
  }
  return null
}

const WINGET_GH = 'winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements'
const APT_GH = 'apt-get update && apt-get install -y gh'

/** How to install gh here: { here, user } like ageInstallPlan. */
export function ghInstallPlan({ win, has, root, sudoOk }) {
  if (win) return { here: has('winget') ? WINGET_GH : null, user: ['Install the GitHub CLI:', `  ${WINGET_GH}`, 'or from https://cli.github.com'] }
  const apt = has('apt-get')
  const here = !apt ? null : root ? APT_GH : has('sudo') && sudoOk() ? `sudo apt-get update && sudo apt-get install -y gh` : null
  return { here, user: ['Install the GitHub CLI (gh): https://github.com/cli/cli#installation', `  Debian / Ubuntu: sudo ${APT_GH.replace('&& apt-get', '&& sudo apt-get')}`] }
}

/** gh, installed and logged in; exits 11 (install it yourself) or 10 (the user logs in) otherwise. Returns the binary. */
export function needGh(why = 'adding deploy keys and cloning private repos') {
  const gh = ghBin()
  if (!gh) {
    const p = ghInstallPlan({
      win: isWin,
      has: c => onPath(c),
      root: process.getuid?.() === 0,
      sudoOk: () => run('sudo', ['-n', 'true'], { capture: true, quiet: true }).status === 0,
    })
    if (p.here) selfStep(`The GitHub CLI (gh) is needed for ${why}. Install it now; this is not a step for the user:`, [`on this machine:  ${p.here}`])
    needUser(['The GitHub CLI (gh) is not installed, and this machine has no way to install it unattended.', ...p.user, 'Then run this step again.'])
  }
  const auth = run(gh, ['auth', 'status'], { capture: true, quiet: true })
  if (auth.status !== 0) {
    needUser([
      `GitHub login, used for ${why}. In this session type:`,
      '  ! gh auth login',
      'and log in with the account that administers the team\'s repos (GitHub.com, HTTPS, browser).',
    ])
  }
  return gh
}

/** The user's GitHub token, for git over https; '' without gh or a login. Never printed or written. */
export function ghToken() {
  const gh = ghBin()
  if (!gh) return ''
  const t = run(gh, ['auth', 'token'], { capture: true, quiet: true })
  return t.status === 0 ? t.stdout.trim() : ''
}

/** gh api, JSON back. */
export function ghApi(gh, path, fields = [], { method } = {}) {
  const a = ['api', path, ...(method ? ['-X', method] : []), ...fields]
  const res = run(gh, a, { capture: true, quiet: true })
  if (res.status !== 0) return { ok: false, error: (res.stderr || res.stdout).trim().split('\n')[0] }
  try { return { ok: true, data: res.stdout.trim() ? JSON.parse(res.stdout) : null } } catch { return { ok: true, data: null } }
}

/**
 * A writable (or read-only) deploy key on owner/repo, unless the same key is already there.
 * @returns {{ added: boolean, title?: string, readOnly?: boolean, error?: string }}
 */
export function addDeployKey(gh, slug, pubLine, { title, readOnly = false, dry = false } = {}) {
  const body = pubLine.trim().split(/\s+/).slice(0, 2).join(' ')
  const list = ghApi(gh, `repos/${slug}/keys?per_page=100`)
  if (!list.ok) return { added: false, error: `cannot list the deploy keys of ${slug} (admin rights on it?): ${list.error}` }
  const have = (list.data ?? []).find(k => String(k.key).trim().split(/\s+/).slice(0, 2).join(' ') === body)
  if (have) return { added: false, title: have.title, readOnly: have.read_only }
  if (dry) return { added: true, title }
  const res = ghApi(gh, `repos/${slug}/keys`, ['-f', `title=${title}`, '-f', `key=${body}`, '-F', `read_only=${readOnly}`], { method: 'POST' })
  if (!res.ok) return { added: false, error: `adding the deploy key to ${slug} failed: ${res.error}` }
  return { added: true, title }
}
