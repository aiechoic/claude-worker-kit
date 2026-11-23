#!/usr/bin/env node
/**
 * Sealed credentials in the state repo, encrypted with the official age tool.
 *
 *   node secrets.mjs status  --role … [--n N]                     which sealed credentials exist here and in the repo (names only)
 *   node secrets.mjs seal    --role … [--n N] [--force]           local credential files → <member dir>/secrets/<id>.age
 *   node secrets.mjs unseal  --role … [--n N] --identity -|<file> [--force]   .age files → their paths (mode 600)
 *   node secrets.mjs keygen  --out <file>                          a new master key (for the user to keep); prints its public key
 *
 * Common: --team <team.json> (else $TEAM_FILE, else team.json up from the cwd), --dry-run.
 *
 * Which credentials: `secrets` entries with `"sealed": true` and a `path`; the public key is `secretsRecipient`.
 * seal needs only the public key, so any member can seal. unseal needs the master key, read once from stdin
 * (`--identity -`) or from a file the user names; it is never printed, logged or written anywhere.
 * `state.mjs save` seals changed credentials before committing; commit with `state.mjs save` after a manual seal.
 */
import { readFileSync } from 'node:fs'
import { ageInstallHint, ageVersion, keygen, recipientOf, seal, sealedEntries, statusOf, unseal } from './lib/secrets.mjs'
import { absPath, die, info, needUser, ok, parseArgs, roleFromArgs, warn } from './lib/team.mjs'

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
const dry = !!args['dry-run']
const force = !!args.force

function needAge() {
  const v = ageVersion()
  if (!v) needUser(['The age tool (age and age-keygen) is not on PATH.', ...ageInstallHint(), 'Then run this step again.'])
  return v
}

function load() {
  const { team, r } = roleFromArgs(args)
  let entries, recipient
  try {
    entries = sealedEntries(r)
    recipient = recipientOf(team, r)
  } catch (e) { die(e.message) }
  return { r, entries, recipient }
}

if (cmd === 'keygen') {
  if (typeof args.out !== 'string') die('pass --out <file> (somewhere outside every repo)')
  needAge()
  const out = absPath(args.out)
  let pub
  try { pub = keygen(out) } catch (e) { die(e.message) }
  ok(`master key written to ${out} (mode 600; not printed)`)
  info(`public key: ${pub}`)
  info('Put the public key into the team file as "secretsRecipient".')
  info('Keep the master key file somewhere only the user controls (a password manager), then delete it from this machine.')
  process.exit(0)
}

const { r, entries, recipient } = load()
if (cmd !== 'status' && entries.length === 0) {
  warn('no secrets entry has "sealed": true; nothing to do')
  process.exit(0)
}

switch (cmd) {
  case 'status': {
    console.log(`age: ${ageVersion() ?? 'not installed'}`)
    console.log(`secretsRecipient: ${recipient ?? '(not set)'}`)
    if (entries.length === 0) { console.log('no sealed secrets in the team file'); break }
    for (const s of statusOf(entries)) {
      console.log(`  ${s.id}: ${s.name} → ${s.path}   local: ${s.local ? 'present' : 'missing'}   sealed: ${s.sealed ? 'in the repo' : 'not yet'}`)
    }
    break
  }
  case 'seal': {
    if (!recipient) die('the team file has no "secretsRecipient" (the age public key to seal to); see secrets.mjs keygen')
    needAge()
    let res
    try { res = seal(entries, recipient, { force, dry }) } catch (e) { die(e.message) }
    if (res.sealed.length) ok(`${dry ? 'would seal' : 'sealed'}: ${res.sealed.join(', ')}`)
    if (res.unchanged.length) info(`unchanged since the last seal: ${res.unchanged.join(', ')} (--force to seal again)`)
    if (res.missing.length) warn(`no local file yet, not sealed: ${res.missing.join(', ')}`)
    if (res.sealed.length && !dry) info('commit them with state.mjs save')
    break
  }
  case 'unseal': {
    if (typeof args.identity !== 'string' && args.identity !== true) die('pass --identity - (master key on stdin) or --identity <file>')
    needAge()
    let key
    try { key = args.identity === '-' || args.identity === true ? readFileSync(0) : readFileSync(absPath(args.identity)) } catch (e) { die(`cannot read the master key: ${e.code ?? e.message}`) }
    let res
    try { res = unseal(entries, key, { force, dry }) } catch (e) { die(e.message) }
    if (res.written.length) ok(`${dry ? 'would write' : 'written'}: ${res.written.join(', ')}`)
    if (res.same.length) info(`already in place: ${res.same.join(', ')}`)
    if (res.kept.length) warn(`a different file is already there, kept: ${res.kept.join(', ')} (--force to replace with the sealed one)`)
    if (res.notSealed.length) warn(`not sealed in the repo, fill by hand: ${res.notSealed.join(', ')}`)
    break
  }
  default:
    console.error('usage: secrets.mjs status|seal|unseal --role leader|worker [--n N] [--team team.json] [--identity -|<file>] [--force] [--dry-run]\n       secrets.mjs keygen --out <file>')
    process.exit(2)
}
