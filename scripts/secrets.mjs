#!/usr/bin/env node
/**
 * Sealed credentials in the state repo, encrypted with the official age tool.
 *
 *   node secrets.mjs status  --role … [--n N]                     which sealed credentials exist here and in the repo (names only)
 *   node secrets.mjs seal    --role … [--n N] [--force]           local credential files → <member dir>/secrets/<id>.age
 *   node secrets.mjs unseal  --role … [--n N] --identity -|<file> [--force]   .age files → their paths (mode 600)
 *   node secrets.mjs keygen  --out <file>                          a new master key (for the user to keep); prints its public key
 *   node secrets.mjs age     [--role … --n N]                      is age installed here
 *
 * Common: --team <team.json> (else $TEAM_FILE, else team.json up from the cwd), --dry-run.
 *
 * Which credentials: `secrets` entries with `"sealed": true` and a `path`; the public key is `secretsRecipient`.
 * seal needs only the public key, so any member can seal. unseal needs the master key, read once from stdin
 * (`--identity -`) or from a file the user names; it is never printed, logged or written anywhere.
 * `state.mjs save` seals changed credentials before committing; commit with `state.mjs save` after a manual seal.
 * Without age, each command exits 11 with the command that installs it (apt-get, sudo apt-get, docker exec -u root on the
 * docker host, or winget), for the session to run; only when none applies does it exit 10 for the user.
 */
import { readFileSync } from 'node:fs'
import { ageInstallHere, ageVersion, keygen, recipientOf, seal, sealedEntries, sealPlace, statusOf, unseal } from './lib/secrets.mjs'
import { absPath, die, info, needUser, ok, parseArgs, roleFromArgs, selfStep, warn } from './lib/team.mjs'

const args = parseArgs(process.argv.slice(2))
const cmd = args._[0]
const dry = !!args['dry-run']
const force = !!args.force

/** age's version; without age, exit 11 with the install command for the session, or 10 when only the user can install it. */
function needAge(r = null) {
  const v = ageVersion()
  if (v) return v
  const p = ageInstallHere(r)
  if (p.here || p.host) {
    selfStep('age (age and age-keygen) is not installed. Install it now; this is not a step for the user:', [
      ...(p.here ? [`on this machine:  ${p.here}`] : []),
      ...(p.host ? [`${p.here ? 'or ' : ''}from the docker host:  ${p.host}`, `  (the same through the kit: host.mjs exec --n ${r?.n ?? 'N'} --root -- "apt-get update && apt-get install -y age"; on Windows it goes through WSL)`] : []),
      ...p.after,
    ])
  }
  needUser(['The age tool (age and age-keygen) is not on PATH, and this machine has no way to install it unattended.', ...p.user])
}

function load() {
  const { team, r } = roleFromArgs(args)
  let entries, recipient
  try {
    entries = sealedEntries(r)
    recipient = recipientOf(team, r)
  } catch (e) { die(e.message) }
  return { r, entries, recipient, place: sealPlace(r) }
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

if (cmd === 'age') {
  const r = args.role ? roleFromArgs(args).r : null
  ok(`age: ${needAge(r)}`)
  process.exit(0)
}

const { r: role, entries, recipient, place } = load()
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
    needAge(role)
    let res
    try { res = seal(entries, recipient, { force, dry, place }) } catch (e) { die(e.message) }
    if (res.sealed.length) ok(`${dry ? 'would seal' : 'sealed'}: ${res.sealed.join(', ')}`)
    if (res.attributes) ok('added "*.age binary" to the state repo\'s .gitattributes')
    if (res.unchanged.length) info(`unchanged since the last seal: ${res.unchanged.join(', ')} (--force to seal again)`)
    if (res.elsewhere.length) warn(`sealed again on another machine, local copy unchanged: ${res.elsewhere.join(', ')} (unseal to take that one; --force to seal this one over it)`)
    if (res.foreign.length) warn(`already sealed, but not by this clone: ${res.foreign.join(', ')} (unseal to take that one; --force to seal this machine's copy over it)`)
    if (res.missing.length) warn(`no local file yet, not sealed: ${res.missing.join(', ')}`)
    if (res.sealed.length && !dry) info('commit them with state.mjs save')
    break
  }
  case 'unseal': {
    if (typeof args.identity !== 'string' && args.identity !== true) die('pass --identity - (master key on stdin) or --identity <file>')
    needAge(role)
    let key
    try { key = args.identity === '-' || args.identity === true ? readFileSync(0) : readFileSync(absPath(args.identity)) } catch (e) { die(`cannot read the master key: ${e.code ?? e.message}`) }
    let res
    try { res = unseal(entries, key, { force, dry, place }) } catch (e) { die(e.message) }
    if (res.written.length) ok(`${dry ? 'would write' : 'written'}: ${res.written.join(', ')}`)
    if (res.same.length) info(`already in place: ${res.same.join(', ')}`)
    if (res.kept.length) warn(`a different file is already there, kept: ${res.kept.join(', ')} (--force to replace with the sealed one)`)
    if (res.notSealed.length) warn(`not sealed in the repo, fill by hand: ${res.notSealed.join(', ')}`)
    break
  }
  default:
    console.error('usage: secrets.mjs status|seal|unseal|age --role leader|worker [--n N] [--team team.json] [--identity -|<file>] [--force] [--dry-run]\n       secrets.mjs keygen --out <file>')
    process.exit(2)
}
