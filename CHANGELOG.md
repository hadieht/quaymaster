# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `publish` workflow: multi-architecture (amd64, arm64) images on GHCR; `:X.Y.Z`/`:latest` for version tags, `:edge` for `main`.
- README and install docs for running the published image; compose files default to `ghcr.io/hadieht/quaymaster:latest`.

## [0.1.0] - 2026-11-12

First release.

### Added

- Monitoring of containers, Compose projects, images, volumes and networks, with live stats, logs and Docker events.
- Container actions (start, stop, restart, kill, pause, unpause, remove, recreate) and Compose actions (up, stop,
  start, restart, down, redeploy), all through one service layer with read-only mode, managed scope, self-protection
  and audit logging.
- Compose discovery from labels, `docker compose ls` and a bounded scan of `QM_STACK_PATHS`; capability levels
  (full, limited, standalone).
- Image update detection by registry digest, staged pulls by digest, update quarantine for failed targets, and image
  cleanup with a preview step.
- Maintenance: policies, maintenance windows, cron schedules, dry-run plans, approvals bound to a plan hash, a
  health-gated and dependency-ordered update workflow, automatic rollback of the image, one-click restore of a run's
  recovery points, standalone-container updates by configuration clone.
- Notifications: webhook, ntfy, Gotify, Discord, Slack, Telegram, SMTP; monitors for container, host and update events.
- Web UI with eight sections (Dashboard, Containers, Compose Projects, Images, Maintenance, Volumes & Networks,
  Logs & Events, Settings), light and dark themes.
- Authentication with first-run setup token, `admin` and `viewer` roles, per-user log access, sessions, CSRF protection,
  login rate limiting, and an append-only audit log.
- Secret redaction of all outgoing data; AES-256-GCM encryption of stored credentials.
- Operator CLI: `gen-secret`, `hash-password`, `backup`, `restore`, `check`.
- Packaging: multi-stage Dockerfile (non-root, read-only root filesystem, no capabilities), Compose deployment,
  socket-proxy deployment for read-only use, systemd unit, Caddy and nginx examples.
- Test suites: unit, integration against real Docker fixtures (`qmtest-*`), web component tests, Playwright end-to-end;
  CI workflow with a secret scan.

### Known limitations

See [README.md](README.md#limitations-and-roadmap). Deferred audit findings are recorded in
[docs/DECISIONS.md](docs/DECISIONS.md).

[0.1.0]: https://github.com/hadieht/quaymaster/releases/tag/v0.1.0
