# Docker worker: inside the container (restore)

Run these inside the worker's container. Either the host session runs them through `host.mjs exec -- "…"`, or a session already running in the container runs them directly. `KIT` is `/opt/worker-kit` (copied by `host.mjs copy-kit`), or the installed plugin. `A` = `--role worker --n N --team <stateClone>/team.json`.

## 1. State repo

1. **Deploy key**, unless `deployKey` already exists (on a surviving volume it does):
   ```
   ssh-keygen -t ed25519 -N "" -C worker-N-state -f <deployKey>
   cat <deployKey>.pub
   ```
   The user forwards the `.pub` line to the leader 🖐. The leader runs `add-worker.mjs` ([leader.md](leader.md#bring-a-worker-in)). Wait for "added".
2. **Clone and restore:**
   ```
   node $KIT/scripts/state.mjs clone --repo <stateRepo> --to <stateClone> --key <deployKey>
   node $KIT/scripts/state.mjs restore A
   ```
   - Memory is linked to `<stateClone>/<dir>/memory`.
   - The manual imports `ROLE.md`. If the project's init rewrote the manual, `restore` adds the import again.
   - Then read `session-state.md`.

## 2. Feishu

1. **App Secret file**: `node $KIT/scripts/channel.mjs check-secret A`.
   - If it exits 10, the user writes the file from a terminal in the container 🖐 (`docker exec -it <container> bash`, then the command the script printed).
   - The secret is on the Feishu open platform, under the worker's app → Credentials.
2. **lark-cli**: `node $KIT/scripts/lark.mjs add A`. The secret is piped from the file. Then run `lark.mjs check A` and `lark.mjs ping A`.
   - `ping` failing usually means the bot is not in the work chat, or the app is not published.
3. **Channel**, in this order:
   1. `node $KIT/scripts/channel.mjs install A` clones the public channel repo and runs `npm ci`.
   2. `node $KIT/scripts/channel.mjs place A` puts the saved config back.
   3. `node $KIT/scripts/channel.mjs launcher A` installs `team-claude`. If one already points elsewhere, it stops and shows it; `--replace` after the user agrees.
   4. `node $KIT/scripts/channel.mjs doctor A` checks the bot's permissions.

## 3. The rest of `ROLE.md`

`ROLE.md` lists what the member set up by hand. Restore each item:

- **Timers and cron**: their text is in `tools/`. Install them as `ROLE.md` says.
- **Data files**: small ones are in `data/`. For big ones, `ROLE.md` says where they live.
- **Credentials**: `ROLE.md` names where each one goes. The user, or the host credential directory, fills it.

## 4. Accept and start

```
node $KIT/scripts/verify.mjs A
node $KIT/scripts/state.mjs save A -m "restored"
```

Then the user starts the worker 🖐: `docker exec -it <container> bash`, `cd <workDir>`, `team-claude`.

The new session reads the manual, `ROLE.md` and `session-state.md`, and posts "online" in its work chat. The leader checks it as described in [verify.md](verify.md).
