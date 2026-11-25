#!/usr/bin/env node
/**
 * Leader side of bringing a worker in (run in the leader's session).
 *
 *   node add-worker.mjs --n N [--pubkey <file | - | "ssh-ed25519 AAAA… comment">] --team <workers' team.json> [--leader-team <leader's team.json>] [--dry-run]
 *
 * The workers' team file gives members.<N>; the leader's settings come from --leader-team (default: the same file).
 *
 * 1. with --pubkey only: adds the worker's public key as a writable deploy key on the workers' state repo (gh api);
 *    normally the worker's side adds its own keys with the user's gh login (repos.mjs keys)
 * 2. adds the worker's bot (members.<N>.bot.appId) to the leader's channel allow list, as "worker-N"
 * 3. checks the worker's work chat (members.<N>.chats.work) exists and the leader's bot is in it
 * Needs: gh logged in with admin rights on the state repo; the leader's lark-cli profile.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { addDeployKey, needGh, repoSlug } from './lib/gh.mjs'
import { die, findTeamFile, info, isWin, loadTeam, needUser, ok, parseArgs, resolveRole, run, warn } from './lib/team.mjs'

const args = parseArgs(process.argv.slice(2))
const dry = !!args['dry-run']
const n = args.n ?? die('pass --n <worker number>')
const teamFile = findTeamFile(args)
const team = loadTeam(teamFile)
const leaderTeamFile = typeof args['leader-team'] === 'string' ? findTeamFile({ team: args['leader-team'] }) : teamFile
const leader = resolveRole(leaderTeamFile === teamFile ? team : loadTeam(leaderTeamFile), 'leader')
const w = resolveRole(team, 'worker', n)
const LARK = isWin ? 'lark-cli.cmd' : 'lark-cli'
const HERE = import.meta.dirname

function pubkey() {
  const p = args.pubkey
  if (p === true) die('pass --pubkey <file | - | key line>')
  const text = p === '-' ? readFileSync(0, 'utf8') : /^ssh-/.test(p) ? p : readFileSync(p, 'utf8')
  const line = text.trim().split('\n')[0].trim()
  if (!/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+( .*)?$/.test(line)) die('that is not a public key line (ssh-ed25519 AAAA… comment)')
  if (/PRIVATE KEY/.test(text)) die('that is a private key: only the .pub line is sent to the leader')
  return line
}

// 1. deploy key, only when the worker's side could not add it (normally repos.mjs keys does, with the user's gh)
if (args.pubkey) {
  const slug = repoSlug(w.stateRepo)
  const gh = needGh('adding the worker\'s deploy key')
  const res = addDeployKey(gh, slug, pubkey(), { title: `worker-${n}-state`, dry })
  if (res.error) die(res.error)
  if (res.added) ok(`deploy key "${res.title}" ${dry ? 'would be added' : 'added'} to ${slug} (writable)`)
  else ok(`deploy key already on ${slug}: "${res.title}" ${res.readOnly ? '(read-only!)' : '(writable)'}`)
  if (res.readOnly) warn('that key is read-only: delete it in the repo settings and run again')
} else info('no --pubkey: the worker adds its own deploy keys (repos.mjs keys)')

// 2. leader's channel allow list
const appId = w.bot?.appId
if (!appId) warn(`members."${n}".bot.appId is missing: the worker's bot is not added to the leader's channel allow list`)
else {
  const a = [join(HERE, 'channel.mjs'), 'allow', appId, '--name', `worker-${n}`, '--role', 'leader', '--team', leaderTeamFile]
  if (dry) a.push('--dry-run')
  const res = run(process.execPath, a, {})
  if (res.status !== 0) die('allow list update failed')
}

// 3. work chat
const chat = w.chats?.work
if (!chat) needUser([`members."${n}".chats.work is missing. Create the work chat for worker-${n}, add the leader's bot and the worker's bot, and put its chat_id in the team file.`])
const prof = leader.bot?.profile || die('roles.leader.bot.profile is missing')
const res = run(LARK, ['api', 'GET', `/open-apis/im/v1/chats/${chat}/members/is_in_chat`, '--profile', prof, '--as', 'bot'], { capture: true, quiet: true })
let inChat = null
try { inChat = JSON.parse(res.stdout).data?.is_in_chat } catch { inChat = null }
if (inChat === true) ok(`work chat ${chat} exists and the leader's bot is in it`)
else needUser([`The leader's bot is not in chat ${chat} (or the chat does not exist). Add the leader's bot and worker-${n}'s bot to it.`])
info(`worker-${n} checks its own bot with: node lark.mjs ping --role worker --n ${n}`)
info('restart the leader\'s channel so the new allow list applies (the channel repo\'s bin/restart.mjs)')
