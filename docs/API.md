# Quaymaster HTTP API (phase 1)

Base path `/api/v1`. JSON in, JSON out. Types live in `shared/src/api.ts`.

**Auth:** session cookie (`qm_session`, or `__Host-qm_session` when `QM_COOKIE_SECURE=true`; `HttpOnly; SameSite=Strict`).
**State-changing requests** (anything except GET/HEAD) need `Origin` equal to a configured origin
(`QM_PUBLIC_ORIGIN`, default derived from host/port) and, once logged in, the header `X-QM-CSRF: <csrfToken>` returned by
login/setup/`auth/me`. **Roles:** `viewer` = read; `admin` = everything. Container logs need the separate `logs:read`
permission (admins always; viewers only when `logsRead` is granted — default off).

**Errors** always use `{ "error": { "code", "message", "details?" } }`. Codes: `validation` 400, `unauthorized` 401,
`forbidden`/`csrf`/`origin` 403, `not_found` 404, `conflict`, `read_only`, `out_of_scope`, `self_protected`,
`confirmation_required`, `blocked_drift`, `limited_capability`, `unsupported` 409, `rate_limited` 429 (with `Retry-After`),
`compose_failed` 422/502, `docker_unavailable` 503.

## Public

| Route              |                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`     | `{status:"ok"}` only (no details)                                                                                    |
| `GET /auth/status` | `{setupRequired, authenticated}`                                                                                     |
| `POST /auth/setup` | `{token, username, password}` → creates the first admin (one-time token from stderr / `<data>/setup-token`), logs in |
| `POST /auth/login` | `{username, password}` → `SessionInfo` + cookie                                                                      |

## Session and users

`POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/me`, `POST /auth/password {current,next}` (revokes other sessions).
Admin: `GET/POST /users`, `PATCH /users/:id {role?,logsRead?,disabled?}` (revokes that user's sessions and streams),
`POST /users/:id/password`, `DELETE /users/:id`. The last active admin cannot be demoted, disabled or deleted.

## System

`GET /system/mode` (read-only state, scope, self id, stack paths) · `GET /system/health` (details) · `GET /system/info`
(redacted `docker info`) · `GET /system/host` (CPU, load, memory, Docker-root free space) · `GET /system/df[?refresh=1]`
(per-type `system df`, cached, single-flight).

## Containers

`GET /containers` (summary incl. `capability` full|limited|standalone, `mutable`, `protectedReason`) ·
`GET /containers/:ref` (redacted inspect) · `GET /containers/:ref/logs?tail&since&timestamps` (needs `logs:read`) ·
`GET /containers/:ref/stats` (ring buffer) · `GET /containers/:ref/stats/history?minutes` (1-minute roll-ups) ·
`POST /containers/:ref/actions/:action` with `start|stop|restart|kill|pause|unpause|remove|recreate`.
Body (strict): `{confirm?, applyDrift?, confirmNamespaceProvider?, signal?, timeoutSeconds?}`. `remove` and `recreate`
require `confirm` = container name; `remove` never forces and never removes volumes. `recreate` works for Compose-managed
containers only (via Compose, hash-gated; returns `operationId`); standalone recreate returns `unsupported` (phase 2).
`:ref` is resolved to the full ID, the scope/read-only/self checks run on the inspected object, and the action is sent by ID.

## Compose

`GET /compose/projects` · `GET /compose/projects/:name` (services, dependency graph, namespace providers) ·
`GET …/graph` · `GET …/config` (redacted resolved config, full level only) · `GET …/validate` (`config --quiet`, unset
variables are errors, file references checked against `QM_STACK_PATHS`) ·
`POST /compose/projects/:name/actions/:action` with `up|stop|start|restart|down|pull|redeploy`, body
`{service?, forceRecreate?, confirm?, applyDrift?, confirmNamespaceProvider?}` → `202 {operationId}`.
`down` and `redeploy` with `forceRecreate` need `confirm` = project name; `down` never uses `-v`. Before any `up`/`redeploy`,
`compose config --hash` is compared with the running containers' `com.docker.compose.config-hash`; mismatch →
`409 blocked_drift` (with the redacted config of the drifted services) unless `applyDrift:true`. Recreating a service that
others share a namespace/volumes with needs `confirmNamespaceProvider:true`. Limited projects (files not trusted/readable)
only support `start|stop|restart` through the Engine API.

## Images, volumes, networks (read-only in phase 1)

`GET /images`, `GET /images/:ref`, `GET /volumes`, `GET /volumes/:name`, `GET /networks`, `GET /networks/:ref`.

## Events, audit, operations

`GET /events?limit&beforeId&container&project` (allow-listed actions only) · admin `GET /audit?limit&beforeId&action&actor`
(no write API) · `GET /operations`, `GET /operations/:id`.

## Streams (Server-Sent Events)

`GET /stream/events[?sinceId]` (`docker-event`) · `GET /stream/stats` (`snapshot`, `stats`) ·
`GET /stream/logs/:ref[?tail&timestamps]` (`log`; needs `logs:read`) · `GET /stream/operations/:id` (`output`, `status`).
Each stream is bound to the session (closed on logout/expiry/role or password change, re-validated every 60 s), limited per
session and in total, heartbeats every 15 s, and closed when the client cannot keep up. Final event: `end {reason}`.

# Phase 2 additions (updates, maintenance, notifications)

All under `/api/v1`; mutations need the admin role. Types are in `shared/src/maintenance.ts` and `shared/src/notifications.ts`.

**Updates & images:** `GET /updates` (cached states `up_to_date|update_available|update_staged|local_only|pinned_digest|unknown`) · `POST /updates/check` (fresh registry lookups) · `GET /updates/quarantine`, `POST /updates/quarantine/clear {target,digest?}` · `POST /images/pull {ref}` → `202 {operationId}` (pull by digest, staged; never restarts/retags) · `GET /images/staged` (staged images + rollback points) · `POST /images/cleanup/preview {categories?,minAgeHours?,labelFilter?}` → preview with `previewId`; `POST /images/cleanup/execute {previewId,confirm:previewId}` · `GET|PUT /registries/credentials`, `DELETE /registries/credentials/:host` (passwords encrypted, never returned).

**Maintenance:** `GET|PUT|DELETE /maintenance/policies[/:kind/:key]` (kind `global|project|service|container`; service key `project/service`), `GET /maintenance/policies/effective?project&service&container` · windows `GET|POST /maintenance/windows`, `PUT|DELETE /maintenance/windows/:id` · schedules `GET|POST /maintenance/schedules`, `PUT|DELETE …/:id` · `POST /maintenance/plan {project,services?,applyDrift?}` (dry run, stored, changes nothing) · `POST /maintenance/runs {project,services?,startNow?,confirm?,windowId?,ignoreWindow?}` · `GET /maintenance/runs[?status&target&limit]`, `GET /maintenance/runs/:id` (plan + persisted steps) · `POST /maintenance/runs/:id/approve {planHash}` (409 `approval_stale` if the plan changed), `POST …/reject`. · `POST /maintenance/standalone {container,confirm}` (standalone update by config clone, 202 with the run; manual only) · `POST /maintenance/runs/:id/restore {confirm,services?}` (one-click restore of the run's recovery points → `{operationId}`; `confirm` = the run's target).

**Monitors:** `GET|PUT /monitors/settings`. **Notifications:** `GET /notifications/types`, `GET|POST /notifications/channels`, `GET|PATCH|DELETE …/:id`, `POST …/:id/test`, `GET /notifications/deliveries`.

**SSE:** `GET /stream/maintenance` (`snapshot`, `run`), `GET /stream/operations/:id` (a run's id is its operation id: live output).
