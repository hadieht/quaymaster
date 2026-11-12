# Operations

Backup, restore, upgrade, and recovery. Commands assume container mode with the container named `quaymaster` and the
data volume mounted at `/data` (the defaults of `deploy/docker-compose.yml`). For native mode, replace the `docker exec`
prefix with `sudo -u quaymaster env QM_DATA_DIR=/var/lib/quaymaster node /opt/quaymaster/server/dist/cli.js ...`.

## What state Quaymaster keeps

| What                                                                                                          | Where                                            | In a backup                                              |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| Users, sessions, policies, windows, schedules, runs, audit log, notification channels, registry logins, stats | SQLite `<QM_DATA_DIR>/quaymaster.db`             | yes                                                      |
| `QM_SECRET_KEY`                                                                                               | your `.env` / secret file                        | **no** - keep it separately                              |
| Your Compose files and volumes                                                                                | your stack directories                           | no - Quaymaster never writes them; back them up yourself |
| Rollback images                                                                                               | Docker image store, tags `quaymaster-rollback/*` | no                                                       |

## Backup

The CLI uses SQLite's online backup API on a read-only handle, so Quaymaster can keep running.

```bash
docker exec quaymaster node server/dist/cli.js backup /data/backup-$(date +%F).db
docker cp quaymaster:/data/backup-$(date +%F).db /path/to/backups/
```

- It refuses to overwrite an existing file, runs `integrity_check` on the result and prints the size.
- Native: `QM_DATA_DIR=/var/lib/quaymaster node server/dist/cli.js backup /var/backups/quaymaster-$(date +%F).db`.
- Verify any backup file: `node server/dist/cli.js check <file>` prints `integrity_check` and the schema version, and
  exits non-zero if the file is damaged.
- Store `QM_SECRET_KEY` with the backup, in a different place from the database. Without the key, stored notification
  and registry credentials cannot be decrypted (the rest of the data stays usable; re-enter the credentials).
- Before every schema migration Quaymaster also writes `backup-pre-vN.db` into the data directory.

Automate it with cron or a systemd timer on the host, for example daily with `docker exec` and a copy off the machine.
Quaymaster does not schedule its own backups, and does not delete old backup files.

## Restore

Stop Quaymaster first. The CLI checks the file, refuses to run while the instance lock is held, keeps the current
database as `quaymaster.db.before-restore-<timestamp>`, deletes stale `-wal`/`-shm` files and copies the backup in.

```bash
docker compose --env-file .env -f deploy/docker-compose.yml stop quaymaster
docker run --rm --user 10001 \
  -v quaymaster_quaymaster-data:/data -v "$PWD:/in:ro" quaymaster:dev \
  node server/dist/cli.js restore /in/backup-YYYY-MM-DD.db
docker compose --env-file .env -f deploy/docker-compose.yml start quaymaster
```

`quaymaster_quaymaster-data` is the volume name that Compose derives from the project name `quaymaster`; check with
`docker volume ls`. Use the same `QM_SECRET_KEY` as when the backup was taken. After restore, sessions from the backup
may still be valid; log in again and review Settings.

If the restored database is from a **newer** Quaymaster version than the one running, the server refuses to start;
use the newer image.

## Upgrading

Migrations are forward-only, run in a transaction at start-up, and are preceded by `backup-pre-vN.db`. A database written
by a newer version is refused.

```bash
docker exec quaymaster node server/dist/cli.js backup /data/pre-upgrade-$(date +%F).db     # 1. back up
git pull                                                                                    # 2. new code
docker build -t quaymaster:dev .                                                            # 3. new image
DOCKER_GID=$(stat -c %g /var/run/docker.sock) \
  docker compose --env-file .env -f deploy/docker-compose.yml up -d                         # 4. recreate; migrates on start
curl -fsS http://127.0.0.1:8787/healthz                                                     # 5. verify
```

Read the [CHANGELOG](../CHANGELOG.md) first for new or changed `QM_*` variables. Because unknown `QM_*` names are
rejected, a removed variable stops the server with a message that names it.

Do not upgrade while a maintenance run is active: check Maintenance → History, and let it finish. Stopping Quaymaster
during a run is handled (see below) but leaves the run `interrupted`.

**Downgrade:** stop the container, restore the pre-upgrade backup (see above) and start the previous image tag.

Quaymaster never updates itself and refuses to act on its own container, so this procedure is always manual.

## Recovery after a failed or interrupted update

Start in **Maintenance → History** and open the run. It shows the stored plan, every step with its output, the result
per service, and a **guidance** list with exact recovery commands where a run did not end cleanly.

### Run ended `rolled_back`

The update failed health checks and the previous image was restored and verified. Nothing to do except to read the
failing step's output and decide whether to try again later. The failed target digest is **quarantined**: unattended
runs skip it until the tag moves again or an admin clears the quarantine.

### Run ended `failed` or `partial` with a service left as is

This is the default for services with writable persistent mounts: auto-rollback is off because old code on migrated
data can be worse than a broken new version. The service is running (or not) on the new image, the remaining services
are `skipped`, and you got an alert. Choose:

1. **Fix forward** - read the logs of the service, fix the cause, and redeploy.
2. **Restore the recovery point** - on the run page choose **Restore previous version…**, type the project name to confirm. Quaymaster
   re-tags the recorded previous image IDs and redeploys those services in reverse order with the health gate
   (`POST /api/v1/maintenance/runs/:id/restore`). Restore the data from your own backup first if the new version
   migrated it.

### Run ended `interrupted`

Quaymaster (or the host) stopped in the middle of a run. At the next start the run is marked `interrupted`, never
resumed, and a critical `service.left_down` notification is sent for any service that is not running, with the exact
command to bring it back. Intended-but-unfinished steps are written ahead of time, so the guidance states whether
the image tag may have moved. Typical recovery:

```bash
cd <project directory>
docker compose --project-name <project> up -d --no-deps --pull never <service>
```

Use the commands from the run's guidance rather than this template: they contain the correct project directory and
file list. When you stop Quaymaster in a container, set `stop_grace_period` at least as long as your longest health
timeout (default drain is 120 s); otherwise Docker's 10 s `SIGKILL` can cut a run short.

### Run ended `blocked` / `blocked_drift`

Nothing was deployed. Compose files differ from the running containers (or free space is too low, or a validation
failed). The plan's drift section shows what differs. Resolve it, then plan again.

### Run ended `approval_stale`

The plan changed between approval and execution (a new image appeared, a container changed, a policy changed). It was
not executed. A new approval request was created; review and approve the new plan.

### A `run.conflict` alert (another tool changed the containers)

Quaymaster stops without rolling back when something else modifies the run's containers or images mid-run, and sends a
critical `run.conflict` alert. Inspect the state by hand before doing anything else.

### Standalone containers

A standalone update renames the old container to `<name>-qm-old-<epoch>`, stops it, and keeps it for
`QM_ROLLBACK_RETENTION_DAYS`. If the new container is bad: stop it, rename it aside, rename the old one back, and start
it. The run output records the old container's original restart policy (Quaymaster sets it to `no` on the kept copy).
This restore is manual.

### Rollback images and cleanup

Rollback images are tagged `quaymaster-rollback/<hash>:<run-id>` and protected for `QM_ROLLBACK_RETENTION_DAYS` (default 7).
Staged pulls use `quaymaster-staged/…`. List them with `docker images 'quaymaster-*'`. Expired rollback tags are an image-cleanup category
(preview first, see Images); once removed, the previous image can only be recovered from the registry.

## Lost admin access

0.1.0 has no password-reset command. If another admin exists, they can set a new password for you (Settings → Security).
If the only admin is locked out, you can restore a backup taken before the password changed, or, with Quaymaster
stopped, empty the users table so that the first-run flow (setup token or `QM_ADMIN_USER`) applies again:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml stop quaymaster
docker run --rm --user 10001 -v quaymaster_quaymaster-data:/data --entrypoint sqlite3 <image-with-sqlite3> \
  /data/quaymaster.db 'PRAGMA foreign_keys=ON; DELETE FROM users;'
```

This procedure was not exercised as part of the 0.1.0 test suite, and the Quaymaster image does not contain the
`sqlite3` tool; use the host's or another image's. It removes all users (and, by cascade, their sessions) but keeps audit
history, policies and schedules. Take a backup first. A proper recovery CLI is on the roadmap.

## Health and logs

- `GET /healthz` returns `{"status":"ok"}` without details; the container healthcheck uses it.
- Logs go to stdout/stderr as JSON; `QM_LOG_LEVEL=debug` adds detail. Secrets are scrubbed from log output.
- Settings → General shows the installation's read-only state, scope, stack paths and retention; the audit log (Logs & Events,
  admins) records every login, action and run.
