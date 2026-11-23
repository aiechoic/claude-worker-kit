# Rollback

Roll back when a step fails and cannot be fixed in place, or when the user asks. Show the plan before running it.

## Docker worker after a rebuild

```
node "$KIT/scripts/host.mjs" rollback --n N --team …          # plan
node "$KIT/scripts/host.mjs" rollback --n N --team … --yes    # after the user agrees
```

The rollback does three things:

1. It removes the new container: `docker rm -f <container>`.
2. It renames `<container>-old` back and starts it.
3. It puts the old image back: `docker tag <image>:pre-<stamp> <image>`.

The new volumes are left in place. The script prints the `docker compose -p <new project> … down -v` that removes them, and the user decides.

The old session lives on the old volumes, with its own `team-claude` inside the container. The user starts it again with `team-claude` in its work directory 🖐.

Without a rollback record (`~/.claude-worker-kit/<container>.json` on the host), `rollback` still brings `<container>-old` back if it exists. The old image tag is then up to the user.

## Native worker

See [worker-native.md](worker-native.md#rollback). The old work directory is the rollback.

## Leader

The old leader's machine and directory are untouched by a restore elsewhere. To go back:

1. Stop the new leader. If it took the lock, release it there: `state.mjs release --role leader`.
2. Start the old one. It takes the lock again with `state.mjs lock --role leader`.

## After any rollback

- Check what reached the state repo from the failed attempt: `git log` in the member's directory. Commits are fine to keep, because they only describe state. If one is wrong, revert it with a new commit. ⛔ Never force-push.
- Write down in the run log what failed and at which step.
