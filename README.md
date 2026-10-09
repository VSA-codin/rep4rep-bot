# R4R Bot

Steam comment task runner for the [rep4rep](https://rep4rep.com/) public API.

This repository is a VSA-maintained edition of an earlier rep4rep bot. It retains code from the earlier project as well as later changes. See [NOTICE.md](NOTICE.md) for provenance and licensing details.

## Features

- Manage multiple Steam accounts from a terminal menu.
- Save account sessions and the last successful comment time in a local SQLite database.
- Run tasks non-interactively with `--auto`, using an independent Steam client for each account.
- Re-authenticate expired sessions when local credentials and Steam Guard secrets are configured.
- Enroll and manage Steam Guard Mobile authentication using the bundled [2FA tools](steam-2fa/README.md).

The task runner applies a 24-hour readiness check per account and pauses between comments.

## Install

Use Node.js 22 or newer and npm. Offline CI covers Node.js 22 and 24; the audit was also run with Node.js 24.19.0.

```bash
npm ci
```

Copy [config.example.json](config.example.json) to `config.json` next to `index.js`, restrict it to the user running the bot, and fill in the rep4rep API token:

```bash
umask 077
cp config.example.json config.json
chmod 600 config.json
```

```json
{
  "apiToken": "YOUR_REP4REP_API_TOKEN"
}
```

Obtain the token from rep4rep. The token and the SQLite session database are private local data. Existing private files with unsafe ownership or permissions must be corrected before running the bot.

Start the menu:

```bash
npm start
```

Select **Manage Steam Accounts** to add an account, refresh a Steam session, or remove an account. Steam may ask for an email code, an authenticator code, or a CAPTCHA during interactive login.

Run one unattended task pass:

```bash
npm start -- --auto
```

The process exits when the pass is complete. Each account has its own Steam client. A failed account is reported and does not prevent the remaining accounts from being checked. `SIGINT` and `SIGTERM` stop the pass and close local resources.

Completed task identities are retained in SQLite. A comment with an unknown outcome blocks that account for manual review; a confirmed comment whose API acknowledgement failed retries only the acknowledgement. Removing an account clears its completed task history and cooldown. Accounts with pending operations must be reconciled before removal. See [the recovery checklist](docs/AUDIT.md).

Before posting, the bot records the operation in SQLite. If a confirmed post still needs rep4rep completion, a later pass retries that completion without posting again. A timeout or crash during posting leaves an uncertain operation and pauses that account until the owner checks Steam and rep4rep. Completed task records are retained to prevent replay. Do not delete these records or restore an older database to force another pass; follow the recovery steps in [the audit report](docs/AUDIT.md).

Run the local checks without logging in:

```bash
npm run check
npm test
npm audit
```

The tests use temporary databases and fake SteamCommunity/rep4rep responses. They do not require `config.json`, existing sessions, or Steam credentials. CI runs syntax checks and the offline tests; dependency audit results and remaining risks are recorded in [the audit report](docs/AUDIT.md).

## Scheduled runs on Linux

Example systemd units are in [deploy/systemd](deploy/systemd). The **repository timer template** currently uses `OnCalendar=hourly`; a deployed server may have a different schedule. Read the installed unit before replacing it:

```bash
systemctl cat r4r-bot.timer
systemctl list-timers r4r-bot.timer --all --no-pager
```

The service is a `Type=oneshot` process: it finishes after one `--auto` pass, and the timer starts the next pass. Leave `RemainAfterExit` disabled so later timer runs can start it again. A running service is not started a second time by the timer.

The template uses a dedicated `r4r` user, `/opt/r4r-bot`, and `/usr/bin/node`. Adapt these to the host, including the Node.js executable. `StateDirectory=r4r` creates `/var/lib/r4r` with mode `0700`; the unit reads `config.json` there, writes `steamprofiles.db` there, and keeps authentication files under `/var/lib/r4r/auth`. Move existing private state with the service stopped, preserving ownership and permissions, rather than starting with an empty database. The source tree remains read-only to the service.

The unit applies `UMask=0077`, permits up to two hours per pass, and allows 30 seconds for shutdown. Increase `TimeoutStartSec` if the account count and comment delay require a longer pass; do not replace it with an unlimited timeout. When using a Node.js installation under `/home`, change the executable location or review `ProtectHome=true` before using the template.

Review the [manual verification checklist](docs/AUDIT.md) and the existing unit before changing a running installation. The audit and PR do not install or activate these units.

When the owner has reviewed and adapted the units, check them before installing or activating the timer:

```bash
systemd-analyze verify deploy/systemd/r4r-bot.service deploy/systemd/r4r-bot.timer
```

After copying the reviewed units to `/etc/systemd/system/`:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now r4r-bot.timer
```

For status and logs:

```bash
systemctl status r4r-bot.timer
journalctl -u r4r-bot.service -n 100 --no-pager
```

An inactive service between runs is expected when the timer is enabled and no task pass is in progress.

## Authentication data

`config.json` contains the API token. `steamprofiles.db` contains Steam sessions and task state; its journal/WAL files and backups are also private. Keep these files out of Git and give them mode `0600` in a directory accessible only to the bot user.

`R4R_CONFIG_FILE` and `R4R_DB_PATH` override the default configuration and database paths. They can keep mutable private state outside the source checkout, as in the systemd template.

The 2FA integration normally uses `~/.config/r4r/`, where automatic re-login reads `steam-passwords.json` and `steam-2fa.json`. `R4R_2FA_DIR` changes the shared directory; `R4R_2FA_FILE`, `R4R_PASSWORDS_FILE`, and `R4R_RELOGIN_FILE` can override individual files. Use directory mode `0700` and file mode `0600`, owned by the account running the bot. Symlinks and hard-linked private files are rejected. See [Steam Guard setup](steam-2fa/README.md) and [security guidance](steam-2fa/SECURITY.md).

Steam authentication is sensitive. A leaked session, password, or authenticator secret must be treated as compromised.

## Dependencies and limits

Parts of SteamCommunity's login stack still depend on packages with known advisories. Review [the audit report](docs/AUDIT.md) and `npm audit` before deployment. The remaining findings need upstream changes or a separately tested replacement; `npm audit fix --force` can select incompatible versions. Offline tests verify local behavior, but the owner must separately verify actual Steam challenges and rep4rep responses.

## Credits

Originally derived from the [rep4rep bot project](https://github.com/rep4rep/rep4rep-bot); this edition is maintained by VSA. The project is independent of the rep4rep service. Copyright and licensing notes for inherited code and the separate 2FA module are in [NOTICE.md](NOTICE.md).
