# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's private vulnerability reporting (Security tab -> Report a vulnerability), or contact VSA on Discord: `vacsecuredapproved`.

## Never post publicly

- Rep4Rep API keys
- `config.json`, `steamprofiles.db`, `~/.config/r4r/*`
- Steam passwords, `shared_secret`, `identity_secret`, revocation codes, cookies, tokens
- Logs or screenshots containing any of the above

## If something leaked

1. **Rep4Rep API key:** create a new key in Settings -> API key (the old one stops working) and update `config.json`.
2. **Steam account:** change the password, revoke and re-create the Steam Guard authenticator if its secrets leaked, and sign out other sessions. If `steamprofiles.db` leaked, treat the saved sessions as compromised.
3. **Git history:** removing a file in a new commit does not remove it from history. Rotate the secret first, then clean the history if needed.

More details for the 2FA module: [steam-2fa/SECURITY.md](steam-2fa/SECURITY.md).

## Design notes

- `npm run 2fa:code` prints only the 5-character code. Whoever can run it on your host can sign in to your accounts, so restrict access to the host and the user account that owns `~/.config/r4r/`.
- The bot has no telemetry. See the README "Privacy" section for every network destination.

## Known limitations

- `steamcommunity` depends on old packages with open advisories (`npm audit --omit=dev`: 10 issues, 6 high, 4 moderate, 0 critical, checked after the 2.1.0 release). The bot does not process untrusted input with them beyond Steam/Rep4Rep API responses, but run it as an unprivileged user and keep the systemd sandbox.
- Unattended re-login keeps Steam passwords in plain text in `~/.config/r4r/steam-passwords.json` (mode 600). Use dedicated accounts and a host you control.
- Comment text comes from other users. Keep the comment filter enabled.
