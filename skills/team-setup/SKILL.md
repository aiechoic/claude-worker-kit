---
name: team-setup
description: Set up, restore, rebuild, roll back or accept a "leader + workers" team of Claude Code sessions that talk over Feishu (feishu-channel-for-claude-code) and keep their memory, manual and session state in git state repositories. Use when the user asks to bring up a new leader or worker, restore one from its state repo after a reinstall or on a new machine, rebuild a worker container on a new image and fresh volumes, roll a rebuild back, add a worker to the team, or check that a member came back correctly. Covers docker workers on Linux / WSL and native sessions on Windows. Not for macOS.
---

# Team setup: leader + workers

A team is one **leader** session and any number of **worker** sessions. Each member has:

- a directory in a git **state repo** — `ROLE.md` (duties and workflows), `session-state.md` (what is in hand, who is waited on; both names are set in the team file), `memory/` (Claude Code memory), `tools/` (scripts, timer / cron text, the saved channel config), `data/` (small data files);
- a Feishu bot with a lark-cli profile and a channel config (the channel delivers chat messages into the session);
- a work chat with the leader.

Everything project-specific comes from the project's **team file** (`team.json`, kept in the state repo; format in [references/team-file.md](references/team-file.md)). This kit holds no project values.

## Where the scripts are

`KIT` = the directory two levels above this skill's base directory (the plugin root, which holds `scripts/`). Run every script as `node "$KIT/scripts/<name>.mjs" …` (PowerShell: `node "$env:KIT\scripts\<name>.mjs"`). Node 20+ is required, and the official `age` tool (`age`, `age-keygen`, 1.1 or later) when the team seals credentials. There are no npm packages to install.

| script | does |
| --- | --- |
| `state.mjs` | `clone` (before a team file exists), `restore`, `save` (seals changed credentials first), `lock` / `release` (leader), `status` |
| `secrets.mjs` | `status` (names only), `seal`, `unseal` (master key from the user, once), `keygen` (a new master key) |
| `channel.mjs` | `install` (channel repo + `team-claude`), `launcher` (only `team-claude`; stops if it points elsewhere, `--replace`), `place` (saved config → live), `capture` (portable fields → state repo), `allow`, `doctor`, `show` |
| `lark.mjs` | `check`, `add` (secret piped from its file), `ping` (reads the work chat) |
| `host.mjs` | docker host: `status`, `rebuild`, `rollback`, `finish`, `copy-kit`, `exec` (plans only, unless `--yes`) |
| `add-worker.mjs` | leader: deploy key for a worker, allow its bot, check its chat |
| `verify.mjs` | acceptance checks for one member |

Every script takes `--role leader|worker`, `--n <N>` for workers, `--team <team.json>`.

## Rules for the whole run

- ⛔ **Never read, print, log or paste a credential**: App Secrets, private keys, tokens, API keys, database passwords. Check only that a file exists and is non-empty. Secrets move file → program (stdin), never through the conversation.
- ⛔ **The master key** (the age identity that unseals the team's credentials, `AGE-SECRET-KEY-1…`) never reaches the session. The user pipes it into `secrets.mjs unseal` in a terminal of their own ([references/secrets.md](references/secrets.md)). If they paste it into the conversation, tell them it is exposed and that the team must make a new master key and seal again.
- **Steps for the user.** A script that exits with code **10** printed a "🖐 This step needs you" block. Stop, show the user those lines, and wait until they say it is done. Then run the same step again. These steps are always for the user: logging in to Claude, `gh auth login`, handing over the master key, pasting an App Secret, creating a Feishu bot or chat, forwarding a public key to the leader, and installing age.
- **Plan, then do.** On the host, run `host.mjs` without `--yes` first, show the plan, and get the user's go-ahead before `--yes`. Do the same for anything that stops, renames or removes a container.
- **Only this member.** Do not touch other members' containers, volumes, chats or state directories.
- **Keep the old one.** A rebuild keeps the old container (`<name>-old`), its volumes and the old image tag until the user decides. Roll back at the first step that cannot be fixed. See [references/rollback.md](references/rollback.md).
- **Write as you go.** After each step, record one line: what ran and what came out. Anything stuck, done by hand, or unclear goes into the run log you hand back at the end. Do not work around a problem silently.

## Decide the case

Ask the user (or read it from the request) three things:

1. **Who**: the leader, or worker N.
2. **Where**: a **docker** worker (Linux, or Windows with docker inside WSL), or a **native** session (Windows, no container). The leader runs natively, in a Linux shell or on Windows.
3. **What**:

| case | when | go to |
| --- | --- | --- |
| **new** | the member has no directory in the state repo yet (or there is no state repo) | [references/new.md](references/new.md), then the member's restore path |
| **restore** | the member exists in the state repo; this is a new session or machine, or the volume survived | leader: [references/leader.md](references/leader.md); docker worker: [references/worker-inside.md](references/worker-inside.md); native worker: [references/worker-native.md](references/worker-native.md) |
| **rebuild** | a docker worker gets a new image and fresh volumes; the old container is kept | [references/worker-host.md](references/worker-host.md) → [references/worker-inside.md](references/worker-inside.md) |
| **rollback** | a rebuild or restore failed | [references/rollback.md](references/rollback.md) |
| **accept** | after any of the above, or "check that X is fine" | [references/verify.md](references/verify.md) |
| **add worker** (leader side) | a worker sends its public key, or a new worker joins | [references/leader.md](references/leader.md#bring-a-worker-in) |

Bring the leader up before its workers. Workers need the leader to add their deploy keys.

## Getting the team file

The team file is in the state repo, so you need the repo before you have the file:

- **On a host with the user's GitHub access** (the docker host, or the leader's machine): clone the state repo with the user's own credentials, for example `gh repo clone <owner>/<repo>` after the user runs `gh auth login`. The team file is in that clone.
- **Inside a member** (container or native work directory): run `state.mjs clone --repo <url> --to <stateClone> --key <deployKey>`. The script stops for the user if the deploy key does not exist yet. The user then generates it and forwards the `.pub` line to the leader.
- **No state repo at all**: see [references/new.md](references/new.md).

## Finish

Run `verify.mjs` for the member and show the result. Run `state.mjs save -m "<what happened>"`. Then tell the user the next step. That is usually: start the session with `team-claude` in the work directory, where it posts "online" in its work chat, and the leader replies.
