# Maintenance guide

Task-oriented instructions for the **Maintenance** section: policies, windows, schedules, plans, approvals, runs and
rollback. The tabs are Overview, Schedules, Plan an update, Approvals, History and Policies. Everything here can also be
done through the [API](API.md). Only admins can change anything; viewers can look.

## Concepts in one minute

- **Target.** A Compose project (optionally a subset of its services) or one standalone container.
- **Policy.** Per-target rules: whether and how it may be updated. Set at global, project, service or container level;
  the most specific level wins, but safety flags combine restrictively (see below).
- **Window.** Days and hours in a time zone during which update steps may _start_.
- **Schedule.** A cron expression in a time zone that creates a job: `image_check`, `image_pull`, `update` or
  `cleanup_report`.
- **Plan.** A dry run for a target: what would change, in which order, with what risk. A plan changes nothing.
- **Run.** One execution, with a stored plan and persisted steps. Statuses: `planned`, `awaiting_approval`, `approved`,
  `running`, `completed`, `failed`, `partial`, `rolled_back`, `skipped`, `interrupted`, `approval_stale`, `blocked`,
  `rejected`.

Defaults are conservative: update mode `notify`, approval required, nothing automatic.

## Task: see what has updates

1. Images → check for updates (or wait: checks are cached for `QM_CHECK_TTL_MINUTES`, default 6 h, and a schedule can
   run them).
2. States: `update_available` (the tag moved in the registry), `update_staged` (pulled, not deployed), `up_to_date`,
   `local_only` (built locally, no registry), `pinned_digest`, `unknown` (the reason is shown).

Detection compares your local digest with the registry's current digest for the same tag. It does not tell you that a
newer _version tag_ exists.

## Task: preview an update (dry run)

1. Maintenance → **Plan an update**, choose the project (and optionally services).
2. Read the plan:
   - **Preflight** checks (state of services, free disk space).
   - **Validation** (`docker compose config`) and **drift**: services whose running config differs from your files.
   - **Order**: dependencies first; dependents that share a network namespace or `volumes_from` are recreated with
     their provider.
   - Per service: downtime note, whether auto-rollback applies and why, **data risk** (writable persistent mounts),
     critical flag, health check method, and whether it is eligible for unattended runs (with blockers).
   - **Impact**: dependents and every other container on the host using the same tag.
   - **Excluded** services (`build:` services, digest-pinned images) with the reason.
3. Nothing was pulled or restarted. The plan is stored in History as a `planned` run.

## Task: run an update by hand

1. Plan it (above). If the plan is `blocked`, fix the stated cause first.
2. **Prepare run for approval…** and confirm. With approval required (the default) the run goes to `awaiting_approval`.
3. Approvals tab: review, then **Approve** or **Reject**. The approval is tied to the plan's hash. If the plan changed
   in the meantime, the run ends `approval_stale`, nothing is executed and a fresh request appears.
4. Watch the live step output on the run page. The ten steps are described in the
   [README](../README.md#safe-update-workflow).

If drift was detected, a manual run needs an extra, explicit confirmation ("apply drift") that shows a redacted diff;
a redeploy would apply those unrelated edits too. Automatic runs never do this: they stop with `blocked_drift`.

While a run is active on a project, manual container and Compose actions on that project are refused (409).

## Task: set policies

Maintenance → **Policies**. Fields (all optional; unset means inherit):

| Field                       | Values                                                                                             | Meaning                                                                                                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update mode                 | `ignore`, `notify` (default), `pull_only`, `auto`                                                  | `ignore`: no checks acted on. `notify`: tell me. `pull_only`: stage the image, never deploy. `auto`: may be deployed unattended (if every other condition holds). |
| Critical                    | on/off                                                                                             | Never updated automatically, whatever the schedule says. Always needs per-run approval.                                                                           |
| Require approval            | on/off (default on)                                                                                | A human approves each plan.                                                                                                                                       |
| Auto rollback               | on/off                                                                                             | See below.                                                                                                                                                        |
| Health                      | timeout (default 60 s), stabilisation (default 15 s), optional HTTP probe `{url, expected status}` | The gate that decides success.                                                                                                                                    |
| Max parallel / update order | numbers                                                                                            | Parallel is fixed to 1 in 0.1.0; order is only a tie-break inside the dependency order.                                                                           |

Levels: `global`, `project`, `service` (key `project/service`), `container` (standalone name). Most specific wins for
update mode and health. **Safety flags combine restrictively across levels:** `critical` and `require_approval` are ON if
any level says so; auto-rollback is OFF if any level says off.

**Unattended deploy** requires all of: update mode `auto`, schedule mode `auto`, approval not required, not critical.
Standalone containers are never updated unattended.

**Health gate.** With a healthcheck, Quaymaster waits for `healthy`; the effective timeout is raised to at least the
healthcheck's own start period plus interval times retries plus 30 s. Without one, the container must stay running with
a stable restart count for the stabilisation period. One-shot services (those other services wait on with
`service_completed_successfully`) succeed on exit code 0. An HTTP probe is tested when you save the policy: if it does
not pass against the current version, it is refused, so a probe can never make a healthy service look broken.

**Auto-rollback defaults.** On for stateless services; **off for services with writable persistent mounts**, because
the old image may not start on migrated data. A project- or global-level `true` does not switch it on for stateful
services; set it explicitly on the service. An explicit `false` anywhere always wins.

## Task: create a maintenance window

Maintenance → Schedules (the "Maintenance windows" card on that tab): name, days of the week, start and end time in 24 h `HH:MM`, and an
IANA time zone such as `Europe/Berlin`.

- `end` earlier than `start` means the window crosses midnight; the listed day is the day it **starts**.
  `start == end` is rejected.
- Update steps only _start_ inside the window. If the window closes mid-run, no further service starts and the run ends
  `partial` with the rest `skipped`. A service already being deployed still finishes its health check and rollback.
- Daylight-saving rules are pinned by tests for Europe/Berlin and Australia/Sydney.

## Task: schedule jobs

Maintenance → **Schedules** → new schedule: name, cron (five fields), time zone, job type, target, mode, optional window.
The form previews the next run times.

| Job type         | Does                                            | Target                                              |
| ---------------- | ----------------------------------------------- | --------------------------------------------------- |
| `image_check`    | Registry lookups; notifies when updates exist   | host-wide                                           |
| `image_pull`     | Stages new images (never deploys)               | host-wide, only images whose every user is in scope |
| `update`         | Plans (and runs, if allowed) an update          | one project or one container                        |
| `cleanup_report` | Report of what a cleanup would remove; notifies | host-wide                                           |

- **Mode `manual`:** produce a plan and wait for approval. **Mode `auto`:** run if the policy allows (see unattended
  conditions). A schedule on a standalone container cannot be `auto`.
- One schedule targets one project or container. Create several for several targets.
- Each occurrence is claimed exactly once, even across restarts. If Quaymaster was down at the time, an `update`
  occurrence runs once at start-up only if a window is set and currently open; otherwise it is recorded as
  `skipped` (missed). Other job types run once.
- Only one maintenance run executes at a time.

### Worked example

Nightly check, weekly planned update with approval (the `media` project from the README):

1. Policy for project `media`: update mode `notify`, approval required, health timeout 120 s.
2. Window `sunday-night`: Sunday 02:00-05:00, `Europe/Berlin`.
3. Schedule `nightly-check`: `image_check`, `0 2 * * *`.
4. Schedule `media-weekly`: `update`, project `media`, `0 3 * * 0`, mode `manual`, window `sunday-night`.

Result: Sunday 03:00 a plan is created and an `maintenance.awaiting_approval` notification is sent. You approve in the UI;
the run starts if the window is open. After several clean weeks, you may set the project's update mode to `auto` and
approval off, and the schedule to `auto`, to make it fully unattended. Keep `critical` on for anything you never
want touched without you present (databases, the reverse proxy).

## Task: handle approvals

- Approvals tab lists pending requests with the plan, risks, and an expiry (`QM_APPROVAL_EXPIRY_HOURS`, default 72).
  Expired requests become `skipped`.
- A notification `maintenance.awaiting_approval` is sent when one appears (if a channel subscribes to it).
- Approve or reject is audited with your name. A plan hash ties approval to exactly what you reviewed.

## Task: roll back

**Automatic.** When a service fails its health gate and auto-rollback applies, Quaymaster re-tags the previous image ID
(taken from the running container before the update), redeploys the service, asserts the image ID and re-verifies
health. The run ends `rolled_back`. Remaining services are skipped.

**Manual / one click.** In History open the run and use **Restore previous version…**: type the project name to
confirm. Quaymaster re-tags the recorded previous images and redeploys those services in reverse order with the health
gate. Available for Compose runs while the rollback images are within `QM_ROLLBACK_RETENTION_DAYS`.

**Limits.** Rollback restores the _image_, not the _data_. If the new version migrated a volume or database, the old
image may refuse to start; restore your own data backup first. Compose on a single host also means a short downtime for
each rollback. If anything else (another tool, you at a terminal) changes the run's containers mid-run, Quaymaster
aborts without rolling back and raises a critical alert. See
[OPERATIONS.md](OPERATIONS.md#recovery-after-a-failed-or-interrupted-update).

## Task: update a standalone container

Containers without Compose labels are updated by cloning their configuration. Manual only, and **API only in 0.1.0**
(the web UI has no button for it):

1. `POST /api/v1/maintenance/standalone` with `{"container": "<name>", "confirm": "<name>"}` (admin session and CSRF
   header, see [API.md](API.md)). It returns `202` with the run.
2. Quaymaster creates a stopped clone with only what differs from the old image's own config (environment, command,
   entrypoint, working dir, user, labels, healthcheck, exposed ports), re-attaches all mounts including anonymous
   volumes and all networks, stops the old container, renames it `<name>-qm-old-<epoch>`, renames the clone, starts it
   and health-gates it.
3. On any failure the clone is removed and the old container restored.

The old container stays stopped for `QM_ROLLBACK_RETENTION_DAYS` as the recovery point. Refused for containers using
`container:` network mode or `--rm`, and for Compose-managed containers. Best-effort: review the result.

## Task: clean up images

Images → cleanup. Choose categories (dangling images, unused images, expired rollback tags), age and optional label
filter, then **Preview**. Execute needs the preview ID within 10 minutes and a typed confirmation. Each item is
re-checked at execution. Never removed: images used by any container, referenced by a Compose project, rollback or
staged tags within retention, anything younger than `QM_CLEANUP_MIN_AGE_HOURS`, anything out of scope. Volumes and
networks are reported, never deleted.

## Task: stop a failing update from repeating

A target and remote digest that failed once is **quarantined**: unattended runs skip it until the tag moves to a new
digest. Admins can clear it with `POST /api/v1/updates/quarantine/clear` (`{target, digest?}`) after fixing the cause.

## Notifications for maintenance

Subscribe a channel to `maintenance.upcoming`, `maintenance.awaiting_approval`, `run.succeeded`, `run.failed`,
`run.rolled_back`, `run.partial`, `run.skipped`, `run.interrupted`, `run.conflict`, `service.left_down` and
`updates.available`. See the [README](../README.md#notification-channels) for channel setup.
