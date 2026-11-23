# The team file (`team.json`)

One JSON file per state repo, at the repo root. Example: `examples/team.json` in this kit. `{n}` in any string is the worker number. `{a.b}` in a string is another field of the same role after member overrides are merged, for example `"path": "{channel.appSecretFile}"`, so one value is written once.

```jsonc
{
  "version": 1,
  "project": "example",              // free text; available as {project}
  "roles": {
    "leader": { …role… , "lock": true },
    "worker": { …role… , "runtime": { "docker": { … }, "native": { } } }
  },
  "members": {                       // workers only: per-number overrides, deep-merged over roles.worker
    "3": { "bot": { "appId": "cli_…" }, "chats": { "work": "oc_…" } },
    "5": { "runtime": { "mode": "native" }, "workDir": { "windows": "~/team/worker-5" }, … }
  }
}
```

## Role fields

| field | meaning |
| --- | --- |
| `stateRepo` | git URL of the state repo (ssh) |
| `stateClone` | where the member clones it |
| `dir` | the member's directory inside the repo (`worker-{n}`, `leader`) |
| `deployKey` | private key used to push the state repo (one deploy key per repo per member; never in any repo) |
| `workDir` | the directory the session starts in; a string, or `{ "linux": …, "windows": … }`. Claude Code's memory directory is derived from it |
| `manual` | the shared manual that imports `ROLE.md` (relative to `workDir`; default `CLAUDE.md`) |
| `roleFile` | the member's role file inside its directory, imported into the manual (default `ROLE.md`); `null` when there is none, because the manual itself lives in the state repo (for example a leader whose `dir` is `.` and whose `CLAUDE.md` is in the repo root) |
| `sessionState` | the member's session-state file inside its directory (default `session-state.md`; for example `memory/session-state.md`). `restore` points at it, and `verify` checks it |
| `memory` | `link` (default on Linux) or `copy` (default on Windows: restore copies in, save copies back) |
| `lock` | leader only: take the single-leader lock |
| `bot` | `{ appId, profile, brand }`: the member's Feishu bot and its lark-cli profile name; `brand` is `feishu` or `lark` |
| `chats` | `{ work, status }`: chat ids (the work chat with the leader; the channel's status chat) |
| `channel` | `{ repo, checkout, config, saved, appSecretFile, stateDir? }`: channel repo URL (https), where to check it out, live config path, saved config path inside the member's directory, App Secret file path |
| `secrets` | list of `{ name, path? , check?, by, note? }`: credentials and logins the member needs. The channel's App Secret file (`channel.appSecretFile`) is checked even when no entry lists it; reference it as `{channel.appSecretFile}` to give it a note. `path`: a file that must exist (never read). `check`: a command that must succeed (for example `gh auth status`). `by`: who fills it in. `note`: where it comes from |

## Docker runtime (`roles.worker.runtime.docker`)

| field | meaning |
| --- | --- |
| `wsl` | `auto` (WSL on Windows), `true`, `false` |
| `buildContext` | directory on the docker host that holds the Dockerfile and compose file (paths on the host; `~` is the host user's home) |
| `dockerfile`, `compose` | relative to `buildContext` |
| `image` | image name; the previous one is tagged `<image>:pre-<stamp>` before a build |
| `composeProject` | base compose project name; a rebuild appends a stamp so it gets new volumes |
| `container` | container name |
| `env` | environment for `docker compose` (for example the worker number, the host credential root) |
| `credDir` | host credential directory mounted read-only into the container (only its file names are checked) |
| `init` | the project's init hook, run in the container after start (`["bash", "/opt/…/init.sh"]`) |
| `workDir` | the work directory inside the container (for `host.mjs exec`) |

`runtime.mode` (`docker` | `native`) picks the runtime for a member. When it is not set, a member with `runtime.docker` is a docker member and one without it is native. This does not depend on which OS the script runs on.

**Managing docker workers from a Windows host.** Set `"runtime": { "mode": "docker" }` on `roles.worker` and `"mode": "native"` on the members that run natively. The default above already does this, but being explicit keeps a member from being treated as native when its `runtime.docker` is missing or misspelled.

## What does not go into the team file

Only paths and ids go in the team file, never credential values. Bot app ids and chat ids are not secrets, but they are project data: keep the team file in the project's **private** state repo.
