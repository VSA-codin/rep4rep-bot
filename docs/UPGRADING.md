# Upgrading to v2 (Rep4Rep API v1) and testing on a PC

v2 talks to `https://api.rep4rep.com/v1`. The old `pub-api` endpoints no longer exist, so the previous version cannot be rolled back to; a rollback only restores your files.

Your existing `~/.config/r4r/steam-2fa.json` and `steam-passwords.json` work unchanged (same format and path).

## A. Test on a PC first (Windows)

1. Node.js 20 or newer. Unzip the project to a folder without secrets, then `npm install`.
2. `copy config.example.json config.json` and put your Rep4Rep API key in it (`"apiToken"`).
3. `npm start` -> 2 (Steam accounts) -> 1 (Add an account). Type the Steam Guard code when asked (the password is not echoed).
4. Dry run (no Steam login, nothing is posted):
   ```powershell
   $env:R4R_DRY_RUN = "1"; node index.js --auto; Remove-Item Env:R4R_DRY_RUN
   ```
5. Real run: `node index.js --auto`. It posts real comments. Steam web sessions last about 24 hours, and a PC without `steam-passwords.json` cannot renew them, so sign in again from the menu (Steam accounts -> Refresh the login of a saved account) right before the run.
6. When finished, delete the project folder and `%USERPROFILE%\.config\r4r` so no keys or sessions stay on the PC.

## B. Upgrade the server

Assumes the project lives in `~/apps/R4R-bot` and runs from the `r4r-bot` systemd timer.

```bash
sudo systemctl stop r4r-bot.timer
cp -a ~/apps/R4R-bot ~/apps/R4R-bot.bak
cp -a ~/.config/r4r ~/.config/r4r.bak
```

Copy the new program files over the old ones. Do **not** overwrite `config.json`, `steamprofiles.db` or `node_modules`. From your PC (PowerShell, from the unzipped project folder):

```powershell
scp -i "PATH\TO\KEY.pem" -r index.js auto-relogin.js package.json package-lock.json lib steam-2fa USER@HOST:~/apps/R4R-bot/
```

On the server:

```bash
cd ~/apps/R4R-bot
npm install
chmod 700 ~/.config/r4r && chmod 600 ~/.config/r4r/* config.json steamprofiles.db
```

Create a **new** API key on rep4rep.com (Settings -> API key; the old one stops working) and put it in `config.json` (`nano config.json`). Then:

```bash
npm run 2fa:check                          # read-only check of your saved authenticators
R4R_DRY_RUN=1 node index.js --auto         # plan only
R4R_ONLY=YOUR_LOGIN node index.js --auto   # one account for real; check "Verified" on rep4rep.com
sudo systemctl reset-failed r4r-bot.service
sudo systemctl start r4r-bot.timer
systemctl list-timers r4r-bot.timer --all --no-pager
```

When everything works, remove the backups (they contain secrets) and old logs:

```bash
rm -rf ~/apps/R4R-bot.bak ~/.config/r4r.bak
sudo journalctl --vacuum-time=1d
```

## C. Publishing to GitHub

1. Make sure no secrets are tracked: `git ls-files | grep -E "config\.json|\.db|steam-2fa|steam-passwords|\.env"` must print nothing, and `git log --all -p` must not contain API keys.
2. Commit with the GitHub `noreply` e-mail address so your real address stays private.
3. In the repository settings enable secret scanning with push protection, private vulnerability reporting and Dependabot alerts.
4. Tag the release (`v2.1.0`) and paste the matching section of `CHANGELOG.md`.
