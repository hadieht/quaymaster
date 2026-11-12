# Configuration reference

Quaymaster is configured **only** through environment variables. Container mode: put them in `.env` (read by
`deploy/docker-compose.yml`). Native mode: `/etc/quaymaster.env`.

Start-up validation is strict:

- Unknown `QM_*` names are rejected, so a typo cannot silently disable a safety setting.
- Invalid values stop the server with a list of problems. Messages name variables but never print values.
- Booleans accept `true`/`false`, `1`/`0`, `yes`/`no`. Lists are comma-separated.

## Network

| Variable | Default | Notes |
| --- | --- | --- |
| `QM_HOST` | `127.0.0.1` | Bind address. In the container image it is `0.0.0.0`; then the published port decides who can connect (`DEPLOY_BIND`). |
| `QM_PORT` | `8787` | 1-65535. |
| `QM_PUBLIC_ORIGIN` | derived from host and port | Exact origin(s) of the UI as the browser sees them, comma-separated. Must be bare origins (`https://qm.example.org`, no path). State-changing requests whose `Origin` header does not match are rejected. |
| `QM_TRUST_PROXY` | empty | IPs or CIDRs of reverse proxies whose `X-Forwarded-For` is trusted for the client IP. Required behind a proxy (rate limiting and audit use the client IP). `true`, `*`, `0.0.0.0/0` are rejected. |
| `QM_COOKIE_SECURE` | `false` | `true` when served over HTTPS: `Secure` cookie, `__Host-` prefix, `Strict-Transport-Security`. With `true` the UI will not work over plain HTTP. |

## Storage and secrets

| Variable | Default | Notes |
| --- | --- | --- |
| `QM_DATA_DIR` | `./data` | Holds `quaymaster.db` (+ `-wal`/`-shm`), `quaymaster.lock`, `setup-token`, and `backup-pre-vN.db` files written before schema migrations. |
| `QM_SECRET_KEY` | none | **Required** unless `QM_SECRET_KEY_FILE` is set. At least 32 random bytes as hex or base64 (`gen-secret` or `openssl rand -base64 32`). Passphrases and low-entropy keys are rejected. Encrypts notification and registry credentials; losing it makes those unreadable. Changing it is not supported in 0.1.0 without re-entering all credentials. |
| `QM_SECRET_KEY_FILE` | none | File with the key (used when `QM_SECRET_KEY` is empty). Suited to Docker/systemd secrets. |

## First admin

Applied only while the user table is empty. See [INSTALL.md](INSTALL.md#first-admin-two-options).

| Variable | Notes |
| --- | --- |
| `QM_ADMIN_USER` | Required if either password variable is set, and vice versa. |
| `QM_ADMIN_PASSWORD_HASH` | `scrypt$N$r$p$salt$hash`, from `cli hash-password`. Single-quote it in `.env`. |
| `QM_ADMIN_PASSWORD_FILE` | Path to a file with a plain password (at least 12 characters), hashed at first start. Set only one of the two. |

## Docker and Compose

| Variable | Default | Notes |
| --- | --- | --- |
| `QM_DOCKER_SOCKET` | `/var/run/docker.sock` | Unix socket path, or `tcp://host:port` for a socket proxy. |
| `QM_DOCKER_BIN` | `docker` | CLI used for `docker compose`. |
| `QM_STACK_PATHS` | none | **Required.** Absolute directories. Compose files are trusted only if their real path (after resolving symlinks) is below one of them and not below the Docker data root. This also applies to `env_file`, `secrets`, `configs` files and includes. Labels on containers are treated as untrusted. In container mode each directory must be mounted at the same absolute path. A bounded read-only scan (depth 3, 500 directories, no symlinks followed) lists projects that are currently down. |
| `QM_DOCKER_ROOT_MOUNT` | none | A directory on the Docker root's filesystem, read-only. Used only for free-space (`statfs`) checks before pulls and updates. Without it (and without a readable Docker root), pull and update preflight fails closed. |

## Safety

| Variable | Default | Notes |
| --- | --- | --- |
| `QM_READ_ONLY` | `false` | No mutating Docker or Compose action is possible; enforced in the transport layer, not just in routes. Quaymaster also forces read-only if it is in a container and cannot identify itself. |
| `QM_MANAGED_SCOPE` | empty | Name globs (`media-*,web`) of projects/containers that may be mutated. Empty means everything. Actions on anything else are refused with `out_of_scope`. Includes resources an in-scope project references. |
| `QM_VISIBLE_SCOPE` | empty | Read-side filter: resources whose names do not match are hidden from every API response. Independent of `QM_MANAGED_SCOPE`; meant for demos and screenshots. |
| `QM_PROTECTED` | empty | Names that are never mutated. List the reverse proxy and socket proxy. |
| `QM_SELF_CONTAINER` | auto | Name or ID of Quaymaster's container. Auto-detected from `/proc/self/mountinfo`, cgroup, hostname. Quaymaster protects its own container, project, networks and volumes. |
| `QM_REDACT_ALL_ENV` | `false` | Mask every environment value in API output. |

## Sessions and streams

| Variable | Default | Range |
| --- | --- | --- |
| `QM_SESSION_IDLE_MINUTES` | `30` | 1-1440 |
| `QM_SESSION_ABSOLUTE_HOURS` | `12` | 1-720 |
| `QM_SSE_MAX_PER_SESSION` | `8` | 1-100 |
| `QM_SSE_MAX_TOTAL` | `32` | 1-1000 |
| `QM_LOG_FOLLOW_BYTES_PER_SEC` | `524288` | 1024-104857600 |
| `QM_SCRYPT_LOG2_N` | `17` | 10-20; values below 14 are accepted only with `NODE_ENV=test`. Raise only if hashing is fast enough on your hardware. |

## Monitoring and retention

| Variable | Default | Range / notes |
| --- | --- | --- |
| `QM_STATS_INTERVAL_SECONDS` | `10` | 2-3600 |
| `QM_STATS_RETENTION_HOURS` | `48` | 1-720 |
| `QM_EVENT_RETENTION_DAYS` | `14` | 1-365 |
| `QM_AUDIT_RETENTION_DAYS` | `365` | 30-3650. The audit table refuses to delete rows younger than 30 days. |
| `QM_DISK_FLOOR_BYTES` | `5368709120` (5 GiB) | Free space on the Docker root that must remain after pulls. The plan also requires 2.5x the compressed layer size plus the larger of this floor and 10% of the filesystem. |
| `QM_DF_MIN_INTERVAL_SECONDS` | `21600` | `docker system df` is expensive; refreshed at most this often unless an admin forces it. 60-604800. |

Thresholds for alerts (disk, CPU, memory, restart loops, upcoming maintenance) are not environment variables: they
are monitor settings stored in the database (`GET/PUT /api/v1/monitors/settings`). Defaults: disk free below 10% or
5 GiB, CPU and memory above 90% sustained for 300 s, 5 restarts within 300 s, maintenance notice 60 minutes ahead.

## Updates and cleanup

| Variable | Default | Notes |
| --- | --- | --- |
| `QM_REGISTRY_INSECURE` | empty | Hosts allowed over plain HTTP (a local registry). Credentials are otherwise sent only over HTTPS or loopback. |
| `QM_CHECK_TTL_MINUTES` | `360` | How long a registry answer is cached (1-10080). |
| `QM_ROLLBACK_RETENTION_DAYS` | `7` | How long `quaymaster-rollback/*` images and kept old containers are protected from cleanup (0-365). |
| `QM_CLEANUP_MIN_AGE_HOURS` | `24` | Cleanup never touches images or containers younger than this. |
| `QM_APPROVAL_EXPIRY_HOURS` | `72` | Pending approvals expire into `skipped` after this. (`.env.example` still shows 48; the code default is 72.) |

## Process

| Variable | Default | Notes |
| --- | --- | --- |
| `QM_LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `QM_DISABLE_BACKGROUND` | `false` | Skips the event watcher, stats sampler and housekeeping. Diagnostics only; monitors and live data stop working. |
| `QM_WEB_DIR` | built-in | Directory with the web bundle. The image and the unit set up the default; change only for custom layouts. |

## Compose deployment variables

Read by `deploy/docker-compose.yml`, not by Quaymaster (Quaymaster would reject them if named `QM_*`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `DOCKER_GID` | none, required | Group ID of the Docker socket: `stat -c %g /var/run/docker.sock`. |
| `DEPLOY_BIND` | `127.0.0.1` | Host address the port is published on. |
| `DEPLOY_PORT` | `8787` | Host port. |
| `DEPLOY_STACKS_DIR` | `/opt/stacks` | Stack directory mounted at the same path. Keep equal to `QM_STACK_PATHS`. |
| `DEPLOY_IMAGE` | `quaymaster:dev` | Image to run. |

## Settings stored in the database

Policies, maintenance windows, schedules, notification channels, registry logins, monitor thresholds and users are
managed in the UI (or API) and stored in SQLite. They are included in backups; secrets inside them are encrypted with
`QM_SECRET_KEY`.
