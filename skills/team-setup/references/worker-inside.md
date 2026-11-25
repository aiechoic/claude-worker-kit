# Docker worker: inside the container (restore)

The host session drives these steps: inside commands go through `H exec -- "…"` (or `H exec --file <script>`), where `H` = `node "$KIT/scripts/host.mjs" --n N --team <team.json>`. A session already running in the container runs them directly. Inside, `KIT` is `/opt/worker-kit` (copied by `H copy-kit --yes`). `A` = `--role worker --n N --team <stateClone>/team.json`; on the host, `A` uses the host's team file.

The user's part here: the master key file they named, and `! gh auth login` on the host if it is not logged in yet. Everything else is the session's.

## 1. State repo

1. **Deploy key** (on the host, with the user's gh login): `node "$KIT/scripts/repos.mjs" keys A --state-only` shows the plan; `--yes` makes the key in the container when missing and adds it to the state repo. gh missing: exit 11, install it yourself; not logged in: exit 10, the user runs `! gh auth login`.
2. **Clone and restore** (inside):
   ```
   node $KIT/scripts/state.mjs clone --repo <stateRepo> --to <stateClone> --key <deployKey>
   node $KIT/scripts/state.mjs restore A
   ```
   - Memory is linked to `<stateClone>/<dir>/memory`.
   - The manual imports `ROLE.md`. If the project's init rewrote the manual, `restore` adds the import again.
   - Then read `session-state.md`.
3. **Sealed credentials**: if `restore` listed sealed credentials:
   1. age in the container: `node $KIT/scripts/secrets.mjs age A`; on exit 11 run the install command it prints ([secrets.md](secrets.md#install-age)). The image usually has it.
   2. On the host: `H unseal --identity <the master key file the user named>`. The script reads the file and pipes it into `secrets.mjs unseal` in the container, then shows `secrets.mjs status`. ⛔ Do not open that file yourself.
   3. Check the result it prints: every sealed credential `written` or `already in place`. "no identity matched" means a different master key: ask the user for the right file. Nothing is written in that case.

## 2. The repos in `ROLE.md`

If `ROLE.md` has a `## Repositories` table ([team-file.md](team-file.md#rolemd-repositories)):

```
node "$KIT/scripts/repos.mjs" keys A --yes      # on the host: keys in the container, deploy keys on GitHub
H exec -- "node $KIT/scripts/repos.mjs clone A --yes"   # inside: ssh Host blocks, clones
```

Then the team file's `setup` steps, if it has any: `node "$KIT/scripts/repos.mjs" setup A --yes` (on the host; they run in the container) ([team-file.md](team-file.md#setup-steps)).

## 3. Feishu

In this order:

1. `node $KIT/scripts/channel.mjs install A` clones the public channel repo and runs `npm ci`.
2. `node $KIT/scripts/channel.mjs place A` puts the saved config back, has the channel's own `setup.mjs` write `mcp.json` / `settings.json`, and checks the App Secret file. After an unseal it is there; if it exits 10 (not sealed), the user writes the file from a terminal in the container 🖐 (the command it printed).
3. `node $KIT/scripts/channel.mjs launcher A` installs `team-claude`. If one already points elsewhere, it stops and shows it; `--replace` after the user agrees.
4. `node $KIT/scripts/lark.mjs add A` (the secret is piped from its file), then `lark.mjs check A` and `lark.mjs ping A`. `ping` failing usually means the bot is not in the work chat, or the app is not published.
5. `node $KIT/scripts/channel.mjs doctor A` checks the bot's permissions and event subscriptions; show its findings.

## 4. The rest of `ROLE.md`

- **Timers and cron**: their text is in `tools/`. Install them as `ROLE.md` says.
- **Data files**: small ones are in `data/`. For big ones, `ROLE.md` says where they live.
- **Credentials**: the sealed ones came back in step 1. `node $KIT/scripts/secrets.mjs status A` shows which are sealed; the others are filled as `ROLE.md` says.

## 5. Accept and start

```
node $KIT/scripts/verify.mjs A
node $KIT/scripts/state.mjs save A -m "restored"
```

`verify` also makes one short `claude -p` call: it shows a container that is not logged in, or an account out of credit, before the session starts.

Then the user starts the worker 🖐: `docker exec -it <container> bash` (straight from PowerShell on Windows with Docker Desktop), `cd <workDir>`, `team-claude`.

The new session reads the manual, `ROLE.md` and `session-state.md`, and posts "online" in its work chat. The leader checks it as described in [verify.md](verify.md).
