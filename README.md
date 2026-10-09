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

Use Node.js and npm. The current deployment has been run with Node.js 26.10.0.

```bash
npm install
```

Create `config.json` next to `index.js`:

```json
{
  "apiToken": "YOUR_REP4REP_API_TOKEN"
}
```

The API token is obtained from rep4rep. Do not commit this file.

Start the menu:

```bash
npm start
```

Select **Manage Steam Accounts** to add an account, refresh a Steam session, or remove an account. Steam may ask for an email code, an authenticator code, or a CAPTCHA during interactive login.

Run one unattended task pass:

```bash
npm start -- --auto
```

The process exits when the pass is complete. To check syntax without logging in:

```bash
npm run check
```

## Scheduled runs on Linux

Example systemd units are in [deploy/systemd](deploy/systemd). The **repository timer template** currently uses `OnCalendar=hourly`; a deployed server may have a different schedule. Read the installed unit before replacing it:

```bash
systemctl cat r4r-bot.timer
systemctl list-timers r4r-bot.timer --all --no-pager
```

The service template refers to a particular user, project directory and Node.js executable. Edit those paths for your host before installing the units.

After copying and adapting the units, check them and reload systemd:

```bash
sudo systemd-analyze verify /etc/systemd/system/r4r-bot.service /etc/systemd/system/r4r-bot.timer
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

Do not upload `config.json` or `steamprofiles.db`. The database contains session material.

The 2FA integration uses files outside the repository, normally under `~/.config/r4r/`. Automatic re-login expects `steam-passwords.json` and `steam-2fa.json` there, with access restricted to the account running the service. See [Steam Guard setup](steam-2fa/README.md) and [security guidance](steam-2fa/SECURITY.md).

Steam authentication is sensitive. A leaked session, password, or authenticator secret must be treated as compromised.

## Dependencies and limits

Parts of the Steam login stack depend on older packages. Review `npm audit` output before upgrading; `npm audit fix --force` can introduce incompatible dependency changes. The checked-in syntax check does not replace an end-to-end login test.

## Credits

Originally derived from the [rep4rep bot project](https://github.com/rep4rep/rep4rep-bot); this edition is maintained by VSA. The project is independent of the rep4rep service. Copyright and licensing notes for inherited code and the separate 2FA module are in [NOTICE.md](NOTICE.md).
