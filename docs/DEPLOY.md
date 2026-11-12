# Deploying Quaymaster

Two supported modes: **container** (recommended) and **native** (systemd). Both read the same `.env`
(`.env.example` has every variable; placeholders only).

## 1. Generate secrets

```bash
# from a checkout (after `npm run build`) or inside the image:
npm run --silent gen-secret            # -> value for QM_SECRET_KEY
npm run --silent hash-password         # prompts, prints scrypt$... for QM_ADMIN_PASSWORD_HASH
# with the image only:
docker run --rm quaymaster:dev node server/dist/cli.js gen-secret
docker run --rm -it quaymaster:dev node server/dist/cli.js hash-password
```

Without `QM_ADMIN_USER` / `QM_ADMIN_PASSWORD_HASH`, the first start prints a one-time setup token (stderr and
`<data>/setup-token`) that the first-run page asks for.

## 2. Container mode

```bash
cp .env.example .env && chmod 600 .env      # set QM_SECRET_KEY, QM_STACK_PATHS, DEPLOY_STACKS_DIR, DOCKER_GID
docker build -t quaymaster:dev .
DOCKER_GID=$(stat -c %g /var/run/docker.sock) docker compose --env-file .env -f deploy/docker-compose.yml up -d
```

- **Socket and user.** The container runs as uid 10001 (non-root). The image never bakes in a GID; the compose file
  adds the host's docker group at run time with `group_add`. Access to the socket is still root-equivalent on the
  host — that is inherent to a Docker manager. Use `QM_READ_ONLY=true` or the socket-proxy example if you only monitor.
- **Stack paths at identical host paths.** Compose resolves relative bind mounts on the host, so each directory in
  `QM_STACK_PATHS` is mounted at the same absolute path inside the container.
- **Network.** Published on `127.0.0.1:8787` by default. Put a TLS reverse proxy in front
  (`deploy/reverse-proxy/Caddyfile` or `nginx.conf`) and set `QM_PUBLIC_ORIGIN`, `QM_COOKIE_SECURE=true`,
  `QM_TRUST_PROXY=<proxy IP/CIDR>`.
- **Hardening.** `read_only` root filesystem (only `/data` and a `/tmp` tmpfs are writable), `no-new-privileges`,
  all capabilities dropped, memory/CPU/pids limits, `tini` as PID 1, `HEALTHCHECK` on `/healthz`.
- **Self-protection.** Quaymaster identifies its own container (from `/proc/self/mountinfo`, or `QM_SELF_CONTAINER`)
  and refuses to stop/restart/update/remove itself or anything in `QM_PROTECTED` (list your reverse proxy and socket
  proxy there).
- **Read-only behind a socket proxy.** `deploy/docker-compose.socket-proxy.yml`; Quaymaster talks to
  `QM_DOCKER_SOCKET=tcp://socket-proxy:2375`. Compose actions are unavailable in that mode.

## 3. Native mode (systemd)

```bash
npm ci && npm run build
sudo useradd --system --home /var/lib/quaymaster --shell /usr/sbin/nologin -G docker quaymaster
sudo install -d -o quaymaster -g quaymaster /var/lib/quaymaster /opt/quaymaster
# copy package.json shared/{package.json,dist} server/{package.json,dist} web/dist to /opt/quaymaster, then:
cd /opt/quaymaster && sudo -u quaymaster npm ci --omit=dev -w shared -w server
sudo install -m 0640 -o root -g quaymaster .env /etc/quaymaster.env       # QM_WEB_DIR=/opt/quaymaster/web/dist
sudo install -m 0644 deploy/quaymaster.service /etc/systemd/system/quaymaster.service
sudo systemctl daemon-reload && sudo systemctl enable --now quaymaster
```

## 4. Backup and restore (SQLite, online)

The CLI uses SQLite's online backup API, so Quaymaster may keep running while you back up.

```bash
# container (data volume mounted at /data; the backup is written next to it)
docker exec quaymaster node server/dist/cli.js backup /data/backup-$(date +%F).db
docker cp quaymaster:/data/backup-$(date +%F).db ./
# native
QM_DATA_DIR=/var/lib/quaymaster node server/dist/cli.js backup /var/backups/quaymaster-$(date +%F).db

# verify a file (integrity check + schema version)
docker exec quaymaster node server/dist/cli.js check /data/backup-YYYY-MM-DD.db

# restore: STOP Quaymaster first. The CLI checks the file, refuses to run while Quaymaster holds the instance lock, checks the
# file, and keeps the old database as `.before-restore-<timestamp>`.
docker stop quaymaster
docker run --rm --user 10001 -v quaymaster_quaymaster-data:/data -v "$PWD:/in:ro" quaymaster:dev \
  node server/dist/cli.js restore /in/backup-YYYY-MM-DD.db
docker start quaymaster
```

`QM_SECRET_KEY` is **not** in the backup. Keep it separately: without it, stored notification-channel secrets cannot
be decrypted.

## 5. Upgrade path

Schema migrations are forward-only and run automatically at start-up inside a transaction; the server refuses to
start on a database written by a newer version.

```bash
docker exec quaymaster node server/dist/cli.js backup /data/pre-upgrade.db     # 1. back up
git pull && docker build -t quaymaster:dev .                                   # 2. new image
DOCKER_GID=... docker compose --env-file .env -f deploy/docker-compose.yml up -d  # 3. recreate (migrates on start)
curl -fsS http://127.0.0.1:8787/healthz                                        # 4. verify
```

Rollback: stop, `restore` the pre-upgrade backup, start the previous image tag.
