# Steam Guard 2FA — R4R Bot

Integrated Steam Guard module maintained by VSA.

This module is included in the main `rep4rep-bot` repository.
No separate repository installation is required.

## Installation

From the main repository directory:

    npm install
    npm run check

## Commands

Enroll a Steam account:

    npm run 2fa:enroll

Finalize pending enrollment:

    npm run 2fa:finalize -- ACCOUNT

Check the module:

    npm run check:2fa

Enrollment requires STEAM_USER and STEAM_PASS environment
variables. Supply passwords interactively, not as literal
commands saved in shell history.

## Automatic login

The main bot uses `auto-relogin.js` for unattended login
with stored credentials and Steam Guard codes.

## Private data

Authentication data must remain outside the repository:

    ~/.config/r4r/steam-passwords.json
    ~/.config/r4r/steam-2fa.json

Never publish passwords, cookies, shared_secret,
identity_secret, revocation_code or API tokens.

The module stores authentication data with restricted
filesystem permissions.

## License and attribution

See LICENSE in this directory for the 2FA module license.
The main bot's inherited code has separate licensing
and attribution information in the repository NOTICE.md.
