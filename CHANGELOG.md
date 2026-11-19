# Changelog

## 2.1.0 - 2026-11-19

### Changed
- **Independent implementation.** The earlier `index.js` was replaced by small modules: `src/db.js`, `src/config.js`, `src/prompt.js`, `src/accounts.js`, `src/menu.js`, `src/run.js` and a short entry point. Almost no earlier source lines remain (13 of 599 non-trivial lines are identical, all imports, column names or a library call). The repository is MIT-licensed as a whole; see [NOTICE.md](NOTICE.md) for how this was checked and its limits.
- The interactive menu was redesigned (run now, Steam accounts, add / refresh / remove). `node index.js --auto` and the environment variables `R4R_DRY_RUN` and `R4R_ONLY` work as before.
- Fewer dependencies: `colors`, `moment`, `form-data` and `steamid` were removed.
- Passwords are read key by key without any echo (`src/prompt.js`); piped input is supported for scripts and tests.
- Privacy: `umask 077` before anything is created, mode `600` for the database and config, `auto-relogin.js` reads secret files through one open descriptor (no check-then-read gap), Steam error messages and the account table show masked logins.
- The update check and `lib/version.js` were removed: the bot contacts Rep4Rep and Steam only.
- `R4R_DATA_DIR` selects where `config.json` and `steamprofiles.db` live (default: current directory).

### Fixed
- First start on a fresh machine: the database table is created before any menu or Auto Run uses it.
- A missing or invalid `config.json` gives one clear line (the parser message is dropped because Node quotes the input, which contains the API key); account menus still work without an API key.
- Unexpected errors during Auto Run are one `[AUTO ERROR]` line, not a stack trace.
- The login flow reads the authenticator through `steam-2fa/src/store.js` (prototype-safe, honours `R4R_2FA_DIR`/`R4R_2FA_FILE`) and never retries a rejected stored code in a loop.
- Removing an account matches the exact login first; a numeric login can no longer delete another row by id.
- A corrupt saved cookie no longer skips the account; the bot reports it and continues to the re-login path.
- An empty login name, a login without a SteamID and `R4R_ONLY` naming an unknown account are reported instead of failing silently.

### Added
- Tests for the sign-in flow (authenticator, e-mail code, CAPTCHA, masking), the account database, the whole Auto Run logic with a scripted Rep4Rep and Steam, the Rep4Rep API client, and the menu over piped input (54 tests).

## 2.0.0 - 2026-11-02

Migration to Rep4Rep API v1, by VSA.

### Changed
- API base is now `https://api.rep4rep.com/v1`. The old `https://rep4rep.com/pub-api/...` endpoints return HTTP 404, which crashed Auto Run with `invalid json response body`.
- Authentication moved from `?apiToken=` in the URL to `Authorization: Bearer <key>`, so the key no longer appears in URLs, error messages or logs. HTTP redirects are refused and requests time out after 30 s.
- Profiles come from `GET /steam-profiles` (by SteamID64). Missing local accounts are added right away with `POST /steam-profiles`.
- Tasks are fetched per profile (`GET /steam-profiles/{steamId}/tasks`) in rounds, limited by the profile's remaining daily comments. Already seen tasks are not repeated.
- Completed comments are submitted with `POST /tasks` (`steamId`, `requestId`, `commentId`, `ticket`) instead of `POST /tasks/complete`.
- Update checker now looks at this repository (it pointed at KniferFTW's) and compares versions numerically.
- `package.json`: `allowScripts` records which dependency install scripts may run (only `sqlite3`), version 2.0.0, `private: true`, `engines.node >= 20`. The unused `form-data` import was removed.

### Added
- `npm run 2fa:code -- ACCOUNT` shows the current Steam Guard code (also `--watch`, `--plain`, `--list`, `--sync`) so you can sign in on another device without resetting 2FA. Secrets are never printed.
- Privacy: login names are masked in logs (`lib/privacy.js`); the update check is now opt-in (`"checkForUpdates": true`) because it contacts GitHub; README has a Privacy section listing everything stored and every network destination.
- 2FA store hardening: `__proto__`, control characters and prototype keys (`constructor`, ...) are no longer treated as accounts; new `listAccounts()` returns names only.
- Enrollment now tells you where the revocation code is saved and to back it up offline.
- `npm run 2fa:check`: read-only health check of `steam-2fa.json` and `steam-passwords.json` (secret integrity, code generation, permissions, mismatched pairs). Never prints secrets or codes.
- Issue and pull request templates with privacy checklists.

### Compatibility
- Existing `~/.config/r4r/steam-2fa.json` and `steam-passwords.json` files work unchanged. Verified in both directions: entries written by the previous 2FA module are read by this version and produce identical codes, and entries written by this version are readable by the previous one.
- Comment filter (`commentFilter` in `config.json`, on by default).
- `R4R_DRY_RUN=1` and `R4R_ONLY=<account>` environment variables.
- Error handling: 401 (stop), 429 (retry with backoff), other submit errors (failed attempt).
- Passwords typed in the menu are no longer echoed.
- When a saved Steam session is rejected, the log now says why (`[SESSION] ... issued 67 h ago and has expired`), using only token timestamps, never cookie values.
- `config.json` and `steamprofiles.db` are set to mode `600` on start.
- `auto-relogin.js`: stored credentials are checked first and a missing setup gives a clear message (no more raw `ENOENT` with your home path); the 6 hour cooldown now starts only when a login is really attempted, not when credentials are missing; error messages no longer contain the config directory path;
- `auto-relogin.js`: permission check skipped on Windows; failing to save the retry state now stops the re-login attempt instead of risking a retry loop.
- Unit tests (`npm test`), CI test and tracked-secret checks, Dependabot.
- Hardened systemd service template (sandboxing, `UMask=0077`) with placeholders instead of host-specific paths.
- Root `SECURITY.md`.
