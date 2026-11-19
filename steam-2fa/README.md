# Steam Guard tools for R4R Bot

VSA's Steam Guard Mobile enrollment and code tools. They are part of the main R4R Bot repository and have their own [MIT license](LICENSE).

Everything runs on your own machine. Secrets are stored locally in `~/.config/r4r/` and nothing is sent anywhere except to Steam (to enroll the authenticator, and optionally to read Steam's clock with `--sync`).

From the repository root, install dependencies and run the checks:

```bash
npm install
npm run check:2fa
```

## 1. Enroll an authenticator

The enrollment script reads the Steam login and password from the `STEAM_USER` and `STEAM_PASS` environment variables. Do not type passwords into commands that end up in shell history. Steam may ask for an email code or an SMS activation code.

```bash
npm run 2fa:enroll
```

If enrollment was started but not finished, finalize it:

```bash
npm run 2fa:finalize -- ACCOUNT
```

When it succeeds the secrets are saved to `~/.config/r4r/steam-2fa.json` (mode `600`), including the **revocation code**. The tool prints where it is. **Copy that revocation code to a safe, offline place right away**: it is the only way to remove Steam Guard if this machine is lost.

## 2. Show the current Steam Guard code

Use this to sign in to Steam on another device or browser **without resetting two-factor authentication**:

```bash
npm run 2fa:code -- ACCOUNT            # show the code once
npm run 2fa:code -- ACCOUNT --watch    # keep it updated, Ctrl+C to stop
npm run 2fa:code -- ACCOUNT --plain    # only the code (for scripts or a clipboard tool)
npm run 2fa:code -- --list             # accounts that have an authenticator stored
```

`ACCOUNT` can be left out when exactly one account is stored. Example output:

```
myaccount: 7BK2P  (valid for 18 s)
```

If Steam rejects a correct-looking code, this machine's clock is probably off. Add `--sync` to use Steam's time (one request to `api.steampowered.com`) or fix the system clock (`timedatectl set-ntp true` on Linux).

The command never prints the shared secret, identity secret or revocation code. Anyone who can run it on your host can sign in to your accounts, so protect the host and the account that runs it.

## 3. Check your files, and move from the previous version

Version 2 reads **the same files in the same format** as the earlier 2FA tools, so there is nothing to convert:

| File | Path | Format |
| --- | --- | --- |
| Authenticator secrets | `~/.config/r4r/steam-2fa.json` | `{ "account": { "shared_secret", "identity_secret", "revocation_code" } }` |
| Passwords for unattended re-login (optional) | `~/.config/r4r/steam-passwords.json` | `{ "account": "password" }` |

To upgrade a server, keep `~/.config/r4r/` where it is, replace the program files, and run the read-only health check:

```bash
cp -a ~/.config/r4r ~/.config/r4r.bak      # backup first
npm run 2fa:check                          # masks account names; add -- --show-names to reveal them
```

It reports, per account, whether the `shared_secret` is intact and generates a valid code, whether `identity_secret` and `revocation_code` are present, whether file permissions are too open, and whether any account has a password without an authenticator (or the other way round). It never prints secrets or codes and never modifies files.

To move secrets to a different machine, copy `steam-2fa.json` over a channel you trust (for example `scp` between your own machines), then set the permissions again (`chmod 700 ~/.config/r4r && chmod 600 ~/.config/r4r/*`) and run `npm run 2fa:check`. Do not email or chat the file, and delete temporary copies. Using the same authenticator on two machines is possible (both generate the same codes) but doubles the places that must be protected.

## 4. Use the authenticator with R4R Bot

The bot's `auto-relogin.js` can use a saved password and the stored shared secret to recover an expired session without a prompt. Files, all in `~/.config/r4r/` and all outside Git:

- `steam-2fa.json`: authenticator secrets
- `steam-passwords.json`: credentials for unattended re-login (plain text by design; use dedicated accounts)

See [SECURITY.md](SECURITY.md) and the main [README](../README.md#privacy). The inherited code of the main bot and its attribution are described in [NOTICE.md](../NOTICE.md).
