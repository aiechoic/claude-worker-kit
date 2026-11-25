# Leader: set up or restore

The leader runs natively (a Linux shell or a Windows session) or in a docker container. A container leader is driven from its docker host: see [Leader in a container](#leader-in-a-container), which runs the same steps inside. Natively, run all steps in the leader's work directory. `S` = `node "$KIT/scripts/state.mjs" --role leader --team <team.json>`, `A` = `--role leader --team <team.json>`.

The user's part is the same three steps as for a worker: naming the master key file, `! gh auth login`, and (in a container) logging in to Claude there. Everything else is the session's.

## 1. The state repo and the team file

- Clone it: `node "$KIT/scripts/state.mjs" clone --repo <url> --to <stateClone> [--key <deployKey>]`.
  - With a deploy key (`deployKey` in the team file): `repos.mjs keys A --state-only --yes` first makes the key and adds it with the user's gh login.
  - Without one: the clone goes over https with the user's gh login. If gh is not logged in: exit 10, the user runs `! gh auth login`.
- Every later step reads `<stateClone>/team.json`.

## 2. Only one leader

```
S lock --session "<machine / window label>"
```

- **exit 0**: the lock is held here; go on.
- **exit 3**: another leader holds the lock. ⛔ Do not start. Show the user who holds it and since when.
  - Stop the other leader first, and have it run `S release`.
  - If that machine is gone, or the lock looks stale, the user must confirm. Only after that run `S lock --force`.
  - Never use `--force` on your own judgment.
- `save` refreshes the lock's time. To hand over, run `S release` in the old leader before the new one takes the lock. There is no heartbeat: an old time alone does not mean the leader is gone.

## 3. Restore memory, manual and role

```
S restore
```

- The script links (Linux) or copies (Windows) the memory directory.
- It adds `@…/ROLE.md` to the manual (unless `roleFile` is `null`: then the manual itself is the leader's).
- It lists the credentials still to fill, the sealed ones it found, the repos and the setup steps.
- If there are sealed credentials:
  1. Make sure age is installed: `secrets.mjs age A`. On exit 11, run the printed install command yourself ([secrets.md](secrets.md#install-age)).
  2. Unseal with the master key file the user names: `secrets.mjs unseal A --identity <file>`. ⛔ Do not open that file.
  3. The user may instead pipe the key in from a terminal of their own 🖐 ([secrets.md](secrets.md#unseal-on-a-new-machine-restore)). ⛔ Not through the session.
- Read `session-state.md` afterwards.

## 4. The leader's repos and the project's setup

The leader's code repos are listed in its role file under `## Repositories` (or, with `roleFile: null`, in the manual), the same table as a worker's ([team-file.md](team-file.md#rolemd-repositories)). A row with an empty `key` is cloned over https with the gh login. No section means no extra repos.

```
node "$KIT/scripts/repos.mjs" keys A --yes     # deploy keys for rows that have a key (none: nothing to do)
node "$KIT/scripts/repos.mjs" clone A --yes    # each repo where the table says
node "$KIT/scripts/repos.mjs" setup A --yes    # the team file's setup steps, in order
```

- `setup` covers what is particular to the project, for example a workspace file that is not committed. The steps live in the team file as `setup` ([team-file.md](team-file.md#setup-steps)), and their scripts in the project's own state repo.
- A step whose `check` passes is skipped. A failing step is reported by number and name, and the steps after it do not run.
- The output of each step is printed as it is, so ⛔ a setup script must not print credentials.
- The channel checkout is not in the table: step 5 installs it.

## 5. GitHub, lark-cli, channel

1. **GitHub CLI**: `gh auth status`. If that fails, the user runs `! gh auth login` 🖐. Adding workers' deploy keys needs the `repo` scope and admin rights on the workers' state repo. `verify` names a missing scope (fix: `gh auth refresh -h github.com -s <scope>`) or missing admin rights (team file: `gh`).
2. **App Secret file**: `node "$KIT/scripts/channel.mjs" check-secret A`. After an unseal it is already there. If it exits 10, the user writes the secret file as shown 🖐.
3. **lark-cli**: `node "$KIT/scripts/lark.mjs" add A`. The secret is piped from the App Secret file. Then run `lark.mjs check A`.
4. **Channel**, in this order:
   1. `channel.mjs install A` clones the public channel repo over https (skipping a global https→ssh rewrite) and runs `npm ci`.
   2. `channel.mjs place A` puts the saved config back.
   3. `channel.mjs launcher A` installs `team-claude` against that config. If a `team-claude` already points at another checkout or config, it stops and shows it; `--replace` after the user agrees.
   4. `channel.mjs doctor A` checks the bot's permissions.
5. **Project MCP servers and tokens**: go through `secrets` in the team file one by one.
   - Sealed entries are already back. `secrets.mjs status A` lists them.
   - For each other `path` entry the user puts the file there 🖐.
   - For each `check` entry, run the check. If it fails, show the `note` and the user fixes it 🖐 (for example `claude mcp add …` with a token they paste).

## 6. Accept

```
node "$KIT/scripts/verify.mjs" A
S save -m "leader restored on <machine>"
```

The user then starts the leader with `team-claude` in the work directory 🖐.

## Leader in a container

The leader's role in the team file has `runtime.docker`, like a worker's ([team-file.md](team-file.md#docker-runtime)), without `--n`. A session on the docker host drives it. In Windows, that is a session in WSL or in PowerShell with Docker Desktop. `H` = `node "$KIT/scripts/host.mjs" --role leader --team <team.json>`. Inside the container `KIT` is `/opt/worker-kit`, and `A` is `--role leader --team <stateClone>/team.json`.

### Only one leader, even while rebuilding

- ⛔ `host.mjs` does not stop a running leader container. `rebuild`, `rollback` and `down` stop with exit 10 while it runs. The old session first runs `S release` and is closed, or the user confirms that container is not the live leader. Only then add `--stop-running`.
- ⛔ Never stop a container to "make room" on your own judgment.
- A leader on another machine is caught by the lock (step 2: exit 3).
- The rebuild record is `~/.claude-worker-kit/<container>.json`, one file per container, and it names its member. A record of another member under the same container name stops `host.mjs`.

### The container

With an image build in the team file (`buildContext` or `buildRepo`, `dockerfile`, `compose`), it is the same as for a worker:

```
H status                # containers, build directory, download speed
H rebuild               # the plan; then --yes after the user agrees
```

The first time, when there is no old container, `rebuild --yes` builds and starts one. `H up --yes` / `H down --yes` start and stop it later under its compose project. `rebuild` stops for the user's step: log in to Claude in the container (`docker exec -it <container> bash`, `claude`, log in, exit).

Without an image build for the leader, the project writes one first. The container needs:

- `node` (20 or later), `git`, `gh`, `age`, `ssh-keygen`, `curl`, and Claude Code.
- A user that is not root, whose home is a named volume, so memory and logins survive a rebuild.
- The work directory and the state clone on a volume too.
- The host credential directory mounted read-only, when the team file has `credDir`.
- `docker compose` with `container_name` set to the team file's `container`.

### The inside steps, from the host

```
H copy-kit --yes                     # the kit to /opt/worker-kit
H gh-login --yes                     # the container's gh logged in with the host's gh login
H exec -- "node $KIT/scripts/state.mjs clone --repo <stateRepo> --to <stateClone>"
H exec -- "node $KIT/scripts/state.mjs lock A --session '<container>@<docker host>'"
H exec -- "node $KIT/scripts/state.mjs restore A"
H unseal --identity <the master key file the user named>    # when restore listed sealed credentials
node "$KIT/scripts/repos.mjs" keys --role leader --team <team.json> --yes   # on the host
node "$KIT/scripts/repos.mjs" clone --role leader --team <team.json> --yes
node "$KIT/scripts/repos.mjs" setup --role leader --team <team.json> --yes
```

- `gh-login` reads the host's gh token and pipes it into `gh auth login --with-token` in the container. The token is never on a command line or in the output. Then it runs `gh auth setup-git`, so git there uses it for https.
  - The token is then stored in the container's gh config, where a login by hand would store it too.
  - If it reports a missing scope, run `gh auth refresh -h github.com -s <scope>` on the host, then `gh-login` again.
- A state repo with a `deployKey`: run `repos.mjs keys --role leader --team <team.json> --state-only --yes` on the host first, and pass `--key <deployKey>` to the clone.
- `lock` exiting 3 stops here, as in step 2.
- Then run step 5 inside with `H exec -- "…"`, then `H exec -- "node $KIT/scripts/verify.mjs A"` and `save`, then `H finish` after acceptance.

### Start the leader

The user runs 🖐:

```
docker exec -it <container> bash
cd <workDir>
team-claude
```

- On Windows this works straight from PowerShell with Docker Desktop, or from a WSL shell.
- `team-claude` starts Claude Code with the channel. The session reads its manual and `session-state.md`.
- Keep that terminal open. If the session is suspended by Ctrl+Z, type `fg` in the same terminal.
- If the terminal was closed, the container keeps running. Start the leader again the same way: `docker exec`, then `team-claude`.

## Bring a worker in

The worker's deploy keys are added on its own side, with the user's gh login (`repos.mjs keys`). The leader only lets the worker in:

```
node "$KIT/scripts/add-worker.mjs" --n N --team <the workers' team.json> --leader-team <the leader's team.json>
```

This does up to three things:

1. Only with `--pubkey "<ssh-ed25519 AAAA… line>"` (a worker set up without gh on its side): it adds that key as a writable deploy key on the workers' state repo. An existing key is reported, not added twice.
2. It adds the worker's bot `members.N.bot.appId` to the leader's channel allow list (live and saved) as `worker-N`. Restart the leader's channel so the change applies: `node <channel checkout>/bin/restart.mjs`.
3. It checks the work chat `members.N.chats.work` exists and the leader's bot is in it. If the chat is missing, the user creates it, adds both bots, and puts its id into the team file 🖐.

Tell the worker it is let in (and "deploy key added" when you added one).

A new worker also needs a Feishu bot. The user creates the app on the Feishu open platform 🖐: enable the bot, long-connection events `im.message.receive_v1` and `im.message.recalled_v1`, message permissions, and publish it. Put its app id into `members.N.bot.appId` and `save`.
