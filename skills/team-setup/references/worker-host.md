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

The rebuild record `~/.claude-worker-kit/<container>.json` (on the machine that runs `host.mjs`) notes each step as it completes; `H status` shows how far it got and which step failed. If a step fails:

- **Step 1 or 2** (tag, image build): the container was not touched. The pre- tag of that attempt is removed, and the same `H rebuild --yes` simply runs again once the cause is fixed.
  A failed build prints the last 60 lines of `docker build` (the whole log is `~/.claude-worker-kit/<container>-build.log` on the docker host). The build downloads base images and toolchains (Go, Node, the Playwright browsers…), so a timeout, TLS or connection error there is usually the network: set a proxy for docker (`"proxies"` in `~/.docker/config.json` on the docker host, or `HTTP_PROXY` / `HTTPS_PROXY` for the docker daemon) and run it again.
- **Step 3, 4 or 5** (the old container is stopped or renamed): the record is kept and a plain rebuild is refused. Two ways on, the user chooses:
  - `H rollback --yes`: back to the old container ([rollback.md](rollback.md));
  - `H rebuild --resume --yes`: continue at the failed step, with the same compose project, once its cause is fixed.

`H finish` refuses a rebuild that did not complete.

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

This forgets the rebuild record. `<container>-old`, its volumes and the `pre-` image tag stay until the user decides to remove them. Suggest keeping them for a week.
