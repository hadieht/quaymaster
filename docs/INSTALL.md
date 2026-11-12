# Installation

Two supported modes: **container** (recommended) and **native** (systemd). Both read the same environment variables;
[`.env.example`](../.env.example) lists all of them and [CONFIGURATION.md](CONFIGURATION.md) explains them.

Quaymaster needs access to the Docker socket, which is root-equivalent on the host. Read
[SECURITY-MODEL.md](SECURITY-MODEL.md) first, and do not expose the service to the internet.

## Requirements

|       | Container mode                                                  | Native mode                                                                                            |
| ----- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Host  | Linux with Docker Engine and the Compose plugin                 | same                                                                                                   |
| Extra | nothing (the image ships the Docker CLI and the Compose plugin) | Node.js 22+, `docker` CLI with `docker compose`, `python3`, `make`, `g++` (to build the SQLite module) |
| Disk  | a few hundred MB for the image, plus a small data volume        | similar                                                                                                |

## 1. Get the image

Use the published image (recommended) or build it yourself.

```bash
docker pull ghcr.io/hadieht/quaymaster:0.1.0      # pin an exact release; :latest = newest release, :edge = main (development)
```

To run it you also need `deploy/docker-compose.yml` and `.env.example` from this repository (download them, or clone).
The commands below use `quaymaster:dev`; substitute `ghcr.io/hadieht/quaymaster:0.1.0` (and set `DEPLOY_IMAGE` accordingly) if you pulled.

### Or build from source

```bash
git clone https://github.com/hadieht/quaymaster.git
cd quaymaster
docker build -t quaymaster:dev .
```

The image is multi-stage, runs as uid/gid 10001, and contains the Docker CLI and Compose plugin (Compose actions
run inside the container against the mounted socket). Images are published to GHCR by the `publish` workflow (releases and `main`);
you can still build it yourself and set `DEPLOY_IMAGE` to your own tag.

## 2. Create the configuration

```bash
cp .env.example .env
chmod 600 .env
grep -v '^QM_SECRET_KEY=' .env > .env.new                                  # drop the blank line from the example
docker run --rm quaymaster:dev node server/dist/cli.js gen-secret >> .env.new   # append QM_SECRET_KEY=...
mv .env.new .env && chmod 600 .env
```

(Use your image instead of `quaymaster:dev` if you pulled `ghcr.io/hadieht/quaymaster`.) Quaymaster will not start
while `QM_SECRET_KEY` is empty; it exits with "QM_SECRET_KEY (or QM_SECRET_KEY_FILE) is required", and Docker's restart
policy then keeps relaunching it.

Edit `.env`:

- `QM_SECRET_KEY` - already written by the commands above. **Store a copy outside the server** (password manager):
  backups do not contain it.
- `QM_STACK_PATHS` - absolute directories that contain your Compose projects, e.g. `/opt/stacks`.
- `DEPLOY_STACKS_DIR` - the same directory; the compose file mounts it at the identical path.
- `QM_PUBLIC_ORIGIN`, `QM_COOKIE_SECURE`, `QM_TRUST_PROXY` - when you use a reverse proxy (step 5).

### First admin: two options

1. **Setup token (default).** Leave `QM_ADMIN_USER` empty. On first start Quaymaster prints a one-time token to its
   stderr and writes it to `<data>/setup-token` (mode 0600, valid 60 minutes, five attempts per IP). Enter it on the
   first-run page together with a username and a password of at least 12 characters. If the token expires, restart
   Quaymaster to issue a new one.
2. **Pre-seeded admin.** Set `QM_ADMIN_USER` and either `QM_ADMIN_PASSWORD_HASH` or `QM_ADMIN_PASSWORD_FILE`. This is
   applied only while there are no users.

   ```bash
   docker run --rm -it quaymaster:dev node server/dist/cli.js hash-password
   # prints:  QM_ADMIN_PASSWORD_HASH='scrypt$...'   <- paste the whole line, keep the single quotes
   ```

   The single quotes matter: the hash contains `$`, which Docker Compose and shells would otherwise expand.

## 3. Start (container mode)

```bash
sed -i "s/^DOCKER_GID=.*/DOCKER_GID=$(stat -c %g /var/run/docker.sock)/" .env   # the compose file needs it on every command
docker compose up -d                                                  # COMPOSE_FILE / COMPOSE_ENV_FILES in .env point at deploy/
docker ps --filter name=quaymaster          # wait for "healthy"
docker logs quaymaster 2>&1 | grep -i -A2 "setup token"
```

Open `http://127.0.0.1:8787`.

What the compose file sets up:

- **User and socket.** Runs as `10001:10001`; `group_add` gives it the host's Docker group, so it needs `DOCKER_GID`.
  The compose file fails with a clear message if `DOCKER_GID` is unset, on **every** compose command (`restart`, `logs`,
  `pull`, ...), so it is stored in `.env`. `.env` also sets `COMPOSE_FILE` and `COMPOSE_ENV_FILES`, which is why a plain
  `docker compose restart` works from the folder that holds `.env`.
- **Volumes.** `quaymaster-data` at `/data`; the socket; your stack directory at its identical host path.
- **Hardening.** Read-only root filesystem (only `/data` and a 64 MB `/tmp` tmpfs are writable), `no-new-privileges`,
  all capabilities dropped, 512 MB memory, 1 CPU, 256 pids, `tini` as PID 1, healthcheck on `/healthz`.
- **Port.** `127.0.0.1:8787` by default (`DEPLOY_BIND`, `DEPLOY_PORT`).
- **Self-protection.** `QM_SELF_CONTAINER=quaymaster` matches the fixed `container_name`.

Optional free-space checks: mount the Docker root read-only (see the commented line in the compose file) and set
`QM_DOCKER_ROOT_MOUNT` to a directory on that filesystem. Without it, pulls and updates are refused because free
space cannot be verified (the check fails closed). Note that `/var/lib/docker` itself is typically not readable by
uid 10001; any readable directory on the same filesystem works.

If you change the container name in the compose file, also change `QM_SELF_CONTAINER`.

## 4. Read-only deployment behind a socket proxy

For monitoring only:

```bash
docker compose --env-file .env -f deploy/docker-compose.socket-proxy.yml up -d
```

The proxy ([tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy)) sits on an internal
network and allows only read endpoints (`POST=0`). Quaymaster connects with `QM_DOCKER_SOCKET=tcp://socket-proxy:2375`
and `QM_READ_ONLY=true`, and has no direct socket mount. Compose actions and updates are unavailable. The image tag
in the file is `latest`; pin a digest in production. `QM_STACK_PATHS` is still required.

## 5. Reverse proxy and TLS (recommended)

Examples: [`deploy/reverse-proxy/Caddyfile`](../deploy/reverse-proxy/Caddyfile) (automatic certificates) and
[`deploy/reverse-proxy/nginx.conf`](../deploy/reverse-proxy/nginx.conf). Replace `quaymaster.example.com` with your
name. Disable response buffering for the proxied location: the UI uses server-sent events for logs and live updates.

Then set in `.env` and recreate the container:

```ini
QM_PUBLIC_ORIGIN=https://quaymaster.example.com
QM_COOKIE_SECURE=true
QM_TRUST_PROXY=<proxy IP or CIDR>
QM_PROTECTED=<proxy container name>
```

If the proxy runs in a container on the same Docker network, `QM_TRUST_PROXY` is the proxy's address or that
network's subnet. Never use `true`, `*` or `0.0.0.0/0`; Quaymaster rejects them.

## Native install (systemd)

```bash
git clone https://github.com/hadieht/quaymaster.git && cd quaymaster
npm ci && npm run build

sudo useradd --system --home /var/lib/quaymaster --shell /usr/sbin/nologin -G docker quaymaster
sudo install -d -o quaymaster -g quaymaster /var/lib/quaymaster /opt/quaymaster

# copy the runtime files
sudo cp -r package.json package-lock.json /opt/quaymaster/
sudo mkdir -p /opt/quaymaster/{shared,server,web}
sudo cp -r shared/package.json shared/dist /opt/quaymaster/shared/
sudo cp -r server/package.json server/dist /opt/quaymaster/server/
sudo cp -r web/package.json web/dist /opt/quaymaster/web/
sudo chown -R quaymaster:quaymaster /opt/quaymaster
cd /opt/quaymaster && sudo -u quaymaster npm ci --omit=dev -w shared -w server
cd -

# configuration: add QM_WEB_DIR=/opt/quaymaster/web/dist and your QM_* values
sudo install -m 0640 -o root -g quaymaster .env /etc/quaymaster.env

sudo install -m 0644 deploy/quaymaster.service /etc/systemd/system/quaymaster.service
sudo systemctl daemon-reload
sudo systemctl enable --now quaymaster
sudo journalctl -u quaymaster -n 50      # setup token appears here
```

Notes:

- The unit runs as `quaymaster` with `SupplementaryGroups=docker`, `ProtectSystem=strict`, `ProtectHome=true`,
  `NoNewPrivileges`, and `MemoryMax=512M`. It sets `QM_DATA_DIR=/var/lib/quaymaster` itself.
- `ReadWritePaths=/var/lib/quaymaster /opt/stacks`: **edit this line** to list every directory in
  `QM_STACK_PATHS`, or Compose cannot write there. If you keep stacks under `/home`, relax `ProtectHome`.
- `WorkingDirectory=/opt/quaymaster` and `ExecStart=/usr/bin/node server/dist/index.js`: adjust if Node lives elsewhere.
- Native mode sees your Compose files directly; no identical-path mounts are needed. `QM_DOCKER_ROOT_MOUNT` is not
  needed either if the service user can read the Docker root (otherwise set it as in container mode).
- Operator commands: `sudo -u quaymaster env QM_DATA_DIR=/var/lib/quaymaster node /opt/quaymaster/server/dist/cli.js backup <file>`.

## Verify the installation

```bash
curl -fsS http://127.0.0.1:8787/healthz         # {"status":"ok"}
```

Then log in and check, in Settings, the installation panel: read-only state, managed scope, stack paths and the
detected self container. Compose projects should show capability **full**; if they show **limited**, see
[Troubleshooting](../README.md#troubleshooting-and-faq).

## Uninstall

Container: `docker compose --env-file .env -f deploy/docker-compose.yml down` (add `-v` only if you want to delete
the data volume). Quaymaster does not modify your containers or Compose files by itself; rollback images it created
carry the tags `quaymaster-rollback/*` and `quaymaster-staged/*` and can be removed with `docker rmi` once you no
longer need them. Native: `systemctl disable --now quaymaster`, remove the unit, `/opt/quaymaster`,
`/etc/quaymaster.env` and, if wanted, `/var/lib/quaymaster`.
