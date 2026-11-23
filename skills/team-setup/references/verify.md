# Acceptance

## In the member's session (or through `host.mjs exec`)

```
node "$KIT/scripts/verify.mjs" --role worker --n N --team …     # or --role leader
```

All checks must pass:

- the state repo is cloned, clean and pushed;
- memory is linked or copied;
- the manual imports the role file (`roleFile`, default `ROLE.md`; skipped when `roleFile` is `null`);
- the session-state file (`sessionState`, default `session-state.md`) is there;
- the leader holds the lock here (leader only);
- the lark-cli profile has the right appId and brand;
- the bot reads the work chat;
- the channel config is in place, its App Secret file is present (not read), and its allow list is not empty;
- the channel is installed, and the `team-claude` first on PATH runs the team file's checkout with its config (not just any `team-claude`);
- every `secrets` entry is present, or its check passes.

Add `--offline` to skip the chat read when there is no network to Feishu.

## After the session starts (`team-claude`)

1. The member posts "online" in its work chat. The leader replies, and the member receives the reply.
2. The leader asks two questions:
   - "What are your duties and workflows?" The answer must match `ROLE.md`.
   - "What were you doing before this?" The answer must match the session-state file.
3. The member runs the project's own health check, if `ROLE.md` names one.
4. The member runs `state.mjs save`. It must push.

## The run log

Hand the user a short table: step | result | stuck / done by hand / unclear. This is what makes the next run smoother. Put fixes for the kit or the project into it, not into silent workarounds.
