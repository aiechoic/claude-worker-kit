# claude-worker-kit

A Claude Code plugin (`worker-kit`) for running a **team of Claude Code sessions**: one leader and any number of workers, talking over Feishu / Lark chats through [feishu-channel-for-claude-code](https://github.com/aiechoic/feishu-channel-for-claude-code). Each member keeps its duties, memory and session state in a git **state repository**. Install the plugin in a fresh session and it walks you through any of these:

- **set up** a new leader or worker;
- **restore** one from its state repo on a new machine or after a reinstall;
- **rebuild** a docker worker on a new image with fresh volumes, keeping the old container for rollback;
- **roll back** a failed rebuild;
- **accept**: check that a member came back with its memory, manual, bot, channel and credentials in place.

Supported: docker workers on Linux or on Windows with docker inside WSL, and native sessions on Windows or Linux. macOS is not supported.

## Install

In Claude Code:

```
/plugin marketplace add aiechoic/claude-worker-kit
/plugin install worker-kit@worker-kit
```

Or by hand, without the marketplace: clone the repo into your skills directory. Claude Code loads it as a plugin at the next session start.

```bash
git clone https://github.com/aiechoic/claude-worker-kit ~/.claude/skills/worker-kit
```

```powershell
git clone https://github.com/aiechoic/claude-worker-kit "$env:USERPROFILE\.claude\skills\worker-kit"
```

Then ask, for example, "restore worker 3 from its state repo" or "rebuild worker 3 on a new image". The `team-setup` skill picks the case and runs the scripts step by step. When a step needs you, it stops and tells you what to do. Those steps are logging in, pasting a secret, creating a bot, and forwarding a public key.

Requirements: Node 20+, git, OpenSSH. The scripts have no dependencies. You also need lark-cli (`npm install -g @larksuite/cli`), the GitHub CLI `gh` on the leader's machine, and docker on the host for docker workers.

## How it fits together

```
state repo (private)                     this kit (public)
├── team.json            ← project data  ├── skills/team-setup/   what to do in each case
├── leader/ or worker-N/                 ├── scripts/             state, channel, lark, host, add-worker, verify
│   ├── ROLE.md          duties, flows   ├── examples/team.json
│   ├── session-state.md what's in hand  └── templates/           ROLE.md, session-state.md
│   ├── memory/          Claude memory (linked on Linux, copied on Windows)
│   ├── tools/           scripts, timer text, feishu-channel/config.json (no secrets)
│   └── data/            small data files
```

- **The team file** (`team.json`, in the project's private state repo) holds everything project-specific. That covers each role's state repo and directory, work directory, bot app id and lark-cli profile, chats, channel paths, the credentials it needs (paths and who fills them, never values) and, for docker workers, the image, compose file, credential directory and init hook. The format is in [skills/team-setup/references/team-file.md](skills/team-setup/references/team-file.md), with an example in [examples/team.json](examples/team.json).
- **Only one leader.** The leader takes a lock in its state repo at start (host, session, time), refreshes it on `save`, and releases it at handover. A lock held elsewhere stops the start. Taking it over needs the user's confirmation and `--force`.
- **Credentials** never go through the conversation or into any repo. Scripts check that a credential file exists. Secrets are piped from their files straight into the program that needs them (for example `lark-cli profile add --app-secret-stdin`).

## Scripts

Run them with `node scripts/<name>.mjs <command> --role leader|worker [--n N] --team <team.json>`.

| script | commands |
| --- | --- |
| `state.mjs` | `clone`, `restore`, `save`, `lock`, `release`, `status` |
| `channel.mjs` | `install`, `launcher`, `place`, `capture`, `allow`, `doctor`, `show`, `check-secret` |
| `lark.mjs` | `check`, `add`, `ping` |
| `host.mjs` | `status`, `rebuild`, `rollback`, `finish`, `copy-kit`, `exec`. Without `--yes` these only print the plan. |
| `add-worker.mjs` | leader side: deploy key on the workers' state repo, the worker's bot in the leader's allow list, the work chat |
| `verify.mjs` | acceptance checks for one member |
| `check-public.mjs` | publishing guard: fails on ids, keys, secrets, non-example hostnames, and words from a local denylist |

More roles (for example ops or report) are added as `roles.<name>` in the team file. Give a role `"numbered": true` to have per-number overrides in `members`, the way workers have them.

## Development

```bash
node --test test/*.test.mjs     # state round trip, leader lock, copy mode, channel config, host rebuild/rollback (fake docker)
node scripts/check-public.mjs   # with your project's words in an untracked .public-denylist
```

## License

MIT
