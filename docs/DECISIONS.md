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
