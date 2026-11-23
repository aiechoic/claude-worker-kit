#!/usr/bin/env node
/**
 * lark-cli profile for one session's bot.
 *
 *   node lark.mjs check  --role … [--n N]   the profile exists, its appId and brand match the team file
 *   node lark.mjs add    --role … [--n N]   add the profile, App Secret piped from the channel's appSecretFile
 *                                           (the session never sees it); without that file, tells the user what to run
 *   node lark.mjs ping   --role … [--n N] [--chat <chat_id>]   the bot can read the work chat (proves the profile works)
 *
 * Profile fields come from roles.<role>.bot: { appId, profile, brand }.
 */
import { existsSync, openSync, statSync } from 'node:fs'
import { absPath, die, info, isWin, needUser, ok, parseArgs, roleFromArgs, run } from './lib/team.mjs'

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
const dry = !!args['dry-run']
const { r } = roleFromArgs(args)
const bot = r.bot || die(`roles.${r.role}.bot is missing`)
if (!bot.profile) die('bot.profile is missing')
const brand = bot.brand ?? 'feishu'
const LARK = isWin ? 'lark-cli.cmd' : 'lark-cli'

function profiles() {
  const res = run(LARK, ['profile', 'list'], { capture: true, quiet: true })
  if (res.status === 127) needUser(['lark-cli is not installed: npm install -g @larksuite/cli'])
  if (res.status !== 0) return []
  try { return JSON.parse(res.stdout) } catch { return [] }
}

function check() {
  const p = profiles().find(x => x.name === bot.profile)
  if (!p) {
    console.error(`❌ no lark-cli profile ${bot.profile}; run: node lark.mjs add …`)
    process.exit(1)
  }
  const bad = []
  if (bot.appId && p.appId !== bot.appId) bad.push(`appId is ${p.appId}, team file says ${bot.appId}`)
  if (p.brand !== brand) bad.push(`brand is ${p.brand}, should be ${brand} (a wrong brand connects to the wrong domain and receives nothing)`)
  if (bad.length) { console.error(`❌ profile ${bot.profile}: ${bad.join('; ')}`); process.exit(1) }
  ok(`lark-cli profile ${bot.profile}: appId ${p.appId}, brand ${p.brand}`)
}

function add() {
  if (profiles().some(x => x.name === bot.profile)) { info(`profile ${bot.profile} exists`); check(); return }
  if (!bot.appId) die('bot.appId is missing in the team file')
  const secret = r.channel?.appSecretFile && absPath(r.channel.appSecretFile)
  const a = ['profile', 'add', '--name', bot.profile, '--app-id', bot.appId, '--brand', brand, '--app-secret-stdin']
  if (!secret || !existsSync(secret) || statSync(secret).size === 0) {
    needUser([
      `Add the lark-cli profile yourself (it asks for the App Secret of ${bot.appId}):`,
      `  lark-cli profile add --name ${bot.profile} --app-id ${bot.appId} --brand ${brand} --app-secret-stdin`,
      'then paste the secret and press Ctrl-D (Ctrl-Z Enter on Windows).',
    ])
  }
  if (dry) { info(`[dry-run] ${LARK} ${a.join(' ')} < ${secret}`); return }
  // the secret goes file → lark-cli's stdin; it is never read into this process
  const res = run(LARK, a, { quiet: true, stdio: [openSync(secret, 'r'), 'inherit', 'inherit'] })
  if (res.status !== 0) die('lark-cli profile add failed')
  check()
}

function ping() {
  const chat = typeof args.chat === 'string' ? args.chat : (r.chats?.work ?? r.chats?.status)
  if (!chat) die('no chat: pass --chat <chat_id> or set chats.work in the team file')
  const res = run(LARK, ['im', '+chat-messages-list', '--chat-id', chat, '--page-size', '1', '--profile', bot.profile, '--as', 'bot'], { capture: true, quiet: true })
  let okRes = false
  try { okRes = JSON.parse(res.stdout).ok !== false && res.status === 0 } catch { okRes = false }
  if (!okRes) { console.error(`❌ ${bot.profile} cannot read chat ${chat}: is the bot in the chat, and the app published with message permissions?\n${(res.stderr || res.stdout).slice(0, 400)}`); process.exit(1) }
  ok(`${bot.profile} reads chat ${chat}`)
}

switch (cmd) {
  case 'check': check(); break
  case 'add': add(); break
  case 'ping': ping(); break
  default:
    console.error('usage: lark.mjs check|add|ping --role leader|worker [--n N] [--team team.json]')
    process.exit(2)
}
