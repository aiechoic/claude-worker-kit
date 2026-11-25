# The team file (`team.json`)

One JSON file per state repo, at the repo root. Example: `examples/team.json` in this kit. `{n}` in any string is the worker number. `{a.b}` in a string is another field of the same role after member overrides are merged, for example `"path": "{channel.appSecretFile}"`, so one value is written once.

```jsonc
{
  "version": 1,
  "project": "example",              // free text; available as {project}
  "secretsRecipient": "age1…",       // optional: the age public key credentials are sealed to (a role may override it)
  "roles": {
    "leader": { …role… , "lock": true },
    "worker": { …role… , "runtime": { "docker": { … }, "native": { } } }
  },
  "members": {                       // workers only: per-number overrides, deep-merged over roles.worker (arrays such as secrets are replaced, not merged)
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
| `deployKey` | private key used to push the state repo (one deploy key per repo per member; never in any repo). Optional: without it the state repo is cloned over https with the user's gh login |
| `workDir` | the directory the session starts in; a string, or `{ "linux": …, "windows": … }`. Claude Code's memory directory is derived from it |
| `manual` | the shared manual that imports `ROLE.md` (relative to `workDir`; default `CLAUDE.md`) |
| `roleFile` | the member's role file inside its directory, imported into the manual (default `ROLE.md`); `null` when there is none, because the manual itself lives in the state repo (for example a leader whose `dir` is `.` and whose `CLAUDE.md` is in the repo root) |
| `sessionState` | the member's session-state file inside its directory (default `session-state.md`; for example `memory/session-state.md`). `restore` points at it, and `verify` checks it |
| `memory` | `link` (default on Linux) or `copy` (default on Windows: restore copies in, save copies back) |
| `lock` | leader only: take the single-leader lock |
| `bot` | `{ appId, profile, brand }`: the member's Feishu bot and its lark-cli profile name; `brand` is `feishu` or `lark` |
| `chats` | `{ work, status }`: chat ids (the work chat with the leader; the channel's status chat) |
| `channel` | `{ repo, checkout, config, saved, appSecretFile, stateDir? }`: channel repo URL (https), where to check it out, live config path, saved config path inside the member's directory, App Secret file path |
| `secrets` | list of `{ name, path? , check?, by, note?, sealed?, id? }`: credentials and logins the member needs. The channel's App Secret file (`channel.appSecretFile`) is checked even when no entry lists it; reference it as `{channel.appSecretFile}` to give it a note or to seal it. `path`: a file that must exist (never read). `check`: a command that must succeed (for example `gh auth status`). `by`: who fills it in. `note`: where it comes from. `sealed: true`: the file travels encrypted in the state repo as `secrets/<id>.age` ([secrets.md](secrets.md)); `id` defaults to the file name of `path` without leading dots |
| `setup` | optional list of `{ name, run, check?, cwd? }`: the project's own steps after the repos are cloned ([Setup steps](#setup-steps)) |
| `gh` | optional `{ scopes?, admin? }`: what the member's gh login needs, checked by `verify` (default scope `repo` when a repo is cloned with gh). `admin`: repos it must administer, for example the workers' state repo the leader adds deploy keys to |
| `runtime` | `{ docker?, native?, mode? }`: how the member runs ([Docker runtime](#docker-runtime)); a leader may run in a container too |
| `secretsRecipient` | the age public key (`age1…`) sealed credentials are encrypted to; usually set once at the top level of the team file. Never the master key |

## Docker runtime

`roles.<role>.runtime.docker`: for workers merged with `members.<N>`; the leader's needs no number (`host.mjs --role leader`).

| field | meaning |
| --- | --- |
| `wsl` | `auto` (WSL on Windows), `true`, `false` |
| `buildContext` | directory on the docker host that holds the Dockerfile and compose file (paths on the host; `~` is the host user's home). Optional with `buildRepo`: then the clone lives at `~/.claude-worker-kit/build/<repo name>` on the machine that runs `host.mjs` |
| `buildRepo` | optional `{ "url": …, "ref": "main" }`: the repo the build directory comes from. A missing build directory is cloned (with the user's gh login for a private repo); an existing one is compared with `ref`; `rebuild` fast-forwards a clean one and stops on local changes. Without it the build directory is used as it is |
| `probe` | optional `[{ "name": …, "url": …, "minKBps": 200 }]`: `host.mjs status` downloads each URL for 15 s from the docker host and warns when it is slower than `minKBps` or refused (for example the apt mirror and the Claude Code download the image needs) |
| `dockerfile`, `compose` | relative to `buildContext` |
| `image` | image name; before a build, the image the container runs is tagged `<image>:pre-<stamp>` |
| `composeProject` | base compose project name; a rebuild appends a stamp so it gets new volumes, and notes the project in use in `~/.claude-worker-kit/<container>.project` (`host.mjs up` / `down` use it) |
| `container` | container name |
| `env` | environment for `docker compose` (for example the worker number, the host credential root) |
| `credDir` | host credential directory mounted read-only into the container (only its file names are checked) |
| `init` | the project's init hook, run in the container after start (`["bash", "/opt/…/init.sh"]`) |
| `workDir` | the work directory inside the container (for `host.mjs exec`) |

`runtime.mode` (`docker` | `native`) picks the runtime for a member. When it is not set, a member with `runtime.docker` is a docker member and one without it is native. This does not depend on which OS the script runs on.

**Managing docker workers from a Windows host.** Set `"runtime": { "mode": "docker" }` on `roles.worker` and `"mode": "native"` on the members that run natively. The default above already does this, but being explicit keeps a member from being treated as native when its `runtime.docker` is missing or misspelled.

## ROLE.md: repositories

A member's other repos (code, tools, sources it pushes to) are listed in its `ROLE.md` under a fixed heading, so a restore brings them back with `repos.mjs keys` and `repos.mjs clone`. A member with `roleFile: null` lists them in its manual. No such section: no other repos.

```
## Repositories

| repo | clone | key | host | access |
| --- | --- | --- | --- | --- |
| git@github.com:owner/tool.git | /work/src/tool | /work/.ssh/tool | gh-tool | write |
| https://github.com/owner/docs.git | /work/src/docs | /work/.ssh/docs |  | read |
| git@github.com:owner/app.git | ~/team/app |  |  |  |
```

- `repo`: the git URL. `clone`: where it is cloned.
- `key`: the deploy key's private file (`.pub` next to it), made in the member when missing. Empty: no deploy key. The repo is cloned over https with the gh login. The token is passed only in `$GH_TOKEN` to a credential helper, so it is never in an argument, the output or the clone's config. The remote stays the plain https URL, and later fetches use the member's own git credentials (`gh auth setup-git`).
- `host`: an ssh `Host` alias; `repos.mjs clone` writes a block for it into `~/.ssh/config` (a `Host` the user wrote by hand is left alone) and clones through it. Empty: the clone gets `core.sshCommand` with the key instead.
- `access`: `write` (default) or `read`, for the deploy key.
- A row with a `host` needs a `key`.
- The state repo is not listed here: it is `stateRepo` / `deployKey` in the team file.

## Setup steps

What is particular to a project after its repos are cloned goes in the team file, not in this kit. An example is a workspace file that ties the clones together and is not committed.

```json
"setup": [
  { "name": "workspace file", "check": "test -f ~/team/app/workspace.cfg", "run": "bash {stateClone}/leader/tools/workspace.sh" }
]
```

- `repos.mjs setup --role … --yes` runs the steps in order, in `cwd`, which defaults to `workDir`. A docker member runs them in its container.
  - A step whose `check` passes is in place and is skipped.
  - Otherwise `run` runs, then `check` again.
  - A step without `check` runs every time, so its `run` must be safe to repeat.
  - The first step that fails is reported by number and name, and the steps after it do not run.
- Without `--yes` it only runs the checks and shows what would run.
- `verify` runs every `check`.
- The commands see `WORKER_KIT_ROLE`, `WORKER_KIT_N`, `WORKER_KIT_WORK_DIR`, `WORKER_KIT_STATE_CLONE`, and `{…}` references are filled as anywhere in the team file.
- ⛔ The output of `run` and `check` is printed as it is: a step must not print credentials.
- Keep the scripts in the project's own state repo, next to the role.

## What does not go into the team file

Only paths, ids and the age public key go in the team file, never credential values or the master key. Bot app ids and chat ids are not secrets, but they are project data: keep the team file in the project's **private** state repo.
