# Steam Guard tools for R4R Bot

This directory contains VSA's Steam Guard Mobile enrollment and code-generation utilities. It is part of the main R4R Bot repository.

From the repository root, install dependencies and run the syntax checks:

```bash
npm install
npm run check:2fa
```

## Enrollment

The enrollment script requires the Steam login name and password in the `STEAM_USER` and `STEAM_PASS` environment variables. Do not paste passwords into commands saved in shell history. Steam may request an email code or an activation code during enrollment.

```bash
npm run 2fa:enroll
```

If enrollment was started but not completed, the pending enrollment can be finalized for that account:

```bash
npm run 2fa:finalize -- ACCOUNT
```

## Using the authenticator with R4R Bot

The bot's `auto-relogin.js` can use saved credentials and a stored Steam Guard shared secret to recover an expired session without a keyboard prompt. The default private file location is `~/.config/r4r/`:

- `steam-2fa.json` — authenticator secrets
- `steam-passwords.json` — credentials used for unattended re-login

These files must remain outside Git with restricted permissions. See [SECURITY.md](SECURITY.md). The main bot's inherited code and its attribution are described in the root [NOTICE.md](../NOTICE.md); this module has its own [MIT license](LICENSE).
