# Red-team review (03): removal of images, networks and volumes

**Reviewer:** rook (red team) · **Date:** 2026-11-12 · **Code reviewed:** uncommitted working tree on top of `31f7e5d`
(forge task t_45c82623: `StorageCleanupService`, `/storage/cleanup/*`, `/volumes|networks|images/:ref/remove`,
`measureReclaim`, `StorageRemoval.tsx`, and the changes to `CleanupService`).

## Claim under test

"Unused images, networks and volumes can be removed one by one or in bulk. Nothing that is in use, that belongs to a
Compose project that still exists, that is Quaymaster's own, or that is outside `QM_MANAGED_SCOPE` / blocked by
`QM_READ_ONLY` can be removed. Bulk removal runs only on a server-stored preview and checks everything again at execute
time. The freed space reported is measured."

## Method

- I read the diff (`git diff`, plus the new files) against `docs/ARCHITECTURE.md` 7.6 and `docs/DECISIONS.md`
  "Storage cleanup".
- **Real-daemon reproduction:** `server/test/integration/storage-redteam.int.test.ts` (new, 7 tests). It only uses
  `qmtest-rt-*` / `qmtest-zz-rt*` resources labelled `quaymaster.test=true`. The instances are scoped to `qmtest-rt-*`;
  one of them also sets `QM_VISIBLE_SCOPE=qmtest-rt-vis-*`. There is no prune. `afterAll` removes everything and checks
  that the set of non-`qmtest` volumes is unchanged.
  **Before the fixes, 5 of the 7 tests failed.** The failures were the RT3-01 to RT3-05 reproductions below; the
  CSRF/auth and injection probes passed. After the fixes, 7/7 pass.
- **Host census (read-only `docker` CLI, nothing modified):** the development host had 11 Compose-labelled volumes that no
  container used and whose project had no containers left (stopped stacks, mostly databases and model caches). These are
  exactly the volumes RT3-01 exposed.
- A throwaway unit probe of `measureReclaim` was run once and then deleted. It became `server/test/unit/reclaim.test.ts`.

## Summary

| Severity | Count | Fixed in this change            |
| -------- | ----- | ------------------------------- |
| CRITICAL | 0     | –                               |
| HIGH     | 2     | 2 (RT3-01, RT3-03)              |
| MEDIUM   | 5     | 5 (RT3-02, -04, -05, -06, -07)  |
| LOW      | 7     | 1 (part of RT3-L5); 6 open      |

No path deletes a volume that a container (running or stopped) uses. No path deletes Quaymaster's own volume, network or
image, or works around read-only mode, CSRF or authentication. The two HIGH findings are about what "unused" and
"Compose project still exists" mean, not about the hard guards.

---

## HIGH

### RT3-01: "Compose project not discovered" was treated as "Compose project deleted": a stopped stack's database was offered without the Compose opt-in

**Mechanism.** `volumeRefusal()` asked for the Compose opt-in only when the volume's project label was in
`own.projects` or the resolved config declared the volume. `own.projects` comes from `compose.discover()`, which
only knows projects that:

- have containers (`docker compose down` removes them all), or
- appear in `docker compose ls` (which also needs containers), or
- sit under `QM_STACK_PATHS`.

It is also filtered by `QM_VISIBLE_SCOPE`, and `runner.ls()` silently returns `[]` when the compose CLI fails. So
take a stack whose directory lives anywhere else, for example `/home/user/myapp`. After `docker compose down`, its
database volume carried `com.docker.compose.project=myapp` and was offered as an ordinary
"Named unused volume". The only safeguard left was the typed phrase `delete N volumes`, which confirms a count, not a
name.

**Evidence.**

- RT3-01 (pre-fix): a volume with exactly Compose's labels (`project=qmtest-rt-ghost`, `volume=db`, `version`) and no
  project directory under `QM_STACK_PATHS` appeared in `candidates` of a `named_volumes` preview with
  `includeComposeProjectVolumes` absent (`expected [ 'qmtest-rt-hidvol', … ] to not include 'qmtest-rt-ghost_db'`).
- Single removal without `acknowledgeComposeProject` was accepted as well.
- The development host census found 11 such volumes.

The docs and the UI promised the opposite: the UI checkbox said "Include volumes of Compose projects *that still exist
on disk*", which implies that everything else is gone.

**Fix (done).**

- Any volume that carries a Compose project label now needs the explicit Compose opt-in (bulk) or the acknowledgement
  (single) when its project is not discovered. The reason reads: "…which Quaymaster cannot find (no containers, not
  under QM_STACK_PATHS); it may still exist on disk".
- The UI checkbox label now says the same thing.
- Unit tests were updated. The old test asserted the unsafe behaviour (`old_vol` of `deleted-project` offered without
  opt-in). New unit tests cover single and bulk, and integration test RT3-01 covers the real daemon.

**Residual risk.** A volume created by plain `docker run -v name:/x` has no labels, so nothing can tell whether
someone still wants it. It stays removable after the named-volume opt-in and the typed phrase. That is by design
(DECISIONS) and acceptable.

### RT3-03: Image cleanup saw an image used only by an invisible container as unused, and execute untagged it until Docker refused

**Mechanism.** `CleanupService.preview()` and `execute()` built the in-use set from `containers.listRaw()`.
`listRaw()` is **filtered by `QM_VISIBLE_SCOPE`**. With a visible scope configured, an image used only by containers
outside it looked unused. Execute then ran `for (t of RepoTags) remove(t)`:

- Docker untags every tag except the last one.
- Docker refuses the last tag with 409 because a container uses the image.

This feature added a one-click "All unused images" button to that dialog.

**Evidence.** RT3-03 (pre-fix): image `qmtest-rt-vis-img` (tags `:1` and `:2`) was used by the stopped container
`qmtest-rt-hidden`, which is outside the visible scope. After preview and execute: `{ tag1: false, tag2: true }`. The
in-use image lost a tag.

**Impact.** The container keeps running on the image ID. But the next `docker compose up` or recreate for that tag
re-pulls it, which silently upgrades `:latest`. A locally built image keeps only an arbitrary surviving tag. This
contradicts "images used by any container (running or stopped) are never removed".

**Fix (done).** Preview, execute and the report-only volume/network counts now read
`docker.listContainers({ all: true })` unfiltered. The visible list is still used for the `stopped_containers`
category, because invisible containers must not be removable. `removeImage()` already used the unfiltered list.

---

## MEDIUM

### RT3-02: `QM_VISIBLE_SCOPE` bypass: the storage preview listed (and single removal accepted) volumes and networks outside it

**Mechanism.** `StorageCleanupService` listed every volume and network on the daemon. `VolumeService.list` and
`NetworkService.list` hide resources outside the visible scope; the storage preview did not. With a narrow visible
scope, the preview's `protected` list leaked every other volume name on the host. RT3-02 pre-fix: 38 names outside
`qmtest-rt-vis-*`, real user volumes included. When the managed scope was broader than the visible scope,
`/volumes/<invisible>/remove` worked too.

**Fix (done).** The preview skips volumes and networks that are not visible (by name or by Compose project, the
inventory rule). Single removal of an invisible volume or network returns 404, as if it did not exist. Covered by unit
and integration tests.

**Still open, adjacent and pre-existing:** the *image* cleanup preview also lists images outside the visible scope (it
calls `listImages` unfiltered). Apply the inventory filter at `cleanup.ts` preview (`RepoTags` base name) the same way.

### RT3-04: Image cleanup execute did not repeat the scope or Compose checks: a tag added after the preview, outside `QM_MANAGED_SCOPE`, was deleted

**Mechanism.** Execute re-read `RepoTags` and removed **all current tags**. It re-checked only "in use" and
"internal tag". It did not repeat `scopeProblem()`, the Compose reference check or the rollback-ID check, although
ARCHITECTURE 7.6 says execute skips anything that "left the scope".

**Evidence.** RT3-04 (pre-fix): preview `qmtest-rt-tt:1` (in scope), then `docker tag qmtest-rt-tt:1
qmtest-zz-rtout:1` (outside the instance scope), then execute. `qmtest-zz-rtout:1` was gone.

**Fix (done).** Execute recomputes, per image, the scope check (with the preview's stored `labelFilter`), the Compose
references and the active rollback IDs. Any hit skips the image with a reason (`now … is outside QM_MANAGED_SCOPE`).

### RT3-05: Untag protection compared raw strings: the tag a container was created from could be removed

**Mechanism.** `removeImage(..., {tag})` refused only when `container.Image === tag`. `docker run nginx` stores
`Image="nginx"`, but the tag is `nginx:latest`, and `docker.io/library/nginx:latest` is the same reference too.

**Evidence.** RT3-05 (pre-fix): container `qmtest-rt-shortc` was created from `qmtest-rt-short`. Untagging
`qmtest-rt-short:latest` returned 200 `untagged`.

**Impact.** The next recreate of that container re-pulls (or, for a local build, fails). The same thing can happen to
Quaymaster's own multi-tag image, which carries `:0.1.0` and `:latest` on this host.

**Fix (done).** References are compared normalised (`cacheKey(parseImageRef())`), with an exact-string fallback.
Integration test RT3-05 covers it.

### RT3-06: The "Reclaimed" number credited host-wide changes to the run

**Mechanism.** `measureReclaim()` reported `before − after` of `/system/df` (layers + volumes) as `reclaimedBytes`
with `basis: 'df'`. The UI shows it without a qualifier. Anything else that ran meanwhile counted: another prune, a
volume removed by hand, a pull, a growing database volume.

**Evidence (unit probe):**

- 0 items removed while 3 GB was pruned elsewhere: `{"reclaimedBytes":3000000000,"basis":"df"}`.
- 500 MB removed while a 2 GB pull finished: `reclaimedBytes: 0`.

**Fix (done).**

- Every call site now passes `maxBytes`, the most the run can have freed: the volumes' `UsageData` from the *before*
  snapshot, the full image size, 0 for an untag or an empty run.
- The headline is capped at `maxBytes`.
- A new `caveat` field (shown in `ReclaimSummary`) explains when the headline was capped, or when it is lower than
  the estimate because usage grew meanwhile.
- Covered by `server/test/unit/reclaim.test.ts` (4 tests).

**Still imperfect:** a low reading is flagged, not corrected. Concurrent growth cannot be told apart from what was freed
without per-item measurement.

### RT3-07: The bulk dialog executed a stale preview after the options changed; the typed phrase named only a count

**Mechanism.** In `StorageCleanupDialog`, changing a checkbox or the minimum age after **Preview** left the old
candidate list and the "Remove N item(s)…" button on screen. That button executed the *old* preview.

Scenario: preview with "Include Compose volumes", see the list, untick the box and click Remove. The Compose volumes
are deleted. The confirmation `delete 3 volumes` does not mention them, and the confirm dialog did not list names.

**Fix (done).**

- Any option change discards the preview and closes the confirm dialog.
- The confirm dialog lists every volume to be deleted, with its Compose project.
- Web test RT3-07. I checked that it fails when the reset is removed.

---

## LOW (open unless noted)

- **RT3-L1: previews are unbounded and expensive.** Every `POST /storage/cleanup/preview` stores an entry (purged only
  on expiry) and runs an uncached `/system/df`. An admin script, or a compromised admin session, can pile them up.
  **Fix:** cap the stored previews per actor (for example 5, oldest evicted) and rate-limit the route. *Code-read.*
- **RT3-L2: previews are bound to a username, not a session.** A user deleted and recreated under the same name
  inherits open previews (10-minute window). **Fix:** bind to the session ID or the user ID.
- **RT3-L3: single image removal can leave a half-untagged image.** `removeImage` removes tags one by one. If a
  container is created between the check and the last tag, Docker refuses that tag after the others are gone. The
  audit record says `failure` but not which tags went. **Fix:** record the removed tags in the failure audit and return
  them in the error details.
- **RT3-L4: image deletion has no typed confirmation, and "whole image" is the default radio option for multi-tag
  images.** A locally built image cannot be re-pulled. **Fix:** default to untagging the selected tag, and require
  the tag or short ID to be typed for a whole-image delete of an image that has no `RepoDigests` (that is, a local
  build).
- **RT3-L5: audit gaps.**
  - 400 (`isSafeRef`) and 404 refusals of the removal routes are not audited.
  - The preview audit omits `minAgeHours`, although a preview with `minAgeHours: 0` is what makes young volumes
    removable.
  - Untagging an *expired* rollback/staged tag did not release its DB record, leaving a dangling rollback point.
    *Fixed:* `rollback.release` / `staged.delete` now also run on the untag path.
- **RT3-L6: network TOCTOU window.** Between `networkUsers()` and `DELETE /networks/<id>`, a container created with
  `--network` but not started has no endpoint, so Docker allows the delete. The window is a few milliseconds and the
  damage is recoverable (`docker network create`). Accept it, or re-list right before the delete.
- **RT3-L7: an unnamed volume from `docker volume create` (64-hex name, no labels) counts as "anonymous".** Docker 29
  marks real anonymous volumes with `com.docker.volume.anonymous` (all such volumes on this host have it). **Fix:**
  prefer that label when present and fall back to the hex-name heuristic.

---

## What survives the attack (verified)

- **In use means in use.** Volume and network users come from `listContainers({ all: true })`, unfiltered, and
  stopped containers count (mounts, `NetworkSettings` keys, `HostConfig.NetworkMode`). The Engine call is never forced,
  so Docker refuses an in-use volume as a second line of defence. The forge integration test (stopped holder) and its
  TOCTOU test pass against the real daemon.
- **Quaymaster's own resources.** Own volumes and networks are refused through `self.volumes` / `self.networks`. The
  own image is refused because the own container uses it (a whole-image delete) and, after RT3-05, because untagging
  compares references normalised.
- **Read-only and scope.** `QM_READ_ONLY` is enforced in the service before anything else, on every route including
  bulk execute (unit), and again at the transport (`checkEngineRequest`). `QM_MANAGED_SCOPE` checks name and project
  for volumes and networks, and every tag for images. Hash-named volumes cannot be attributed to a scope and are never
  removable under one.
- **Preview token.** UUID, server-side, 10-minute TTL. Bound to its creator (403 for another user). Single use:
  `get → checks → delete` contains no `await`, so two concurrent executes cannot both run it. Execute accepts no
  candidate list. Volumes are re-inspected (`CreatedAt` comparison catches a recreated volume) and networks are
  re-inspected by full ID.
- **Injection.** No CLI is involved: dockerode over the socket. Names must match `SAFE_NAME_RE` / `SAFE_REF_RE` (first
  character alphanumeric, no `/`, `?`, `%`, `..` segments). The `-rf`, `..`, `%2e%2e%2f…`, `a%3Fforce%3Dtrue`,
  `a%2Fb`, `' x'`, `a/../../version` and `tag: '-f'` probes were all rejected with 400/404 before Docker was called
  (integration test). The transport permits bind the exact name/ID and refuse `force`.
- **CSRF and auth.** Every route is under the API scope with `requirePerm('write')` (admin). The integration test showed
  no session → 401/403, foreign Origin → 403, missing `X-QM-CSRF` → 403.
- **Build-cache cleanup was rightly not built.** `/build/prune` cannot be label-filtered.

## Steelman of the original design

Treating an undiscovered project as gone is what `docker volume prune -a` does, and Quaymaster still asks for two
deliberate opt-ins plus a typed phrase. That argument is not enough here. The UI explicitly promised to keep "Compose
projects that still exist on disk", the phrase confirms a count, and on this very host 11 stopped-stack volumes would
have been listed as ordinary unused volumes. A data-loss feature must fail closed on "unknown". The fix costs the owner
one extra checkbox that already exists.

## Verdict

**Proceed with the changes made here.** The single most important reason: before RT3-01, a stopped Compose stack's
database outside `QM_STACK_PATHS` was one generic, count-only confirmation away from permanent deletion. That is now
behind the explicit Compose opt-in, and the confirmation lists every volume by name.

## Results after the fixes (real output, 2026-11-12)

- `npm run typecheck` exited 0. `npm run lint` (eslint plus prettier --check) exited 0.
- Server unit tests: 18 files, 258 passed. This includes the new `reclaim.test.ts` and the RT3-01/RT3-02 unit tests.
- Web tests: 5 files, 22 passed. This includes RT3-07; I checked that it fails when the fix is reverted.
- Integration tests (`vitest run test/integration`): 5 files passed and 8 failed (39 passed, 17 failed, 40 skipped).
  - Passed: `storage-cleanup` 11/11, `storage-redteam` 7/7, `audit-02`, `webui` and `notifications`.
  - The 8 failing files all fail in fixture setup. Their base images are not on this host: `No such image:
    alpine:latest` (fixture `up.sh`) and `No such image: registry:2` (`upd-up.sh`).
  - I did not pull them, because AGENTS.md rule 1 allows creating only `qmtest-*` resources. This is the same
    pre-existing condition forge reported.
- Clean-up: `test-fixtures/scripts/down.sh all` and `upd-down.sh` removed the 1 volume and 3 networks the failed
  fixture setups had left behind. Afterwards 0 containers, 0 volumes and 0 networks labelled
  `quaymaster.test=true` remain. No non-`qmtest` resource was touched (the `afterAll` check passed).
