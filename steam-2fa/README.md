# Steam Guard tools for R4R Bot

This directory contains VSA's Steam Guard Mobile enrollment and code-generation utilities. It is part of the main R4R Bot repository.

Use the root lockfile and Node.js 22 or newer. From the repository root:

```bash
npm ci
npm run check:2fa
npm test
```

## Enrollment

Enrollment requires the Steam login name and password in `STEAM_USER` and `STEAM_PASS`. Load them through a private prompt or a credential manager; avoid putting passwords in shell history. Steam may request an email code and an activation code. Enrollment changes the account's authenticator, so the owner must keep Steam's recovery options available.

```bash
npm run 2fa:enroll
```

If enrollment returned authenticator data but was not completed, keep `STEAM_PASS` available and finalize the pending enrollment for that account:

```bash
npm run 2fa:finalize -- ACCOUNT
```

The scripts refuse to overwrite an existing authenticator or pending enrollment. They save private pending state before contacting Steam. If a request times out or the process is interrupted, Steam may already have changed the account: the pending file is deliberately retained. A pending file without a `shared_secret` cannot be finalized automatically. Check the authenticator state and recovery options in Steam before removing that marker or attempting enrollment again. Clear `STEAM_USER` and `STEAM_PASS` from the environment when finished.

After Steam confirms finalization, a `finalized` marker is saved before the main secret store. If local persistence then fails, running `2fa:finalize` again completes local storage without another Steam request. If the confirmation marker could not be written, verify Steam's state manually before retrying. An account operation lock prevents concurrent enrollment and finalization.

Network requests and keyboard prompts have deadlines, and retries are bounded. A timeout is a reason to inspect account state, not proof that a remote operation failed.

## Using the authenticator with R4R Bot

The bot's `auto-relogin.js` uses saved credentials and the Steam Guard shared secret to recover an expired session without a keyboard prompt. The default directory is `~/.config/r4r/`:

- `steam-2fa.json` — authenticator secrets
- `steam-passwords.json` — credentials used for unattended re-login
- `relogin-attempts.json` — per-account retry times

`steam-passwords.json` is a JSON object mapping Steam login names to passwords. `steam-2fa.json` maps the same names to objects containing `shared_secret` and, when available, `identity_secret` and `revocation_code`. These values are stored as plaintext; filesystem permissions and host security protect them.

The bot allows an unattended re-login attempt at most once every six hours per account and retries once when Steam requests a mobile code. The returned session must belong to the configured Steam account before it is saved. Email challenges and CAPTCHA still require the interactive login flow.

`R4R_2FA_DIR` selects a different private directory. `R4R_2FA_FILE`, `R4R_PASSWORDS_FILE`, and `R4R_RELOGIN_FILE` override individual files. The directory must have mode `0700`, and existing files must have mode `0600`, be owned by the current user, and have no symlinks or additional hard links. An unsafe existing file is rejected rather than silently rewritten.

Keep private data outside Git, including pending enrollment files and backups. See [SECURITY.md](SECURITY.md) for permissions and recovery after exposure. Attribution for the main bot is preserved in [NOTICE.md](../NOTICE.md); this module retains its separate [MIT license](LICENSE).
