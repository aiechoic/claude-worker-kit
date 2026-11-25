# <member> — duties and workflows

<One paragraph: who this member is, who gives it work, where it talks (work chat), what it delivers.>
The shared manual is the project's `CLAUDE.md`; this file holds only what is this member's own.

## Receiving messages

- Through the Feishu channel only: start sessions with `team-claude` in the work directory.
- If the channel breaks, tell the leader in the work chat with lark-cli (`--profile <profile> --as bot`).

## Workflows

### <workflow name>

- Input: <what starts it>
- Steps: <numbered steps, commands, scripts in tools/>
- Output: <what is delivered, where>
- When: <trigger or schedule>

## Repositories

Other repos this member works in (the state repo is in the team file). `repos.mjs keys` / `clone` restore them.

| repo | clone | key | host | access |
| --- | --- | --- | --- | --- |
| <git URL> | <where it is cloned> | <deploy key path> | <ssh Host alias, or empty> | write |

## Environment (only on this machine; not in any repo)

- Timers / cron: <none | text in tools/, how to install>.
- Data: <small files in data/ | where big ones live>.

## Credentials (paths only)

- <name>: <path>, filled by <user | host credential directory>.
