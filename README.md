# R4R Bot

**Repaired, rebuilt & maintained by VSA**  
**Discord:** `vacsecuredapproved`

R4R Bot automates Steam comment tasks through the rep4rep public API. The current VSA edition includes an interactive Steam-account manager and a non-interactive `--auto` mode intended for scheduled VPS execution.

## Project origin & attribution

This repository is a **rebuilt and maintained VSA edition** of an earlier rep4rep bot codebase.

- **Upstream project:** [rep4rep/rep4rep-bot](https://github.com/rep4rep/rep4rep-bot)
- **Upstream service/API:** [rep4rep](https://rep4rep.com/)
- **VSA edition:** repaired, rebuilt and extended by **VSA**
- **Discord:** `vacsecuredapproved`

The VSA edition adds and maintains the current VPS deployment, scheduled Auto Run workflow, multi-account session isolation and Steam Guard integration.

VSA does **not** claim authorship of the original rep4rep project or its inherited code. The upstream repository currently does not provide a software license covering the old bot code. Accordingly, this repository does not claim that the inherited portions are open-source or relicense them under ISC/MIT. See [NOTICE.md](NOTICE.md) for details.


## What the bot does

- Runs rep4rep Auto Run tasks for saved Steam profiles.
- Stores Steam profile sessions locally in SQLite (`steamprofiles.db`).
- Adds a local Steam profile to rep4rep when needed.
- Fetches available rep4rep tasks for each saved profile.
- Posts the required Steam comments with a delay between comments.
- Tracks the last successful comment time and respects the bot's 24-hour readiness logic.
- Supports Steam Guard, CAPTCHA prompts and automatic Steam Guard Mobile code generation from the local VPS 2FA store during manual re-login.
- Lets you add, re-login and remove Steam accounts from the interactive menu.
- Supports `--auto` mode so a scheduler can run the job without waiting for keyboard input.
- Uses a separate `SteamCommunity` client per saved account during Auto Run to avoid cross-account session mixing.
- Includes the integrated [`steam-2fa/`](steam-2fa/README.md) for VPS-side Steam Guard Mobile setup and code generation.

> **Security notice (October 2026):** The latest steamcommunity version still depends on vulnerable legacy libraries, including request and cheerio. npm audit reports unresolved vulnerabilities, including critical findings. Use only in a controlled environment. Never publish Steam credentials or authentication secrets.

## Requirements

- Node.js
- npm
- A rep4rep API token
- Steam account(s) added through `Manage Steam Accounts`

The VPS currently used for this bot runs Node.js `v26.10.0`.

## Installation

Install dependencies:

```bash
npm install
```

Create/edit `config.json`:

```json
{
  "apiToken": "YOUR_REP4REP_API_TOKEN"
}
```

Never publish your real API token.

## Normal interactive mode

Start the bot:

```bash
npm start
```

You will see:

```text
R4R Bot - Home
Repaired & maintained by VSA | Discord: vacsecuredapproved

1) Auto Run
2) Manage Steam Accounts
CTRL + C to exit at any time.
```

### Manage Steam Accounts

Choose:

```text
2) Manage Steam Accounts
```

The account menu provides:

```text
1) Add a Steam Account
2) Re-Login to a Steam Account
3) Remove a Steam Account
4) Back
```

Use **Re-Login** when a saved Steam session has expired. If the account has a stored `shared_secret` in `~/.config/r4r/steam-2fa.json`, the Steam Guard Mobile code is generated automatically. Email Steam Guard and CAPTCHA prompts remain interactive when Steam requests them.

## Automatic mode

Run Auto Run directly without opening the menu:

```bash
npm start -- --auto
```

Equivalent direct command:

```bash
node index.js --auto
```

The bot performs one Auto Run pass and exits when finished. This is the mode used by the systemd timer.

---

# VPS cheat sheet

## Project location

```bash
/home/admin/apps/R4R-bot
```

KYNTRA Core is a separate project/service and is not controlled by R4R Bot.

## Login to VPS from Windows PowerShell

```powershell
ssh -i "$env:USERPROFILE\Downloads\YOUR-SSH-KEY.pem" admin@YOUR_VPS_IP
```

## Current automatic schedule

R4R Bot is checked **every hour on the hour**:

```text
OnCalendar=hourly
```

The VPS runs in UTC. In Poland, the displayed local trigger time depends on daylight saving time. If the previous Auto Run is still active at the next hourly trigger, systemd does not start a second copy of the same service in parallel.

Check the timer:

```bash
systemctl is-active r4r-bot.timer
systemctl is-enabled r4r-bot.timer
systemctl list-timers r4r-bot.timer --all --no-pager
```

Expected:

```text
active
enabled
```

Between scheduled runs, this is normal:

```text
r4r-bot.service -> inactive (dead)
```

The service is only started by the timer, performs Auto Run, and exits.

## Logs

Last 100 lines:

```bash
journalctl -u r4r-bot.service -n 100 --no-pager
```

Today's logs:

```bash
journalctl -u r4r-bot.service --since today --no-pager
```

Live logs:

```bash
journalctl -u r4r-bot.service -f
```

Exit live logs with `CTRL + C`.

## Manually run Auto Run

```bash
cd ~/apps/R4R-bot
npm start -- --auto
```

## Add / re-login / remove Steam accounts

When you need the interactive account manager:

```bash
cd ~/apps/R4R-bot
sudo systemctl stop r4r-bot.timer
npm start
```

Choose:

```text
2) Manage Steam Accounts
```

Make the account changes. When finished, exit with:

```text
CTRL + C
```

Then restore the hourly timer:

```bash
sudo systemctl start r4r-bot.timer
systemctl is-active r4r-bot.timer
systemctl list-timers r4r-bot.timer --all --no-pager
```

## Integrated Steam Guard 2FA

Steam Guard tools are included in `steam-2fa/`.

Install and check from the repository root:

    npm install
    npm run check

Steam Guard commands:

    npm run 2fa:enroll
    npm run 2fa:finalize -- ACCOUNT

Automatic re-login is handled by `auto-relogin.js`.

Keep passwords and 2FA secrets outside Git:
`~/.config/r4r/`

See [Steam Guard documentation](steam-2fa/README.md).

## systemd files

Templates are included in:

```text
deploy/systemd/r4r-bot.service
deploy/systemd/r4r-bot.timer
```

To install/update them on the current VPS:

```bash
sudo cp deploy/systemd/r4r-bot.service /etc/systemd/system/r4r-bot.service
sudo cp deploy/systemd/r4r-bot.timer /etc/systemd/system/r4r-bot.timer
sudo systemctl daemon-reload
sudo systemctl enable --now r4r-bot.timer
```

Verify:

```bash
sudo systemd-analyze verify /etc/systemd/system/r4r-bot.service /etc/systemd/system/r4r-bot.timer
systemctl is-active r4r-bot.timer
systemctl is-enabled r4r-bot.timer
systemctl list-timers r4r-bot.timer --all --no-pager
```

## Check KYNTRA separately

```bash
systemctl is-active kyntra.service
systemctl is-enabled kyntra.service
```

Expected:

```text
active
enabled
```

## Important files

Do not casually delete:

```text
config.json
steamprofiles.db
```

- `config.json` contains the rep4rep API configuration.
- `steamprofiles.db` contains saved Steam account/session data.

Do not run this blindly:

```bash
npm audit fix --force
```

This project currently relies on older dependency versions and forced dependency upgrades can introduce breaking changes. Review upgrades before applying them.

## Maintainer

**R4R Bot — repaired, rebuilt & maintained by VSA**  
**Discord:** `vacsecuredapproved`

This VSA edition is independently maintained and is not affiliated with any previous maintainer.
