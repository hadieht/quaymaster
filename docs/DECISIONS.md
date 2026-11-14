# Decisions and trade-offs

Format: **ID** — decision (status). Status: accepted / deferred (phase) / rejected.

## Phase 1 implementation choices

- **Migrations as TypeScript** (`server/src/db/migrate.ts`) instead of `.sql` files: no asset-copy step in the build. Forward-only, `VACUUM INTO backup-pre-vN.db` before applying, refuses a database newer than the build.
- **Instance lock** is an `O_EXCL` pid file (`quaymaster.lock`) with a liveness check; Node has no `flock`. Equivalent for the "two instances, one DB" case (RT-27) except after a hard crash with PID reuse.
- **Fixtures use only `alpine:latest`** (already local, `pull_policy: never`) instead of busybox/nginx: pulling would add images the daemon owner did not ask for, and moving a tag is a mutation (RT-07).
- **`spawn`-free runner:** all child processes use `execFile` with argument arrays; streaming is done by listening on the child's pipes.
- **CPU % in stats** is percent of one core (Δcpu-ns/Δwall-ns), like `docker stats`; can exceed 100 on multi-core.
- **Viewer log access** is a per-user flag `logsRead` (default off) rather than a global setting.
- **`docker compose ls`** is merged with labels and a bounded scan of `QM_STACK_PATHS` (depth 3, 500 dirs, no symlink following) so down projects stay visible (RT-40).
- **Scope matching** is on name globs only; the dev/test rule that resources are also labelled `quaymaster.test=true` is enforced by the fixture scripts, not by the server.
- **Remove** never uses force or `v=true`: a running container must be stopped first (Docker returns 409, passed through).
- **Not implemented in phase 1 (by design):** pulls (image pull is a mutation tied to RT-07, phase 2), image/volume/network removal and prune, standalone `recreate` (needs RT-12 clone), registry checks, scheduler, notifications.

## Red-team review 01 — disposition

MUST-FIX

- **RT-01** accepted (phase 1 primitive): `ComposeService.checkDrift` compares `config --hash` per service with the running label before `up`/`redeploy`/`recreate`; mismatch → `blocked_drift` + redacted config; separate `applyDrift` confirmation; unset-variable warnings are errors; every Compose call passes `--project-name/--project-directory/--file` explicitly with a documented minimal child env (PATH, HOME, DOCKER_HOST, LANG); Compose version stored in the operation record. Automatic runs/snapshot diff: deferred to phase 2.
- **RT-02** accepted: `QM_STACK_PATHS` mandatory; `PathPolicy` uses realpath, rejects the Docker root, symlink escapes; conflicting labels or `ls` disagreement → limited; env_file/secrets/configs paths checked in `validate`; remote include/extends → limited; project mutation names come from the validated project, not one container.
- **RT-03** accepted: transport wrapper (`enforceOnModem`) allows only GET/HEAD plus container lifecycle calls by full ID with a matching permit; runner subcommand allow-list; resolve→check→act by full ID with rename re-check; scope covers referenced volumes/networks/container names; image/volume/network mutations do not exist yet.
- **RT-04** accepted: `redactDeep` walks every key of every outgoing object; known-value `Scrubber` for logs/errors/CLI output; events reduced to an allow-list; extended key regex, query-parameter, flag and webhook-path rules; notification URL helper `maskUrlToSchemeHost`. Image history is not exposed.
- **RT-05** accepted: self detection via `QM_SELF_CONTAINER` → mountinfo → cgroup → hostname; failure inside a container forces read-only; protects own container, own project (project-level), own volumes/networks, `QM_PROTECTED`; all actions on self refused.
- **RT-06 / RT-07 / RT-08 / RT-09 / RT-10 / RT-14** deferred to phase 2 (design-now items): schema support exists (`intents`, `schedule_occurrences`, `operations`); new workflow order is in ARCHITECTURE §13.
- **RT-11** accepted (phase 1 part): `shares_namespace` and `volumes_from` edges; provider recreate needs `confirmNamespaceProvider`.
- **RT-12** accepted (phase 1 part): Compose containers recreate only through Compose; standalone recreate refused (`unsupported`) until the clone procedure exists.
- **RT-13** accepted (phase 1 part): `HostMetrics.dockerRoot` from `statfs` of the Docker root / `QM_DOCKER_ROOT_MOUNT`, with an explicit error when unavailable. Preflight in phase 2.
- **RT-15** accepted: `SseHub` — session-bound streams, revocation on logout/expiry/role/password change, 60 s re-validation, per-session/total limits, 1 MiB back-pressure close, byte-rate cap for logs.

SHOULD-FIX

- **RT-16** accepted: scrypt `maxmem` 256 MiB, params stored in the hash, `HashGate` (1 concurrent, queue 8, then 429), IP budget before hashing.
- **RT-17** accepted: per-account capped delay (≤30 s, failures only), hard lock keyed on (account, IP), `QM_TRUST_PROXY` explicit list only. Recovery CLI: deferred (phase 1.5; documented need).
- **RT-18** accepted: session-bound HMAC CSRF token, `__Host-` cookie when Secure, new session id per login, password change revokes others, exact Origin match (missing → reject), 30 min idle / 12 h absolute, GET-has-no-side-effects integration test.
- **RT-19** accepted: setup token printed to stderr outside pino, `0600` file, 60 min TTL, 5 attempts per IP, constant-time compare, deleted on success; env admin applied only when no users exist.
- **RT-20** deferred (phase 2, registry client). **RT-22, RT-23, RT-24, RT-29** deferred (phase 2).
- **RT-21** accepted (phase 1 part): remote include/extends → limited. Outbound policy for notifications: phase 2.
- **RT-25** accepted: allow-listed persisted actions, `exec_*` dropped, batched writes, inventory re-sync with synthetic "missed" events after reconnect.
- **RT-26** accepted: `one-shot` stats with own CPU delta, concurrency 2, `system df` per type single-flight and rate-limited, batched prune deletes. Resource budget measurement: phase 5.
- **RT-27** accepted: WAL, `synchronous=NORMAL`, `busy_timeout`, `foreign_keys`, periodic checkpoint, pid-file lock, pre-migration backup, newer-schema refusal. Run-lock release by reconciliation: `OperationManager.recover` marks running operations failed/interrupted.
- **RT-28** accepted (phase 1 part): deny-list tested in `assertSafeArgv`, `--flag=value` form, `--` before services. `--no-start` for stopped services: phase 2.
- **RT-30** accepted: `logs:read` permission, default off for viewers; known-value scrubbing + text rules on log lines.

NOTE items RT-31 (version negotiation), RT-33 (Compose versions shown per project), RT-34 (SSE headers/heartbeat), RT-35 (`/healthz` minimal), RT-36 (audit never stores raw failed usernames; retention), RT-37 (key validation, random IV, AAD, key id) are implemented. RT-32, RT-38, RT-39, RT-41, RT-42: carried to later phases/docs.

## Phase 2 — updates, maintenance, notifications (work in progress; see "Not finished" below)

- **RT-06/07 (accepted, implemented):** workflow order is Preflight → Validate (+hash gate) → Check → Recovery point → Pull → Impact → Deploy → Health → Confirm/rollback → Record. The rollback image ID comes from the running container's `ImageID`; rollback tags are `quaymaster-rollback/<sha256(project/service)[:12]>:<run-id>` with the original reference in `rollback_points`. Pulls are by digest into `quaymaster-staged/<hash>:<digest12>`; the user-visible tag moves only inside the deploy step. `--no-build --pull never` always; `build:` and digest-pinned services are excluded from plans.
- **RT-08 (accepted):** approvals carry the plan hash (service list/order, from-image ID, to-digest, config hash, policy snapshot). The executor re-plans at preflight and ends `approval_stale` (creating a new approval request) on any difference.
- **RT-09 (accepted):** `schedule_occurrences` is claimed before a run is created; DST rules live in `maintenance/time.ts` (gap → first valid instant after the gap, ambiguous → once at the first instant, window end = zoned start instant + duration) and are pinned by `test/unit/time.test.ts` for Europe/Berlin and Australia/Sydney. Missed `update` occurrences run once only if a window is configured and open, otherwise `skipped_missed`; other job types run once.
- **RT-10 (accepted):** effective health timeout = max(policy, start_period + interval × retries + 30 s); `auto_rollback` defaults OFF for services with writable volume/bind mounts and ON for stateless ones (an explicit policy value wins; any level's explicit `false` wins over `true`); one-shot success = exit 0; HTTP probes are verified when the policy is saved and refuse to save if they fail.
- **RT-11/29 (accepted):** `shares_namespace` / `volumes_from` dependents are added to the plan and recreated (`--force-recreate`) right after their provider; `depends_on` dependents are re-verified after the dependency is healthy (restart only if `depends_on.restart` is declared, otherwise the rollout stops and nothing is rolled back).
- **RT-13 (accepted):** plan preflight requires free ≥ 2.5 × Σ compressed layer sizes + max(`QM_DISK_FLOOR_BYTES`, 10 % of the filesystem) on the Docker root and fails closed when free space is unknown; the pull aborts if free space falls below the floor.
- **RT-14:** write-ahead `intents` per deploy/rollback, startup recovery marks runs `interrupted`, raises a critical `service.left_down` alert with the exact compose command, and never resumes. Conflict detection (containers/images changed by another tool) is checked before each service and aborts WITHOUT rollback. Graceful drain on SIGTERM exists from phase 1. The one-click restore API was added later (see below).
- **RT-20 (accepted):** registry credentials are sent only over https (or loopback/`QM_REGISTRY_INSECURE` hosts) and only to the registry host or an allow-listed token realm; HEAD uses `Accept` for OCI index, Docker list, OCI and Docker v2 manifests; a mismatch with the pulled `RepoDigests` is also accepted when the local digest is one of the remote index's linux/amd64 platform manifests. Pulls use `X-Registry-Auth` from the encrypted store.
- **RT-21/RT-04 (notifications):** one outbound client (`notifications/outbound.ts`): http/https only, no userinfo, link-local/metadata/unspecified addresses refused at connect time (loopback and RFC1918 allowed: home LAN targets), same-host redirects only, 5 s, 64 KiB, status code only. Channel configuration is encrypted as a whole; URLs are masked to scheme://host.
- **RT-22 (accepted):** a failed (reference, remote digest) pair is quarantined; unattended runs skip it (`unattended.blockers`) until the tag moves or an admin clears it (`POST /updates/quarantine/clear`).
- **RT-23 (accepted):** safety flags combine most-restrictive (`critical` OR, `require_approval` OR, `auto_rollback` AND); unattended deploy only if update_mode = auto ∧ schedule mode = auto ∧ ¬require_approval ∧ ¬critical (`maintenance/policy.ts`).
- **RT-24 (accepted):** cleanup needs a preview (10-minute token, same admin, typed confirm), re-verifies each item, never removes in-use / compose-referenced / rollback or staged (within retention) / young / out-of-scope items, treats untagged images as out of scope while `QM_MANAGED_SCOPE` is set unless a label filter is given, and only reports volumes and networks.
- **RT-03:** the transport allow-list now also covers image pull/tag/untag (never forced), container create/rename and network attach, each only with a permit that names exactly that target. docker-modem keeps query parameters in `options.options`, so the allow-list sees them via `withQuery`.
- **Redaction fix:** `com.docker.compose.config-hash` and `com.docker.compose.image` label values are no longer fed to the known-value scrubber (their entropy made every config hash/image ID in API output read `••••••`).
- **Deviations / choices:** one update schedule targets one project/container; standalone containers are never auto-updated; `update_order` is only a tie-breaker inside the dependency order; `maxParallel` is fixed to 1; the clock is injectable (`ctx.clock`) so tests can move time; notification `MAX_ATTEMPTS` is 5 total sends.

### Phase 2 continuation: what was added and what is still open

- **RT-12 (implemented, `maintenance/clone.ts`, `maintenance/standalone.ts`):** `POST /maintenance/standalone {container, confirm}` updates a standalone container by config clone, manual only (schedules refuse `mode: auto` for containers). The clone keeps only what differs from the OLD image's own config (Env, Cmd, Entrypoint, WorkingDir, User, Labels, Healthcheck, ExposedPorts), re-attaches every mount including anonymous volumes by name, keeps static IPs/aliases (minus the auto alias) and connects extra networks before start, and refuses `container:` network mode, `--rm` and Compose-managed containers. Sequence: create (stopped) → stop old → rename old to `<name>-qm-old-<epoch>` → rename clone → start → health gate; any failure removes the clone, renames the old container back, starts it and restores the tag. The old container is kept stopped as a recovery point (the cleanup service protects `-qm-old-` containers within the rollback retention). Limit: the old container keeps its restart policy, so a daemon restart with `restart: always` could start it next to the clone; `container update` is not on the permit list. A remaining volume declared only by the NEW image becomes an anonymous volume of the clone (removed with `v:false` on undo, so it can linger).
- **RT-14 (completed):** `POST /maintenance/runs/:id/restore {confirm: <project>, services?}` (admin, typed confirmation, single-run lock, audited) re-tags the run's recorded previous image IDs and redeploys those services in reverse plan order with the health gate. It applies to Compose runs; restoring a successful standalone update is done by renaming the kept `-qm-old-` container (documented in the run output), not by this endpoint.
- **Health steps (behaviour change):** a health step that fails is persisted as `failed` (it used to be `succeeded` with `ok:false` in the detail), likewise a deploy whose `compose up` exited non-zero.
- **Detector race (fixed):** a `fresh` check no longer joins an in-flight non-fresh check that started earlier (it could return pre-publish answers; seen as a flaky `up_to_date` right after a run).
- **Redaction:** `configHash`, `planHash`, `fromImageId`, `toImageId` are safe keys (the key-name rule matched `hash` and masked them in API output).

#### Still not done / not tested (honest status)

- SMTP and Telegram channels have unit tests with mocked transports only; there was no real round trip.
- Registry behaviour is tested against the plain-HTTP fixture registry (no token auth) and against a mocked HTTP client for token auth, 429 and multi-arch; Docker Hub / GHCR were not contacted.
- The scheduler is exercised through `tick()` with the injected clock (critical-target scenario and the missed-run unit tests), not through the real 20 s timer; the monitors are unit-tested with stubbed Docker events/host data, not with real events.
- Standalone restore after a successful update is manual (see RT-14 above); the restart-policy caveat of RT-12 is open.
- The web UI is not part of this task.

## Phase 2c — audit 01b fixes (decisions and deferrals)

- **Drift gate per recreate (F-01):** the plan's `configHash` (wanted `compose config --hash` at plan time) is re-computed for the service right before each `up`; an unverifiable hash fails closed. Rollback and restore use `checkDrift` (running label vs wanted hash) instead, because a rollback must not apply an edit made after the deploy. A mid-run drift ends the run `blocked` (nothing deployed yet) or `partial`, never rolls back, and raises a critical alert.
- **Intents live until the outcome is final (F-02):** no schema change (no phase column); `recover()` derives the phase from the live image vs `fromImage`/`toImage`. A deploy intent always prints the tag-restore command because the crash may have happened between the tag move and `up`.
- **Shutdown (F-03):** the executor checks `ctx.shuttingDown` before each service. Health/rollback of the current service always finish. In container mode set `stop_grace_period` ≥ the longest health timeout (default 120 s drain); otherwise Docker's 10 s SIGKILL turns a restart into the F-02 path, which is now reported truthfully.
- **Compose `pull` removed (F-04):** instead of reimplementing it through staged pulls, the action is gone; the update workflow (check → staged pull by digest) is the only pull path. The UI's "pull images" is `image_pull` / a run with `pull_only`.
- **Restart policy of the kept container (F-05):** set to `no` through a dedicated `container_restart_policy` permit (only `POST /containers/<id>/update` for that id). Restoring the old container by hand needs the original policy, which is written into the run result.
- **Scope for image side effects (F-06):** a plan whose tag is shared with an out-of-scope or protected container is refused at preflight (no "confirm anyway" path in v1); background `image_pull` only handles images whose every user is in scope; policies cannot be set for out-of-scope targets.
- **autoRollback (F-09):** supersedes the phase-2 rule "an explicit policy value wins": a project/global `true` no longer enables rollback for stateful services; service/container level can. An explicit `false` anywhere still wins.
- **Deferred:** **L-4** (one-shot detection by `restart: "no"`/exit-0 heuristics needs a decision; today a one-shot without a `service_completed_successfully` edge is gated as long-running), **L-5** (unknown layer sizes: the floor-only check is kept; the check still fails closed when free space is unknown), **redaction test teardown** (test hygiene; `qmtest-secrets-leaky-1` is left running by `redaction.int.test.ts` and must be removed by `test-fixtures/scripts/down.sh`). **F-07** has no end-to-end test (see audit table). The real-daemon-restart behaviour of F-05 and a real `kill -9` re-run of F-02 were not repeated in phase 2c.

## Phase 3: web UI

- **Static serving**: the server serves `web/dist` with `@fastify/static` (`QM_WEB_DIR`), SPA fallback to `index.html` for client routes (never for `/api`, assets or non-GET). The CSP stays strict (`script-src 'self'`): the bundle has no inline scripts and styling uses classes/CSSOM only.
- **New endpoints for the UI**: `GET /system/settings` (non-secret operational config), `GET/DELETE /auth/sessions` (own sessions), `GET /maintenance/cron/preview`, `GET /stats/overview`; `GET /containers` additionally returns `restartCount` and `startedAt`.
- **Theming** uses CSS variables (light/dark) with one status colour language (`healthy|warning|critical|inactive|info`); dialogs are native `<dialog>` (focus trap and Esc for free).
- **Compose `pull` action removed from the UI**: API.md listed it, the server never implemented it. Pulling is done from Images (`POST /images/pull`, staged).
- **`POST /maintenance/plan` returns a stored run record** (`plan` inside); the UI reads `.plan`.
- **Scrubber vs. account endpoints (bug found while integrating)**: the global known-value scrubber masks every learned secret literal in all JSON responses. A container whose password is a short common word (e.g. `admin`) made `/auth/me` return `username:"••••••", role:"••••••"`, so the UI treated the admin as a viewer. `/auth/*` and `/users*` responses are now exempt (they never contain container data); structural key-based redaction and log scrubbing are unchanged. Regression test in `webui.int.test.ts`.
- **Stats prune bug (found in the browser walkthrough):** `StatsRepo.prune` used `rowid`, but `stats_rollups` is `WITHOUT ROWID`, so the periodic prune threw `no such column: rowid`. It now deletes by the `(container_id, minute)` key; regression test in `server/test/unit/stats-repo.test.ts`.
- **Accessibility:** clickable table rows are keyboard-operable (tabindex, Enter/Space). Stat cards put the icon inline with the label so long labels and values never overlap or wrap.

## Phase 5: hardening and packaging

- **uncaughtException policy:** the process logs and keeps running (the update engine must not die mid-update); only startup errors exit.
- **Scrubber (`learnable()`):** only values that look like credentials (length, entropy, key-name hint) are learned, so short or ordinary values (years, image names) are never blanked everywhere.
- **Pull scope:** `/images/pull` is allowed only for references used by an in-scope container (repository match), through the service layer.
- **Maintenance gate:** while a run is active on a project, manual container/compose actions on it are refused (409).
- **`QM_VISIBLE_SCOPE`:** a read-side glob filter (containers, projects, events, images used by visible containers). Independent from `QM_MANAGED_SCOPE`; used for demos and screenshots.
- **`QM_DOCKER_SOCKET=tcp://host:port`** is accepted so Quaymaster can sit behind a socket proxy (read-only deployment).
- **Container free-space check:** the server fails closed when it cannot determine free space; in a container `QM_DOCKER_ROOT_MOUNT` must point to any directory on the Docker root's filesystem (the Docker root itself is mode 710 and unreadable for uid 10001).
- **Instance lock:** pid files are unreliable across container restarts; the lock now carries the hostname and is refreshed every 5 s (stale after 20 s).
- **Test environment:** the containerised verification ran with `--network host` (the fixture registry listens on host 127.0.0.1) and fixtures copied to a neutral path outside `/root` (mode 700, not traversable by the non-root user). Production uses the bridge network as in `deploy/`.
- **Playwright:** `@playwright/test` 1.64 is a root devDependency; `E2E_CHROMIUM` can point to an installed Chromium.
- **Deferred:** M-05 (persist rate-limiter state), M-03 socket destroy, L-01 (npm audit: zod, react-router, uuid bumps), L-02, L-03, L-05, L-06.

## Phase 5: history rewrite and test flakiness note

- **M-06 history rewrite.** The owner approved rewriting history to drop two real container names from earlier review text. Done with `git filter-repo --replace-text` after a `git bundle` backup outside the repo; all commit hashes changed. RFC1918 literals in unit tests and the fake credentials in redaction tests are deliberate fixtures (gitleaks reports 8 findings, all in those files).
- **Timing-sensitive test.** `maintenance.int.test.ts` "critical target is never auto-updated" failed once when the full suite ran alongside a typecheck/lint on the 2-core host (2 runs instead of 1) and passed in isolation and when the file was re-run. Treat as load-sensitive; do not run other jobs during the suite.

## Storage cleanup: removal of images, networks and volumes

- **Deliberate reversal of "report only".** RT-24 and ARCHITECTURE 7.6 made volumes and networks report-only and said
  volume removal is single-volume only. The owner now explicitly asked to clean up images, networks and volumes and to
  free their storage. RT-24's concern (a stopped stack's database looks unused) is handled by safeguards instead of a ban:
  no volume category is selected by default; anonymous and named volumes are separate categories; named volumes need an
  explicit opt-in; a volume of a Compose project that still exists on disk or whose config declares it is kept unless a
  second opt-in is given; every volume removal needs a typed confirmation (exact name, or `delete N volume(s)`); a
  stopped container counts as a user. A volume labelled with a Compose project that Quaymaster cannot discover (no
  containers left, directory outside `QM_STACK_PATHS`, compose CLI unavailable, or project outside `QM_VISIBLE_SCOPE`)
  is treated like an existing project and needs the same opt-in: "not discovered" is not proof of "deleted from disk"
  (red-team RT3-01, docs/reviews/03-cleanup-redteam.md). Known residual risk: an unlabelled named volume (plain
  `docker run -v name:/x`) is removable by design once its owner opted in and typed the phrase.
- **Same flow as image cleanup, but separate endpoints.** `/storage/cleanup/{preview,execute}` is its own service
  (`StorageCleanupService`) instead of more categories on `/images/cleanup/*`: the confirmation differs (typed phrase
  versus echoing the preview id) and previews must never mix data-loss and routine items by accident.
- **Typed confirmation for anonymous volumes too.** The brief required it only for named volumes. Anonymous volumes can
  hold data (`docker run -v /data` without `--rm -v`), so the phrase is required whenever any volume is in the
  preview. This is stricter than asked.
- **"Count word" for bulk** is implemented as `delete <n> volume(s)` (for example `delete 3 volumes`).
- **Execute re-validates, it does not trust the preview.** Volumes compare `CreatedAt` with the preview (a volume
  deleted and recreated under the same name is skipped), re-read the container list unfiltered by `QM_VISIBLE_SCOPE`,
  and repeat the scope, self-protection and Compose checks. Stopped containers are matched by their mounts and by
  network name/`HostConfig.NetworkMode`: the daemon-side `network` filter misses stopped containers (their
  NetworkID is empty), which the integration test caught (it removed a network a stopped container was configured
  for before the fix).
- **Engine permits.** `volume_remove {name}` and `network_remove {id}` (full 64-hex id only) join `image_remove`; no
  force, prune stays off the allow-list. Docker's own refusal for a volume in use is a second line of defence.
- **Scope and anonymous volumes.** With `QM_MANAGED_SCOPE` set, anonymous (hash-named) volumes cannot be attributed to
  the scope by name and are therefore never removable; this is intentional.
- **Last known user** of a volume is only what Docker records: the Compose project/volume labels. An unused volume has
  by definition no container, so the UI says "unknown" otherwise. No usage history is stored (would need a migration).
- **Minimum age** (`QM_CLEANUP_MIN_AGE_HOURS`) applies to bulk volume and network cleanup (protects a volume that a
  `docker run` has just created); explicit single removals ignore it.
- **Reclaimed storage.** Estimate = sum of volume `UsageData.Size` and per-image `Size - SharedSize`. Measured = the
  decrease of (`LayersSize` + volume sizes) from `/system/df`, taken before and after (each call can take a while on big
  hosts, so it runs only for explicit previews/removals), plus the statfs free-space delta, which is shown but noisy.
  The df delta is the headline figure; if df cannot be read the report falls back to statfs, then to the estimate and
  says so.
- **Build cache: not implemented.** The Engine's `POST /build/prune` filters (`until`, `id`, `type`, `inuse`, ...)
  cannot be restricted by label, so it cannot be limited to Quaymaster-managed or test resources. An unfiltered prune
  is forbidden by the repository rules and would also delete build cache that belongs to others, so the category is
  not offered. `docker builder prune` remains a manual step (documented).
- **Not done:** per-item removal for networks does not offer an opt-in for Compose-defined networks (networks hold no
  data and `compose up` recreates them; the bulk and single paths both keep them).

## ADR: dynamic Compose project discovery and file access (unreleased, 0.2.0)

**Context.** Update/redeploy/config used to work only for projects under `QM_STACK_PATHS` that were also mounted at the identical path. Everything else showed one generic banner and, before that, startup failed without `QM_STACK_PATHS`.

**Options considered.**

- (a) _Read-only helper container_: created through the Docker API, bind-mounts the project's directory read-only, prints only compose/`.env` files. Works for any path the daemon can see, with no mount in Quaymaster.
- (b) _Require a mount_ (previous behaviour) with a clear, per-project hint.
- (c) _Run `docker compose` for update/redeploy inside the helper._ Would remove the last mount requirement, but needs the compose CLI in the helper image, the project's relative bind mounts and env files resolved inside it, streaming output, and a permit model for compose-in-container. Too large and risky for this release.

**Decision.** Ship (a) for reading and (b) for acting. Discovery is label-driven and needs no configuration. Update, redeploy and `docker compose config` still require the files to be readable by Quaymaster under an allowed root. Allowed roots are `QM_STACK_PATHS` plus directories mounted into Quaymaster's own container at the same path (read from its own container inspect, so a label cannot forge them; switch off with `QM_STACK_AUTO_MOUNTS=false`). (c) is deferred.

**Helper rules.** Image: `QM_HELPER_IMAGE` or Quaymaster's own image; never pulled. No network, all capabilities dropped, no-new-privileges, read-only root, 128 MiB, 64 pids, directory mounted read-only via the Mounts API (no `:` parsing). Fixed script, argv array, no shell. Refuses symlinks, non-regular and world-writable files, files over 1 MiB; a world-writable directory makes the project untrusted. Output is re-validated on our side (names, sizes). Only used for projects inside `QM_MANAGED_SCOPE`, never in read-only mode, force-removed in a `finally`, stale helpers swept by label and name. Creation/start/removal go through the transport permits like every other mutation. The helper shows the files as written (not interpolated) and `.env` keys only.

**Threat model.** Anyone who can create a container with forged Compose labels already has root through the socket. What must not widen is what a Quaymaster _user_ can read. So a label is never trusted by itself: the working directory must be absolute, canonical, free of `..`/control characters, not `/` or a pseudo filesystem; only compose-like and `.env*` names (plus explicit `config_files` entries under that directory) are read; responses are redacted as before; non-admins see exactly what they saw before (redacted configuration).

**Stop monitoring.** An ignore list in SQLite keyed by (kind, name, working directory), not a Docker operation. It is allowed in read-only mode and for out-of-scope resources because it only hides things from Quaymaster. Safety computations (image/volume/network ownership and in-use checks) deliberately ignore the ignore list, so hiding a project can never make its resources look unused. Ignoring Quaymaster's own project is refused. No "destroy project" feature exists.

**Known risks / limits.** The helper image must contain Node.js and be present locally. Containers with conflicting labels can reappear as a second entry after ignoring. Stored history of events from before the ignore is hidden by name in `GET /events` only.
