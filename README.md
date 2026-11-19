# R4R Bot

Automatic Steam comment bot for [Rep4Rep](https://rep4rep.com), working with the **Rep4Rep API v1** (`https://api.rep4rep.com/v1`, [docs](https://rep4rep.com/api)).

**Migrated to API v1, rebuilt and maintained by VSA** · Discord: `vacsecuredapproved`

> **Read this first.** This is an unofficial tool, not affiliated with Rep4Rep or Valve. Automating Steam accounts may violate Steam's rules and can put your accounts at risk. You use it at your own responsibility. See [Safety](#safety).

## Origin and attribution

This repository is a VSA-maintained edition of earlier rep4rep bot code:

- Upstream project: [rep4rep/rep4rep-bot](https://github.com/rep4rep/rep4rep-bot) and the community fork [KniferFTW/rep4rep-bot](https://github.com/KniferFTW/rep4rep-bot).
- Service and API: [rep4rep.com](https://rep4rep.com).
- **VSA work:** the old `pub-api` endpoints were removed, so VSA rewrote the API layer for **API v1** (Bearer authentication, per-profile tasks, ticket-based submission) and added multi-account session isolation, unattended re-login with Steam Guard, the [2FA tools](steam-2fa/README.md) (enrollment and on-demand Steam Guard codes), privacy-preserving logs, the comment filter, systemd deployment and tests.

**Licensing.** This repository is MIT-licensed ([LICENSE](LICENSE)). Since 2.1.0 the program is an independent reimplementation, split into small modules (`src/`, `lib/`). It shares its purpose and the public Rep4Rep API with the earlier bots, and none of the earlier source lines are copied: of 599 non-trivial lines, 13 are identical to the earlier code, and all of those are standard library imports, the database column names (which must stay compatible with existing databases) or a one-line library call. Credits and provenance are in [NOTICE.md](NOTICE.md). VSA does not claim authorship of the original project or of the Rep4Rep service.

## What it does

1. Reads your Steam profiles linked on Rep4Rep (`GET /steam-profiles`) and adds saved local accounts that are missing there (`POST /steam-profiles`).
2. For each account that is ready (24 h local gate and remaining daily limit reported by Rep4Rep), fetches tasks (`GET /steam-profiles/{steamId}/tasks`).
3. Skips tasks whose comment text is rejected by the [comment filter](#comment-filter).
4. Posts each remaining comment with a 15 s pause, then submits it (`POST /tasks` with `requestId`, `commentId` and `ticket`). Rep4Rep verifies it a few minutes later.
5. Error handling: `401` stops the run, `429` is retried with backoff, any other submit error counts as a failed attempt (two per account, then the account is skipped).

Each account uses its own Steam client and saved session (SQLite). Expired sessions can be restored automatically (see [Steam Guard](#steam-guard-and-unattended-re-login)).

## Requirements

- Node.js 20 or newer (deployed on 26.10.0) and npm
- A Rep4Rep API key: Rep4Rep -> Settings -> API key
- Linux for the systemd templates (the bot itself also runs on macOS/Windows)

## Install

```bash
git clone https://github.com/VSA-codin/rep4rep-bot.git
cd rep4rep-bot
npm install
cp config.example.json config.json
chmod 600 config.json
```

Put your key in `config.json`:

```json
{
  "apiToken": "YOUR_REP4REP_API_KEY",
  "commentFilter": { "enabled": true, "maxLength": 300 }
}
```

`config.json` and `steamprofiles.db` are git-ignored. **Never commit or share them.** The bot sets both to mode `600` on start (Linux/macOS).

## Install notes

npm 11 and newer ask you to approve packages that run install scripts. This project already records the decision in `package.json` (`allowScripts`): `sqlite3` (native module, needs its install script) is allowed, `protobufjs` (its script only prints a warning) is denied. Older npm versions ignore the field.

## Usage

Interactive menu (run now, add / refresh / remove Steam accounts). Passwords are typed without echo:

```bash
npm start
```

One unattended pass, then exit (used by the timer):

```bash
npm start -- --auto
```

Testing helpers (environment variables):

| Variable | Effect |
| --- | --- |
| `R4R_DRY_RUN=1` | Reads profiles and tasks and prints what would happen. No Steam login, no comments, no submissions. |
| `R4R_ONLY=<steam login>` | Process only that saved account. |
| `R4R_DATA_DIR=<folder>` | Where `config.json` and `steamprofiles.db` live (default: the current directory). |

```bash
R4R_DRY_RUN=1 node index.js --auto
R4R_ONLY=myaccount node index.js --auto
```

Development: `npm run check` (syntax) and `npm test` (unit tests).

## Comment filter

Comment texts are written by other Rep4Rep users and are posted from **your** accounts. By default the bot skips comments that contain links, file or download/delete instructions, cheating accusations or `-rep`, and comments longer than 300 characters. Skipped tasks are simply not done. Configure in `config.json`:

```json
"commentFilter": {
  "enabled": true,
  "maxLength": 300,
  "blockedWords": ["http://", "https://", "www.", "download", "delete", "cheat", "hack", "scam", "-rep"]
}
```

`blockedWords` replaces the default list (case-insensitive substring match). Setting `"enabled": false` posts every task as received, at your own risk.

## Scheduled runs

### Linux (systemd)

Templates are in [deploy/systemd](deploy/systemd). Replace `USER`, the project path and the Node.js path (`command -v node`), then:

```bash
sudo cp deploy/systemd/r4r-bot.service deploy/systemd/r4r-bot.timer /etc/systemd/system/
sudo nano /etc/systemd/system/r4r-bot.service      # edit USER and paths
sudo systemd-analyze verify /etc/systemd/system/r4r-bot.service /etc/systemd/system/r4r-bot.timer
sudo systemctl daemon-reload
sudo systemctl enable --now r4r-bot.timer
```

The service template is sandboxed (read-only filesystem except the bot directory and `~/.config/r4r`, no extra privileges, only network sockets). Check the result with `systemd-analyze security r4r-bot.service`. Logs: `journalctl -u r4r-bot.service -n 100 --no-pager`. The timer runs hourly; each account is processed at most once per 24 h.

### Without systemd

- cron: `0 * * * * cd /path/to/rep4rep-bot && /usr/bin/node index.js --auto >> bot.log 2>&1` (`*.log` is git-ignored; protect the log file, it contains account names).
- Windows: Task Scheduler running `node index.js --auto` in the project folder.

## Steam Guard and unattended re-login

Steam sessions expire. With the optional setup below the bot can log in again without a prompt:

- `~/.config/r4r/steam-passwords.json` (account -> password)
- `~/.config/r4r/steam-2fa.json` (account -> `shared_secret`), created by the bundled [2FA tools](steam-2fa/README.md)

Show the current Steam Guard code on demand with `npm run 2fa:code -- ACCOUNT` (details in [steam-2fa/README.md](steam-2fa/README.md)). These files must stay outside Git, in a `700` directory with `600` files. The bot refuses to read them if their permissions are too open (checked on Linux/macOS), and tries each account at most once per 6 hours. **This stores passwords on disk in plain text by design; only do this on a host you control, ideally with dedicated accounts used for this bot.** **Why this matters:** Steam's web session cookies last only about 24 hours. Without these two files the bot cannot renew an expired session, so it skips the account (`[SESSION] ... has expired` followed by `[RELOGIN] ... not set up`) and you have to sign in again from the menu (Steam accounts -> Refresh the login of a saved account). For scheduled, unattended use, set up both files.

## Privacy

R4R Bot is designed so that **nobody but you, Rep4Rep and Steam ever receives your data**. There is no telemetry, no analytics, no crash reporting, no update check and no server operated by the maintainers. Nothing is collected about you or about the accounts the bot uses.

The bot sets `umask 077` before creating anything, so its database, config and re-login state are readable only by your user account.

**Stored only on your machine**

| What | Where | Protection |
| --- | --- | --- |
| Rep4Rep API key | `config.json` | git-ignored, mode `600` |
| Steam session cookies and tokens | `steamprofiles.db` | git-ignored, mode `600` |
| Authenticator secrets, revocation codes | `~/.config/r4r/steam-2fa.json` | outside the repo, dir `700`, file `600` |
| Passwords for unattended re-login (optional) | `~/.config/r4r/steam-passwords.json` | outside the repo, plain text, `600` |

**Network connections the bot makes**

| Destination | When | What is sent |
| --- | --- | --- |
| `api.rep4rep.com` | every run | your API key (header), your SteamID64s, task data |
| `steamcommunity.com` / Steam | when commenting, logging in | the comment, session or login data |
| `api.steampowered.com` | only `2fa:code --sync` | a time request |

That is the complete list: the bot has no other network destinations.

**Logs.** Login names are masked in the bot's output (`vacsecuredapproved` -> `va***d`). Passwords, tokens, API keys and authenticator codes are never logged. Log lines still contain public task data (target profile names and comment texts) and your accounts' masked names, so review a log before sharing it.

**Removing your data.** Delete `config.json`, `steamprofiles.db` and `~/.config/r4r/`, create a new Rep4Rep API key, and remove the profiles in your Rep4Rep settings. If an authenticator secret may have leaked, revoke Steam Guard in Steam's account security.

## Safety

- **Secrets.** API key, Steam session cookies and tokens (`steamprofiles.db`), passwords and authenticator secrets give full access to your accounts. Keep them out of git, screenshots, chats and logs. The bot sends the API key only in an HTTP header, refuses redirects, and does not print it. If anything leaks, rotate it (new Rep4Rep key; Steam password/authenticator) because deleting a commit does not invalidate a leaked secret.
- **Steam rules and bans.** Steam limits profile comments and discourages automation. Keep the delays. Prefer dedicated accounts.
- **Third-party text.** See the [comment filter](#comment-filter). Review what the bot posts.
- **Dependencies.** The Steam stack (`steamcommunity`) pulls old transitive packages. `npm audit --omit=dev` currently reports 12 issues (7 high, 5 moderate, none critical). The suggested `npm audit fix --force` would **downgrade** `steamcommunity` and can break the bot, so do not run it. Run the bot as an unprivileged user, ideally with the systemd sandbox.
- **No guarantee.** Nobody can promise "100% secure". Report problems via [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. By contributing you agree that your changes are MIT-licensed. Never post API keys, cookies, `steamprofiles.db`, `steam-2fa.json` or logs containing them.

## Credits and license

The whole repository is **MIT-licensed** ([LICENSE](LICENSE)), including `index.js`, `lib/`, `auto-relogin.js`, `steam-2fa/` ([its own MIT license](steam-2fa/LICENSE)), `test/`, `deploy/` and `docs/`. Every `.js` file states the license in an `SPDX-License-Identifier: MIT` header. Provenance and credits: [NOTICE.md](NOTICE.md).
