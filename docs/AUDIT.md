# Maintenance audit — Issue #3

This audit starts at `main` commit `80b258366d856e0197c327190a5a01ea3925a7a9`, including the earlier authentication and maintenance changes. Work is on `audit/issue-3-offline-hardening`, for human review through a pull request. No Steam account, authenticator, production secret, VPS, installed systemd unit, or real comment was used or changed.

## Changes and regression coverage

| Area | Confirmed problem and resulting behavior | Files and offline evidence |
| --- | --- | --- |
| Startup and CLI | SQLite initialization was not awaited; imports started the application; paths depended on the current directory; input and async failures could leave resources open. Initialization now completes before use, imports are inert, paths default to the source directory, and EOF/SIGINT/SIGTERM close prompts, transport, and SQLite. The menu, `--auto`, email/mobile Guard, CAPTCHA, and version check remain available. | `index.js`, `lib/database.js`, `lib/login.js`; CLI, login, and database tests. |
| Accounts | Lookup by username or SteamID could update an ambiguous account; deletion by username or ID could remove unrelated rows. Updates verify one identity and preserve its ID and cooldown. Numeric removal selects one ID; pending task operations prevent removal. | `lib/database.js`, `auto-relogin.js`; account identity, SQL input, deletion, and persistence tests. |
| Session recovery | A stale session, malformed cookies, Family View, or wrong-account session could be reused incorrectly. Each account gets its own client, verified against its SteamID. Invalid sessions trigger bounded re-login; one failed account does not stop the remaining accounts. | `lib/bot.js`, `auto-relogin.js`; isolated cookies/tokens, wrong identity, Family View, and expired-session tests. |
| Re-login and secrets | Retry state was written nonatomically, concurrent attempts could race, unsafe JSON errors could disclose content, and path overrides were inconsistent. Owned regular private files, canonical secret encoding, case-insensitive accounts, atomic writes, exclusive writer locks, and a persisted six-hour cooldown now apply consistently. Password-only accounts still work; mobile challenges receive at most one automatic response. | `lib/private-files.js`, `auto-relogin.js`, `steam-2fa/src/store.js`; unsafe permissions, links, malformed stores, two-process contention, per-account cooldown, and late-response tests. |
| Steam login | Callback deadlines alone could leave the underlying login session polling. The shared `steam-session` adapter cancels the session, destroys its transport, refuses later transport retries, and ignores late cookies. Both web login and mobile enrollment use the adapter. | `lib/steam-login.js`; authentication transport, mobile token, timeout, abort, challenge, and late-response tests. |
| API and scheduling | HTTP errors, malformed JSON, provider errors, duplicate tasks, unsafe numeric SteamID64 values, and unbounded requests were not handled consistently. Requests have deadlines, cancellation, size limits, encoded query parameters, and schema checks. Explicit negative or empty acknowledgements fail. Comments are spaced by at least 15 seconds across accounts, including failed attempts. New cooldown timestamps use UTC ISO strings. | `lib/api.js`, `lib/bot.js`; API contract, deadline/body timeout, duplicate identities, acknowledgement, cooldown boundary, and rate-limit tests. |
| Interrupted comments | A comment could succeed while its database update or rep4rep acknowledgement failed, allowing a later run to post it again. Durable intent is written before Steam. Confirmed posts update the cooldown and retry state in one transaction; later runs retry only the API acknowledgement. Completed identities remain recorded. An unknown posting outcome blocks that account for manual review. | `comment_operations` in `lib/database.js`, `lib/bot.js`; restart, acknowledgement retry during cooldown, uncertain timeout, cancellation, and post-success SQL rollback tests. |
| Steam responses | SteamCommunity parses comment HTML after a successful post and can throw asynchronously on an unexpected response. The bot's adapter checks the HTTP/JSON result without parsing comment HTML. It also tracks request handles and cancels them on shutdown. | `lib/community.js`; mock transport tests for real client cookies, malformed responses, request timeout, abort, and late callbacks. |
| Authenticator lifecycle | Enrollment could overwrite pending state, retries were unbounded, and the upstream finalizer did not enforce its remaining-attempt counter. Enrollment now reserves an account before changing Steam, preserves recovery data on failure, and caps login/finalization attempts. A confirmed finalization marker allows local persistence to resume without another remote finalization. | `steam-2fa/src/enrollment.js`, `src/cli.js`, scripts and store; pending reservation, server-time/code payload, confirmation budget, abort handles, local save failure, and recovery tests. |
| Configuration and deployment | CI skipped the native SQLite build and did not run tests. Private temporary/backup files needed broader ignores. The service used host-specific paths without a private umask. CI installs the full lockfile and runs offline tests on Node 22/24; pinned Actions have read-only permissions. The example service uses a dedicated user, private state directory, bounded shutdown, and a read-only source tree. | `package*.json`, `.github/workflows/check.yml`, `.gitignore`, `scripts/check.js`, `deploy/systemd/r4r-bot.service`; native SQLite, cookie compatibility, network guard, syntax and unit verification. |

## Validation

Installation and advisory lookups use the package registry. Test processes preload a guard that rejects HTTP, HTTPS, HTTP/2, sockets, TLS, UDP, DNS, and fetch, including in Node subprocesses; all Steam/rep4rep interactions are mocks. Temporary SQLite databases use the real native binding.

| Check | Result |
| --- | --- |
| `npm ci` | Pass; 200 packages installed with lifecycle scripts enabled and the native SQLite binding available. |
| `npm ls --all` | Pass; no missing or invalid dependencies. |
| `npm run check` and `npm run check:2fa` | Pass; all 34 JavaScript source, example, helper, and test files pass syntax validation. |
| `npm test` | Pass; 132 offline tests, zero failures, cancellations, or skips. |
| Node.js 22.23.3 and 24.21.0 | Full offline suite and syntax checks pass on both CI-supported release lines. The environment's Node.js 24.19.0 also passes. |
| `npm --prefix steam-2fa run check` / `npm --prefix steam-2fa test` | Pass; 32 module tests. |
| `npm audit` | Completed, exit 1: eight affected packages (six high, two moderate), detailed below. |
| `git diff --check` and private-path ignore checks | Pass; protected paths include JSON temporary files, locks, backup/session files, and SQLite sidecars. |
| `systemd-analyze verify` (systemd 257) | Pass on copies with the environment's actual Node executable. The exact template cannot resolve `/usr/bin/node` on this host; the owner must adapt that path. No unit was installed or started. |

The execution sandbox initially restricted Node child-process pipes/IPC, so file-level test summaries were insufficient evidence. Final tests ran with the executor permission that permits those subprocesses; the offline preloader remained active and all individual assertions were reported. This environment workaround does not change test commands or permit test connections to Steam.

## Dependencies that remain

The original dependency graph reported nine affected packages: six high and three moderate. Updating `request`'s `tough-cookie` to `4.1.4` removes its prototype-pollution advisory; synchronous cookie operations and independent SteamCommunity sessions have regression coverage. Unused direct `colors`, `moment`, and `steamid` dependencies were removed. Existing patched `request` form-data and qs overrides remain. `steam-session` is an explicit dependency of the new login adapter.

The final graph still reports **eight affected packages, six high and two moderate**, representing these five distinct advisories:

| Package | Severity | Advisory and compatibility limit |
| --- | --- | --- |
| `nth-check` | High | [GHSA-rp65-9cf3-cjxr](https://github.com/advisories/GHSA-rp65-9cf3-cjxr). Old css-select expects a callable export; patched nth-check uses a different export shape. |
| `lodash.pick` | High | [GHSA-p6mc-m468-83gw](https://github.com/advisories/GHSA-p6mc-m468-83gw). No patched compatible version is available. |
| `image-size` | High | [GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr). The patched major exports a different API from the callable function SteamCommunity expects. |
| `request` | Moderate | [GHSA-p8p7-x288-28g6](https://github.com/advisories/GHSA-p8p7-x288-28g6). The deprecated HTTP library has no safe patch in this dependency chain. |
| `uuid` | Moderate | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq). The compatible transitive version has no patch; a major replacement requires upstream work. |

`cheerio`, `css-select`, and `steamcommunity` are also counted as affected through those dependencies. This is not a clean security audit. The bot does not expose an HTTP server or use image-upload helpers, and the comment adapter avoids the vulnerable HTML parsing path; that reduces reachable surfaces but does not remove the dependency findings. Replace or update the upstream stack in a separately tested change. No `npm audit fix --force` was run. CI records the remaining audit findings as an advisory step rather than presenting them as a pass.

## Secrets, provenance, and limits

The full available original history was inspected: 27 commits and 49 unique blobs, with no binary blobs or committed private runtime files. Pattern searches covered credential literals, private keys, provider tokens, JWTs, credential-bearing URLs, cookies, and authenticator files. Sixteen empty or clearly illustrative literals were classified as placeholders; no actual secret was confirmed. The current code was reviewed separately, and test credentials are synthetic. Pattern scanning cannot prove that no unrecognized secret has ever existed; ignored files, inaccessible refs, remote logs, and production state were outside scope. No history was rewritten. If exposure is discovered later, follow the rotation procedure in [SECURITY.md](../steam-2fa/SECURITY.md); deleting a commit does not revoke credentials.

`NOTICE.md`, the 2FA MIT license, and authorship metadata remain intact. Historical upstream metadata declared ISC, while a separate grant/license file for the inherited old bot was not established. The existing root `UNLICENSED` declaration is retained; this audit does not decide or expand rights over inherited code. The owner should resolve that uncertainty with upstream before redistribution.

Offline tests do not establish whether Steam currently accepts every real login challenge, mobile endpoint, or account state. The rep4rep API's real response contract must also be checked: profile/task IDs, string SteamID64 values, and a positive `success` or nonempty `info` acknowledgement are expected. A provider response that fails validation leaves task state for review rather than guessing success.

New `last_comment` values use UTC; existing SQLite `localtime` values retain their local-time interpretation for compatibility. Confirm the historical server timezone before moving an existing database to a host with another timezone. Invalid or future timestamps remain in cooldown until reviewed. SQLite process locks assume a local database and one host/PID namespace; a reused live PID can conservatively block a recovered lock. Do not share the database over a network filesystem.

Private JSON writer locks intentionally require manual recovery after a crash in their short write section. With every bot/enrollment process stopped, inspect the lock owner and remove only the stale `steam-2fa.json.lock`, `relogin-attempts.json.lock`, or account `*.2fa-pending.json.operation-lock` after confirming no writer is alive. Preserve their data files. Do not routinely delete locks or reset retry timestamps.

## Owner verification before deployment

1. Read the installed service and timer. Compare its actual schedule with the unchanged repository timer (`hourly`, `Persistent=false`), and adapt user, executable, source path, state path, and time limits. Verify units locally before activating them. No units were installed or activated during this audit.
2. Stop the existing service and make a private backup of the closed database, sidecars, config, and authentication data. Confirm ownership, file mode `0600`, private directory mode `0700`, and a database directory that other users cannot write. Move state when adapting paths; do not start against an empty database by accident. Run `npm ci`, `npm run check`, `npm test`, and review `npm audit`.
3. Exercise menu add, refresh, removal by ID, and navigation; verify hidden password/code input, email/mobile Guard, CAPTCHA where Steam offers it, EOF, SIGINT, and SIGTERM. Existing IDs and cooldowns must survive refresh. Removal of an account intentionally removes its completed task history and cooldown; it is not a recovery procedure for uncertain tasks.
4. Verify two distinct accounts with different SteamIDs. Expire one saved session, check automatic re-login and the six-hour cooldown, and confirm there is no cookie or author crossover. Check Family View, account restrictions, and system clock synchronization separately.
5. In an owner-authorized, controlled pass, verify actual rep4rep registration, task payloads, comment success, and completion acknowledgements. Confirm the 15-second spacing, daily cooldown, normal process exit, and next timer run. Repeated completed task identities must not generate another comment.
6. Test interruption during a comment and during its API acknowledgement. With the bot stopped, inspect only journal metadata (`account_id`, `task_id`, `comment_id`, `rep_id`, `state`, `created_at`). `posted` retries API completion; `completed` needs no action. For `posting`, compare the real Steam comment and task state before changing anything. If a post is confirmed, change that operation to `posted` and restore its known UTC cooldown in one transaction; if its absence is confirmed, remove only that intent. If the result cannot be established, leave it blocked. Keep the private backup and avoid blanket journal deletion.
7. Exercise enrollment/finalization only with Steam recovery options available. A `requesting` reservation means the remote result is unknown; inspect Steam before removing it. A saved `finalized` marker resumes local persistence without contacting Steam. Confirm that failed storage retains pending recovery data, and check that no token, cookie, password, shared secret, activation code, or TOTP reaches logs.

Merge and deployment remain separate owner decisions. The pull request is not merged, and production verification is deliberately left to the owner.
