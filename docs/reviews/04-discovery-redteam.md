# Red-team review 04: dynamic Compose discovery, the read-only helper and "stop monitoring"

Scope: the uncommitted work of t_dc2dc668 (backend) and t_86cf28a7 (web). That covers label-driven discovery,
`QM_STACK_AUTO_MOUNTS`, the read-only file helper container, the per-project `reasonDetails`/`fileAccess`/`mountHint`,
and the ignore list (`/ignored`, migration 3).

Method: I read the code first, then reproduced every finding on the real daemon with `qmtest-*` resources labelled
`quaymaster.test=true`. All instances were scoped to `qmtest-rt-*`. Containers were only created, never started, from
FROM-scratch images. Each regression test was run before the fix and the failure lines are quoted below.

- Regression suite: `server/test/integration/discovery-redteam.int.test.ts` (7 tests).
- Unit regressions: the `discovery red-team regressions` block in `server/test/unit/dynamic-discovery.test.ts`, plus
  the updated helper and `filesUnderDir` tests.

## Claim under test

> "Anyone who can create a container with forged labels already has root through the socket. What must not widen is
> what a Quaymaster user can read. … non-admins see exactly what they saw before." (DECISIONS ADR, SECURITY-MODEL)

The premise is false. Docker **copies image `LABEL`s into the container**. Whoever publishes an image therefore
controls `com.docker.compose.project.working_dir` and `config_files` for every plain `docker run <image>` / `docker
create <image>` a trusted operator does. The labels need no socket access. Test `precondition: a container inherits
forged Compose labels from its image` proves it on the real daemon.

## Summary

| ID     | Severity | Finding                                                                                                  | Status |
| ------ | -------- | -------------------------------------------------------------------------------------------------------- | ------ |
| RT4-01 | HIGH     | Forged (image) labels make the helper mount any host directory and return any `*.yaml` in it, to viewers | fixed  |
| RT4-02 | HIGH     | `.env` values (and compose files) go through the helper's stdout into the daemon's log driver            | fixed  |
| RT4-03 | HIGH     | YAML alias bomb: a 364-byte compose file expands to 10^8 values (13 MB / 36 s at 10^6); OOM at 10^8      | fixed  |
| RT4-04 | HIGH     | Ignoring an out-of-scope container silences the F-06 shared-tag fence (QM_MANAGED_SCOPE bypass)          | fixed  |
| RT4-05 | MEDIUM   | Viewers (GET) make Quaymaster create containers on the host; unbounded concurrency; no audit             | fixed  |
| RT4-06 | MEDIUM   | Sticky world-writable directories (`/tmp`) passed the helper's trust check                               | fixed  |
| RT4-07 | MEDIUM   | Visibility scope also hid shared-tag users from the fence (same mechanism as RT4-04)                     | fixed  |
| RT4-08 | LOW      | `GET /ignored` readable by viewers (spec: admin-only)                                                    | fixed  |
| RT4-09 | LOW      | Helper `status()` inspected the image on every discovery (3 s cache)                                     | fixed  |
| RT4-10 | LOW      | `QM_HELPER_LABELS` could overwrite the `quaymaster.helper` marker label                                  | fixed  |
| RT4-11 | LOW      | Symlinked bind source: the daemon follows a symlink in the label path; the lexical denylist cannot see it | open   |
| RT4-12 | LOW      | `QM_STACK_AUTO_MOUNTS` (default on) turns read-only and unrelated same-path mounts into full stack roots  | open   |
| RT4-13 | LOW      | Ignore matching: container entries by name only (a new container with that name is hidden too); project entries miss containers with conflicting labels | open   |
| RT4-14 | LOW      | Web disables "Stop monitoring" in read-only mode while the API allows it (inconsistent, harmless)        | open   |
| RT4-15 | LOW      | Full projects still have no world-writable/owner check on compose files (helper path now has one)        | open   |

No critical findings: no path makes Quaymaster execute anything from a forged label. Commands still need an allowed
root, and the helper only reads.

## Findings

### RT4-01 HIGH: forged labels → host file disclosure to viewers

**Mechanism.** `buildProjects` marked a project `fileAccess: 'helper'` whenever `validateLabelDir` accepted the label.
That check only refused `/`, `/proc`, `/sys` and `/dev`, so `/etc`, `/root`, `/home/x/.kube` and the Docker root all
passed. `filesUnderDir` also accepted **any `*.yml|yaml`** that `config_files` named. Three more gaps:

- `GET /compose/projects/:name/config` was open to viewers.
- The helper ran as the image's user, which is root for `QM_HELPER_IMAGE=node:*`.
- The parsed file was returned with key-name redaction only.

**Repro (before the fix).** An image with `LABEL com.docker.compose.project.working_dir=<dir>` and
`config_files=<dir>/cluster-admin.yaml` is `docker create`d with no `--label` flags. Then a **viewer** asks for the
config:

```
RT4-01 viewer 200 {"source":"files","config":{"cluster-admin.yaml":{"clusters":[{"server":"https://internal-cluster.example.invalid:6443"}]}},"warnings":[],"files":["cluster-admin.yaml",".env"],"envKeys":["API_TOKEN"]}
```

**Fix.**

- New `helperDirAllowed` refuses:
  - system prefixes: `/etc /boot /run /var/run /usr /bin /sbin /lib* /var/lib /var/log /var/spool /var/cache /var/tmp /tmp /snap`
  - top-level directories themselves: `/root /home /var /srv /opt /mnt /media /data`
  - any hidden path segment, such as `.ssh`, `.kube` or `.config`
  - the Docker data root, and the host source of Quaymaster's data directory (`helperDeniedDirs` in `context.ts`)

  It is applied in discovery, in `readViaHelper` and inside `FileHelper.read`.
- The helper reads **compose file names only** (`compose*.yml`, `docker-compose*.yaml`) and `.env*`. This is enforced
  in `filesUnderDir`, in the in-container script (argv filter) and again in `parseHelperOutput`. A label that names
  other files gets a warning, not a fallback to some other file in the directory.
- The helper runs with an explicit non-root `User`: Quaymaster's own uid:gid, or `65534:65534` when Quaymaster is
  root.
- Helper-backed views are admin-only (RT4-05).

After the fix the viewer gets 403, the admin gets `cluster-admin.yaml: not read (not a compose file name …)`, and the
hidden-dir project shows `fileAccess: none` and 409.

**Trade-off.** Projects started with `-f stack.yml` (a non-compose name) can no longer be *viewed* through the helper.
They still work fully through a mount or `QM_STACK_PATHS`.

### RT4-02 HIGH: `.env` values in the Docker log driver

**Mechanism.** The helper printed the full `.env` content to stdout. Quaymaster parsed out the keys, but stdout is
container logs: with a `journald`, `syslog`, `fluentd`, `gelf`, `awslogs` or `loki` default log driver, those secrets
leave the host log boundary. They also outlive `docker rm`. Some distributions' Docker packages default to journald. A
crash between create and remove also left them in the json log until the next sweep.

**Repro (before).** I intercepted the helper's removal and read `docker logs`:
`RT4-02 logContainsEnvValue=true logType=json-file user=10001:10001`.

**Fix.**

- The in-container script emits `keys` only for `.env*` files. Values never leave the helper process.
- `parseHelperOutput` drops `.env` content even if a modified image prints it.
- `LogConfig` is pinned to `json-file` (8 MiB, 1 file), so compose-file output is deleted with the container.
- `.env` values are no longer added to the global scrubber. They never reach Quaymaster, so that would only have grown
  the scrubber with attacker-chosen strings.

After: `RT4-02 logContainsEnvValue=false logType=json-file user=65534:65534`.

### RT4-03 HIGH: YAML alias bomb (DoS / OOM)

**Mechanism.** `js-yaml` 4 has no alias limit and keeps aliases as shared references, including cycles (`&a {b: *a}`
gives `d.a.b === d.a`). `learnSecrets` and `redactDeep` then walk and *copy* every reference. `docker compose config`
is protected by compose-go's alias limits, but the helper path is not. Who can trigger it:

- anyone who can write a compose file in a project directory;
- anyone who can point a label at such a directory (RT4-01);
- any admin page view.

**Repro (before).** A 6-level bomb (≈300 bytes) gave `expected 13135977 to be less than 20000` after 36 357 ms on one
request. Eight levels, still under 400 bytes, gives 10^8 values; JSON already fails with `Invalid string length` in a
standalone probe, so the server process would run out of memory. A crash during a maintenance run interrupts updates.

**Fix.** `withinNodeBudget(doc, 50 000)` counts values the way a recursive walk sees them, aliases counted per
reference, and stops early, so a cycle or bomb costs at most 50 000 steps. Documents over the budget are refused with
a warning. After: `RT4-03 200 bytes=164 ms=421`.

### RT4-04 HIGH: ignore list silences the managed-scope fence

**Mechanism.** The planner's F-06 check ("containers sharing the image tag are within the managed scope") iterated
`containers.listRaw()`, which now drops ignored containers. Ignoring is allowed for out-of-scope resources. So an
admin could:

1. ignore an out-of-scope container that uses tag T;
2. update an in-scope project on T;
3. watch the tag move under the out-of-scope container, which then runs the new image on its next recreate.

That bypasses `QM_MANAGED_SCOPE`, a server-side guarantee a UI admin is not supposed to be able to lift.

**Repro (before).** Plan with a stubbed registry status (dry run only, nothing pulled or tagged), before and after
ignoring `qmtest-oos-rtshare`:

```
before: {"ok":false,"detail":"qmtest-oos-rtshare use the same tag but are outside QM_MANAGED_SCOPE ..."}
after:  {"ok":true,"detail":"ok"}
```

**Fix.** A new `ContainerService.listDaemonAll()` lists every container, with neither the ignore list nor the
visibility scope applied. The planner computes both the fence and `impact.sharedTag` from it. Hidden containers are
counted, never named (see RT4-07). After: `after.ok=false` and the detail names the ignored container.

### RT4-05 MEDIUM: viewers create host containers; unbounded helpers; no audit

**Mechanism.** `GET …/config` is a read for a viewer, but on a helper project it creates, starts and removes a
container.

- There was no audit record.
- Helper concurrency was per project only, so N forged projects meant N parallel 128 MiB containers.
- Being a GET, a top-level cross-site navigation can trigger it too.

**Fix.**

- Helper-backed views need the `write` permission (403 otherwise).
- Each fresh (uncached) helper read writes the audit record `compose.files_read` (project, dir, files).
- A global semaphore allows at most 2 helper containers at a time. The unit test runs 6 parallel reads and sees at
  most 2 live containers.

### RT4-06 MEDIUM: sticky world-writable directory trusted

`readViaHelper` accepted a world-writable directory if the sticky bit was set (`/tmp`). The sticky bit only prevents
deleting other users' files. Any local user can still add a `compose.override.yaml`, which the helper discovers
automatically. **Fix:** any world-writable project directory is untrusted. `/tmp` and `/var/tmp` are also denied
outright (RT4-01).

### RT4-07 MEDIUM: visibility scope hides shared-tag users from the fence

This is the same mechanism as RT4-04, but for `QM_VISIBLE_SCOPE`. It existed before this feature, and it is the
pattern the cleanup review (RT3-03) warned about. The fix is the same as RT4-04: the fence counts invisible
containers, the plan says `N container(s) outside the visible scope` and never names them, and a warning is added.

### Low findings

- **RT4-08:** `GET /ignored` is now admin-only. The web "Ignored projects" tab is shown to admins only, like
  Registries.
- **RT4-09:** `FileHelper.status()` is cached for 15 s. `read()` re-checks read-only mode itself.
- **RT4-10:** the `quaymaster.helper=true` label is applied after `QM_HELPER_LABELS`, so configuration cannot
  overwrite it.
- **RT4-11 (open):** the denylist is lexical. If `/srv/app/data/x` is a symlink to `/etc`, made for example by a
  container with a writable bind mount, the daemon mounts `/etc`. What limits the impact: only compose file names and
  `.env` keys are read, as a non-root user, and only by admins. Full mitigation would need a host-side realpath, which
  Quaymaster cannot see. Documented.
- **RT4-12 (open):** `selfMountRoots` treats every same-path bind of Quaymaster's own container as a full stack root,
  including `:ro` and unrelated ones. That is admin-controlled deployment config, but broader than "stack
  directories". Suggestion: count only mounts listed in `QM_STACK_PATHS`, or require an explicit opt-in label.
- **RT4-13 (open):** container ignore entries match by name, so a future container with the same name is hidden too.
  Project entries match on (name, working dir), so containers with conflicting labels stay visible. Both are
  documented by forge as known limits; neither can mutate anything.
- **RT4-14 (open):** the web disables "Stop monitoring" in read-only mode; the server allows it. The UI is merely
  stricter.
- **RT4-15 (open, pre-existing):** full projects have no world-writable or owner check on compose files. Only the
  helper path has one now.

## What I confirmed holds

- **Ignore never touches Docker or files.** `IgnoreService` and `IgnoreList` make no Engine call and run no CLI; the
  only writes are SQLite rows. Forge's integration test checks that `StartedAt` is unchanged. Cleanup, image
  protection and volume/network ownership use `listRawAll`, `discoverAll` or direct daemon lists, so ignored resources
  never look unused. Restore works and is audited.
- **Ignore is admin-only, CSRF-protected and audited.** POST without the CSRF header returns 403 (RT4-05 test); a
  viewer POST returns 403. Typed-name confirmation is enforced server-side, and own-project self-protection holds.
- **The helper has no shell and no network.** It uses an argv array, `NetworkMode: none`, `CapDrop: ALL`,
  no-new-privileges, a read-only rootfs, pid and memory limits, a read-only bind via the Mounts API (no `:` parsing),
  a forced remove in `finally`, and a label+name sweep. Injection through names is blocked by `SEGMENT_RE`, the
  validated relative names and per-segment symlink refusal inside the container.
- **Read-only mode and managed scope still hold.** Read-only mode disables the helper. Projects outside the managed
  scope never get `fileAccess: helper`, and helper names are forced into the scope prefix.
- **Labels cannot widen local trust.** `PathPolicy` roots come only from env and Quaymaster's own inspect. A symlink
  that leaves a root is now reported as `untrusted`; the trust checks are not weaker than before.
- **Hardcoded host details.** Grepping code, tests, docs and deploy files found none. The only project-specific
  strings are the project's published image/repository name and generic example addresses (`192.168.1.50`).

## Web review (t_86cf28a7)

- **Wording.** The "Stop monitoring" dialog says it does **not** stop, remove or modify containers, volumes, networks
  or files, and never says delete/remove stack.
- **Confirmation.** It needs the typed name (`requireText={name}`), and the button stays disabled until the text
  matches. A web test covers this.
- **Admin-only controls.** The button is disabled for viewers; Restore is disabled for viewers; the tab is now hidden
  for them (RT4-08).
- **No secrets.** The file view shows only `envKeys` ("values are never shown").
- **Host strings.** None in the new files.
- **Viewer config view.** Viewers now get 403 for helper-backed config views (RT4-05). The page shows the API error
  message, which explains that an administrator is needed.

## Verification (real runs, after the fixes)

- `npm run typecheck`: pass. `npm run lint` (eslint + prettier): pass.
- Server unit tests: 306/306. Web tests: 28/28.
- `discovery-redteam.int.test.ts`: 7/7. `dynamic.int.test.ts`: 10/10.
- Full integration suite: see the task completion record. The fixture-based files need `alpine:latest` and
  `registry:2`, which are not cached on the dev host and must not be pulled.
- Afterwards there were no `qmtest-*` containers or `quaymaster.test=true` images left.
