# Security

The Steam Guard tools and R4R Bot handle authentication secrets. Keep them outside the Git repository and restrict file access on the host.

## Local files

The Steam Guard module saves authenticator data under `~/.config/r4r/` by default. The main bot also supports unattended re-login using a local `steam-passwords.json` file and `steam-2fa.json`. These files contain credentials or secrets and must be protected accordingly.

On Linux, recommended permissions for the default location are:

```bash
chmod 700 ~/.config/r4r
chmod 600 ~/.config/r4r/steam-2fa.json
chmod 600 ~/.config/r4r/steam-passwords.json
```

Apply the same restrictions to `relogin-attempts.json`, pending enrollment files, and any backups that contain private data. File permissions are only one layer of protection: limit access to the host and the account running the service.

## Keep out of Git

Never commit passwords, API tokens, Steam cookies, mobile authenticator secrets, recovery codes, SDA/maFiles, pending enrollment files, or copies of the local SQLite session database.

The enrollment script reads `STEAM_USER` and `STEAM_PASS` from the environment. Avoid putting credentials directly into shell commands that may be saved in history, and clear sensitive environment variables when finished.

## If a secret is exposed

Revoke or replace the affected Steam authenticator, credentials, or sessions using Steam's account security controls. Deleting a published file or commit does not invalidate a leaked secret.

Production logs should not contain passwords, session cookies, or authenticator codes.

Maintainer: VSA (`vacsecuredapproved` on Discord).
