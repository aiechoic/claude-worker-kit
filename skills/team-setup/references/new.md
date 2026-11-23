# New team or new member

## A new team (no state repos yet)

1. **Repos**: the user creates two **private** repos 🖐: one for the leader's state, one for all workers' states. Each member gets a directory in its repo.
2. **Team file**:
   - Copy `examples/team.json` from this kit into each state repo as `team.json`.
   - Fill in the repo URLs, paths and runtime settings.
   - Bot app ids and chat ids come later, as they are created.
   - Commit the file. It is project data, so it stays in the private repos.
3. **Leader bot**: the user creates a Feishu app for the leader 🖐.
   - Enable the bot.
   - Choose long-connection events `im.message.receive_v1` and `im.message.recalled_v1`.
   - Grant the message read/send, reaction, pin and chat-list permissions.
   - Publish it.
   - Put the app id into `roles.leader.bot.appId`.
4. **Leader's directory**:
   - Create `leader/` in the leader's repo with `ROLE.md` and `session-state.md`, using the templates in `templates/` of this kit.
   - Write a channel config into `leader/tools/feishu-channel/config.json`. Start from the channel repo's `config.example.json`, and use `appSecretFile`, not `appSecret`.
5. Continue with [leader.md](leader.md).

## A new worker N

1. **On the leader side:**
   - The user creates the worker's Feishu app, as in step 3 above 🖐.
   - The user creates the work chat 🖐 and adds the leader's bot and the worker's bot to it.
   - Add `members.N` to the workers' `team.json` with `bot.appId` and `chats.work`. For a native Windows worker, also add `runtime.mode: native` and the Windows paths.
   - Create `worker-N/` with `ROLE.md`, `session-state.md` and `tools/feishu-channel/config.json`. The config's `allow` lists the user's open_id and the leader's app id, and its `statusChat` is the work chat.
   - Commit and push.
2. **Docker worker**:
   - The host needs the project's image, compose file and credential directory. Those are the project's business, and its `init` hook prepares the container.
   - Start the container: `host.mjs rebuild --n N` works for a first start too, because there is simply no old container to set aside.
   - Then continue with [worker-inside.md](worker-inside.md).
3. **Native worker**: continue with [worker-native.md](worker-native.md).
4. **The worker's deploy key**: when the worker sends its public key, the leader runs `add-worker.mjs` ([leader.md](leader.md#bring-a-worker-in)).
