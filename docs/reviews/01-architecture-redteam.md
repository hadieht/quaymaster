# Red-team review 01 — Architecture specification (pre-implementation)

- **Target:** `docs/ARCHITECTURE.md` at commit `299a28b`
- **Reviewer:** red team (Rook)
- **Type:** design review only. No code was written. I ran only read-only commands to check facts (see
  "Evidence gathered" at the end).
- **How to use this:** every finding has an ID, a severity, the phase it lands in, a concrete failure scenario and a
  specific design change. The phase-1 engineer implements every **MUST-FIX** marked phase 1. MUST-FIX items marked
  phase 2 must be written into the spec now so phase 1 does not build module boundaries that prevent them. Each
  MUST-FIX and SHOULD-FIX gets a line in `docs/DECISIONS.md` (accepted / deferred / rejected, with the reason).

Severity scale:

- **MUST-FIX**: as designed, this can take the owner's services down, corrupt or orphan their data, or escalate
  privileges. Fix it in the design before building.
- **SHOULD-FIX**: a real weakness with a concrete scenario, but bounded impact or a cheap workaround. Fix it in the
  phase that builds the feature.
- **NOTE**: a gap, ambiguity or over-claim to document or decide. Low risk.

---

## Claim under test

> "Quaymaster can hold the Docker socket and safely monitor, redeploy and schedule-update a home server's existing
> Compose projects and standalone containers, deployed by other tools, without breaking them, and fail safe when
> something goes wrong."

The security model in section 5 is careful. Almost every serious problem sits in one assumption the spec never states:
**that what Quaymaster runs with `docker compose` reproduces the deployment that is currently running.** It does not
in general. Several findings below (RT-01, RT-02, RT-07, RT-11, RT-12) are cases of that assumption failing.

## Summary

| Severity | Count |
|---|---|
| MUST-FIX | 15 |
| SHOULD-FIX | 15 |
| NOTE | 12 |

| ID | Sev | Phase | Title |
|---|---|---|---|
| RT-01 | MUST | 1+2 | Redeploy/update does not reproduce the running deployment; config-hash drift is only "surfaced" |
| RT-02 | MUST | 1 | Compose labels are attacker-controllable and are trusted as file paths (privilege escalation) |
| RT-03 | MUST | 1 | Read-only mode and managed scope are under-specified and bypassable |
| RT-04 | MUST | 1 | Redaction is a per-section deny-list and leaks through events, images, CLI output and errors |
| RT-05 | MUST | 1 | Self-protection: detecting the own container fails on cgroup v2; coverage too narrow |
| RT-06 | MUST | 2 | The rollback point can capture the wrong image; build/pinned services are not handled |
| RT-07 | MUST | 2 | "Pull ≠ deploy" is false: pulling moves shared tags for every project on the host |
| RT-08 | MUST | 2 | Approvals are not bound to what gets executed |
| RT-09 | MUST | 2 | Scheduler: no occurrence idempotency, DST undefined, missed-run logic re-runs crashed runs |
| RT-10 | MUST | 2 | Health gating can roll back a migrating database; defaults favour data damage |
| RT-11 | MUST | 1+2 | Shared network namespaces (`network_mode: service:`/`container:`) and `volumes_from` are ignored |
| RT-12 | MUST | 1+2 | Standalone config-clone loses data (anonymous volumes) and carries stale image config |
| RT-13 | MUST | 1+2 | The disk-space check cannot be done in container mode as specified; pull failure is not zero impact |
| RT-14 | MUST | 2 | A crash or a concurrent manager mid-deploy leaves services down, and the run only says "interrupted" |
| RT-15 | MUST | 1 | SSE streams outlive logout or a role change and have no resource limits |
| RT-16 | SHOULD | 1 | scrypt parameters throw with Node defaults; unauthenticated CPU/memory DoS on 2 cores |
| RT-17 | SHOULD | 1 | Lockout design is a DoS on the single admin; per-IP limits break behind a proxy |
| RT-18 | SHOULD | 1 | CSRF/session: SameSite gives no protection between sibling subdomains; token and cookie details |
| RT-19 | SHOULD | 1 | First-run token and env-provisioned admin lifecycle undefined |
| RT-20 | SHOULD | 2 | Registry auth: credential leak via `realm`; pull auth path undefined; digest Accept headers |
| RT-21 | SHOULD | 1+2 | Outbound request policy ("URLs are validated") undefined; compose `include:` remote resources |
| RT-22 | SHOULD | 2 | A failed update is retried every night (no quarantine of the bad digest) |
| RT-23 | SHOULD | 2 | Policy precedence lets a service-level setting override `critical` |
| RT-24 | SHOULD | 2 | Cleanup can delete images and volumes of stacks that are only temporarily down |
| RT-25 | SHOULD | 1 | Events: the daemon replay buffer is small; healthcheck exec spam floods persistence |
| RT-26 | SHOULD | 1 | Resource budget on 2 cores: stats, `system df`, synchronous SQLite |
| RT-27 | SHOULD | 1 | SQLite: two instances on one DB, stale run lock, unsafe backup and migration |
| RT-28 | SHOULD | 1+2 | `up` starts services the operator had stopped; dangerous compose flags not forbidden |
| RT-29 | SHOULD | 2 | Dependents are not re-verified after their dependency is recreated |
| RT-30 | SHOULD | 1 | Viewer role can read every container log (logs routinely contain secrets) |
| RT-31…42 | NOTE | — | see NOTE section |

---

## MUST-FIX

### RT-01: Redeploy/update does not reproduce the running deployment; drift is only "surfaced"
**Severity:** MUST-FIX · **Phase:** 1 (redeploy, per-service up) and 2 (update, rollback)

**Problem.** Step 4 detects drift and "surfaces it", then step 7 runs `docker compose up -d --no-deps <service>`
anyway. The spec also requires a *minimal child environment* and, in container mode, a Compose binary bundled in a
different image. The original deployment's inputs cannot be reconstructed from what Docker records:

- Compose records `project`, `working_dir`, `config_files`, `config-hash`, `image`, `depends_on` and `version`
  labels. On the reference host no container records `--env-file`, active `--profile`s or the shell environment
  that was present at deploy time. Those inputs are lost.
- Interpolation of `${HOME}`, `${PWD}`, `${USER}`, `~`, and variables the operator `export`ed before running
  `docker compose up` gives **different values** in Quaymaster's minimal environment, and in a different container
  `HOME`.
- A missing variable is a *warning* in Compose ("variable is not set. Defaulting to a blank string"), not an error.

**Failure scenarios.**
1. `volumes: ["~/ha/config:/config"]`. The host shell resolved `~` to the operator's home. Quaymaster's child
   resolves it to its own `HOME`. The daemon creates an **empty** directory on the host at the new path, and the
   service starts with no config: a fresh onboarding screen, or a freshly initialised empty database. The health check
   passes, the run reports **success**, and the real data is still on disk but no longer used. The operator notices
   days later, after the new location has collected writes.
2. A project deployed with `--env-file ../secrets.env`. Quaymaster omits it (no label records it), `POSTGRES_PASSWORD`
   interpolates to blank, and the recreated container gets the wrong credentials, or an init script runs with an empty
   password.
3. The operator edited `compose.yaml` in Dockge last week (added `privileged: true` to try something) and never
   redeployed. Tonight's automatic image update applies that unrelated change.

**Change.**
- Make the per-service config hash the central safety gate. Before **any** compose mutation that recreates a service
  (redeploy, per-service up, update deploy, rollback), run `docker compose … config --hash=<svc>` (this flag exists in
  the host's Compose v5.4) and compare it with the running container's `com.docker.compose.config-hash`.
  - `auto` runs: any mismatch on a service that would be recreated → **abort before pull**, status `blocked_drift`,
    notify.
  - Manual runs and redeploys: a mismatch needs an explicit "apply drift" confirmation that shows the redacted diff of
    `config` output against the stored snapshot. Make it a separate confirmation field from the target-name one.
- Treat Compose warnings about unset variables as **errors** in Validate (parse stderr; fail closed).
- Pass every input explicitly: `--project-name`, `--project-directory=<working_dir>`, and `--file=<each config file>`
  in recorded order. Put the child environment (`PATH`, `HOME`, `DOCKER_HOST`, `DOCKER_CONFIG`) in the spec, and
  record the Compose version used in the operation record.
- Spec text: the update rationale becomes "an update changes only the image. If anything else would change, it is not
  an update; it is a redeploy and needs approval."

### RT-02: Compose labels are attacker-controllable and are trusted as file paths
**Severity:** MUST-FIX · **Phase:** 1 (discovery, capability levels)

**Problem.** Discovery is label-based. Labels are not trustworthy:
- An **image** can carry `LABEL com.docker.compose.project.working_dir=…` / `config_files=…` / `project=…`.
  Containers inherit image labels, so any `docker run` of that image is "discovered" as a Compose project with
  attacker-chosen paths.
- Anyone who can create a container (any Portainer or Dockge user, any automation) can set those labels.
- Tools that run Compose *inside their own container* record paths in **their** filesystem namespace. Portainer, for
  example, records `/data/compose/<id>/docker-compose.yml`, which is not a host path. That path can collide with
  Quaymaster's own `/data` in container mode.

**Failure scenario (escalation to host root).** A compromised but unprivileged application container writes
`compose.yml` into its own named volume (host path under the Docker data root) with `privileged: true` and
`volumes: ["/:/host"]`. Its image labels point `config_files` at that file. In native mode Quaymaster can read it, so
the "project" gets capability **full**. The next "redeploy", or a scheduled update targeting "all projects", runs the
attacker's file through the socket. Result: root on the host, created by Quaymaster.

Lower-severity variant: a label `com.docker.compose.project=<real project>` merges a foreign container into a real
project, so it is included in `down`/`restart` of that project.

**Change.**
- `QM_STACK_PATHS` becomes **mandatory in both deployment modes** and is the only allow-list. A project is **full**
  only if `realpath(working_dir)` and `realpath(every config file)` lie under an allowed root. Resolve symlinks and
  reject `..` escapes. Also reject any path under `DockerRootDir` (from `/info`) whatever the roots say. Otherwise the
  level is **limited**, with the reason shown.
- Apply the same allow-list check to `env_file`, `.env`, `secrets.*.file`, `configs.*.file` and `include:` paths in
  the resolved config. A file outside the roots → limited.
- If the containers of one project disagree on `working_dir`/`config_files`, or containers claim the project but
  `docker compose ls` reports different files, mark it **limited (conflicting labels)** and refuse file operations.
- Never take the project name from a single container's label for a mutation. Resolve it from the allow-listed
  working directory.

### RT-03: Read-only mode and managed scope are under-specified and bypassable
**Severity:** MUST-FIX · **Phase:** 1 · **Note:** development safety (AGENTS.md rule 4) depends on this being correct.

**Problem.** The spec says read-only "disables every mutating Docker action at the service layer" and scope
"refuses mutating actions against anything outside". It defines neither "mutating" nor what scope means for images,
volumes, networks or Compose file contents. Concrete bypasses an implementer will plausibly create:

1. **Image operations are not tied to a container or project name.** With `QM_MANAGED_SCOPE=qmtest-*`, "pull
   `nginx:latest`", "remove unused images" or rollback-tag expiry act on images that real services use (see RT-07 and
   RT-24). A developer test of cleanup preview/execute on the real daemon deletes the images of real stacks that are
   currently `down`.
2. **An in-scope project's file references out-of-scope resources.** `qmtest-x` with `volumes: {data: {external: true,
   name: <real volume>}}`, `network_mode: container:<real container>`, `container_name: <real name>` or
   `pid: service:…`. The scope check passes on the project name, and Quaymaster mounts and mutates real data.
3. **Name/ID ambiguity (TOCTOU).** Docker resolves an identifier as full ID, then name, then ID prefix. The check
   resolves the name, the action is sent with the user-supplied string, and between the two calls another tool
   renames or recreates the container. The action hits a different object.
4. **Read-only gated per route.** The implementer guards routes. A background job (scheduler pull, rollback-tag
   expiry, an event-triggered auto action) calls dockerode directly and is never checked. Pull and tag count
   as mutations because they change what the next `up` deploys, and they are easy to forget.

**Change.**
- Enforce **in the transport**, not in routes. Wrap the dockerode modem: in read-only mode only allow-listed
  `(method, path)` pairs pass (all `GET`, plus specific read-only `POST`s such as `/auth` if needed). Everything else
  throws before any network I/O. Give the Compose runner a subcommand allow-list: read-only mode allows
  `config`, `ls`, `ps`, `images`, `version` and nothing else.
- Scope check protocol: resolve the identifier with inspect to the full 64-hex ID → run the scope check on the
  *inspected* object → send the action **by full ID** → re-check that the ID still has the same name before
  destructive actions.
- Define scope per resource type in the spec:
  - container: matched on its name (leading `/` stripped) **and** its Compose project, both must match when present;
  - Compose project: its name, **and** every resource its resolved config references must be in scope (external
    volumes/networks, `container_name`, `network_mode`/`pid`/`ipc` `container:`/`service:` targets);
  - image: in scope only if every container referencing it (running or stopped) is in scope and no out-of-scope
    discovered project references its tag;
  - volume/network: by name and by `com.docker.compose.project` label.
  With a non-empty scope, cleanup/prune candidates are filtered to in-scope resources *before* the preview is built.
- Unit test matrix: every mutating service method × {read-only, out-of-scope, self} → refused, with an audit entry.

### RT-04: Redaction is a per-section deny-list and leaks through other channels
**Severity:** MUST-FIX · **Phase:** 1

**Problem.** 6.3 applies key/value rules to a fixed list (env, Compose `environment`, `secrets`, `configs`, labels,
command args). Secrets reach the browser, the DB and logs by other paths:

- **Docker events.** Verified on the reference host: `exec_create`/`exec_start` events carry the **full exec command
  line** in `Action` (e.g. a healthcheck `/bin/sh -c curl -u user:pass …`), and every container event carries
  **all container labels** in `Actor.Attributes`. Events are persisted and fanned out over SSE.
- **Image inspect/history.** `Config.Env` of the image, and `history[].CreatedBy`, which contains `ARG` values used in
  `RUN` steps (`|1 NPM_TOKEN=… /bin/sh -c npm ci`).
- **Container inspect beyond Env.** `HostConfig.LogConfig.Config` (`splunk-token`, `loki-url` with userinfo), `Args`,
  `Path`, healthcheck `Test`.
- **Compose config.** `build.args`, `healthcheck.test`, `x-*` extension fields and anchors, `command` as a string
  (`--password=x`, or `--password x` as two tokens), `DATABASE_URL=…?password=…` (key does not match, no userinfo).
- **Captured CLI output and errors.** Operation records store Compose stdout/stderr. Error messages and stack traces
  carry interpolated strings that pino's *path*-based redaction never sees.
- **Notification URLs.** Telegram (`/bot<token>/`), Discord and Slack webhooks hold the secret in the **path**, which
  the "URL with userinfo" rule does not cover.

**Change.**
- Redaction walks **every** key at every depth of any object leaving the process (API, SSE, DB persistence of
  events/operations, notifications, logs). There is no per-section list.
- **Known-value scrubbing.** When a project, container or channel is loaded, collect every value the key rules classify
  as secret. Scrub those literal strings (and their URL-encoded forms) from all captured CLI output, error messages,
  event attributes and log lines before storage or transmission.
- Events: persist and stream only an allow-listed attribute set (`name`, `image`, `com.docker.compose.project`,
  `com.docker.compose.service`, `exitCode`, `signal`, health status). Strip the `exec_*` command suffix from `Action`.
- Treat every notification URL as a secret as a whole: store it encrypted, never log it, show only scheme + host.
- Extend the key regex: `psk|seed|mnemonic|passphrase|otp|bearer|apikey|access|license|encrypt|hash|hmac`. Add a
  query-parameter rule for URLs (`password|token|key|secret|sig` params masked). Add a "next token after a secret-named
  flag" rule for argv arrays.
- Test fixture: one Compose project containing each of the above, and a test asserting that no fixture secret string
  appears anywhere in the API responses, SSE frames, DB file bytes or the log output.

### RT-05: Self-protection: detecting the own container fails on cgroup v2; coverage too narrow
**Severity:** MUST-FIX · **Phase:** 1

**Problem.** "Detects its own container" is unspecified. The common method, parsing `/proc/self/cgroup`, returns no
container ID on cgroup v2: the reference host is cgroup v2, and inside a container the file reads `0::/`. `HOSTNAME`
is only the short ID and the operator can override it. If detection silently fails, self-protection is silently off.
Coverage is also too narrow. Even with detection working, these all take Quaymaster down in the middle of the operation
that runs them:
- `down`/`restart`/`redeploy` of the Compose **project** that contains Quaymaster;
- `pause` (which freezes the process doing the pause) and `kill`;
- removing or disconnecting its network, removing its data volume;
- stopping the socket proxy or reverse proxy it depends on (operator lockout).

**Change.**
- Detection order: `QM_SELF_CONTAINER` (ID or name, optional) → `/proc/self/mountinfo` (the
  `/var/lib/docker/containers/<64-hex>/` hostname/resolv.conf mount) → hostname match against inspect. In container
  mode, **fail closed**: if self cannot be determined, start in read-only mode and show why.
- Protected set = own container + its Compose project (project-level mutations refused; per-service mutations of
  *other* services allowed) + its networks and volumes + containers listed in `QM_PROTECTED` (default empty; document
  adding the socket proxy and reverse proxy). Refuse `pause`/`kill`/`stop`/`remove`/`recreate`/`update` on the set.
- Unit tests cover each detection path with recorded `mountinfo` samples for cgroup v1 and v2.

### RT-06: The rollback point can capture the wrong image; build/pinned services are not handled
**Severity:** MUST-FIX · **Phase:** 2 (design now)

**Problem.** Step 3 (pull) runs **before** step 6 (recovery point). After the pull, the tag already resolves to the
**new** image. An implementation that records "old image" with `image inspect <ref>` records the new image as the
rollback point, so rollback becomes a no-op that reports success. Further gaps:
- `quaymaster-rollback/<project>-<service>:<run>`: Compose service names may contain upper case and `.`, but repository
  names must be lower case and length-limited. Tagging fails and the step aborts (or, worse, is skipped).
- Services with `build:` and no `image:`, or `pull_policy: build`: `up` without `--no-build` **rebuilds** from the
  context. That executes a Dockerfile, takes minutes of CPU on 2 cores, and needs build contexts the container may not
  have mounted.
- `image: repo@sha256:…` or `repo:tag@sha256:…`: re-tagging cannot roll this back, and there is nothing to update.
- After `up`, nobody checks that the container actually runs the intended image, for example because another tool
  re-pulled the tag in between.

**Change.**
- New order: Preflight → **Validate (+RT-01 hash gate)** → Check → **Recovery point** → Pull → Impact → Deploy →
  Health → Confirm/rollback → Record. Nothing touches images before validation and the recovery point.
- The rollback image ID comes from each container's `.Image` (inspect of the running container), never from resolving
  the tag.
- Rollback tag: `quaymaster-rollback/<sha256(project/service)[:12]>:<run-id>`, with the original
  project/service/reference stored in the DB and in a label-free side table.
- Always pass `--no-build` and `--pull never`. `local_only` (built) and `pinned_digest` services are excluded from
  update runs. That makes them non-updatable, not just undetectable.
- After deploy, and again after rollback: assert `container.Image == expected image ID` for every container of the
  service. A mismatch counts as a health failure.

### RT-07: "Pull ≠ deploy" is false: pulling moves shared tags for every project on the host
**Severity:** MUST-FIX · **Phase:** 2 (design now)

**Problem.** A tag is host-global. Pulling `postgres:16` for project A moves the local tag that projects B and C also
reference. Nothing restarts, but the **next `up` by anyone** deploys the new image: a Dockge "deploy" after an
unrelated env edit, a Portainer stack update, an operator's `docker compose up -d`. That deploy happens outside any
window, without health gating, recovery point or audit. `pull_only` mode turns this into a standing policy. Two
services in the same project sharing the tag (app + worker) are handled the same way: the plan updates one, and the
other is silently "staged".

**Change.**
- Pull **by digest** (`repo@sha256:<remote digest>`) through the Engine API. Immediately tag the result
  `quaymaster-staged/<hash>:<digest12>` so it is not dangling (otherwise any `image prune`, including another tool's,
  deletes it). Move the user-visible tag (`docker tag <new id> repo:tag`) **only inside the deploy step**, just before
  `up` of the first service using that reference.
- Impact (step 5) lists **every** container on the host, in every project and standalone, that references the same
  repository:tag. They are either part of the run or explicitly listed as "will deploy the new image on their next
  recreate".
- The "update staged" state means "staged image present, tag not moved". Rename the spec claim accordingly.

### RT-08: Approvals are not bound to what gets executed
**Severity:** MUST-FIX · **Phase:** 2 (design now)

**Problem.** An approval is valid for 72 h. Approved Monday for "app: 1.4 → digest X", executed Wednesday: by then the
tag has moved to digest Y (an untested or yanked release), or the Compose file changed. The run executes something no
one approved, under an audit entry that says "approved".

**Change.** The approval stores a **plan hash** over (service list, per-service from-image-ID, to-digest, config hash,
dependency order, policy snapshot). At execution, recompute it. Any difference → the run stops at preflight with status
`approval_stale` and creates a new approval request. The audit entry records the approved plan hash.

### RT-09: Scheduler: no occurrence idempotency, DST undefined, missed-run logic re-runs crashed runs
**Severity:** MUST-FIX · **Phase:** 2 (design now; schema in phase 1)

**Problems / scenarios.**
1. **Crash loop re-executes.** A run starts at 03:00 and crashes Quaymaster mid-deploy (OOM, the run itself recreated a
   dependency, host hiccup). At restart the run is marked `interrupted` (good). Then "missed runs: run once at startup
   if still inside the window" starts a **new** run for the same occurrence. That is exactly the auto-resume the spec
   forbids, and it repeats on every crash.
2. **DST.** In Europe/* on the last Sunday of March, 02:00–03:00 local time does not exist. In October, 02:00–03:00
   happens twice. A 02:30 schedule runs zero times or twice, and a window of 02:00–04:00 is 1 h or 3 h long. The spec
   is silent. The cron library's behaviour is an implementation detail no test pins down.
3. **Midnight crossing.** "Days of week + start/end": is Sunday 01:00 inside a "Saturday 23:00–02:00" window? Is
   start == end empty or 24 h?
4. **Window closing mid-service.** "Update steps only *start* inside a window." Is a rollback after the window closes
   allowed? It must be. Otherwise a failed service stays down until the next window.

**Change.**
- Table `schedule_occurrences(schedule_id, occurrence_utc, status, run_id)` with `UNIQUE(schedule_id,
  occurrence_utc)`. A run is created by inserting the occurrence first. An occurrence that has any run (including
  `interrupted`) is never started again automatically.
- DST rules in the spec: a non-existent local time fires at the first valid instant after the gap. An ambiguous local
  time fires **once**, at its first occurrence. Window membership is computed in UTC from the zoned start instant plus
  the duration. Unit tests pin both transition days in a European zone and one southern-hemisphere zone.
- Window semantics: the day of week refers to the **start** day. `end <= start` means it crosses midnight.
  `start == end` is rejected by validation.
- Health verification, rollback and recording always complete regardless of the window. Only *starting* a new
  service's deploy is gated.

### RT-10: Health gating can roll back a migrating database; defaults favour data damage
**Severity:** MUST-FIX · **Phase:** 2 (design now)

**Problems / scenarios.**
1. **Rollback during a migration.** The new image runs a long schema migration on start (Nextcloud, Gitea, Immich,
   Paperless all do this). The healthcheck has `start_period: 300s`, and Quaymaster's health timeout is shorter. The
   timeout fires, auto-rollback (default **true**) recreates the container, which kills the migration halfway, and the
   old image starts on a half-migrated schema. That is data damage caused by the safety mechanism.
2. **False positive.** With no healthcheck, "running, restart count stable for N s" passes for images whose PID 1 is a
   supervisor (s6-overlay in linuxserver.io images): the container keeps running while the app inside crash-loops.
3. **False negative.** One-shot services (`restart: "no"`, migration or init jobs, `service_completed_successfully`
   dependencies) exit 0 by design. "Running" fails, and a correct update is rolled back.
4. **Unreachable probe.** "HTTP probe executed from the server": in container mode Quaymaster is not attached to the
   project's networks, so `http://app:8080/health` fails, and a healthy update is rolled back. Every time.

**Change.**
- Effective health timeout = max(policy timeout, `start_period + interval × retries` + 30 s) whenever a healthcheck
  exists. Show the effective value in the plan.
- `auto_rollback` default = **false for services with persistent mounts** (named volumes or binds that are not
  read-only); there the failure action is "stop the rollout, leave the service as is, alert". It stays true for
  stateless services. Make this rule explicit in 7.3 and the UI.
- One-shot services: success = exited with code 0 within the timeout.
- HTTP probe: when saving the policy, Quaymaster runs the probe once against the current version and refuses to enable
  probe-gated auto-rollback until it has succeeded. Document that the URL must be reachable from Quaymaster's network
  namespace (a published port, or attach Quaymaster to the network).
- Consider `docker compose up --wait --wait-timeout` (available in v5.4) as the primitive for healthcheck-bearing
  services, with Quaymaster's own checks layered on top.

### RT-11: Shared network namespaces and `volumes_from` are ignored by per-service `--no-deps` deploys
**Severity:** MUST-FIX · **Phase:** 2 (update), 1 (single-service redeploy/recreate warning)

**Problem.** The VPN-sidecar pattern is common on home servers: `gluetun` plus `qbittorrent` with
`network_mode: service:gluetun`. Recreating `gluetun` alone with `up --no-deps gluetun` gives it a new network
namespace. `qbittorrent` keeps running in the **dead** namespace with no network at all. It stays "running" and passes
the restart-count check, so the run reports success while the service is unreachable (or, worse for the VPN case, its
traffic routing state is undefined until recreated). The same applies to standalone `--network container:X`, and to
`volumes_from` with anonymous volumes.

**Change.** The dependency graph gets an edge type `shares_namespace` (from `network_mode`/`pid`/`ipc`
`service:`/`container:`) and `volumes_from`. Recreating the provider forces recreating every dependent in the same
step (provider first, then dependents), and the health gate covers all of them. A standalone dependent outside Compose
→ the plan refuses the auto path and shows manual steps. Phase-1 per-service redeploy/recreate shows a warning and
requires confirmation when the target is a namespace provider.

### RT-12: Standalone config-clone loses data and carries stale image config
**Severity:** MUST-FIX · **Phase:** 1 (`recreate` action on standalone containers), 2 (standalone update)

**Problem.** `docker inspect` merges image defaults into `Config`. A naive clone:
- copies the **old image's** `Env` (e.g. `APP_VERSION=1.2`, `PATH`), `Cmd`, `Entrypoint`, `WorkingDir`, `User`,
  `Labels`, `Healthcheck`, `ExposedPorts` and `Volumes` onto the new image. The new version starts with the old
  entrypoint or version variables and breaks or misbehaves;
- loses **anonymous volumes**: `docker run postgres` without `-v` keeps its data in an anonymous volume attached to
  the *old* container. The clone gets a new empty anonymous volume, so Postgres initialises an **empty database**,
  starts, and passes health. When the rollback retention expires the old container is removed, and the next "unused
  volumes" cleanup (RT-24) deletes the only copy of the data;
- drops or garbles static IPs (`IPAMConfig`), aliases, MAC address, `container:` network mode, multiple networks
  (only one can be given at create), `--init`, device requests (GPU), `--rm`, the auto-generated hostname;
- port conflict: the new container cannot bind published ports until the old one stops, so downtime starts before
  creation is known to succeed.

**Change.**
- Clone = diff against the old image: for each of `Env`, `Cmd`, `Entrypoint`, `WorkingDir`, `User`, `Labels`,
  `Healthcheck`, `ExposedPorts` and `Volumes`, keep only the values that differ from the **old image's** config. Let
  the new image supply its defaults.
- Every mount of the old container, **including anonymous volumes**, is re-attached by volume name in the new
  container.
- Networks: create on one network, then connect the rest with their `IPAMConfig`/aliases before start. Refuse if
  `NetworkMode` is `container:`.
- Sequence: create the new container (stopped) → stop the old → rename the old → start the new → health. On any
  failure: remove the new, rename the old back, start the old.
- Standalone **auto** update is not allowed in v1, whatever the policy says (remove "unless the policy says so").
- Phase-1 `recreate` of a Compose-managed container always goes through Compose (`up -d --force-recreate --no-deps
  <svc>`, subject to RT-01), never through clone.

### RT-13: The disk check cannot be done in container mode as specified; pull failure is not "zero impact"
**Severity:** MUST-FIX · **Phase:** 1 (host disk metric), 2 (preflight)

**Problem.**
- Inside a container, `statfs` cannot reach the Docker data root unless it is mounted. The spec mounts only the socket,
  `/data` and the stacks, so the safety-critical "disk-space check" (and the "low disk" monitor) has no data source.
  `/info` and `/system/df` report usage, not free space on the filesystem.
- "Pull failure aborts with zero impact" is over-claimed. A pull that hits ENOSPC has already filled the filesystem
  that holds `/var/lib/docker/volumes`, container logs and overlay upper dirs. Running databases then fail their writes.
  The damage happens before the abort.
- Rollback tags keep old images for 7 days and staged images (RT-07) add more, so disk pressure grows exactly where
  the check is missing.

**Change.**
- Container mode mounts the Docker root read-only for `statfs` only (e.g. `<DockerRootDir>:/host-docker-root:ro`,
  configured by `QM_DOCKER_ROOT_MOUNT`). If it is missing, preflight **fails closed** for pull/update with an
  explanation. Native mode uses `statfs(DockerRootDir)`.
- Preflight requirement per image: free ≥ `2.5 × Σ compressed layer sizes` (from the manifest; skip layers already
  present) + floor. Floor = `max(QM_DISK_FLOOR_BYTES, 10 % of the filesystem)`. Check before each image pull, and
  monitor during the pull: abort the pull if free space drops below the floor.
- Reword 7.5 step 3 to "a pull failure does not restart or recreate anything", and state the disk caveat.

### RT-14: A crash or a concurrent manager mid-deploy leaves services down, and the run only says "interrupted"
**Severity:** MUST-FIX · **Phase:** 2 (design now; operation records in phase 1)

**Problems / scenarios.**
1. Compose recreate = stop old → rename old to `<id-prefix>_<name>` → create new → start → remove old. If Quaymaster is
   killed in the middle (systemd stop with the default `KillMode=control-group` kills the compose child; a container
   restart; OOM), the service can be left **stopped**, or as a renamed orphan with no running replacement. At startup
   the spec marks the run `interrupted` "with recovery guidance". The service stays down and no one is paged.
2. During a run, the operator clicks "Update" in Dockge, or an updater such as Watchtower acts on the same service.
   Two recreates race, one fails with a name conflict, and Quaymaster's state machine continues with stale
   assumptions. Its rollback may then undo the other tool's intentional change.

**Change.**
- Write-ahead intent: before each side-effecting sub-step, persist `{run, service, action, from_image, to_image,
  container_ids_before}`. On startup, reconciliation inspects every service in an unfinished intent. Any service that
  is not running (or is renamed-orphaned) → send a **critical notification** immediately, and show the exact recovery
  command (`docker compose … up -d --no-deps <svc>` with the files used), plus a one-click "restore previous state"
  action gated by admin confirmation. Never act automatically.
- Graceful shutdown: on SIGTERM, start no new step and wait for the current Compose child (systemd unit
  `TimeoutStopSec=` ≥ the longest stop timeout + 60 s; `KillMode=mixed`). Document `stop_grace_period` for the
  container deployment.
- Concurrency guard: during a run, watch events for the run's projects. Any container `create`/`destroy`/`rename` that
  does not come from Quaymaster's own Compose child → abort the remaining steps, **do not roll back** automatically,
  alert as `conflict`.

### RT-15: SSE streams outlive logout or a role change and have no resource limits
**Severity:** MUST-FIX · **Phase:** 1

**Problem.** `EventSource` authenticates once at connect. If the session is only checked at connect:
- a user who is logged out, demoted from admin to viewer, deleted, or whose session expires keeps receiving live logs
  and events indefinitely (revocation does not work);
- each log-follow stream holds a Docker log stream open. 50 tabs, or one script, means 50 daemon streams. A slow client
  on a chatty container makes Node buffer without bound (no backpressure) and Quaymaster is OOM-killed, which
  interrupts any running maintenance (RT-14).

**Change.** Register every SSE stream with its session ID. Logout, logout-all, expiry, password change and role change
close them. Re-validate the session every 60 s on the stream. Absolute stream lifetime ≤ the session's absolute
timeout. Limits: ≤ 8 concurrent streams per session, ≤ 32 total, configurable. Close the stream when
`res.write()` returns false and the buffer exceeds 1 MiB, with an event telling the client to reconnect. Log follow
has a bytes/s cap.

---

## SHOULD-FIX

### RT-16: scrypt parameters throw with Node defaults and allow unauthenticated DoS
**Phase 1.** Verified on the reference host: `scryptSync(…, {N: 2**17, r: 8, p: 1})` throws
`ERR_CRYPTO_INVALID_SCRYPT_PARAMS`, because 128 MiB exceeds Node's default `maxmem` of 32 MiB. With `maxmem` raised,
one hash took **731 ms** on this 2-core host. libuv's default pool runs 4 hashes in parallel: 512 MiB and both cores
saturated by four unauthenticated login requests. That starves health-check timers during a maintenance run, and
health failures can then trigger rollbacks. **Change:** set `maxmem: 256 MiB` explicitly. Keep N=2^17 but put the
rate limiter **before** hashing, and cap concurrent hash operations at 1 with a short queue (reject above 8 queued
with 429). Store the parameters with each hash (`scrypt$N$r$p$salt$hash`) so they can be changed later.

### RT-17: Lockout design is a DoS on the single admin; per-IP limits break behind a proxy
**Phase 1.** A per-account exponential lockout lets anyone who can reach the login page lock the only admin out,
possibly during an incident. Behind the recommended reverse proxy, all requests share the proxy IP: either per-IP
limits lock everyone out, or, with `trustProxy: true`, `X-Forwarded-For` is spoofable, which bypasses the limits and
forges the IPs in the audit log. **Change:** per-account limits become a progressive *delay* (capped, e.g. 30 s), not
a hard lock. Hard lockout is keyed on (account, client IP). `QM_TRUST_PROXY` accepts only an explicit IP/CIDR list,
never `true`. Add a local recovery CLI (`quaymaster admin reset-password`, run on the host or in the container) to the
spec.

### RT-18: CSRF/session details
**Phase 1.** `SameSite=Strict` does not protect against **sibling subdomains**. `wiki.home.example` and
`qm.home.example` are the *same site*, which is the normal layout behind a home reverse proxy. An XSS in any sibling
app can send credentialed same-site requests and can toss cookies onto the parent domain. The custom header and the
Origin check are therefore the real defences, and they must be specified strictly. **Change:**
- Use a synchronizer token tied to the session (HMAC(session secret, session ID)), not a plain double-submit cookie.
- Cookie names get the `__Host-` prefix when `Secure`.
- Rotate the session ID on login and on privilege change. A password change revokes all other sessions.
- Compare `Origin` exactly against the configured `QM_PUBLIC_ORIGIN` list (new variable), not against `Host`. A
  missing `Origin` on a state-changing request → reject.
- Mutations only on non-GET methods. Add a test that every GET route has no side effects.
- Define the idle and absolute timeouts (proposal: 30 min idle / 12 h absolute).

### RT-19: First-run token and env-provisioned admin lifecycle
**Phase 1.**
- A setup token "printed to the server log" may be **masked by pino's redaction** (key `token`), which makes setup
  impossible. It is also readable by every other log viewer on the host for as long as the log exists. **Change:**
  print it once to stderr outside pino, also write it to `/data/setup-token` (mode 0600), expire it after 60 min
  (regenerate on restart), compare it in constant time, limit to 5 attempts per IP, and delete it on success.
- `QM_ADMIN_PASSWORD_HASH`: if it is applied on every start, a password changed in the UI reverts on restart, or the
  env hash stays a permanent second credential. **Change:** apply it only when the users table is empty. Document the
  hash format (same as RT-16).

### RT-20: Registry auth: credential leak via `realm`, undefined pull auth, digest pitfalls
**Phase 2.**
- Token auth follows `WWW-Authenticate: Bearer realm=…`, and the realm is chosen by the registry, or by anyone who
  controls the `image:` string in a Compose file. Sending stored Basic credentials to that realm leaks them to an
  arbitrary host. **Change:** send credentials only over https, and only to a realm whose host equals the registry
  host or is on a per-registry allow-list (e.g. `registry-1.docker.io` → `auth.docker.io`).
- How **pulls** authenticate is unspecified. `docker compose pull` in the container has no `~/.docker/config.json`
  (or would need the host's mounted, which exposes every credential and breaks with `credsStore` helpers).
  **Change:** pulls go through the Engine API with `X-Registry-Auth` from the encrypted store (this also fits RT-07).
- The HEAD request must send `Accept:` for OCI index, Docker manifest list, OCI manifest and Docker v2 manifest.
  Otherwise registries return a converted manifest whose digest never matches `RepoDigests`, the result is always
  `update_available`, and auto mode churns every night. Pick the `RepoDigests` entry whose repository matches the
  reference (an image can have several).

### RT-21: Outbound request policy is undefined; remote compose resources
**Phase 1–2.** "Outbound URLs are validated" is not a spec. An admin is already root-equivalent, so SSRF from admin
settings is not a privilege boundary. But Compose files (written by non-admins via Dockge etc.) also cause outbound
requests: registry hosts from `image:`, and remote `include:` (git/OCI) resolved by `docker compose config`.
**Change:** define one outbound policy: http/https only, no redirects to a different host, 5 s timeout, 64 KiB
response cap, response bodies never returned to the client (status code only). Notification test results show
success/failure plus the status code. Projects whose resolved config uses remote `include`/`extends` are **limited**
(RT-02).

### RT-22: A failed update is retried every night
**Phase 2.** After a rollback the local tag points at the old image while the registry still has the bad digest. The
next check says `update_available`, and the next auto run repeats the failure: nightly downtime plus rollback, forever.
**Change:** record a failed (service, remote digest) pair as `quarantined`. Auto runs skip quarantined digests until
the tag moves to a different digest or an admin clears the quarantine. Notify once.

### RT-23: Policy precedence lets a service-level setting override `critical`
**Phase 2.** "Most specific wins" is ambiguous for safety flags. Project `critical: true` + service
`update_mode: auto`: if resolution is whole-policy or per-field "most specific", the service is auto-updated. The
interaction between `update_mode: auto`, `require_approval` (default true) and schedule `mode: auto` is also undefined
(three knobs, no truth table). **Change:** safety flags combine as **most restrictive across all levels**
(`critical` = OR, `require_approval` = OR, `auto_rollback` = AND). Other fields use most specific. Add a truth table to
7.3: an unattended deploy happens only if update_mode=auto ∧ schedule.mode=auto ∧ ¬require_approval ∧ ¬critical.

### RT-24: Cleanup can delete images and volumes of stacks that are only temporarily down
**Phase 2.** "Unused" = no container. A project that is `down` (normal during maintenance or for seasonal services)
has no containers, so its images are "unused" and its **named volumes** (its database) are "unused". Volume removal is
"report only *by default*", which implies it can be switched on. Standalone clones (RT-12) leave anonymous volumes that
look unused too. **Change:** v1 never deletes volumes in bulk or on a schedule. Volume removal is single-volume only,
with typed confirmation of the volume name, and refused while any discovered project (label or allow-listed file)
references it. Images referenced by any discovered project file are "referenced", not "unused". `quaymaster-staged/`
tags are protected like rollback tags. Scope filters candidates (RT-03).

### RT-25: Event stream: small replay buffer, exec spam
**Phase 1.** The daemon keeps only a small in-memory event buffer (moby keeps the last 256 events) and loses it on
restart, so `since` on reconnect is best effort. Missed `die`/`oom` events mean missed alerts. Verified on the reference
host: every healthcheck run emits `exec_create` + `exec_start` + `exec_die` (18 events per minute on this host from
healthchecks alone). With "persist every event", most rows are healthcheck noise and contain command lines (RT-04).
**Change:** after every reconnect, do a full inventory re-sync and synthesise state-change records from the diff
(e.g. "container X found exited (missed event)"). Persist an allow-list of actions (`create, start, die, oom, kill,
stop, destroy, health_status, rename, pull, delete, tag, untag`), drop `exec_*`, and write in batched transactions.

### RT-26: Resource budget on 2 cores
**Phase 1.**
- One-shot stats without `one-shot=true` make the daemon sample twice (about 1–2 s per container). With
  `one-shot=true` there is no `precpu`. **Change:** use `one-shot=true`, compute CPU % from Quaymaster's own previous
  sample, concurrency 2.
- `system df` walks every volume (du). On hosts with large volumes it takes minutes of I/O, and concurrent calls fail.
  **Change:** use the `type=` filter (`image`, `container`, `volume` separately), on demand plus at most every 6 h,
  never during a maintenance run, single-flight.
- better-sqlite3 is synchronous: a retention `DELETE` of 100k rows blocks the event loop, which stalls SSE and health
  timers. **Change:** batched deletes (≤ 5k rows per tick) and an idle-time prune.
- State a budget in the spec: idle CPU < 3 % of one core, RSS < 200 MiB. Measure it in phase 5.

### RT-27: SQLite: two instances, stale lock, backup, migrations
**Phase 1.**
- Native and container instances (or two containers during a botched upgrade) pointed at the same DB file run **two
  schedulers**. **Change:** take an exclusive `flock` on `/data/quaymaster.lock` at startup and exit if it is held.
- The "DB-backed lock" for runs must be released by the startup reconciliation (RT-14), or every future run stays
  blocked after a crash. Store `holder = instance id + pid + started_at`.
- Copying a WAL database while it runs gives an inconsistent backup. **Change:** document and expose backup via
  `VACUUM INTO`, take an automatic `VACUUM INTO /data/backup-pre-<version>.db` before applying migrations, and use
  forward-only migrations with a refusal to start on a DB newer than the binary.
- Set `busy_timeout`, `synchronous=NORMAL` and `foreign_keys=ON`, with a periodic `wal_checkpoint(TRUNCATE)`.

### RT-28: `up` starts stopped services; dangerous Compose flags not forbidden
**Phase 1–2.** `docker compose up -d <svc>` **starts** a service the operator deliberately stopped. An update run would
silently bring back a service that was off on purpose (a disabled updater, a paused bot). **Change:** a service
that was stopped (and is not a dependency being started on purpose) is updated with `up --no-start` and stays stopped;
the plan says so. The argv builder has a deny-list test: never `--remove-orphans`, `-v/--volumes`, `--rmi`, `--build`,
`--force-recreate` (except explicit redeploy), `--always-recreate-deps`. Use the `--flag=value` form for every
user-derived value, and `--` before service names.

### RT-29: Dependents are not re-verified after their dependency is recreated
**Phase 2.** Updating `db` (a dependency) with `--no-deps` restarts the DB under a running `app` whose connection pool
may not reconnect. The health gate checks only `db`, so the run succeeds while `app` returns 500s. **Change:** after
recreating any service, re-run the health gate for its direct dependents (they are already listed in Impact). If a
dependent fails: if `depends_on.restart: true` is declared, restart it; otherwise alert and stop the rollout.

### RT-30: Viewer role can read every container log
**Phase 1.** Application logs routinely contain secrets: bootstrap tokens, admin passwords printed on first start,
OAuth codes, connection strings in stack traces. Redaction (RT-04) is not applied to logs (and cannot be reliably).
"Viewer = read-only" therefore means "viewer reads secrets". **Change:** make log access a separate permission
(`logs:read`), default **off** for viewers, or apply known-value scrubbing (RT-04) to log streams and document the
residual risk. Decide explicitly.

---

## NOTE

- **RT-31 API version.** By default dockerode sends unversioned paths (the daemon uses its newest API). That works,
  but response shapes can change on a daemon upgrade. Negotiate explicitly: `GET /version` → use
  `min(daemon ApiVersion, max version Quaymaster is tested with)`, and refuse below the daemon's `MinAPIVersion`.
- **RT-32 containerd image store.** Docker 29 defaults to the containerd image store on fresh installs (the reference
  host uses overlay2). There, image IDs are index digests and multi-platform content may be partial. Rollback by
  image ID and the `RepoDigests` comparison need a test on both stores, or detection plus refusal of rollback-based
  automation on the store that is not supported.
- **RT-33 Compose version skew.** Container labels on the reference host show three different Compose versions
  (5.1.x, 5.3.x, 5.4.x; tools such as Dockge bundle their own), and five Compose containers lack the
  `com.docker.compose.image` label. Hash computation and recreate decisions can differ between versions. With RT-01 in
  place this shows up as drift (safe), but it can block every update. Show the bundled Compose version next to each
  project's label version, and document mounting the host's Compose plugin as an option.
- **RT-34 SSE through proxies.** Send `X-Accel-Buffering: no`, `Cache-Control: no-cache` and a comment heartbeat every
  15 s, or nginx-based proxies buffer the stream or time it out.
- **RT-35 `/healthz`.** Return only `{status}`: no version, no Docker reachability details (fingerprinting). A separate
  authenticated `/api/v1/system/health` gives the details.
- **RT-36 Audit details.** A failed-login audit entry must not store the raw username field: users type passwords
  into it. Store it only if it matches an existing user, otherwise a hash. "Append-only" holds at the API level only;
  say so, and set a retention period (default 365 d) so the table cannot grow without bound.
- **RT-37 Secret key.** Define "weak": a decoded length of at least 32 bytes from base64/hex, no passphrases. Use
  random 96-bit IVs, and authenticated data = `table:column:row id` so ciphertexts cannot be swapped between rows. Plan
  key rotation (a key ID prefix on the ciphertext).
- **RT-38 Exposure.** A root-equivalent UI behind a public reverse proxy with password-only auth is the most likely
  real compromise path. The spec and the README should say "do not expose to the internet; use a VPN, or proxy auth
  in front", and the spec should list TOTP for admins as v1.x.
- **RT-39 Other updaters.** Detect running containers of known auto-updaters (Watchtower, Ouroboros, Diun in update
  mode) and show a warning banner: their changes make Quaymaster's plans stale (RT-14).
- **RT-40 Discovery gaps.** A project that is `down` has no containers and does not appear in `compose ls`, so it is
  invisible unless `QM_STACK_PATHS` is scanned for compose files. Decide whether to scan; if yes, scan read-only with
  depth and file-count limits. Replicas (`deploy.replicas > 1`, `container-number`) must be handled everywhere a
  "service = one container" assumption sneaks in.
- **RT-41 Container deployment hardening.** The socket is root regardless. Mount stack roots `:ro` (Quaymaster never
  writes to them, and `--no-build` removes the build need). Run as a non-root UID with `group_add: <docker gid>`.
  State that a socket proxy is only meaningful in read-only mode, because write access to containers/create is root
  anyway.
- **RT-42 Phase plan.** Phase 4's red-team review comes after the UI. Ask for a short targeted review of the executor
  and rollback state machine at the end of phase 2 as well: that is where most MUST-FIX items above land, and it is the
  costliest code to rework.

---

## What survives

The attack does not touch the following; keep them:

- **No generic Engine-API proxy, no command-line route, no exec/terminal, no Compose editing in v1.** This removes the
  largest classes of attack surface. Most findings above are about where the design still trusts *data* (labels,
  files, tags), not about routes.
- **`execFile` with fixed argv templates.** With the `--flag=value` form and `--` (RT-28), argument injection is
  effectively closed. Identifiers validated against what Docker reports is the right principle; RT-03 only makes it
  an exact protocol.
- **Pull separate from deploy, dry run, persisted plans, one run at a time, `interrupted` instead of auto-resume.**
  These are the right primitives. RT-07, RT-09 and RT-14 tighten them; they do not replace them.
- **The honesty section (brief downtime, image-not-data rollback).** Keep it and extend it (RT-10 makes the
  data-rollback limit drive the defaults instead of only being displayed).
- **Default `notify` + approval; automation opt-in; `critical` never auto.** Correct defaults (fix the precedence
  ambiguity in RT-23).
- **First-run setup token instead of a default password; scrypt; hashed server-side sessions; encrypted secrets with
  an external key; no "reveal" API.** Sound. RT-16 to RT-19 are implementation details, not redesigns.
- **SQLite + croner + single process** fits a 2-core host, provided the event filtering and batching in RT-25/RT-26
  are done.

**Steelman of the opposite view.** "Most of this is over-engineering for a single-user home server; the operator owns
every Compose file and every container, so labels and files are trusted, and Dockge already does `pull && up`
without any of this." That is partly fair. Dockge does work for many people, and RT-31 to RT-42 can wait. But Dockge
runs `up` **when a human clicks**, with the human's shell environment and a human watching the result. Quaymaster's
selling point is that it does this **unattended at 03:00**, from a different environment, a different Compose
binary and possibly a different filesystem namespace. That is exactly when RT-01, RT-10, RT-11 and RT-14 turn "it
works when I click it" into "the database came up empty and the run said success". The trust argument fails on RT-02:
a container's image author is not the operator.

## Verdict

**Proceed with changes.** The architecture is sound in shape, and phase 1 can start once the phase-1 MUST-FIX items
(RT-01 hash-gate primitive, RT-02, RT-03, RT-04, RT-05, RT-11 warning, RT-12 recreate rules, RT-13 disk data source,
RT-15) are folded into the spec. The phase-2 MUST-FIX items (RT-06 to RT-10, RT-14) must be written into
`ARCHITECTURE.md` now so the phase-1 schema and module boundaries support them.

**Most important reason:** the spec assumes that re-running `docker compose up` from Quaymaster reproduces the running
deployment. It does not, and nothing in the workflow refuses to proceed when it doesn't. Make the per-service config
hash comparison (RT-01) a hard gate before any recreate; that single change converts the worst silent-failure modes
into a visible "blocked: drift" state.

---

## Evidence gathered (read-only commands on the reference host)

- `docker compose version` → v5.4.0. `docker compose config --help` lists `--hash`, `--no-interpolate`,
  `--no-path-resolution`, `--no-env-resolution`. `docker compose up --help` lists `--no-build`, `--no-start`, `--wait`
  and `--wait-timeout`.
- `docker info` → storage driver overlay2, cgroup version 2, Engine 29.7.2. `/proc/self/cgroup` on cgroup v2 has the
  single `0::/…` form (no container ID).
- Labels across all containers: no `--env-file`/profile label exists. Three Compose versions are recorded (5.1.x,
  5.3.x, 5.4.x). Five Compose containers lack `com.docker.compose.image`.
- `docker events --since 60s --until 0s` → 6 each of `exec_create`/`exec_start`/`exec_die` per minute (healthchecks).
  `Action` contains the exec command line. `Actor.Attributes` contains every container label.
- Node 22 `crypto.scryptSync` with N=2^17, r=8, p=1: default `maxmem` → `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`; with
  `maxmem` = 256 MiB → 731 ms per hash on this host (2 cores).

No Docker resources were created or modified. No `docker compose` command was run against any project directory.
