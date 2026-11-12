# Contributing to Quaymaster

Thank you for helping. Please read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (the specification, including section
13, "Binding amendments") before changing behaviour, and [AGENTS.md](AGENTS.md) for the working rules.

## Development setup

Requirements: Node.js 22+, npm, Docker with the Compose plugin, a local `alpine:latest` image, and (for the browser
tests) Chromium via `npx playwright install chromium`.

```bash
git clone https://github.com/hadieht/quaymaster.git
cd quaymaster
npm ci
npm run build
```

The repository is an npm workspace: `shared/` (types and contracts), `server/` (Fastify API, Docker and Compose
services, scheduler, SQLite), `web/` (React UI), `e2e/` (Playwright), `deploy/` (packaging examples),
`test-fixtures/` (throw-away Docker stacks).

Run a development server only against fixtures, never unscoped (see the next section):

```bash
export QM_SECRET_KEY=$(openssl rand -base64 32)
export QM_STACK_PATHS=$PWD/test-fixtures/stacks
export QM_DATA_DIR=$(mktemp -d)
export QM_MANAGED_SCOPE='qmtest-*'
export QM_HOST=127.0.0.1
npm run build && npm start     # serves the API and the built UI on 127.0.0.1:8787
```

For UI work, `npm run dev -w web` starts the Vite dev server on `127.0.0.1:5173` and proxies `/api` to the running
server. (`npm run dev -w server` is currently broken: it sets `QM_DEV=1`, which the strict configuration check rejects
as an unknown variable. Use `npm start`.)

## The fixture-only test rule

Tests and development servers share a Docker daemon with whatever else runs on your machine.

1. Only create, modify, stop or remove Docker resources that are named `qmtest-*` **and** labelled
   `quaymaster.test=true`. Everything else is read-only for you.
2. Never run an unfiltered prune (`docker system|image|volume|container|network prune`). A test that needs prune must
   pass `--filter label=quaymaster.test=true`.
3. Never run `docker compose` against a project directory outside `test-fixtures/`.
4. Any Quaymaster instance that can reach the real socket runs with `QM_MANAGED_SCOPE=qmtest-*` and binds to
   `127.0.0.1`.
5. Do not restart or reconfigure the Docker daemon, and do not install system packages as part of a change.
6. Clean up your `qmtest-*` resources when you are done (`test-fixtures/scripts/down.sh`).
7. Tests must not depend on any particular real container, project, image or port on your machine.

Fixtures live in [`test-fixtures/`](test-fixtures/README.md) and use only the local `alpine:latest` image.

## Checks

```bash
npm run typecheck
npm run lint                 # eslint + prettier --check
npm run test:unit            # server unit tests; no Docker
npm test                     # server unit + integration, then web; needs Docker
npm run e2e                  # Playwright against fixtures
```

Run the full suite without other heavy jobs in parallel: one integration test is timing-sensitive on a loaded machine
(see [docs/DECISIONS.md](docs/DECISIONS.md)). `npm run format` applies Prettier.

## Engineering rules

- TypeScript strict mode; no `any` in exported signatures.
- Every Docker or Compose mutation goes through the service layer (scope check, read-only check, self-protection,
  audit). Routes never call dockerode or the CLI directly.
- Child processes use `execFile` with argument arrays. Never build a shell string.
- Nothing that may contain a secret is logged or returned unredacted.
- New behaviour comes with tests, including the failure paths.
- Record notable trade-offs and deviations from the specification in [docs/DECISIONS.md](docs/DECISIONS.md).
- Never commit `.env`, databases, keys, or anything under `.local/`.

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(server): ...`, `fix(web): ...`,
`docs: ...`, `test: ...`, `chore: ...`, `refactor: ...`, `ci: ...`. Keep commits small and meaningful.

A pull request should describe what changed and why, list the commands you ran with their results, and mention any
documentation that needs updating. Security issues go through [SECURITY.md](SECURITY.md), not public pull requests.
