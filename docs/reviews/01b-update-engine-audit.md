# Red-team review 01b — update engine (executor, rollback, scheduler, safety gates)

Reviewer: Rook (red team). Baseline: `docs/ARCHITECTURE.md` §13 (binding), `docs/reviews/01-architecture-redteam.md`,
`docs/DECISIONS.md`. Code audited at HEAD `edb41a6` (phase 2 complete). Code was not changed. The failing demonstrations are
in `server/test/integration/audit-01b.int.test.ts`. They are skipped unless `QM_AUDIT_DEMOS=1` is set.

All runs used only the `qmtest-*` fixtures (label `quaymaster.test=true`), the fixture registry on loopback, and a dev server
bound to `127.0.0.1` with `QM_MANAGED_SCOPE=qmtest-*`.

> **Status note.** At about 11:47 UTC the operator (atlas) paused all Docker testing on this host, because two real standalone
> containers owned by the host operator had disappeared. I stopped my in-flight full-suite rerun at once and ran no further Docker
> mutations. Cleanup is therefore **pending** (see "Not done"). I checked my own traces for that investigation
> (read-only): no `audit_log` or `events` row in any `.local/*/quaymaster.db` names either of those containers. Every recorded
> `destroy`/`rename`/`stop`/`kill` event concerns `qmtest-*` resources. My scripts and demos address only `qmtest-*` names.

## Claims under test

The claim is that the phase 2 engine implements the binding amendments RT-01, 02, 03, 06–14, 22–24, 28 and 29 so that an
unattended update can only:

- change the image,
- of in-scope, non-critical, eligible services,
- with a correct rollback point,
- and that a crash or shutdown is detected, reported truthfully and never resumed or repeated.

## Summary

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 5 |
| MEDIUM | 8 |
| LOW | 6 |

None of the attacks could:

- make a rollback point equal the new image,
- execute a stale approval,
- re-run a schedule occurrence after a real `kill -9`,
- roll back a stateful service *by default*,
- make cleanup remove a staged or rollback image.

Those gates hold. The weaknesses are in what happens **during** and **after** a run: the drift gate is checked only once,
crash reporting is wrong after the deploy step, shutdown does not stop the executor, and tag and scope handling leak
outside the run.

## Findings

### F-01 HIGH (RT-01): the drift gate is checked once at preflight, not before each service's recreate
- **Evidence:**
  - `server/src/maintenance/executor.ts:135-193`: the hash gate runs only in preflight/validate.
  - The per-service loop `executor.ts:282-332` and `deployOne` (`:484-495`) call `compose.deployServices` with no
    hash check.
  - `compose/service.ts:273-290` (`deployServices`) does guard checks only.
  - Demo `F-01` (`audit-01b.int.test.ts:142`) edits `worker`'s Compose file while `app` is in its health gate. The unattended
    run ends `completed`, approved by `schedule:audit-qmtest-upd`, and `worker` is recreated *with* the unreviewed
    `QM_AUDIT_DRIFT=privileged-change` env (`.local/audit-demos.log`).
- **Impact:** §13.1 says "before **any** Compose mutation that recreates a service". The scenario is a nightly auto run on a
  multi-service project during which a file changes (a git-pull cron, a sync tool, an editor save, or an attacker with write
  access to the stack dir). That run deploys arbitrary configuration (privileged, new mounts) without review. The window
  is minutes long, because it spans every earlier service's health gate.
- **Fix:** immediately before each `deployServices` (deploy, rollback and restore), run `config --hash` for that service. Compare
  it with the hash in the approved plan. On mismatch, stop with `blocked_drift`, skip the rest of the run and do not roll back.
  Add a regression test (un-skip F-01).

### F-02 HIGH (RT-14): a crash during the health gate is reported as "interrupted before any container was changed", with no left-down alert
- **Evidence:**
  - The intent is completed directly after the deploy step (`executor.ts:521`), before the health gate (`:523-567`) and
    before rollback/confirm.
  - `recover()` (`maintenance/service.ts:613-660`) only looks at *open* intents. With none open it writes
    `'The run was interrupted before any container was changed.'` (`:660`).
  - **Real `kill -9`** (`.local/audit-kill9.py`, dev server on 127.0.0.1:8791):
    ```
    KILLED -9 during ('app', 'health', 'running') run d43a6e18…
    after kill: app container running 2-unhealthy | user tag -> 2-unhealthy
    after restart: run interrupted | guidance: ["The run was interrupted before any container was changed."]
    audit interrupted params: [{"run": "d43a6e18…", "leftDown": false}]
    open intents: [('d43a6e18…', 'app', 'deploy', 1794387380170)]   # completed_at set before the kill
    final: app exited unhealthy 2-unhealthy | user tag -> 2-unhealthy
    ```
  - Demo `F-02` reproduces this in-process (`crash` hook during health; `app=exited/2-crash`, `leftDown=false`).
  - The existing crash test (`maintenance.int.test.ts:443`) crashes only at `deploy/start`, which is *before* anything
    changed, and asserts only `/interrupted/`. It would not catch this.
- **Impact:** the update is the most likely moment for a crash, and the health gate is the longest phase. A crash there
  leaves the service on a new, failing image with the user tag moved, and Quaymaster then tells the user nothing changed. No
  critical `service.left_down` alert is raised and no recovery command is shown. The same gap exists in the standalone path
  (`standalone.ts:171` opens the intent; it is completed after the swap, before the health gate).
- **Fix:** keep the intent open until the service outcome is final (healthy+confirmed, or rolled back and re-verified). Record
  the phase in the intent (`deploying` / `health` / `rolling_back`). In `recover()`, compare the live image with
  `fromImage`/`toImage` instead of trusting the intent alone, and always show the tag-restore and `compose up` command when
  the live image ≠ `fromImage`. Add a test that crashes during `health` and during `rollback`.

### F-03 HIGH (RT-14): graceful shutdown does not stop the executor from starting new services
- **Evidence:**
  - `context.ts:440-455` → `ops.drain(120_000)` (`operations/manager.ts:150-154`) only sets `shuttingDown` and waits.
  - The executor loop (`executor.ts:282-302`) has no shutdown or abort check.
  - After 120 s, `opened.close()` closes the DB under a running run.
  - Demo `F-03`: after the shutdown starts, `deploy` steps for `app` *and* `worker` still start; all three services end on
    `2-good`.
- **Impact:** in container mode, `docker stop` sends SIGKILL after 10 s by default. Every container restart or image update of
  Quaymaster itself during a run therefore becomes a kill mid-deploy, which is exactly the F-02 path. In native mode the run
  keeps changing services for up to 120 s and then loses its DB handle mid-step.
- **Fix:** pass an abort signal into `execute()`. Check it before each service (same place as the window check) and skip the
  remaining services as `interrupted_by_shutdown`. Never interrupt a running health/rollback step. Document
  `stop_grace_period` ≥ max health timeout in the deployment example. Test: begin shutdown during service 1 and assert
  that no deploy step starts for service 2.

### F-04 HIGH (RT-07): the Compose `pull` action moves the user-visible, host-global tag
- **Evidence:** `compose/service.ts:489-490` maps action `pull` to `docker compose pull`. Demo `F-04` (`.local/audit-demos2.log`):
  `tag 127.0.0.1:5055/qmtest-worker:latest: sha256:825ecf7c… (1-good) -> sha256:175a7f73… (2-good)`, while
  `qmtest-upd-worker-1` shares the tag and still runs 1-good.
- **Impact:** §13.7 says "pulls do not move tags". This is the one pull path that bypasses staging. After a "harmless" pull,
  the next `compose up` of *any* project that references that tag deploys the new version unreviewed. The planner's
  from/to view of other projects is then also wrong. The UI will expose this as a plain "Pull" button.
- **Fix:** remove `pull` from the Compose action set, or reimplement it as resolve-digest → `pullByDigest` → staged tag (as
  the executor does). Keep raw `compose pull` refused in `assertSafeArgv`. Un-skip F-04.

### F-05 HIGH (RT-12): the kept `-qm-old-` container retains its restart policy, so both containers start after a reboot on the same volumes
- **Evidence:** `maintenance/standalone.ts:203-218` stops and renames the old container but never updates `RestartPolicy`.
  The swap leaves an old container with `restart: always` holding the same named and anonymous volumes as the clone. Docker
  restarts `always` containers on daemon start even when they were stopped manually. I did not demonstrate this, because
  restarting the daemon is forbidden on this host. The mechanism is Docker's documented behaviour and is acknowledged in
  `DECISIONS.md` ("restart-policy caveat of RT-12 is open").
- **Impact:** after the next host reboot, two processes of a stateful app (a database, for example) run on one data
  directory. That is silent data corruption, and the user did nothing wrong.
- **Fix:** before the rename-aside, `container update --restart no` on the old container, and record the original policy in
  the rollback point so restore can put it back. Test: inspect `HostConfig.RestartPolicy` of the `-qm-old-` container.

### F-06 MEDIUM (RT-03): scope and protection are not applied to image-level side effects of runs and background jobs
- **Evidence:**
  - `docker/imageops.ts:69-170`: `pullByDigest`/`tag`/`remove` grant their own permits and call no `guard` scope or
    protected check. The transport still enforces read-only mode.
  - The executor moves the shared tag (`executor.ts:486`).
  - The scheduled `image_pull` job (`maintenance/service.ts:791-818`) iterates `updates.statuses()` over *all* images, with no
    scope filter.
  - Demo `F-05`, with scope `qmtest-upd*`: the run `completed` and moved a tag that out-of-scope `qmtest-oos-shared` uses
    (impact listed it, but nothing blocked). `PUT` policy on the out-of-scope container returned `200`. The background job
    staged `127.0.0.1:5055/qmtest-oos:latest`.
- **Impact:** a background job (not a route) mutates image state for resources the operator deliberately excluded,
  including the owner's other stacks when scope is used to fence them off. No container is recreated, so this is not HIGH,
  but it breaks the premise of RT-03 that scope is enforced below the routes.
- **Fix:** filter `image_pull` candidates to images whose every user is in scope. Refuse (unattended) or require an explicit
  confirmation (manual) when the impact contains an out-of-scope or protected container sharing the tag. Validate policy
  targets against scope.

### F-07 MEDIUM (RT-11/RT-23): unattended eligibility ignores namespace dependents
- **Evidence:**
  - `maintenance/service.ts:409-412`: `unattended = … plan.services.filter(s => s.role === 'update').every(s => s.unattended.eligible)`.
  - Dependents (`role: 'dependent'`) are recreated with `--force-recreate` (`executor.ts:493`), but their own
    `critical`/`requireApproval` flags are never consulted.
  - Demo `F-06` did **not** reproduce the full scenario: the run was stopped earlier by an unrelated drift on the fixture
    (`consumer`). The finding rests on the code path alone. The demo test currently passes and should be reworked before it
    is un-skipped.
- **Impact:** marking a service `critical` does not protect it from being recreated unattended when its namespace provider
  is updated.
- **Fix:** compute eligibility over every service the plan recreates, dependents included, and test it.

### F-08 MEDIUM (RT-07/RT-14): a failed update without rollback, a deploy failure, or a crash between tag and `up` leaves the user tag moved
- **Evidence:** the tag is moved in `executor.ts:486`. The `failed_left_as_is` branch (`:594-600`) and the deploy-failure path
  do not restore it. `recover()` prints a `docker tag` command only for services that are *down*.
- **Impact:** the next manual `compose up` deploys the failing image again. This interacts with F-02.
- **Fix:** whenever the service did not end `updated`, re-tag `fromImageId` → repoTag. For the "left as is" case, say so
  explicitly in the guidance.

### F-09 MEDIUM (RT-10): a project- or global-level `autoRollback: true` silently enables rollback for stateful services
- **Evidence:** `maintenance/policy.ts:69-75` and `:119-131`: an explicit `true` at any level wins over the
  persistent-mount default. My kill-9 harness set `autoRollback: true` on the project and `db` would have been rolled back.
  This is documented in DECISIONS ("an explicit policy value wins"), and the *default* is correct (unit test
  `maintenance.test.ts:168`).
- **Impact:** one convenience toggle on a project re-enables the exact failure RT-10 is about: old code on migrated data.
- **Fix:** an explicit `true` overrides the stateful default only at service level. At broader levels, apply it to stateless
  services only, and show this in the effective-policy view.

### F-10 MEDIUM (RT-29/RT-03): the dependent restart bypasses the guard
- **Evidence:** `executor.ts:788-794`, `restartContainer` calls `withPermit` directly without `guard.assertContainer`. The route
  path (`docker/containers.ts:~250-272`) checks it first. Errors are swallowed (`.catch(() => undefined)`).
- **Impact:** in practice the dependent is in the same project, which `assertProject` checked, so this is a latent bypass and
  not currently exploitable. It also violates AGENTS.md ("every mutation through the service layer"), and a failed restart
  is invisible.
- **Fix:** route the call through `ContainerService`, and record the failure in the step detail.

### F-11 MEDIUM (RT-14): standalone crash recovery uses Compose lookups
- **Evidence:** `recover()` (`service.ts:619-646`) always uses `compose.projectContainers(run.target)` and prints a
  `docker compose … up` command. For a `standalone_clone` intent (`standalone.ts:171`) the target is a container, so `live`
  is empty, the result is always "NOT running", and the guidance is wrong. Found by code reading only; not executed.
- **Impact:** after a crash mid-swap, the user gets a false alert and a command that cannot work. The real state (old
  container renamed `-qm-old-`, clone under a temporary name) is not explained.
- **Fix:** branch on `intent.action`. For standalone, inspect by `containerIdsBefore` and the clone ID (record it in the
  intent), and print the exact rename/start commands.

### F-12 MEDIUM (RT-09): no tests for the scheduler's claim, missed-run or tick logic
- **Evidence:** `grep` in `server/test` finds no test of `occurrences.claim`, `skipped_missed` or `tick()` beyond the
  critical-target scenario. `time.test.ts` covers only DST and cron arithmetic. The behaviour **is** correct today: the
  real kill-9 restart produced
  `occurrences: [(08:56,'started',d43a6e18), (09:56,'skipped_missed',None), (10:56,'skipped_missed',None)]`, no second
  run for 08:56, and the run `interrupted`, never resumed.
- **Impact:** RT-09 is the guarantee against double-running a deploy. Without a test, one refactor of `tick()` can silently
  break it.
- **Fix:** unit tests with the injected clock for these cases:
  - a claimed occurrence is never fired again;
  - a crash between claim and `started` leaves it `claimed` and never fires it;
  - several missed occurrences give at most one run, the latest, and only inside its window.

### F-13 MEDIUM (RT-14): one-click restore has no intents, no drift gate and no conflict check
- **Evidence:** `executor.ts:372-445`: tag, then `deployServices`, for each point, with no `addIntent`, no hash check and no
  `assertNoConflict`. Lines 383-386 are a duplicated guard (cosmetic).
- **Impact:** a crash during restore is invisible to `recover()`, and restore applies any Compose drift (as in F-01).
- **Fix:** use the same intent and drift/conflict machinery as `deployOne`.

### LOW
- **L-1 (RT-09):** `nextOccurrences(…, 50, now)` (`service.ts:723`). After more than 50 missed occurrences, the "latest" is
  the 50th from the cursor, not the real latest. A stale occurrence can then fire in an open window.
- **L-2 (RT-14):** runs in status `approved` at crash time are not touched by `interruptRunning()`
  (`db/maintenance.ts:505-511`). They stay `approved` forever.
- **L-3 (RT-22):** quarantine is added only on a health-gate failure path that has a `toDigest`. A `compose up` failure is
  quarantined too (`executor.ts:581`), which also quarantines an image for a failure that a config problem caused.
- **L-4 (RT-10):** one-shot detection relies only on `service_completed_successfully` edges. A one-shot without such an edge
  is gated as a long-running service and is rolled back after it exits 0.
- **L-5 (RT-13):** when the compressed layer sizes are unknown, the disk check falls back to the floor alone
  (`planner.ts:541-548`), so 2.5× the download is not enforced.
- **L-6 (RT-06):** the recovery point takes `live[0].ImageID` (`executor.ts:213`). With replicas on mixed images, only the first
  is checked against `fromImageId`.

## Attempted attacks that failed (what survives)

| Attack | Result |
|---|---|
| Rollback point equals new image | **Held.** The point comes from the running container's `ImageID` and is asserted against `fromImageId`, else `approval_stale` (`executor.ts:206-236`). The image is asserted after deploy and after rollback (unit test `maintenance.test.ts:221`). |
| Execute a stale approval | **Held.** Plan-hash check at preflight and validate (`executor.ts:136, 184`), new approval request; tests `executor.test.ts:273`, `maintenance.int.test.ts` "approval…stale". |
| Double-run an occurrence after kill -9 | **Held** (real kill -9, see F-12). Not covered by tests. |
| Roll back a stateful service by default | **Held** (default off; unit test). Overridable broadly, see F-09. |
| Cleanup removes staged/rollback image | **Held** (`maintenance.int.test.ts` cleanup scenario passes). |
| Drifted service recreated by an auto run (drift present at plan time) | **Held** (`blocked_drift`; `actions.int.test.ts` RT-01). Mid-run drift is **not** held, see F-01. |
| Pull through the executor moves tag before deploy | **Held** (staged by digest, tag only in deploy). The Compose `pull` action is **not** held, see F-04. |
| Concurrent tool changes containers mid-run | **Held** (`assertNoConflict`, `executor.test.ts:284`). |
| Out-of-scope or self container recreated via background job | **Held** for containers (`deployServices` guard). Image side effects leak, see F-06. |

## RT status table

| RT | Status | Test that would fail on regression | Notes |
|---|---|---|---|
| RT-01 | **partially** | `actions.int` drift gate (plan-time only) | F-01 mid-run drift; F-13 restore |
| RT-02 | verified (by reading) | phase 1 path-policy tests | executor uses `targetOf(…, true)`; no new gaps found |
| RT-03 | **partially** | phase 1 guard tests | F-06, F-10 |
| RT-06 | verified | `maintenance.test.ts:35,221`, `executor.test.ts:198` | L-6 |
| RT-07 | **partially** | `updates.int` standalone pull / dry run | F-04, F-08 |
| RT-08 | verified | `executor.test.ts:273`, `maintenance.int` approval | — |
| RT-09 | verified, **untested** | none for claim/missed | F-12, L-1 |
| RT-10 | verified (default) | `maintenance.test.ts:118,168` | F-09, L-4 |
| RT-11 | **partially** | `maintenance.test.ts:82`, `actions.int` RT-11 | F-07 |
| RT-12 | **partially** | `standalone.int.test.ts:114,153` | F-05; F-11 |
| RT-13 | verified (fail-closed) | phase 1 disk test, `maintenance.int` pull failure | L-5 |
| RT-14 | **partially** | `maintenance.int:443` (crash only at deploy start), `executor.test.ts:284` | F-02, F-03, F-11, F-13, L-2 |
| RT-22 | verified | `maintenance.int` rollback scenario | L-3 |
| RT-23 | **partially** | `maintenance.test.ts:138,151` | F-07 |
| RT-24 | verified | `maintenance.int` cleanup scenario | — |
| RT-28 | verified | `--no-start` used for stopped services (`executor.ts:493`); phase 1 argv tests | — |
| RT-29 | verified, weak | none dedicated | F-10 |

## Test-suite results (real)

- Full `npm test`, run 1 (09:36 UTC): **16 files, 244 tests: 243 passed, 1 failed.** The failure was
  `updates.int.test.ts:77` "dry run changes nothing", where the image tag list differed before and after. It is probably
  order-dependent: leftover `quaymaster-rollback/*` / `quaymaster-staged/*` tags from earlier runs. Phase 2 reported 244/244,
  and its handoff mentions another flaky scenario in `maintenance.int.test.ts`. The suite is therefore not reliably green.
- Full `npm test`, run 2: **aborted** at the operator's pause (no result).
- Full `npm test`, run 3 (after the pause was lifted, all `qmtest-*` fixtures cleaned first): **17 files (16 passed, 1 skipped),
  250 tests: 244 passed, 0 failed, 6 skipped** (the 6 skipped are the audit demos), in 628 s, exit 0. The run 1 failure did not
  recur. Together with phase 2's flake, this supports the reading that the suite is order- and leftover-sensitive, not broken.
  Separately, `redaction.int.test.ts` has no fixture teardown (`afterAll` only closes the app, lines 26-28). After a green
  run, `qmtest-secrets-leaky-1` is left running, which breaks AGENTS.md rule 6 (LOW, test hygiene).
- Audit demos (`QM_AUDIT_DEMOS=1`): F-01, F-02, F-03 and F-05 fail as intended (evidence above). F-04 failed as intended in
  the second run; in the first run the registry had nothing newer to pull. F-06 passes, which means it did not reproduce
  (see F-07). With the flag unset, all 6 are skipped.
- No test in the suite is marked skipped or todo apart from these 6 demos.
- `npm run typecheck`: 0 errors (web workspace is a placeholder). No source code was changed; the demo test file is formatted with prettier.

## Not done

- Nothing from the audit plan remains. After the pause was lifted, `upd-down.sh`, `registry-down.sh` and `down.sh` were run.
  Afterwards no container, image, volume or network labelled `quaymaster.test=true` (or named `qmtest-*`) was left,
  and no dev server was running.
- F-06 was not reproduced (see F-07). The real Docker Hub and GHCR registries were not contacted. The scheduler was exercised
  through the kill -9 / restart harness and `tick()`, not through a long-running real timer.

## Verdict

**Proceed with changes.** The approval, rollback-point, scheduler-idempotency and cleanup gates hold under attack. Before the UI
puts a "run update" button on top of the engine, fix F-01 to F-03 (they are one theme: the run is only safe at its start and
lies about its own state after a crash or shutdown). Also fix F-04 and F-05, which can each change or corrupt services the
user never chose to update.

## Phase 2c resolution (finding → status)

Fixed in phase 2c (task t_84b27f76). Commit subjects are in `git log`; tests named below are the regression tests.

| Finding | Status | Fix / regression test |
|---|---|---|
| F-01 (HIGH) | **fixed** — `fix(executor): per-service drift gate …` | `config --hash` re-checked right before every recreate; mismatch or unverifiable hash stops the run (`blocked`/`partial`), no rollback, critical alert. Also gates rollback and restore (`checkDrift`). `executor.test.ts` F-01 (3 tests + rollback test), `audit-01b.int` F-01 |
| F-02 (HIGH) | **fixed** — same commit + `fix(standalone,recover)` | deploy intent stays open until the service outcome is final; `recover()` compares the live image with `fromImage`/`toImage`, prints tag-restore + compose commands, raises `service.left_down` or an "unverified" warning. Standalone path likewise. `recover.test.ts`, `executor.test.ts` F-02, `audit-01b.int` F-02 |
| F-03 (HIGH) | **fixed** | `OperationContext.shuttingDown`; executor skips remaining services (`partial`/`skipped`) once shutdown began, never interrupts a running health/rollback step. `executor.test.ts` F-03, `audit-01b.int` F-03. `stop_grace_period` guidance: see DECISIONS |
| F-04 (HIGH) | **fixed** — `fix(compose): remove the Compose pull action` | `pull` removed from actions/argv builder; `assertSafeArgv` refuses `pull` and other unneeded subcommands. `core.test.ts`, `actions.int` (400), `audit-01b.int` F-04 |
| F-05 (HIGH) | **fixed** | kept `-qm-old-` container gets `RestartPolicy=no` (new narrow permit `container_restart_policy`), original policy restored on undo and printed in the result. `core.test.ts` F-05 (permit). **Not executed against a real daemon restart** (forbidden); `standalone.int` still green is required, see report |
| F-06 (MED) | **fixed** | planner preflight refuses when a container sharing the tag is out of scope/protected; `image_pull` job filters to in-scope images; policy PUT validates the target against scope; standalone `prepare` refuses likewise. `audit-01b.int` F-05 |
| F-07 (MED) | **fixed (code), integration not reproduced** | dependents count for unattended eligibility (planner computes blockers for them, service checks every service). The fixture scenario is still stopped earlier by an unrelated drift (see F-06 demo output), so only the code path is verified, not an end-to-end test |
| F-08 (MED) | **fixed** | shared tag is put back on `fromImageId` when an update does not stick (deploy failure, left as is); guidance says so; crash case printed by `recover()`. `executor.test.ts` F-08 |
| F-09 (MED) | **fixed** | project/global `autoRollback:true` applies to stateless services only; service/container level may override. `maintenance.test.ts` F-09 |
| F-10 (MED) | **fixed** | dependent restart goes through `ContainerService.act` (guard, audit); failures recorded in the step detail. `executor.test.ts` F-10 |
| F-11 (MED) | **fixed** | `recover()` branches on `standalone_clone`: inspects by id/name, prints rename/start commands. `recover.test.ts` F-11 (not executed with a real crash of a standalone swap) |
| F-12 (MED) | **fixed** | `scheduler.test.ts`: claim idempotency, claimed-never-fires, missed → at most one in a window, no window → none, 1800-occurrence backlog, start failure |
| F-13 (MED) | **fixed** | restore uses intents, drift gate and the `services` filter (which was silently ignored before); orphan restore intents reported at startup. `executor.test.ts` F-13, `recover.test.ts` |
| L-1 | **fixed** | full backlog scan in chunks (`scheduler.test.ts`) |
| L-2 | **fixed** | `approved` runs interrupted at startup (`recover.test.ts`) |
| L-3 | **fixed** | only health-gate failures are quarantined (`executor.test.ts`) |
| L-4 | deferred | one-shot detection beyond `service_completed_successfully` needs a product decision (restart policy heuristics); see DECISIONS |
| L-5 | deferred | unknown compressed sizes: floor-only check remains (fails closed only when free space is unknown); see DECISIONS |
| L-6 | **fixed** | recovery point checks every replica (`executor.test.ts`) |
| extra LOW (redaction test teardown) | deferred | test hygiene only; see DECISIONS |
