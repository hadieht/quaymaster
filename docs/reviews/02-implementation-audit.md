# Implementation audit (02): security and update safety

**Auditor:** rook (red team) · **Date:** 2026-11-12 · **Code audited:** `main` at 4e2fa8d (Phases 1–3)
**Measured against:** `docs/ARCHITECTURE.md` (incl. s13 binding amendments), `docs/reviews/01-architecture-redteam.md`,
`docs/reviews/01b-update-engine-audit.md`, `docs/DECISIONS.md`.

> **Revision note.** The first version of this file (commit 120e713, attempt 1) contained findings that had not
> been verified live. Some of them did not reproduce: SSE unscrubbed, notification-channel secret leak, and a stack
> trace in the 500 response. It also missed the most severe issue (C-02). This version replaces it. Every finding
> below was reproduced against a running instance, unless it is explicitly marked *code-read*.

## Method

- Gates: `npm test` → server 21 files / 286 passed, web 4 files / 12 passed, 0 failed. `npm run typecheck` → exit 0.
  `npm audit --omit=dev` → 5 vulnerabilities (1 high, 4 moderate).
- Live instance: `node server/dist/index.js` with `QM_HOST=127.0.0.1`, `QM_PORT=8795`, `QM_MANAGED_SCOPE=qmtest-*`, a throwaway
  `QM_DATA_DIR` and `QM_STACK_PATHS=test-fixtures/stacks`. A second instance (port 8796, no admin) was used for the setup race.
- Fixtures: `up.sh all`, `upd-up.sh` (fixture registry 127.0.0.1:5055), `publish.sh app 2 unhealthy`, and planted containers
  `qmtest-audit-scrub` and `qmtest-audit-echo` (fake secrets `fx-audit-plant-zz9` and `fx-cold-plant-q7`, all labelled
  `quaymaster.test=true`).
- Routes: 91 routes enumerated from `server/src/routes/*.ts`. Each was swept unauthenticated with 8 prefix spellings.
- All probes used Python `http.client` scripts (kept locally, not committed). Every fixture was removed afterwards: 0 `qmtest`
  containers and 0 listeners on 8790-8799 at the end.

## Summary

| Severity | Count |
| -------- | ----- |
| CRITICAL | 2     |
| HIGH     | 4     |
| MEDIUM   | 6     |
| LOW      | 6     |

---

## CRITICAL

### C-01: Authentication bypass through a percent-encoded API prefix

**Evidence.** `app.ts:132-139` decides whether a request is an API request from the raw, still-encoded `req.url`
(`url.startsWith('/api/v1/')`). The router (find-my-way) decodes the path before matching, so `/%61pi/v1/...` and
`/api/v%31/...` reach the API handlers with `req.auth = null`. The CSRF/Origin check does not run either.

```
GET /api/v1/containers        -> 401
GET /%61pi/v1/containers      -> 200 application/json, 25 088 bytes (full inventory)
GET /api/v%31/containers      -> 200
```

The unauthenticated sweep returned 200 JSON on every GET route that has no `preHandler`:

- `/containers` and `/containers/:ref`, plus `stats` and `stats/history`
- `/compose/projects` and `/:name`, `/config`, `/graph`, `/validate`
- `/images`, `/images/staged`, `/volumes`, `/networks`, `/events`, `/operations` and `/:id`
- `/system/*`, `/stats/overview`, `/updates`, `/updates/quarantine`
- `/maintenance/policies` and `/effective`, `/windows`, `/schedules`, `/runs` and `/:id`
- `/notifications/channels` and `/:id`, `/notifications/deliveries`, `/monitors/settings`, `/auth/sessions`

Routes with `requirePerm` stay closed (401): `/audit`, `/users`, `/registries/credentials`, logs, and every mutation.

**Side effects of the same root cause:**

- `GET /%61pi/v1/stream/events` and `/stream/maintenance` return 200 `text/event-stream` and write `: connected`. Then
  `SseHub.open` throws `TypeError: Cannot read properties of null (reading 'session')`. The hijacked socket stays open and
  the hub does not count it against `QM_SSE_MAX_TOTAL`: an unauthenticated connection-exhaustion vector. No events were
  delivered.
- `POST /%61pi/v1/auth/password {"current":..,"next":..}` returns 500 (`TypeError ... reading 'user'` at
  `AuthService.changePassword`). The handler casts `req.auth` without a null check. The response body is generic.

**Impact.** Anyone who can reach the port can read, without credentials:

- the complete Docker and Compose inventory and the redacted Compose configs
- maintenance schedules and windows, which tell an attacker when updates run (see C-02)
- run history, including recovery guidance with host paths
- system information

**Fix.**

1. Base `isApi` on the decoded, routed path (`req.routeOptions.url` / `req.routerPath`). Better, register the auth
   hook inside the `/api/v1` plugin scope, so it runs for every route that plugin owns, however the URL was spelled.
2. Fail closed: make `requirePerm('read')` (or an equivalent default) a preHandler on every API route, so a hook
   mistake cannot open a route again.
3. Guard `SseHub.open` and `changePassword` against a null `req.auth`.

Add a regression test that sweeps every registered route with the encoded spellings.

### C-02: One unauthenticated GET crashes the Quaymaster process (Engine path traversal → uncaught exception)

**Evidence.** `SAFE_REF_RE` (`docker/model.ts:45`) allows `/` and `.`, and `ContainerService.detail` passes the raw ref to
`docker.getContainer(ref).inspect()` (`docker/containers.ts:144`). This applies to images, volumes, networks, logs and
stats too. With `x/../../version`, docker-modem requests `/containers/x/../../version/json`. The Engine answers with a
path-cleaning redirect, and docker-modem's redirect handler throws `TypeError: Invalid URL` (`input:
'http:/v1.55/version/json'`) outside any promise chain. **Node exits.**

```
GET /api/v1/containers/qmtest-single-solo-1%2F..%2F..%2Fversion   -> connection reset; process exited
GET /%61pi/v1/containers/x%2F..%2F..%2Fversion                     -> same, WITHOUT any credentials (C-01)
```

The crash reproduced on `/containers/:ref`, `/containers/:ref/stats`, `/containers/:ref/logs`, `/images/:ref`,
`/volumes/:name` and `/networks/:ref`. The server log ends with `code: 'ERR_INVALID_URL'` and `Node.js v22.23.2`.

**Update-safety consequence (demonstrated).**

1. A manual update of `qmtest-upd/app` to an unhealthy v2 was started with `autoRollback: true`.
2. Six seconds in, one unauthenticated crash request was sent. Quaymaster died during the health gate.
3. Thirty seconds later the app was still `running unhealthy v2`, with no rollback.
4. After a restart, reconciliation marked the run `interrupted`, `leftDown: false`, and sent only a *warning* (see H-04).

The schedules are readable unauthenticated (C-01). An attacker can therefore time this request to land inside every
update window and defeat auto-rollback whenever they want. With a restart policy the process comes back, but each
restart also resets the in-memory login limiter (`auth/limiter.ts`). Repeating the crash therefore also removes the
brute-force protection.

**Fix.**

1. Restrict refs to `^[A-Za-z0-9][A-Za-z0-9_.-]*$` for containers, volumes and networks (Docker names never contain `/`).
2. For images, parse with `parseImageRef` and reject any path segment that is `.` or `..`, or resolve the image to its
   ID first.
3. Add `process.on('uncaughtException')` logging and a fatal-exit policy that first marks the active run.
4. Long term, call the Engine through an HTTP client that does not follow redirects.

Add a regression test that requests `x%2F..%2F..%2Fversion` on each `:ref` route.

---

## HIGH

### H-01: The global known-value scrubber blanks unrelated data, and any container can trigger it

**Evidence.** `Scrubber.add` (`redaction/redact.ts:484-493`) learns every value of a secret-named env/label with length ≥ 4,
and `app.ts:158-173` replaces that literal in **every** JSON response. A single container with
`APP_PIN_SECRET=2026` and `AUDIT_PASSWORD=alpine` caused:

- `"createdAt":"••••••-11-12T01:…"` in containers, images, events, runs, operations, updates and system/df: every ISO
  timestamp of the year (70 masks in `/containers`, 152 in `/events`)
- `"image":"••••••:latest"` for every alpine-based container and Compose service
- a masked word inside Compose operation output

The JSON stayed syntactically valid, but the data was corrupted for all users.

**Impact.** An image's `ENV` counts as container env, so any image author or any user who can start a container on the
host can blind the dashboard. For example, `X_TOKEN=unhealthy` or `X_PASSWORD=running` masks health and state words
everywhere. The UI then cannot show `unhealthy`, `failed` or `rolled_back`. That is an integrity failure of the
monitoring product, and the attacker needs no Quaymaster access.

**Fix.**

- Scrub only inside container-derived free-text fields (logs, command strings, operation output), not across the
  whole response.
- Require a minimum length of about 8, plus an entropy check, for global learning.
- Never learn values that are dictionary words, numbers or dates.

Add a test: `FOO_SECRET=2026` must not change `/api/v1/events`.

### H-02: `QM_MANAGED_SCOPE` does not cover `POST /images/pull`, and a route calls the image layer directly

**Evidence.** `routes/updates.ts:95-168` calls `ctx.imageOps.pullByDigest` and `ctx.imageOps.tag` straight from the route.
No guard or scope check is made. This breaks the engineering rule "routes never call dockerode directly / every mutation
through the service layer". Proof on this host: attempt 1 of this audit ran with `QM_MANAGED_SCOPE=qmtest-*` and still
created the non-`qmtest` image `nginx:latest`, plus two `quaymaster-staged/*` tags, on the real daemon. Those are
listed under *Not cleaned up*.

**Impact.** The scope allow-list is the main safety control for any instance on a shared daemon (AGENTS.md rule 4).
Under it an admin can still pull anything, create new tags that later `docker compose up` runs by other tools pick up
silently, and fill the disk. Existing tags are not moved: verified, the local `latest` image ID did not change.

**Fix.** Move pull into a service. When a scope is set, refuse refs that are not used by an in-scope container or
project. Never add a missing tag for out-of-scope refs.

### H-03: Manual Compose and container actions run concurrently with a maintenance run on the same project

**Evidence (live).** During a running update of `qmtest-upd`:

```
POST /maintenance/runs                                  -> 409 "Another maintenance run is in progress"   (good)
POST /compose/projects/qmtest-upd/actions/restart       -> 202, operation succeeded while the run was in health gate
POST /containers/qmtest-upd-worker-1/actions/restart    -> 200 {"ok":true}
```

Maintenance runs lock `'maintenance'` (`maintenance/service.ts:503/539/575`), Compose operations lock `project:<name>`,
and container actions lock nothing. `ComposeService.conflictIfBusy` (`compose/service.ts:613`) exists but has no
caller. This run still rolled back correctly. Even so, a manual `restart`, `down` or `redeploy` that lands between the
executor's drift gate and its recreate gives the health gate a container the executor did not create. It can also
make a rollback recreate a project that the user just took down.

**Fix.**

- While a run is active, refuse mutating Compose and container actions on that run's project (409), unless the run
  has been explicitly aborted.
- Make maintenance runs also take `project:<name>`.
- Wire `conflictIfBusy` into the Compose actions, or delete it.

### H-04: After a crash mid-update, an unhealthy new version stays live with only a warning, and auto-rollback is not honoured

**Evidence.** See C-02. `MaintenanceService.recover` (`maintenance/service.ts:615-680`) treats a service as down only when
`State !== 'running'` (`:729`). The new container was `running` but Docker reported it `unhealthy` at reconciliation
time. Even so, the alert sent was a *warning*, "health was never confirmed", with `leftDown: false`, and the policy
had `autoRollback: true`.

The guidance text says "it is currently running on the new image" and gives a correct manual rollback command. It
does not say the service is unhealthy.

**Impact.** The spec's promise (s13 item 14: critical alert for a service left broken) is not kept for the most likely
crash outcome, a bad image during the health gate. The user is told less than Docker already knows.

**Fix.** At reconciliation, read the Docker health state. Treat `unhealthy`, or `starting` beyond the policy timeout, as
critical. Put the real health state in the guidance. Optionally offer a one-click "complete rollback" that uses the
recorded intent (`fromImage`). Never perform that rollback automatically after a restart without the user's decision.

---

## MEDIUM

### M-01: The setup token can be redeemed several times concurrently

**Evidence.** Four parallel `POST /auth/setup` with the same token on a fresh instance (port 8796) all returned 200. The
`users` table then held `race0`…`race3`, all `admin`. `auth/setup.ts` `complete()` checks `required()`, then the token,
then hashes with scrypt, and only after that creates the user and clears the token. The await on the hash is the race
window.

**Fix.** Claim the token synchronously, before any `await`: set `this.token = null`, and restore it if the request
fails. Alternatively, wrap the operation in a mutex together with a `users`-count check in the same DB transaction.

### M-02: Refused `startNow` runs leave an orphan run awaiting approval

**Evidence.** The second `POST /maintenance/runs {startNow:true}` during an active run returned 409. The `runs` table
nevertheless gained `e26d1bba… | update | awaiting_approval`, a full-project plan that the requester saw as refused.
An admin who approves it later runs a plan nobody asked to queue.

**Fix.** Check the run lock before persisting the run, or delete or expire the row when `startNow` fails.

### M-03: SSE hijack-before-auth leaks connections (part of C-01, listed separately because the fix is separate)

`SseHub.open` calls `reply.hijack()` and writes `: connected` before dereferencing `req.auth`. When it throws, the
socket stays open indefinitely; it was observed idle for more than 12 s with no close. **Fix:** validate the session
before hijacking, and `destroy()` the raw socket on any exception after hijacking.

### M-04: `/auth/password` current-password check has no attempt limit (*code-read*)

`AuthService.changePassword` verifies `current` with scrypt and has no limiter. Someone holding a stolen session
cookie can test passwords without a lockout, at about 0.6 s per guess. **Fix:** apply the per-account limiter.

### M-05: The login limiter is per-IP and in memory only

Verified: after 5 failures, the per-IP budget (20 per 5 minutes, which also counts successful logins) blocked the
correct password from the same IP with 429 for the rest of the window. Behind a reverse proxy without `QM_TRUST_PROXY`,
one attacker therefore locks out every user. A restart (see C-02) clears the limiter. **Fix:** persist limiter state in
SQLite. Document that `QM_TRUST_PROXY` is mandatory behind a proxy, and warn at startup when requests arrive from a
single proxy IP.

### M-06: Real host container names in committed history

`docs/reviews/01b-update-engine-audit.md` (commit 0eb7d34) and the first version of this file (120e713) name two of the
owner's real containers, and `git log -p` still shows them. The current text of 01b is now generic (this commit).
**Fix:** rewrite history before any publication, for example with `git filter-repo --replace-text`. No secrets, real
IPs, host paths or real tokens were found: only RFC1918/TEST-NET literals and fake `ghp_…`/`AKIA…` strings in unit tests.

---

## LOW

- **L-01 Dependencies.** `npm audit --omit=dev` reports 5 vulnerabilities:
  - zod 3.25.76, high (GHSA-mrhx-c7xc-m3w5). Mitigated by the 64 KiB body limit and `.max()` bounds.
  - react-router, 2 moderate. Client-side only.
  - uuid via dockerode, moderate. The buffer path is not used.

  Upgrade react-router. Track zod 4.
- **L-02 Health-probe URLs bypass the outbound policy.** `routes/maintenance.ts:88` (save-time verification) and
  `maintenance/executor.ts:1051` use bare `fetch`. A probe to `http://169.254.169.254/...` was actually attempted (it
  failed only because nothing listens there). The 400 message also exposes reachability and HTTP status: an admin-only
  SSRF oracle. Use `checkedLookup` and block link-local addresses.
- **L-03 Webhook hostnames are checked only at send time.** `http://169.254.169.254.nip.io/` was accepted at create time,
  while literal link-local, IPv4-mapped, decimal and `0.0.0.0`/`::` addresses are correctly rejected. Loopback
  (`http://localhost:2375/...`, `http://127.0.0.1:8795/`) is accepted by design. The channel test returns the remote HTTP
  status (`httpStatus: 401`), which is an oracle for admins. Resolve and check at save time too, and document the
  loopback decision.
- **L-04 The audit log over-redacts.** `approvedPlanHash` is stored as `••••••`, because `SECRET_KEY_RE` matches `hash` and
  `SAFE_KEY_RE` lists only `planhash`. This removes the approval-to-plan binding from the audit trail. Add
  `approvedplanhash`.
- **L-05 Viewers can read notification channel metadata and the full policies.** The secrets inside are masked,
  verified. Whether viewers should see channel names and URL hosts is a product decision; record it in DECISIONS.md.
- **L-06 Recovery guidance and the audit `argv` contain absolute host paths** (`--project-directory=/…/stacks/…`). With
  C-01 these are readable unauthenticated. After the C-01 fix this is acceptable for admins.

---

## Verified as sound (with evidence)

- **CSRF / Origin.** A mutation is refused with 403 when:
  - the `X-QM-CSRF` header is missing or wrong, or belongs to another session
  - Origin is missing, `http://evil.example`, or `null`
  - (login) Origin is missing

  A `text/plain` body is rejected with 400. The derived `localhost` origin is accepted.
- **Sessions.** The cookie is `HttpOnly; SameSite=Strict`. Login issues a new ID even when an attacker-chosen
  `qm_session` is sent (no fixation). After logout the old cookie gets 401.
- **Roles.** A viewer gets 403 on all 12 mutating routes tried and on logs, `/audit`, `/users` and
  `/registries/credentials`.
- **Identifier validation.** `-h`, `--help`, `..`, `%00`, `?all=1`, leading `..%2F`, `;id`, upper-case project names and
  300-400-character input are rejected (400 or 404). Out-of-scope or non-existent targets give 404, and no action was
  executed. Mutations resolve the target to the full ID (`r.id`) before the scope check and the Engine call
  (`containers.ts:179/214`).
- **Secret redaction.** The planted `fx-*` values were absent from:
  - all 19 GET endpoints swept and all operation outputs
  - SSE `events`, `logs` and `maintenance` during a Compose restart of `qmtest-secrets`
  - the server log, the SQLite DB and its WAL

  This held for a *cold* start too: the first request after boot was `logs` / `stream/logs` of a container echoing
  `$API_TOKEN`, and it returned `value=••••••`. Notification channel URLs and HMAC secrets are masked for admin, viewer
  and the C-01 path. (So attempt-1's "SSE unscrubbed" and "channel secret leak" findings are withdrawn.)
- **Webhook URL validation.** These are all rejected: literal link-local, IPv4-mapped (`::ffff:a9fe:a9fe`), decimal
  (`2852039166`), unspecified addresses, userinfo and `file:`.
- **Pull is non-disruptive.** A standalone pull of `127.0.0.1:5055/qmtest-app:latest` restarted no container (StartedAt
  unchanged for all 3) and did not move the local tag. The result was staged as `quaymaster-staged/…`.
- **Rollback.**
  - An unhealthy v2 was rolled back after the health gate (`rolled_back`, all 3 services healthy on v1, tag back on v1).
  - An external `docker stop` of the app mid-run was detected (exit 143) and rolled back.
- **Single run.** A second concurrent run gets 409.
- **Crash reconciliation.** The run was marked `interrupted`, with exact `docker tag` plus `compose up` recovery
  commands, and audited. Only the severity is wrong (H-04).
- **HTTP headers.** Strict CSP (`script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`), `X-Frame-Options:
  DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP, `Permissions-Policy`, and `Cache-Control: no-store` on
  the API.

## Not verified

- session idle/absolute expiry, because of time
- read-only mode on a live instance (code path only: `guard.readOnlyReason` is checked in the pull route and the
  services)
- self-protection, because no containerised instance was run
- cleanup with real removals, because the preview showed nothing removable
- scheduled (unattended) critical-target behaviour

## Not cleaned up (needs the owner)

Attempt 1 of this audit pulled these non-`qmtest` images. No container uses them. Under the safety rules I may not
remove them myself:

- `nginx:latest` (c05939e13a61)
- `quaymaster-staged/7e59ad64326b:165ddde8751e`
- `quaymaster-staged/0fb9fb8fe2d7:f59abe656b69`

Suggested command: `docker rmi nginx:latest quaymaster-staged/7e59ad64326b:165ddde8751e quaymaster-staged/0fb9fb8fe2d7:f59abe656b69`.

## Fix order

1. C-01 and C-02. Both are pre-auth, and C-02 also defeats rollback. Nothing should be deployed before these are fixed.
2. H-01 to H-04.
3. M-01 to M-06.
4. LOW.
