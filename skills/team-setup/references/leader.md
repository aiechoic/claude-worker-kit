# Leader: set up or restore

The leader runs natively, in a Linux shell or in a Windows session. Run all steps in the leader's work directory. `S` = `node "$KIT/scripts/state.mjs" --role leader --team <team.json>`.

## 1. The state repo and the team file

- If the leader's state repo is not cloned yet, clone it with the user's GitHub access (`gh auth login` first if `gh auth status` fails, 🖐). Or use the leader's deploy key: `state.mjs clone --repo <url> --to <stateClone> --key <deployKey>`.
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
- It adds `@…/ROLE.md` to the manual.
- It lists the credentials still to fill, and the sealed ones it found.
- If there are sealed credentials, first make sure age is installed (`secrets.mjs age --role leader --team …`; on exit 11 run the printed install command yourself, [secrets.md](secrets.md#install-age)). Then the user unseals them with the master key, from a terminal of their own 🖐 ([secrets.md](secrets.md#unseal-on-a-new-machine-restore)). ⛔ Not through the session.
- Read `session-state.md` afterwards.

## 4. GitHub, lark-cli, channel

1. **GitHub CLI**: `gh auth status`. If that fails, the user runs `gh auth login` 🖐. Adding workers' deploy keys needs admin rights on the workers' state repo.
2. **App Secret file**: `node "$KIT/scripts/channel.mjs" check-secret --role leader --team …`. After an unseal it is already there. If it exits 10, the user writes the secret file as shown 🖐.
3. **lark-cli**: `node "$KIT/scripts/lark.mjs" add --role leader --team …`. The secret is piped from the App Secret file. Then run `lark.mjs check`.
4. **Channel**, in this order:
   1. `channel.mjs install --role leader …` clones the public channel repo over https (skipping a global https→ssh rewrite) and runs `npm ci`.
   2. `channel.mjs place --role leader …` puts the saved config back.
   3. `channel.mjs launcher …` installs `team-claude` against that config. If a `team-claude` already points at another checkout or config, it stops and shows it; `--replace` after the user agrees.
   4. `channel.mjs doctor …` checks the bot's permissions.
5. **Project MCP servers and tokens**: go through `secrets` in the team file one by one.
   - Sealed entries are already back. `secrets.mjs status --role leader --team …` lists them.
   - For each other `path` entry the user puts the file there 🖐.
   - For each `check` entry, run the check. If it fails, show the `note` and the user fixes it 🖐 (for example `claude mcp add …` with a token they paste).

## 5. Accept

```
node "$KIT/scripts/verify.mjs" --role leader --team …
S save -m "leader restored on <machine>"
```

The user then starts the leader with `team-claude` in the work directory 🖐.

## Bring a worker in

The worker sends its state-repo public key: one line, `ssh-ed25519 AAAA… worker-N-…`. Public keys are fine to pass around; private keys never are.

```
node "$KIT/scripts/add-worker.mjs" --n N --pubkey "<the line>" --team <the workers' team.json> --leader-team <the leader's team.json>
```

This does three things:

1. It adds a writable deploy key on the workers' state repo (`gh api repos/<owner>/<repo>/keys`). An existing key is reported, not added twice.
2. It adds the worker's bot `members.N.bot.appId` to the leader's channel allow list (live and saved) as `worker-N`. Restart the leader's channel so the change applies: `node <channel checkout>/bin/restart.mjs`.
3. It checks the work chat `members.N.chats.work` exists and the leader's bot is in it. If the chat is missing, the user creates it, adds both bots, and puts its id into the team file 🖐.

Tell the worker "deploy key added". The worker then clones its state repo.

A new worker also needs a Feishu bot. The user creates the app on the Feishu open platform 🖐: enable the bot, long-connection events `im.message.receive_v1` and `im.message.recalled_v1`, message permissions, and publish it. Put its app id into `members.N.bot.appId` and `save`.
