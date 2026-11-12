# Quaymaster — Architecture & Implementation Plan

Quaymaster is a self-hosted web application for monitoring, managing and safely
maintaining Docker hosts: containers, Compose projects, images, volumes,
networks, and scheduled updates with a controlled, auditable workflow.

Design priorities, in order: **safety → reliability → security → usability →
feature breadth**. When in doubt, do less and say so in the UI.

---

## 1. Constraints (from the target environment)

- Ubuntu Server, x86_64, small CPU budget (2 cores) → no heavy runtimes, no
  external database, no message broker.
- Docker Engine 29.x and Compose v2+ plugin (v5 on the reference host). The
  Engine API minimum version was raised in Docker 29, which broke older
  updaters; Quaymaster must negotiate the API version, never pin an old one.
- Existing Compose projects live in arbitrary host directories and were
  deployed by different tools (CLI, Dockge, Portainer). Some containers are
  standalone (`docker run`). Nothing may need to be re-created to be managed.
- Other management UIs may run on the same host. Quaymaster must tolerate
  state changing underneath it at any time.

## 2. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (Node.js 22 LTS) end to end | One toolchain, shared API types between server and UI |
| HTTP server | Fastify 5 | Small, fast, schema-first, good plugin model |
| Docker access | `dockerode` over the Unix socket | Typed Engine API, streams for logs/events/stats |
| Compose access | `docker compose` CLI via `execFile` (argument arrays, never a shell) | The CLI is the only complete, correct Compose implementation; re-implementing it would diverge |
| Storage | SQLite (`better-sqlite3`, WAL mode) + versioned SQL migrations | Zero-ops, single file, easy backup, plenty for one host |
| Scheduler | `croner` + DB-backed job state | Cron expressions with time zones; state survives restarts |
| Validation | `zod` on every request body, query and env var | Fail closed on malformed input |
| Logging | `pino` (JSON), with redaction paths | Structured app log, secrets never logged |
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS + TanStack Query + Recharts | Mature, fast to build a consistent UI, small static bundle |
| Live updates | Server-Sent Events (events, stats, run progress, log tail) | One-way streaming is all we need; simpler and proxy-friendlier than WebSockets |
| Packaging | Single container image (multi-stage build) serving API + static UI on one port; also runnable natively under systemd | One thing to deploy |
| Tests | Vitest (unit + integration), Playwright (UI smoke + screenshots) | |

Rejected: Go (not installed on the reference host; two languages), Python
(two languages), Postgres/Redis (operational weight), WebSocket terminal /
`exec` into containers (large attack surface — explicitly out of scope for v1).

## 3. Repository layout

```
quaymaster/
├── server/                 # Fastify backend
│   ├── src/
│   │   ├── config/         # env parsing (zod), paths, constants
│   │   ├── db/             # connection, migrations/*.sql, repositories
│   │   ├── auth/           # users, sessions, password hashing, CSRF, rate limit
│   │   ├── docker/         # dockerode client, containers, images, volumes, networks, events, stats
│   │   ├── compose/        # discovery, CLI runner, config parsing + redaction, dependency graph
│   │   ├── registry/       # remote digest lookup, update detection, cache
│   │   ├── maintenance/    # policies, windows, schedules, planner, executor, health, rollback
│   │   ├── notifications/  # channel interface + webhook, ntfy, discord, slack, smtp, gotify, telegram
│   │   ├── audit/          # append-only audit log
│   │   ├── monitor/        # background watchers (health, disk, resource thresholds)
│   │   ├── routes/         # REST + SSE routes, one file per area
│   │   └── app.ts, index.ts
│   └── test/               # unit/ and integration/ (integration uses fixtures only)
├── web/                    # React SPA
│   └── src/ (pages/, components/, api/, hooks/, lib/)
├── shared/                 # API types shared by server and web
├── test-fixtures/          # throwaway compose stacks + local registry for integration tests
├── deploy/                 # docker-compose.yml, systemd unit, reverse-proxy examples
├── docs/                   # architecture, security, operations, API, screenshots/
├── Dockerfile  .env.example  .gitignore  LICENSE  README.md  CONTRIBUTING.md  SECURITY.md  CHANGELOG.md
```

npm workspaces: `shared`, `server`, `web`.

## 4. Runtime architecture

```
Browser ──HTTPS (reverse proxy, recommended)──▶ Quaymaster (single process)
                                                 ├─ static SPA
                                                 ├─ REST /api/v1/*  + SSE /api/v1/stream/*
                                                 ├─ auth/session/CSRF middleware
                                                 ├─ services: docker · compose · registry · maintenance · notifications · audit
                                                 ├─ background: scheduler · event watcher · stats sampler · monitors
                                                 └─ SQLite (/data/quaymaster.db)
                                                        │
                                   /var/run/docker.sock ┘ (server-side only)
```

The browser never talks to Docker. Every Docker/Compose operation is a named,
validated server-side action. There is no generic "proxy to Engine API" route
and no route that accepts a command line.

### 4.1 Deployment modes

1. **Container (default).** Mounts `/var/run/docker.sock` and the data volume.
   For Compose *file-level* operations (config view, validation, redeploy,
   update) the Compose project directories must be mounted **at the same
   absolute path as on the host** (e.g. `/opt/stacks:/opt/stacks`), because
   Compose resolves relative bind mounts, `env_file` and build contexts
   relative to the project directory, and the Docker daemon interprets bind
   paths on the host. `QM_STACK_PATHS` lists these roots.
2. **Native (systemd).** Runs on the host as a dedicated service; sees all
   Compose files without extra mounts. Bind to `127.0.0.1` by default.

### 4.2 Compose project capability levels

Discovery is label-based (`com.docker.compose.project`, `.service`,
`.project.working_dir`, `.project.config_files`, `.depends_on`,
`.config-hash`) merged with `docker compose ls -a`. Each project gets a level:

| Level | Condition | Available |
|---|---|---|
| **full** | config files readable at their recorded host path | everything, incl. config view, validate, redeploy, update |
| **limited** | containers exist but files are not readable | status, logs, start/stop/restart of existing containers via Engine API; image pull; update *planning*. Redeploy/update are disabled with an explanation of which path to mount |
| **standalone** | container without Compose labels | status, logs, start/stop/restart; recreate/update via config-clone (see 7.5), clearly marked |

Quaymaster never writes to, moves or rewrites users' Compose files.

## 5. Security model

Docker socket access is root-equivalent on the host. Controls:

- **Authentication required for everything** except `/healthz` and the login /
  first-run endpoints. No anonymous mode.
- **First run:** no default password. The admin account is created either from
  `QM_ADMIN_USER` + `QM_ADMIN_PASSWORD_HASH`/`QM_ADMIN_PASSWORD_FILE`, or via a
  setup page protected by a one-time setup token printed to the server log
  (so a network attacker cannot win a race to claim a fresh install).
- **Passwords:** scrypt (Node built-in, N=2^17, r=8, p=1) with per-user salt;
  constant-time compare; minimum length 12.
- **Sessions:** random 256-bit ID, stored hashed (SHA-256) in SQLite, cookie
  `HttpOnly; SameSite=Strict; Secure` (Secure when behind HTTPS /
  `QM_COOKIE_SECURE=true`), idle and absolute timeouts, logout-all.
- **CSRF:** SameSite=Strict plus a required `X-QM-CSRF` header (double-submit
  token) and `Origin` check on all state-changing requests.
- **Brute force:** per-IP and per-account rate limiting with exponential lockout;
  failed logins audited.
- **Roles:** `admin` (everything) and `viewer` (read-only). Enforced server-side
  per route.
- **Read-only mode:** `QM_READ_ONLY=true` disables every mutating Docker
  action at the service layer (suitable for use behind a restrictive socket proxy).
- **Mutation scope:** optional `QM_MANAGED_SCOPE` allow-list (project / container
  name globs). Mutating actions against anything outside the scope are refused
  server-side. Empty = everything is manageable.
- **Self-protection:** Quaymaster detects its own container and refuses to
  stop, remove, recreate or auto-update it.
- **Secrets at rest:** notification credentials and registry credentials are
  encrypted with AES-256-GCM using a key derived (HKDF) from `QM_SECRET_KEY`.
  The key is supplied by env/file, never stored in the DB. Refuse to start with
  a missing or weak key.
- **Secret redaction:** Compose config, container env and labels are redacted
  server-side before leaving the process (see 6.3). Redacted values are never
  sent to the browser; there is no "reveal" API in v1.
- **Input handling:** zod schemas; resource identifiers validated against
  what Docker actually reports (no path or flag injection: identifiers starting
  with `-` rejected, `--` separator used, `execFile` only, fixed argv
  templates, minimal child environment).
- **HTTP hardening:** strict CSP (no inline script), `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `nosniff`, no CORS, body size limits,
  `trustProxy` only when configured.
- **Destructive actions** (remove, prune, recreate, down) require an explicit
  server-validated confirmation field naming the target, and are audited.
- **Audit log:** append-only table; actor, IP, action, target, parameters
  (redacted), outcome, duration. No update/delete API.
- **Not in v1 (deliberately):** container exec/terminal, file browser, editing
  Compose files, arbitrary hook commands, multi-host agents.

## 6. Monitoring & management

### 6.1 Data collection
- **Inventory:** on demand from the Engine API with a short (2–5 s) cache;
  invalidated by Docker events.
- **Events:** one long-lived `/events` stream; reconnect with backoff and
  `since`; persisted (bounded retention) and fanned out over SSE.
- **Stats:** one-shot stats for running containers on a fixed interval
  (default 10 s), bounded concurrency. In-memory ring buffer for live charts;
  1-minute roll-ups persisted for 24 h–7 d (configurable), pruned by a job.
  CPU %, memory (usage minus inactive file cache), network rx/tx, block I/O,
  plus writable-layer and volume sizes from `system df` (refreshed slowly —
  it is expensive).
- **Host:** CPU, memory, load, and disk usage of the Docker data root.
- **Logs:** tail N lines + follow over SSE, timestamps, stdout/stderr
  demultiplexed, size-capped.

### 6.2 Actions
Containers: start, stop, restart, kill, pause/unpause, remove (confirmation),
recreate. Compose (full level): up, stop, start, restart, down (confirmation,
never `-v`), pull, redeploy (`up -d`, optional `--force-recreate`), per-service
variants. Every action → audit entry + operation record with captured output.

### 6.3 Redaction rules
Applied to env vars, Compose `environment`, `secrets`, `configs` inline
content, labels and command arguments:
- Key matches (case-insensitive) `pass|pwd|secret|token|key|credential|auth|
  private|cert|dsn|connection|cookie|session|salt|signature|webhook` → value
  replaced by `••••••`.
- Value looks like a secret regardless of key (URL with userinfo, JWT,
  PEM block, long high-entropy string, known token prefixes) → redacted or, for
  URLs, only the userinfo part is masked.
- `QM_REDACT_ALL_ENV=true` masks every environment value.
- Redaction happens in one module with exhaustive unit tests.

## 7. Images, updates and maintenance

### 7.1 Update detection
For each image reference in use (and optionally all tagged local images):
compare the local `RepoDigests` entry with the registry's current manifest
digest for the same tag, obtained with a **HEAD** request against the registry
v2 API (token auth; anonymous for public images, daemon-independent
credentials stored encrypted for private ones). Fallback: Engine
`distribution inspect`. Results cached; checks are throttled, jittered and
back off on HTTP 429. States: `up_to_date`, `update_available`, `local_only`
(built locally / no registry), `pinned_digest`, `unknown` (with reason).
Digest comparison answers "has this tag moved?" — it does not suggest newer
version tags in v1 (documented limitation).

### 7.2 Pull ≠ deploy
Pulling only downloads. It never restarts, recreates or re-tags anything in
use. A pulled-but-not-deployed image shows as **"update staged"** on the
affected containers/services. Deploy is a separate, explicit action or
maintenance step.

### 7.3 Policies (per project / service / container; most specific wins)
- `update_mode`: `ignore` | `notify` (default) | `pull_only` | `auto`
- `critical`: bool — critical targets are **never** updated automatically,
  whatever the schedule says; they always need explicit per-run approval.
- `require_approval`: bool (default true)
- `health`: timeout, stabilisation period, optional HTTP probe (URL, expected
  status) executed from the server
- `auto_rollback`: bool (default true where a rollback point exists)
- `update_order` hint / `max_parallel` (default 1)
Global default is `notify` + approval required. Automation is opt-in.

### 7.4 Schedules and windows
- **Schedule:** cron expression + IANA time zone, job type (`image_check`,
  `image_pull`, `update`, `cleanup_report`), target selector, mode
  (`manual` = produce a plan and wait for approval, `auto` = run if policy
  allows), optional maintenance window, enabled flag.
- **Maintenance window:** days of week + start/end local time (may cross
  midnight) + time zone. Update steps only *start* inside a window; a run that
  cannot finish before the window closes does not start the next service and
  ends `partial` with the remainder `skipped`.
- Missed runs while the app was down: run once at startup only if still inside
  the window, otherwise record `skipped (missed)`.
- One maintenance run at a time (DB-backed lock). Approvals expire
  (default 72 h) → `skipped`.
- Runs left `running` after a crash are marked `interrupted` at startup with
  the last completed step and recovery guidance; they are never auto-resumed.

### 7.5 Safe update workflow (state machine; every step persisted)
1. **Preflight** — current state of project/services; refuse if a service is
   already restarting/unhealthy unless explicitly overridden; disk-space check.
2. **Check** — registry digests for affected images.
3. **Pull** — required images only. Failure here aborts with zero impact.
4. **Validate** — `docker compose config --quiet`; detect drift between the
   files and what is running (config-hash) and surface it, because a redeploy
   would also apply those unrelated changes.
5. **Impact** — affected services + dependents (`depends_on` graph), expected
   downtime per service, volumes attached, critical flags.
6. **Recovery point** — record old image ID/digest per service and tag it
   `quaymaster-rollback/<project>-<service>:<run>` so it cannot be pruned;
   store hashes of the Compose files and a redacted config snapshot.
7. **Deploy** — dependencies first (topological order), one service at a time:
   `docker compose up -d --no-deps --pull never <service>`.
8. **Health** — wait for `healthy` if a healthcheck exists; otherwise
   "running, not restarting, restart count stable" for the stabilisation
   period; plus the optional HTTP probe.
9. **Confirm / rollback** — on failure, stop the rollout (remaining services
   `skipped`). If auto-rollback is enabled: re-tag the previous image ID to the
   original reference, `up -d --no-deps --pull never <service>`, re-verify
   health. Otherwise leave as is and show exact manual recovery commands.
10. **Record & notify** — result, per-step output, durations, audit entries,
    notifications.

**Dry run** executes 1, 2, 4, 5 and renders the plan; nothing is pulled or
changed. Every real run stores the plan it executed.

**Standalone containers** are updated by cloning the inspected configuration
into a new container (old one renamed and kept stopped as the rollback point
until retention expires). This is best-effort, flagged as such, and never
automatic unless the policy says so.

**Honest limits, shown in the UI:**
- Compose on a single host recreates a container in place → a short
  interruption per service is expected. Quaymaster labels it "brief downtime
  expected" rather than claiming zero downtime. Staged, health-gated,
  dependency-ordered rollout minimises it; it does not eliminate it.
- Rollback restores the **image**, not the **data**. If a new version migrated
  a database/volume, the old image may not start. Services with volumes are
  flagged; a pre-update data backup remains the operator's responsibility.

### 7.6 Cleanup
Preview first, always. Categories: dangling images, unused images (no
container, running or stopped), stopped containers, unused networks, unused
anonymous volumes and unused named volumes. Never removed: images used by any
container, rollback-tagged images inside retention (default 7 days), anything
created less than a configurable age ago. No scheduled automatic deletion in v1
except expired rollback tags; scheduled cleanup produces a report + notification.

**Removal of images, networks and volumes (amends RT-24, see DECISIONS.md
"Storage cleanup").** Every list page can remove a single item, and
the Images and Volumes & Networks pages offer a bulk "clean up" built on the
same preview -> expiring preview token -> typed confirmation -> execute flow.
Rules, all enforced in the service layer (never in the UI):

- *Preview token.* The server computes candidates and stores them under a random
  `previewId` (10 minutes, bound to the admin who created it, single use). Execute
  accepts only that id plus the confirmation text, never a candidate list. Every
  candidate is re-inspected right before it is removed (TOCTOU): anything that
  became used, was recreated under the same name (volumes compare `CreatedAt`),
  left the scope or changed kind is skipped and reported.
- *Images.* Not used by any container (running or stopped), not a rollback/staged
  image within retention, not named by a discovered Compose project, older than
  the minimum age, in scope. Dangling-only and all-unused are separate
  categories. A multi-tag image can be untagged one tag at a time (the image
  stays) or deleted entirely; the result says which happened.
- *Networks.* Not `bridge`/`host`/`none`/swarm-internal, no attached or configured
  container (stopped containers count), not defined by a Compose project that still
  exists on disk, not Quaymaster's own network, in scope.
- *Volumes (data loss).* No container references it, stopped containers included
  (the container list is read unfiltered by `QM_VISIBLE_SCOPE`); never Quaymaster's own volumes; in scope
  (name and project label); a volume of a Compose project that still exists on disk,
  whose config declares it, or whose project Quaymaster cannot discover at all, is
  kept unless the admin opts in. Volumes and networks outside `QM_VISIBLE_SCOPE`
  are neither listed nor removable. Anonymous
  (64-hex name) and named volumes are separate categories, and **no volume
  category is selected by default**. Every volume removal needs a typed confirmation:
  the exact volume name (single) or `delete <n> volume(s)` (bulk). Engine calls
  carry a name-bound permit and are never forced, so Docker itself also refuses a volume in use.
- *Refusals* reuse the existing error codes (`read_only`, `out_of_scope`,
  `self_protected`, `confirmation_required`, `conflict`).
- *Storage reporting.* The preview shows per-item sizes: volumes from `UsageData`,
  images as size minus layers shared with other images (shared layers are freed only
  when the last image using them goes). Networks free nothing. After each run the
  result reports the estimate next to the measured figure (decrease of the layers +
  volumes accounted by `/system/df`, plus the change of free space on the Docker
  root).
- *Build cache is not cleaned up.* The Engine's build-cache prune cannot be filtered by
  label, so it cannot be restricted to what Quaymaster manages; it is therefore not offered.
- *Audit.* Every removal (and every refusal) is an audit record with actor, target,
  outcome and bytes. Containers are never touched by these flows.

## 8. Notifications
`NotificationChannel` interface (`id`, `configSchema`, `send(event)`, `test()`)
with a registry; adding an integration = one file. Shipped: generic webhook
(JSON, optional HMAC signature), ntfy, Gotify, Discord, Slack, Telegram, SMTP.
Events: container died/unhealthy/restart loop, updates available, maintenance
upcoming / awaiting approval, run succeeded/failed/rolled back/skipped, low
disk, high CPU/memory, app errors. Per-channel event subscriptions, minimum
severity, de-duplication and cool-down, delivery log with retry/backoff.
Outbound URLs are validated; delivery failures never break the triggering job.

## 9. API (REST, JSON, `/api/v1`)
`auth` · `system` (info, df, host) · `containers` · `compose` · `images` ·
`volumes` · `networks` · `events` · `updates` · `maintenance` (policies,
windows, schedules, runs, approvals) · `notifications` · `audit` · `settings` ·
`stream/*` (SSE). Uniform error envelope `{ error: { code, message, details } }`.
Long operations return an operation/run ID and stream progress.

## 10. UI
Left navigation: Dashboard, Containers, Compose Projects, Images, Maintenance,
Volumes & Networks, Logs & Events, Settings. Responsive (collapsing nav),
light/dark themes, one status colour language (healthy / warning / critical /
inactive / info) used everywhere, tables with search/sort/filter, detail
drawers/pages, confirmation dialogs that name the target and state the impact,
toasts for results, empty and error states for every view, keyboard-accessible.

## 11. Testing strategy
- **Unit:** redaction, dependency ordering, window/cron logic, policy
  resolution, planner, state machine transitions, registry client (mocked HTTP),
  auth/session/CSRF.
- **Integration (real Docker, fixtures only):** throwaway Compose stacks and a
  local registry under `test-fixtures/`, all named `qmtest-*` and labelled
  `quaymaster.test=true`. Covers discovery, actions, update detection by
  pushing a new image to the local registry, full update run, failed-health
  update → rollback, pull failure, invalid Compose file, window closing
  mid-run, crash mid-run → `interrupted`.
- **UI:** Playwright smoke test of each section + README screenshots taken
  against fixture data only.
- Tests never touch resources without the test label and never run an
  unfiltered prune.

## 12. Implementation phases
1. **Foundation** — workspace, config, DB/migrations, auth & security
   middleware, audit, Docker inventory/actions/events/stats/logs, Compose
   discovery + operations + redaction, tests, fixtures.
2. **Updates & maintenance** — registry checks, image management + cleanup,
   policies, windows, schedules, planner, executor, health, rollback,
   notifications, monitors, tests incl. failure scenarios.
3. **Web UI** — all eight sections against the real API.
4. **Red-team review** — security and safety audit of the implementation.
5. **Hardening & packaging** — fix findings, Dockerfile, Compose deployment,
   systemd unit, end-to-end tests, screenshots.
6. **Documentation** — README, install/config/backup/upgrade guides,
   SECURITY, CONTRIBUTING, CHANGELOG.
7. **Publish** — secret scan, repository creation, push.

---

## 13. Binding amendments (red-team review 01)

`docs/reviews/01-architecture-redteam.md` was reviewed and **accepted**. Every MUST-FIX (RT-01 … RT-15) and
SHOULD-FIX (RT-16 … RT-30) in it is part of this specification, with the recommended change as written there.
Where that review conflicts with sections 1–12 above, **the review wins**. The most consequential changes:

1. **An update changes only the image (RT-01).** Before any Compose mutation that recreates a service, the
   per-service config hash (`docker compose config --hash`) is compared with the running container's
   `com.docker.compose.config-hash`. Mismatch → automatic runs abort before pulling (`blocked_drift`); manual
   runs need a separate, explicit "apply drift" confirmation showing a redacted diff. Unset-variable warnings
   from Compose are errors. Compose is always invoked with explicit `--project-name`, `--project-directory`
   and `--file` in recorded order and a fixed, documented child environment.
2. **Labels are untrusted (RT-02).** `QM_STACK_PATHS` is mandatory in both deployment modes and is the only
   allow-list for file-level operations (realpath-checked; nothing under the Docker root; includes `env_file`,
   `secrets`/`configs` files and `include`). Conflicting or out-of-root labels → `limited`.
3. **Read-only mode and scope are enforced in the transport (RT-03)**: an allow-list of Engine API
   method/path pairs and Compose subcommands, not per-route checks. Actions resolve to the full ID, check the
   inspected object, and act by ID. Scope is defined per resource type, including everything an in-scope
   project's config references, and it filters cleanup candidates.
4. **Redaction is universal (RT-04)**: every object leaving the process (API, SSE, persisted events and
   operation output, notifications, logs) is walked at every depth; known secret values are scrubbed from
   free text; events carry an allow-listed attribute set; notification URLs are secrets as a whole.
5. **Self-protection fails closed (RT-05)** and covers the own project, networks, volumes and `QM_PROTECTED`.
6. **Workflow order (RT-06, supersedes 7.5):** Preflight → Validate (+hash gate) → Check → Recovery point →
   Pull → Impact → Deploy → Health → Confirm/rollback → Record. The rollback image ID comes from the running
   container, never from the tag. Always `--no-build --pull never`. Built and digest-pinned services are not
   updatable. After deploy and after rollback the running image ID is asserted.
7. **Pulls do not move tags (RT-07).** Images are pulled by digest and held under a `quaymaster-staged/…` tag;
   the user-visible tag moves only inside the deploy step. Impact lists every container on the host that
   references the same tag.
8. **Approvals are bound to a plan hash (RT-08)**; a changed plan → `approval_stale`, never executed.
9. **Scheduler (RT-09):** unique `(schedule, occurrence)` rows; an occurrence that already has a run is never
   started again automatically; DST and midnight semantics as specified in the review; health checks, rollback
   and recording always finish regardless of the window.
10. **Health and rollback defaults (RT-10):** effective timeout respects the healthcheck's own timings;
    `auto_rollback` defaults to **false for services with writable persistent mounts** (stop, leave as is,
    alert) and true for stateless services; one-shot services succeed on exit 0; HTTP probes must pass against
    the current version before they can gate a rollback.
11. **Namespace sharing (RT-11):** `network_mode`/`pid`/`ipc` `service:`/`container:` and `volumes_from` are
    dependency edges; recreating a provider recreates its dependents in the same step.
12. **Standalone containers (RT-12):** clone by diffing against the old image's config, re-attach every mount
    including anonymous volumes, reconnect all networks, create-then-swap with restore on failure.
    Standalone updates are **never automatic** in v1. Compose-managed containers are only ever recreated
    through Compose.
13. **Disk (RT-13):** free space is measured on the Docker root (mounted read-only in container mode via
    `QM_DOCKER_ROOT_MOUNT`); pull/update preflight fails closed without it.
14. **Crash and conflict handling (RT-14):** write-ahead intents, startup reconciliation with a critical
    notification for any service left down, graceful shutdown, and abort-without-rollback when another tool
    changes the run's containers.
15. **SSE (RT-15):** streams are bound to sessions, re-validated, limited and back-pressured.

Decisions on points the review left open:

- **RT-30:** container log access is a separate permission, **off for the viewer role by default**.
- **RT-40:** `QM_STACK_PATHS` is scanned read-only (bounded depth and file count) so projects that are down
  remain visible. Replicated services (`container-number` > 1) are supported in views; update runs treat a
  service's replicas as one unit and say so.
- **RT-32:** the image store is detected; on a store Quaymaster has not been tested on, rollback-based
  automation is refused with an explanation rather than attempted.
- **RT-38:** documentation states plainly: do not expose Quaymaster to the internet; TOTP is on the roadmap.
- **RT-39:** known auto-updaters running on the host produce a warning banner.
- **RT-42:** a targeted red-team review of the executor/rollback state machine happens directly after
  phase 2, before the UI is built.
- Remaining NOTE items (RT-31, RT-33 … RT-37, RT-41) are accepted as written.

Implementers record how each finding was addressed in `docs/DECISIONS.md`.
