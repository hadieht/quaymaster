# Security model

What Quaymaster protects, how, and what it cannot do. The binding specification is
[ARCHITECTURE.md](ARCHITECTURE.md) section 5 and the amendments in section 13; findings and fixes are in
[reviews/](reviews/) and [DECISIONS.md](DECISIONS.md). To report a vulnerability see [../SECURITY.md](../SECURITY.md).

## The central fact: the Docker socket

Anyone who can talk to the Docker socket can start a privileged container that mounts the host's root filesystem. So
**whoever controls Quaymaster, or the account it runs as, controls the host.** Quaymaster reduces what _it_ will do
and records what it did. It does not and cannot sandbox the socket.

Consequences:

- Do not expose Quaymaster to the internet. It has no two-factor authentication in 0.1.0 (TOTP is on the roadmap). Use a
  trusted LAN or a VPN, and a TLS reverse proxy.
- Keep it bound to `127.0.0.1` unless a proxy on another host must reach it.
- If you only need monitoring, run the socket-proxy deployment with `QM_READ_ONLY=true`: Quaymaster never holds the
  socket, and the proxy refuses non-GET requests.
- Use `QM_MANAGED_SCOPE` to restrict mutations to named projects/containers.
- Treat the data volume and `QM_SECRET_KEY` as sensitive.

## Trust boundaries

| Boundary         | Rule                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser → server | Authenticated session, CSRF protection. The browser never talks to Docker.                                                                                                                                                                        |
| Server → Docker  | Named, validated actions only. No generic proxy to the Engine API; no route accepts a command line.                                                                                                                                               |
| Compose files    | Trusted only if their real path lies under `QM_STACK_PATHS` (and not under the Docker data root). Container labels are untrusted input. Quaymaster never edits Compose files.                                                                     |
| Outbound network | Notification and registry clients: http/https only, no URL credentials, link-local and cloud-metadata addresses refused at connect time, same-host redirects, short timeouts, response bodies not returned. LAN addresses are allowed on purpose. |

## Authentication and sessions

- No anonymous mode. Only `/healthz`, `/auth/status`, `/auth/setup` and `/auth/login` are public (`/healthz` returns
  just `{"status":"ok"}`).
- **First run:** no default password. Either a one-time setup token (printed outside the normal log pipeline, stored
  mode 0600, valid 60 minutes, five attempts per IP, constant-time compare, deleted on success), or an admin from
  `QM_ADMIN_USER` plus a hash/password file, applied only while no users exist.
- **Passwords:** scrypt (default N=2^17, r=8, p=1), per-user salt, parameters stored with the hash, constant-time compare,
  minimum 12 characters. Hashing is concurrency-limited so a flood of logins cannot exhaust memory.
- **Sessions:** random 256-bit IDs stored hashed (SHA-256). Cookie `HttpOnly; SameSite=Strict`, and `Secure` plus the
  `__Host-` prefix and HSTS when `QM_COOKIE_SECURE=true`. New session ID at every login. Idle timeout 30 min and absolute
  12 h by default. Logout-all; a password change revokes other sessions; role changes and user disabling revoke that
  user's sessions and live streams.
- **CSRF:** session-bound token in `X-QM-CSRF` plus exact `Origin` match for every state-changing request
  (`QM_PUBLIC_ORIGIN`). GET requests have no side effects (tested).
- **Brute force:** per-IP budget before hashing, per-account capped delay, hard lock keyed on (account, IP), failed
  logins audited (raw failed usernames are not stored). Limiter state is in memory (see limitations).
- **Roles:** `admin` can do everything; `viewer` is read-only. Container logs need the separate `logs:read` permission:
  admins always, viewers only when granted (default off). The last active admin cannot be demoted, disabled or deleted.

## Authorization layers for every mutation

All Docker and Compose mutations pass through one service layer, in this order:

1. **Role** - admin only.
2. **Read-only mode** (`QM_READ_ONLY`) - enforced in the Docker transport as an allow-list of method/path pairs and in
   the Compose runner as an allow-list of subcommands, so a bug in a route cannot bypass it.
3. **Managed scope** (`QM_MANAGED_SCOPE`) - the target must match; includes everything an in-scope project references
   (volumes, networks, container names). Image side effects are checked too: a plan whose tag is shared with an
   out-of-scope or protected container is refused.
4. **Self-protection** - refuses actions on Quaymaster's own container, project, networks and volumes, and on anything
   in `QM_PROTECTED`. If Quaymaster runs in a container and cannot identify itself, it forces read-only.
5. **Resolve → check → act by ID** - names are resolved to full IDs, the inspected object is checked, and the action is
   sent by ID, so a rename between check and act cannot redirect it.
6. **Confirmation** - remove, recreate, down, cleanup and restore require a server-validated confirmation naming the
   target.
7. **Audit** - append-only `audit_log` (update and delete of young rows blocked by triggers; retention at least 30 days)
   with actor, IP, action, target, redacted parameters, outcome and duration.

Other safety limits: removal never uses force; containers are never removed together with their volumes (volumes are removed only by the separate, typed-confirmation storage cleanup, and only when no container references them); Compose `down` never uses `-v`; Compose
is always called with explicit project name, directory and file arguments in a fixed, minimal child environment; every
child process uses `execFile` with argument arrays (never a shell), identifiers starting with `-` are rejected and `--`
separates arguments.

## Secrets

- **At rest:** notification channel configuration and registry credentials are encrypted with AES-256-GCM using a key
  derived from `QM_SECRET_KEY` (random IV, authenticated context). The key lives in the environment or a file, never in
  the database. The server refuses to start with a missing or weak key.
- **In transit out of the process:** every outgoing object (API responses, SSE, stored events and operation output,
  notifications, logs) is redacted: keys matching secret-like names (password, token, key, secret, auth, cookie, DSN,
  webhook ...) are masked; values that look like secrets (URL userinfo, JWTs, PEM blocks, high-entropy strings, known
  token prefixes) are masked regardless of the key; learned secret values are scrubbed from free text such as logs.
  `QM_REDACT_ALL_ENV=true` masks all environment values. There is no "reveal" function.
- **Never returned:** notification URLs (masked to scheme and host), channel secrets, registry passwords.
- **Not covered:** the Docker events and container logs of your own applications are scrubbed with the same rules, but
  redaction is heuristic. If an application prints a secret in an unusual form, it can appear in logs shown to users
  with log access. Grant `logs:read` sparingly.

## HTTP hardening

Strict Content-Security-Policy (no inline script), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, no CORS, request body limits, HSTS when secure cookies are on. `trustProxy` is
set only from `QM_TRUST_PROXY`, which must be an explicit IP/CIDR list. Live streams (SSE) are bound to the session,
re-validated every 60 seconds, limited per session and in total, heartbeated, and closed when the client cannot keep up.

## Update-safety properties

These are security-relevant because an update runs with root-equivalent power:

- An update changes only the image. Compose drift between files and the running container blocks automatic runs.
- Images are pulled by digest and staged; user-visible tags move only inside the deploy step.
- Approvals are bound to a hash of the exact plan; any change makes the approval stale.
- Critical targets are never automated. Standalone updates are never automated.
- Registry credentials are sent only over HTTPS (or loopback / allow-listed insecure hosts) and only to the registry host.
- Disk checks fail closed. Runs that crash are never resumed automatically.

## Deployment hardening included

Container: non-root uid 10001, read-only root filesystem, `no-new-privileges`, all capabilities dropped, memory/CPU/pid
limits, `tini`, healthcheck, Docker group added at run time rather than baked in. Native: dedicated user,
`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `NoNewPrivileges`, `MemoryMax`. Examples for TLS and a socket
proxy are in [`deploy/`](../deploy/).

## Known limitations

From the implementation audit ([reviews/02-implementation-audit.md](reviews/02-implementation-audit.md)); all
critical and high findings were fixed, the following were deferred and are recorded in [DECISIONS.md](DECISIONS.md):

- **Login limiter is in memory only** (M-05). A restart clears it. Behind a proxy without `QM_TRUST_PROXY`, one client
  can exhaust the per-IP budget for everyone. Set `QM_TRUST_PROXY`.
- **Dependencies** (L-01): `npm audit` reported advisories in zod, react-router and uuid at the time of the audit; bumps are
  deferred. Re-run `npm audit --omit=dev` before you deploy.
- **Webhook and health-probe URLs** (L-02, L-03): the outbound policy is applied at send time; a hostname that resolves
  to a forbidden address is refused then, not when you save it. Health-probe URLs saved in policies are not subject to the
  notification outbound policy.
- **Viewers can read** notification channel metadata and full policies (secrets inside are masked) (L-05).
- **Recovery text and audit `argv`** contain absolute paths of your Compose directories (L-06).
- **SSE socket teardown on stream error** is not forced (M-03, low impact).
- **No 2FA, no multi-host, no per-resource roles.** Two roles only.
- **Redaction is heuristic** (see above); **Compose `include`/`extends` from remote sources** make a project `limited`.
- Mocked-transport-only testing of SMTP and Telegram; no real registry round trip against Docker Hub or GHCR.

The first public release was scanned with gitleaks; the 8 findings are fake credentials in redaction and notification
tests and fixtures.

## Dynamic discovery and the file helper (0.2.0)

Compose labels are attacker-writable data, but anyone who can create a container with forged labels already has root through the Docker socket. The design goal is that Quaymaster does not widen what a Quaymaster user can read. Labels never grant trust by themselves: update/redeploy/config require the files to be under an administrator-controlled root (`QM_STACK_PATHS` or a same-path mount of Quaymaster's own container, read from its own container inspect). The read-only helper accepts only an absolute, canonical working directory (no `..`, control characters, `/`, `/proc`, `/sys`, `/dev`), reads only compose-like and `.env*` files (plus explicit config files below that directory), refuses symlinks, non-regular and world-writable files, runs without network or capabilities, and its output is re-validated and redacted; `.env` values are never returned. It is not used in read-only mode or for projects outside `QM_MANAGED_SCOPE`. The ignore list only filters; it cannot be used to act on a resource. See docs/DECISIONS.md.
