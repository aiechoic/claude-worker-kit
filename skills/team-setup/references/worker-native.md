# Native worker (Windows, no container)

The session runs straight on Windows, in a work directory of its own. Run commands in PowerShell, or Git Bash if the user prefers. `A` = `--role worker --n N --team <stateClone>\team.json`.

What is different from a docker worker:

- **No host side.** There is no image or container. "Rebuild" means a new work directory. The old directory is left alone, and that is the rollback.
- **Memory is copied, not linked.** Symlinks need developer mode on Windows.
  - `restore` makes the local memory directory hold exactly the repo's `memory/`, deletions included. The repo wins.
  - Before that, it compares the local files with what the last `save` or `restore` left (the marker file `.state-repo-copy` records a hash per file). If anything changed here since then, `restore` stops and lists it: changed, new or deleted.
    - To keep those changes, run `save` first, then `restore`.
    - To throw them away, run `restore --force`.
  - `save` copies local → repo, three-way against that marker. A file changed only in the repo since the last sync (another machine saved it) keeps the repo's version and is copied here too. A file changed on both sides is a conflict: `save` stops and lists it, and `save --force` keeps this machine's versions.
  - Line endings do not count as a change: files are compared with CRLF read as LF. `state.mjs` clones the state repo with `core.autocrlf=input`, so a global `core.autocrlf=true` does not turn memory files into CRLF.
  - So run `save` at every checkpoint. Memory written after the last `save` exists only on this machine.
- **Taking over a memory directory restore did not create.** This means Claude Code already wrote memory here before the first `restore`, so there is no marker. `restore` then stops and lists every local file that differs from the repo.
  - `restore --adopt` copies the local files into the repo's `memory/` (local wins on name clashes) and syncs. Then run `save` to push them.
  - `restore --force` throws the local files away and takes the repo's.
- **`team-claude` is per machine, not per work directory.** It is one launcher on PATH (`team-claude.cmd` in npm's global directory), pointing at one channel checkout and one config. A new work directory on the same machine repoints it.
  - `channel.mjs install` / `launcher` stops when the launcher points elsewhere, and shows the old checkout and config. `--replace` repoints it after the user agrees.
  - `--dir <directory on PATH>` installs a separate one instead.
- **Paths**: in the team file, `workDir`, `stateClone`, `deployKey` and `channel.*` take Windows paths for this member (`members.N`). `~` is `%USERPROFILE%`.
- **Commands**: `lark-cli.cmd`, `npm.cmd` and `team-claude.cmd` are found through PATH. The scripts handle this.

## Steps

1. **Work directory**: make the directory (`workDir`) and start Claude Code there. For a rebuild, use a new directory and keep the old one.
2. **State repo**: do step 1 of [worker-inside.md](worker-inside.md), with the same commands and Windows paths. `ssh-keygen` comes with Windows' OpenSSH client.
3. **Feishu**: do step 2 of [worker-inside.md](worker-inside.md). When `check-secret` exits 10, the user writes the App Secret from a separate PowerShell window with the command the script printed 🖐.
4. **Accept**: run `verify.mjs A`, then `state.mjs save A`.
5. **Start**: the user opens a new terminal in the work directory and runs `team-claude` 🖐. `channel.mjs install` installed `team-claude.cmd` into npm's global bin.

## Rollback

1. Stop the new session.
2. Point `team-claude` back at the old work directory, because the new one repointed it. In the old work directory, run `node "$KIT/scripts/channel.mjs" launcher A --replace` with the old directory's team-file paths. It shows what it is replacing.
3. Start the old session again from the old work directory with `team-claude`. Its memory copy, channel config and lark-cli profile are still on this machine.
4. `verify.mjs A` in the old directory: `team-claude points here` must pass.

If both used the same bot, only one may run at a time. Two connections for one bot split the messages.

If the state repo got commits from the new directory, the old directory's next `restore` stops on any local memory the old directory changed since its last sync. Decide per file, as above. Before taking the repo's side, check the new directory's commits are wanted.
