# Sealed credentials

A member's credentials can travel in its private state repo, encrypted with the official [age](https://github.com/FiloSottile/age) tool. A new machine then needs one thing from the user, the **master key**, instead of every credential one by one.

- **Public key** (`age1…`): in the team file as `secretsRecipient`. Anyone who has it can seal, so members seal their own credentials at `save`.
- **Master key** (`AGE-SECRET-KEY-1…`): the matching age identity. Only the user keeps it, for example in a password manager. ⛔ It never goes into a repo, a log, a chat or the session.
- **Which credentials**: `secrets` entries with `"sealed": true` and a `path`. Each one is kept as `<member dir>/secrets/<id>.age`; `id` defaults to the file name of `path`, without leading dots. To seal the bot's App Secret, list it as `{ "name": …, "path": "{channel.appSecretFile}", "sealed": true }`.
- **Not sealed**: deploy keys. A lost deploy key is replaced: generate a new one and send the `.pub` line to the leader. Entries with only a `check` (a login such as `gh auth status`) cannot be sealed either.

`A` below is `--role … [--n N] --team <team.json>`, as for every script.

## Install age

`secrets.mjs` exits 10 with these lines when age is missing 🖐:

- Windows: `winget install FiloSottile.age`, then open a new terminal.
- Debian / Ubuntu (docker workers: in the image or the init hook): `apt install age`.
- Elsewhere: an official release from GitHub, with `age` and `age-keygen` on PATH.

Version 1.1 or later (it reads the master key from stdin).

## Set up once per team

1. The user makes the master key on a machine they trust 🖐:
   ```
   node "$KIT/scripts/secrets.mjs" keygen --out <file outside every repo>
   ```
   It prints only the public key. The user stores the key file in their password manager and deletes it from this machine.
2. Put the public key into the team file as `secretsRecipient`, and mark the credentials to carry with `"sealed": true`. Commit.

## Seal

Sealing needs only the public key, so each member does it for itself:

- `state.mjs save` seals every sealed credential whose file changed since its last seal, then commits.
- `node "$KIT/scripts/secrets.mjs" seal A` does it by hand; `--force` seals again even if nothing changed.
- `node "$KIT/scripts/secrets.mjs" status A` lists each sealed credential: local file present or missing, sealed in the repo or not yet. It never opens either file.

## Unseal on a new machine (restore)

After `state.mjs restore`, which lists the sealed credentials it found, the user hands the master key over once, from a terminal of their own (not this session) 🖐:

- Linux or a docker worker (`docker exec -it <container> bash` first):
  ```
  (read -rsp "master key: " k && printf '%s\n' "$k" | node "$KIT/scripts/secrets.mjs" unseal A --identity -); echo
  ```
- Windows, with the key copied from the password manager:
  ```
  Get-Clipboard | node "$env:KIT\scripts\secrets.mjs" unseal A --identity -
  ```
  Then clear the clipboard.
- Or, if the user put the key in a file: `--identity <file>`. Delete the file afterwards.

What `unseal` does:

- It decrypts every sealed file in memory first. Only when all of them decrypted and passed age's authentication does it write: each to a temporary file (mode 600), then renamed into place.
- A wrong master key, or a damaged or altered file, stops it with nothing written.
- A different file already at a path is kept, and reported. `--force` replaces it with the sealed one.
- Credentials that are not sealed in the repo are reported. Fill them by hand as before.

The session only runs the follow-up checks (`channel.mjs check-secret`, `verify.mjs`). These check that files exist; they do not read them.

## No sealed files

If the team has no `secretsRecipient`, or a credential was never sealed, fill each credential by hand as the restore steps say. That is the user writing the file from a separate terminal, or the host credential directory.

## A leaked master key

If the master key reached a chat, a log or the session, it is exposed. Make a new master key (`keygen`), put its public key into `secretsRecipient`, run `secrets.mjs seal A --force` on every member that has its credentials in place, and save. Rotate the credentials themselves too: the old `.age` files are still in the repo's history.
