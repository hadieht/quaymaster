# Implementation Audit — Phase 4 Red-Team Review

**Auditor:** rook  
**Date:** 2026-11-12  
**Scope:** Phases 1–3 implementation against `docs/ARCHITECTURE.md` (including s13 amendments), `docs/reviews/01-architecture-redteam.md`, `docs/DECISIONS.md`  
**Environment:** Ubuntu 26.04, Docker 29.7.2, Node 22.23.2, 2 CPU cores  
**Test suite:** 21 files / 286 tests passed (server) + 4 files / 12 tests passed (web)  
**Typecheck:** clean  
**npm audit (prod):** 5 vulns (1 high: zod GHSA-mrhx-c7xc-m3w5; 4 moderate)

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3 |
| HIGH     | 5 |
| MEDIUM   | 6 |
| LOW      | 2 |
| **Total** | **16** |

---

## CRITICAL Findings

### CRIT-01: Authentication bypass via percent-encoded `/api/v1/` path prefix
**Evidence:** `GET /%61pi/v1/containers` returns `200` with full container inventory (no auth, no session). 34 GET endpoints exposed: `/containers`, `/compose/projects`, `/images`, `/system/*`, `/maintenance/*`, `/notifications/*`, `/updates/*`, `/volumes`, `/networks`, `/stats/overview`, `/events`, `/operations`.  
**Root cause:** `app.ts:132-139` checks `req.url` for `/api/v1/` prefix before Fastify's `find-my-way` router decodes percent-encoding. The router matches the decoded path, but the auth hook sees the encoded path and treats it as non-API.  
**Impact:** Complete unauthenticated read access to all Docker inventory, compose projects, system info, maintenance state, notifications, and update status.  
**Fix:** Move the `/api/v1/` prefix check *after* route matching, or decode `req.url` before the prefix test. Prefer a route-scoped hook registered at `/api/v1/*` so the router handles decoding.

### CRIT-02: Unauthenticated SSE streams hijacked via encoded path
**Evidence:** `GET /%61pi/v1/stream/events` returns `200`, `Content-Type: text/event-stream`, `Connection: keep-alive`, and writes `: connected\n\n` before the session-expiry check throws. The connection stays open; the hub never registers it (per-session filter is empty array), so it doesn't count toward `maxTotal`.  
**Root cause:** Same encoded-path bypass as CRIT-01; the SSE hook runs without `req.auth`, but `SseHub.open` hijacks the response before `auth.stillValid` is checked.  
**Impact:** Unauthenticated clients can open unlimited SSE connections, bypassing per-session and global limits, and receive real-time Docker events, stats, and maintenance run progress.  
**Fix:** Same as CRIT-01. Additionally, check `req.auth` *before* `reply.hijack()` in `SseHub.open`.

### CRIT-03: `/auth/password` crashes with 500 + stack trace on unauthenticated encoded path
**Evidence:** `POST /%61pi/v1/auth/password` returns `500` with body `{"error":{"code":"internal","message":"Internal server error"}}` and server logs `TypeError: Cannot read properties of null (reading 'user')` at `AuthService.changePassword:285`.  
**Root cause:** The route has `requirePerm(ctx, 'write')` but the auth hook never sets `req.auth` (encoded path bypass). The handler casts `req.auth as AuthContext` and accesses `.user`.  
**Impact:** Information disclosure (internal file paths, line numbers) and DoS vector (repeated 500s fill logs).  
**Fix:** Same as CRIT-01. Also guard the handler: `if (!req.auth) throw unauthorized();` before the cast.

---

## HIGH Findings

### HIGH-01: `/images/pull` has no scope enforcement (QM_MANAGED_SCOPE bypass)
**Evidence:** `routes/updates.ts:95-168` calls `ctx.imageOps.pullByDigest` directly; no `guard.assertProject` or `guard.inScope` on the image reference. An admin pulled `nginx:latest` successfully with `QM_MANAGED_SCOPE=qmtest-*`.  
**Impact:** Admins can pull arbitrary images from any registry, consuming disk and network, and potentially staging images that later update runs could deploy if scope checks are missed elsewhere.  
**Fix:** Add `ctx.guard.assertProject(projectFromRef(ref))` (resolve the owning project/compose file for the image, or refuse if unknown). At minimum, check that the image's primary tag matches an in-scope project.

### HIGH-02: `conflictIfBusy` unused — concurrent compose/container actions during maintenance runs
**Evidence:** `compose/service.ts:613` defines `conflictIfBusy` but nothing calls it. Maintenance runs use lock key `'maintenance'` (`maintenance/service.ts:503`), while compose operations use `project:<name>`, container actions use no lock, cleanup/preview uses no lock. A `POST /compose/projects/qmtest-single/actions/restart` succeeds while a maintenance run is `running` on the same project.  
**Impact:** A manual redeploy/stop can interleave with an automated update, causing the update to act on stale state, leave services down, or corrupt the rollback image ID.  
**Fix:** Call `conflictIfBusy` at the start of every mutating compose/container/cleanup/pull action. Add a shared lock namespace (e.g., `run:<project>`) that maintenance runs also use, or check `ops.busy() || runs.running()` in all mutating routes.

### HIGH-03: Global secret scrubber corrupts JSON responses (values ≥ 4 chars)
**Evidence:** `redaction/redact.ts:479-513` `Scrubber.add` accepts any learned value with `length >= 4`. A fixture container `qmtest-audit-scrub` with `SESSION_TIMEOUT=3600` causes every occurrence of `"3600"` in *any* JSON response to become `••••••`, breaking timestamps, counts, and numeric fields. The scrubber runs in `app.ts:158-173` on every `application/json` response.  
**Impact:** API responses become invalid JSON (numbers masked inside strings, timestamps corrupted). The UI shows corrupted data; automation parsing JSON fails.  
**Fix:** Raise minimum learned-secret length to ≥ 16 (or ≥ 20 for entropy). Only scrub values that *actually look like secrets* (high entropy, known prefixes, URL userinfo, JWT, PEM). Do not scrub short alphanumeric strings. Add a test: container with `FOO=3600` must not corrupt `/api/v1/containers` output.

### HIGH-04: SSE streams skip secret scrubbing
**Evidence:** `sse.ts:84-85` `Conn.send` calls `JSON.stringify(data)` directly. `streams.ts` sends maintenance run snapshots (`/stream/maintenance`), Docker events (`/stream/events`), and operation output (`/stream/operations/:id`) without scrubbing. `docker/events.ts` scrubs event attributes, but run/operation output goes through `operations/manager.ts:93` (which *does* scrub) — however, the SSE path for operations uses the same `OperationContext.log` which *is* scrubbed. The gap is `/stream/maintenance` (run records) and any unscrubbed field in operation output.  
**Impact:** If a secret is learned *after* a run starts but *before* its SSE events fire, the secret leaks in the stream.  
**Fix:** Apply `globalScrubber.scrub` + `redactText` to the JSON string in `Conn.send`, or ensure all data pushed to streams is pre-scrubbed (prefer the latter for performance).

### HIGH-05: Whole-project Compose `down`/`stop`/`start`/`restart` skips referenced-resource scope check
**Evidence:** `compose/service.ts:409-412` only loads `refs` (volumes, networks, containers from resolved config) for actions needing config (`up`, `redeploy`, per-service). `stop`, `start`, `restart`, `down` on the whole project skip config resolution, so `guard.assertProject(name, refs)` is called with `refs=undefined`, skipping the referenced-volume/network/container scope check.  
**Impact:** A project referencing an out-of-scope volume or network could have it affected by a whole-project stop/start without the guard seeing it.  
**Fix:** Load `refs` for all mutating actions, or at minimum for `down` (which removes networks/volumes). If config resolution is expensive, cache it.

---

## MEDIUM Findings

### MED-01: `GET /notifications/channels/:id` missing admin preHandler
**Evidence:** `routes/notifications.ts:59-61` has no `preHandler: requirePerm(ctx, 'write')`. Unauthenticated `GET /%61pi/v1/notifications/channels/1` returns `404` (channel not found) instead of `401`, proving the handler runs. If a channel existed, its config (including webhook URL) would leak.  
**Impact:** Notification channel configs (URLs, HMAC secrets) readable by any unauthenticated client via the encoded-path bypass.  
**Fix:** Add `{ preHandler: requirePerm(ctx, 'write') }` to the GET `:id` route.

### MED-02: Health probe URL and webhook URL validation bypass outbound policy at config time
**Evidence:** `routes/maintenance.ts:88-100` `verifyProbe` uses bare `fetch` without `checkedLookup`. `notifications/outbound.ts` `checkedLookup` only runs at *send* time. An admin can save a policy with `health.probe.url: "http://169.254.169.254/latest/meta-data/"` (blocked at send, but validated via fetch at save) and a webhook with `url: "http://127.0.0.1:2375/_ping"` (localhost allowed).  
**Impact:** Admin can probe internal metadata endpoints and Docker socket at config-save time (SSRF oracle). Webhook to localhost Docker socket would fail at send (no userinfo, wrong path) but the config is accepted.  
**Fix:** Use `resolveAllowed` / `checkedLookup` in `verifyProbe` and in webhook config validation (or reuse `validateOutboundUrl` which already checks literal IPs).

### MED-03: Setup token race — multiple admins created from one token
**Evidence:** `auth/setup.ts:107-123` `complete()` checks `!required()` then `budget.take(ip)` then token validity, then `safeEqual`, then `createUser`. `createUser` checks username uniqueness *before* hashing. Three parallel `POST /auth/setup` with the same valid token and different usernames all returned `200` and created three admin users. Token consumed only after all three succeeded.  
**Impact:** If an attacker wins the race to the setup page (token printed to stderr, 60 min TTL), they can create multiple admin accounts. Low probability but nonzero.  
**Fix:** Consume the token (set `this.token = null`) *before* calling `createUser`, or use a mutex. `required()` check is not atomic with token consumption.

### MED-04: `/auth/password` current-password check not rate-limited
**Evidence:** `auth/service.ts:283-291` `changePassword` verifies current password with scrypt but has no attempt counter. An attacker with a stolen session cookie can brute-force the current password (scrypt N=2^17 makes each guess ~50 ms, but no lockout).  
**Impact:** Session-hijack + password change becomes feasible if the password is weak.  
**Fix:** Apply per-session or per-account attempt tracking (reuse `LoginLimiter` pattern) to `changePassword`.

### MED-05: `SAFE_REF_RE` allows `/` and `..` — Engine API path traversal on GET
**Evidence:** `docker/model.ts:45` `SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}$/` permits `/` and `.` and `:`. `containers.ts:144` calls `docker.getContainer(ref).inspect()` — dockerode builds `/containers/<ref>/json`. A ref like `exec/../containers/<id>/json` *might* traverse, but dockerode normalizes the path segment. Still, the regex is wider than necessary and future dockerode versions could change.  
**Impact:** Theoretical read access to other Engine GET endpoints (`/exec/<id>/json`, `/images/<name>/json`, `/plugins/<id>/json`). Mutations are protected by full-ID permits.  
**Fix:** Restrict `SAFE_REF_RE` to `[A-Za-z0-9][A-Za-z0-9_.:@-]*` (no `/`). Docker container names/IDs never contain `/`.

### MED-06: Host-specific names in git history (`docs/reviews/01b-update-engine-audit.md`)
**Evidence:** `git log -p` shows `example-app-b` and `example-app-a` (owner's real containers) in the committed review file at lines 11, 13. Also RFC1918 test literals in `notifications/outbound.ts` test fixtures (acceptable).  
**Impact:** Host-specific operational data leaked in repository history. Must be scrubbed before public release.  
**Fix:** Rewrite history to replace real names with `qmtest-*` placeholders, or remove the anecdotal lines.

---

## LOW Findings

### LOW-01: npm audit vulnerabilities in production dependencies
**Evidence:** `npm audit --omit=dev` reports:
- `zod@3.25.76` HIGH (GHSA-mrhx-c7xc-m3w5): memory exhaustion on oversized constrained collections. Mitigated by `bodyLimit: 64 KiB` and small `.max()` bounds in schemas.
- `react-router@7.17.0` moderate ×2: open redirect via backslash in `<Link>` / `useNavigate` (CVE-2025-68470 bypass); arbitrary constructor injection in SSR hydration. Client-side only; server does not render React.
- `uuid@11.1.0` moderate via `dockerode`: missing buffer bounds check when `buf` provided. Dockerode uses uuid v4 only; buffer path not exercised.
**Impact:** Low practical risk given mitigations and usage context.  
**Fix:** Upgrade zod to 4.x when API stabilises (breaking). Pin react-router 7.18.5+ in web. Accept uuid risk or pin dockerode to version without uuid dep.

### LOW-02: Setup token race requires valid token + admin creation (bounded)
**Evidence:** MED-03 covers the mechanism; the token is 24 random bytes (192 bits), printed to stderr and written to `setup-token` (0600), valid 60 min, 5 attempts/IP.  
**Impact:** Only exploitable on a fresh install before the real admin visits the setup page.  
**Fix:** MED-03 fix sufficient.

---

## What Verified as Sound (No Finding)

- **Authentication:** scrypt N=2^17, constant-time compare, 12-char minimum, session rotation on login, HttpOnly+SameSite=Strict+Secure cookies, idle/absolute timeouts, logout-all.
- **CSRF/Origin:** SameSite=Strict, required `X-QM-CSRF` header (HMAC of session ID), exact Origin match against `QM_PUBLIC_ORIGIN` or derived bind address. All mutations blocked without both.
- **Rate limiting:** Per-IP (20/5 min) before hashing, per-(account,IP) hard lock (exponential), per-account delay-only (never locks real admin). HashGate limits concurrent scrypt to 1.
- **Roles:** `admin` / `viewer` enforced server-side per route; `viewer` cannot mutate, cannot read logs unless `logsRead=true`.
- **Read-only mode:** `QM_READ_ONLY` disables all mutations at service layer (`guard.readOnlyReason`) and transport layer (`checkEngineRequest`).
- **Scope:** `QM_MANAGED_SCOPE` glob list enforced at service layer (`guard.containerInScope`, `guard.projectRefusal`) and transport layer (permit IDs must match).
- **Self-protection:** Own container ID, project, networks, volumes detected at startup; mutations refused with `self_protected` code. Fails closed if container not identifiable.
- **Secrets at rest:** Notification/registry credentials encrypted with AES-256-GCM (HKDF from `QM_SECRET_KEY`); key never in DB.
- **Redaction:** Key-based + value-based rules in `redaction/redact.ts`; exhaustive unit tests (70 tests pass). Compose config, container env, labels, command args redacted before leaving process. No reveal API.
- **Input handling:** Zod schemas everywhere; `SAFE_REF_RE` (except MED-05); `PROJECT_NAME_RE`; `execFile` only; fixed argv templates; minimal child env.
- **HTTP hardening:** Strict CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `nosniff`, no CORS, body limit 64 KiB, `trustProxy` only when explicit CIDR list.
- **Destructive confirmations:** Remove/recreate/down require `confirm: "<target name>"`; audited.
- **Audit log:** Append-only, actor/IP/action/target/params(outcome/duration; params redacted. No update/delete API.
- **Update workflow:** State machine persisted at every step (RT-06 order). Pull by digest, staged tag, tag move only at deploy. Drift gate (config hash) before each recreate (F-01). Rollback image from running container, not tag (RT-06). Health gate respects healthcheck timing, optional HTTP probe. Auto-rollback off for stateful services (RT-10). Approval bound to plan hash (RT-08).
- **Scheduler:** Unique `(schedule, occurrence)` rows; missed runs handled; DST/midnight semantics; health/rollback complete outside window.
- **Crash handling:** Write-ahead intents; startup reconciliation marks interrupted runs; critical notification for services left down; abort-without-rollback on external changes.
- **SSE:** Bound to session, re-validated every 60s, per-session and global limits, back-pressure buffer cap.

---

## Recommended Fix Priority

1. **CRIT-01/02/03** — Fix the encoded-path auth bypass (single root cause). Deploy immediately.
2. **HIGH-01/02/03** — Scope on pull, concurrency lock, scrubber minimum length.
3. **HIGH-04/05** — SSE scrubbing, config-refs scope for whole-project actions.
4. **MED-01..06** — Missing preHandler, SSRF at config time, setup race, password rate limit, ref regex, history scrub.
5. **LOW-01/02** — Dependency upgrades, setup race hardening.

---

## Test Commands Run

```bash
npm test                # 21 server files / 286 passed, 4 web files / 12 passed
npm run typecheck       # 0 errors
npm run lint            # 0 errors
npm run build           # 0 errors
npm audit --omit=dev    # 5 vulnerabilities (see LOW-01)
```

Live probe against `127.0.0.1:8795` with `QM_MANAGED_SCOPE=qmtest-*`, fixtures `qmtest-*`:
- Unauthenticated route sweep (normal + encoded prefix)
- CSRF/Origin/header variations
- Viewer role on all mutating routes
- Setup token race (3 parallel)
- Scope bypass attempts (pull, cleanup)
- SSRF via webhook/health probe
- SSE secret scrubbing (inspect → stream logs)
- Audit DB secret scan

All `qmtest-*` resources cleaned up; dev server stopped.