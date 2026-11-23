# Docker worker: the host side (rebuild)

Run this on the machine with docker: a Linux shell, or a Windows session where docker lives in WSL. On Windows, `host.mjs` runs every docker command through `wsl -e bash -lc`, and paths in `runtime.docker` are paths inside WSL. `H` = `node "$KIT/scripts/host.mjs" --n N --team <team.json>`.

## 1. Look first (read-only)

```
H status
```

- Docker must be reachable.
- The host credential directory (`runtime.docker.credDir`) must have the files the project's init expects. Only their names are shown.
- Shared services the project needs (databases, networks) must already run. They are the project's business; check them with the commands its docs give, and do not start or stop them here.

## 2. Plan, then rebuild

```
H rebuild               # prints the plan, changes nothing
H rebuild --yes         # after the user agrees to the plan
```

The rebuild does five things:

1. It tags the current image `<image>:pre-<stamp>`.
2. It builds the image from `buildContext`. This can take a long time; run it in the background and say so.
3. It stops the container and renames it `<container>-old`. Its volumes stay.
4. It starts a new container under a new compose project `<composeProject>-<stamp>`. A new project name means new, empty volumes, so nothing is mounted from the old ones.
5. It runs the project's init hook in the container. The init must end green. If it does not, see [rollback.md](rollback.md).

The rebuild then exits 10: the user logs in to Claude inside the new container 🖐 (`docker exec -it <container> bash`, run `claude`, log in, exit).

**Note:** the new compose project name is the one to use from now on. The old name mounts the old volumes. Tell the user, and write it into the member's `ROLE.md` when you get there.

## 3. Continue inside

1. Copy the kit into the container: `H copy-kit --yes`. This gives `/opt/worker-kit/scripts/…`.
2. Run the inside steps ([worker-inside.md](worker-inside.md)) from here with `H exec -- "<command>"`, using `KIT=/opt/worker-kit`.
3. Commands that need a terminal are for the user, through `docker exec -it <container> bash` 🖐. These are pasting a secret and starting `team-claude`.

## 4. After acceptance

Once the worker has passed acceptance ([verify.md](verify.md)) and the leader has confirmed:

```
H finish --yes
```

This forgets the rollback record. `<container>-old`, its volumes and the `pre-` image tag stay until the user decides to remove them. Suggest keeping them for a week.
