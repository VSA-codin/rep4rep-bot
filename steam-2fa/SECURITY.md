# Security

**Made by VSA**
**Discord:** `vacsecuredapproved`

This project handles authentication material. Treat the local secret store as sensitive.

## Never commit

Never commit or upload:

- Steam passwords
- Steam session cookies or access tokens
- authenticator secrets
- recovery/revocation codes
- SDA/maFiles
- `steam-2fa.json`
- `*.2fa-pending.json`

## Local permissions

Recommended permissions:

```bash
chmod 700 ~/.config/r4r
chmod 600 ~/.config/r4r/steam-2fa.json
chmod 600 ~/.config/r4r/*.2fa-pending.json 2>/dev/null || true
```

Backups of these files contain the same sensitive material and must be protected the same way.

## If authentication material is exposed

Assume it is compromised. Remove it from public access and use Steam's account-security/recovery controls to revoke or replace the affected authenticator or session.

Deleting a Git commit is not enough to make an already-published secret safe again.

## Passwords

This repository intentionally does not persist Steam passwords. If R4R-bot later needs unattended re-login, keep passwords in a separate system secret mechanism rather than Git.

## Logging

Do not print secrets or authentication codes in production logs.
