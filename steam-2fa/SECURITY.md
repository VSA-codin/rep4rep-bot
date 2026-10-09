# Security

The Steam Guard tools and R4R Bot handle plaintext authentication secrets. Keep them outside Git and restrict access to the host and the user running the bot.

## Local files

The default private directory is `~/.config/r4r/`; `R4R_2FA_DIR` can select another location. `steam-2fa.json`, `steam-passwords.json`, pending enrollment files, and their backups contain account secrets. `relogin-attempts.json` stores retry times. Custom `R4R_2FA_FILE`, `R4R_PASSWORDS_FILE`, and `R4R_RELOGIN_FILE` locations require the same protection.

On Linux, recommended permissions for the default location are:

```bash
chmod 700 ~/.config/r4r
chmod 600 ~/.config/r4r/steam-2fa.json
chmod 600 ~/.config/r4r/steam-passwords.json
```

Apply the same restrictions to `relogin-attempts.json`, pending enrollment files, and backups. The files and their containing directory must be owned by the user running the bot. The application rejects unsafe existing permissions, symlinks, non-regular files, and extra hard links. Correct ownership and permissions manually before retrying; do not make the directory readable to other users.

If a process is killed during a write or enrollment, a `*.lock` or `*.operation-lock` can remain. Stop every bot and enrollment process, check the recorded owner, and remove only a confirmed stale lock. Preserve the data and pending files. Never delete a lock while its writer may still be running.

The root `config.json` and `steamprofiles.db`, including SQLite sidecar files, also contain private data. Use file mode `0600` and a private parent directory. A database backup grants access to saved Steam sessions even when passwords are not present.

## Keep out of Git

Never commit passwords, API tokens, Steam cookies, mobile authenticator secrets, recovery codes, SDA/maFiles, pending enrollment files, or copies of the local SQLite session database.

The enrollment script reads `STEAM_USER` and `STEAM_PASS` from the environment. Avoid putting credentials directly into shell commands that may be saved in history, and clear sensitive environment variables when finished.

## If a secret is exposed

1. Stop unattended runs on the affected host and determine which account or API token was exposed. Do not copy the value into issues, logs, or the PR.
2. Replace an exposed rep4rep API token through rep4rep. For Steam exposure, change the affected password, revoke existing sessions, and review authorized devices using Steam's account security controls.
3. If a shared secret, identity secret, revocation code, or pending authenticator data was exposed, remove or replace that authenticator through Steam's supported recovery flow. Preserve access to legitimate recovery options while doing so.
4. Replace the local files using the new credentials with private ownership and permissions. Old session databases and backups remain sensitive; retire them after recovery is verified.
5. Review access and logs to identify the source of exposure. Record only the affected path, commit, account reference, and type of material in a report.

Deleting a published file or commit does not revoke credentials. History was not rewritten by this audit. The scan found no confirmed authentication secrets in the available repository history; see [the audit report](../docs/AUDIT.md) for its scope and limits.

Production logs must not contain passwords, API tokens, session cookies, authenticator secrets, or generated codes. Treat third-party error bodies and URLs as sensitive too. Do not attach private files or a full local environment dump when reporting an error.

Maintainer: VSA (`vacsecuredapproved` on Discord).
