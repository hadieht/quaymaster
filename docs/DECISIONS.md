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
- **RT-14 (partly):** write-ahead `intents` per deploy/rollback, startup recovery marks runs `interrupted`, raises a critical `service.left_down` alert with the exact compose command, and never resumes. Conflict detection (containers/images changed by another tool) is checked before each service and aborts WITHOUT rollback. Graceful drain on SIGTERM exists from phase 1. The one-click "restore previous state" API is NOT implemented yet.
- **RT-20 (accepted):** registry credentials are sent only over https (or loopback/`QM_REGISTRY_INSECURE` hosts) and only to the registry host or an allow-listed token realm; HEAD uses `Accept` for OCI index, Docker list, OCI and Docker v2 manifests; a mismatch with the pulled `RepoDigests` is also accepted when the local digest is one of the remote index's linux/amd64 platform manifests. Pulls use `X-Registry-Auth` from the encrypted store.
- **RT-21/RT-04 (notifications):** one outbound client (`notifications/outbound.ts`): http/https only, no userinfo, link-local/metadata/unspecified addresses refused at connect time (loopback and RFC1918 allowed: home LAN targets), same-host redirects only, 5 s, 64 KiB, status code only. Channel configuration is encrypted as a whole; URLs are masked to scheme://host.
- **RT-22 (accepted):** a failed (reference, remote digest) pair is quarantined; unattended runs skip it (`unattended.blockers`) until the tag moves or an admin clears it (`POST /updates/quarantine/clear`).
- **RT-23 (accepted):** safety flags combine most-restrictive (`critical` OR, `require_approval` OR, `auto_rollback` AND); unattended deploy only if update_mode = auto ∧ schedule mode = auto ∧ ¬require_approval ∧ ¬critical (`maintenance/policy.ts`).
- **RT-24 (accepted):** cleanup needs a preview (10-minute token, same admin, typed confirm), re-verifies each item, never removes in-use / compose-referenced / rollback or staged (within retention) / young / out-of-scope items, treats untagged images as out of scope while `QM_MANAGED_SCOPE` is set unless a label filter is given, and only reports volumes and networks.
- **RT-03:** the transport allow-list now also covers image pull/tag/untag (never forced), container create/rename and network attach, each only with a permit that names exactly that target. docker-modem keeps query parameters in `options.options`, so the allow-list sees them via `withQuery`.
- **Redaction fix:** `com.docker.compose.config-hash` and `com.docker.compose.image` label values are no longer fed to the known-value scrubber (their entropy made every config hash/image ID in API output read `••••••`).
- **Deviations / choices:** one update schedule targets one project/container; standalone containers are never auto-updated; `update_order` is only a tie-breaker inside the dependency order; `maxParallel` is fixed to 1; the clock is injectable (`ctx.clock`) so tests can move time; notification `MAX_ATTEMPTS` is 5 total sends.

### Not finished in this session (honest status)
- Standalone-container update by config clone (RT-12) is NOT implemented (plans only cover Compose projects; the permits for create/rename/network exist).
- "Restore previous state" API (RT-14) and a real SMTP/Telegram round trip are not implemented/tested.
- Integration tests for: successful dependency-ordered update, broken image → rollback, rollback disabled, pull failure during a run, invalid Compose file, window closing mid-run, approval expiry/staleness, critical never auto-updated, crash → interrupted, cleanup protections are NOT written yet. `test/integration/updates.int.test.ts` (detection, dry run, standalone pull) exists but fails: see the task comment for the failure analysis.
- Unit tests for planner ordering, policy resolution, health state machine, registry client (mocked HTTP) are NOT written yet (window/cron/DST and notifications unit tests exist).
