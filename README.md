# R4R Bot

**Repaired, rebuilt & maintained by VSA**  
**Discord:** `vacsecuredapproved`

R4R Bot automates Steam comment tasks through the rep4rep public API. The current VSA edition includes an interactive Steam-account manager and a non-interactive `--auto` mode intended for scheduled VPS execution.

## What the bot does

- Runs rep4rep Auto Run tasks for saved Steam profiles.
- Stores Steam profile sessions locally in SQLite (`steamprofiles.db`).
- Adds a local Steam profile to rep4rep when needed.
- Fetches available rep4rep tasks for each saved profile.
- Posts the required Steam comments with a delay between comments.
- Tracks the last successful comment time and respects the bot's 24-hour readiness logic.
- Supports Steam Guard, mobile authenticator and CAPTCHA prompts during manual login.
- Lets you add, re-login and remove Steam accounts from the interactive menu.
- Supports `--auto` mode so a scheduler can run the job without waiting for keyboard input.

## Requirements

- Node.js
- npm
- A rep4rep API token
- Steam account(s) added through `Manage Steam Accounts`

The VPS currently used for this bot runs Node.js `v26.10.0`.

## Installation

Install dependencies from the lockfile:

```bash
npm ci
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

Use **Re-Login** when a saved Steam session has expired. Steam Guard/mobile authenticator/CAPTCHA prompts are handled interactively when Steam requests them.

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
ssh -i "$env:USERPROFILE\Downloads\KYNTRA-key.pem" admin@3.76.82.252
```

## Current automatic schedule

R4R Bot runs once per day at:

```text
06:00 Europe/Warsaw
```

The VPS itself can remain on UTC. The timer uses `Europe/Warsaw`, so daylight-saving-time changes are handled automatically.

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

Then restore the daily timer:

```bash
sudo systemctl start r4r-bot.timer
systemctl is-active r4r-bot.timer
systemctl list-timers r4r-bot.timer --all --no-pager
```

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
