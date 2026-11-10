# Working rules for this repository

Quaymaster is a Docker management and maintenance dashboard. Read
`docs/ARCHITECTURE.md` before changing anything; it is the specification.

## Safety rules for development (non-negotiable)

The development machine runs real services on the same Docker daemon.

1. Only create, modify, stop or remove Docker resources that are named
   `qmtest-*` **and** labelled `quaymaster.test=true`. Everything else on the
   daemon is read-only for you.
2. Never run an unfiltered prune (`docker system|image|volume|container|network
   prune`). If a test needs prune, it must pass
   `--filter label=quaymaster.test=true`.
3. Never run `docker compose` against a project directory outside
   `test-fixtures/`.
4. Any locally started Quaymaster instance that can reach the real socket must
   be started with `QM_MANAGED_SCOPE=qmtest-*` so mutating actions on real
   resources are refused server-side. Bind dev servers to `127.0.0.1`.
5. Do not restart or reconfigure the Docker daemon. Do not install system
   packages without it being part of your task.
6. Clean up your `qmtest-*` resources when a test run finishes.

## Engineering rules

- TypeScript strict mode. No `any` in exported signatures.
- Every Docker/Compose mutation goes through the service layer (scope check,
  read-only check, self-protection, audit). Routes never call dockerode or the
  CLI directly.
- Child processes: `execFile` with argument arrays only. Never build a shell
  string.
- Nothing that may contain a secret is logged or returned unredacted.
- New behaviour comes with tests. Run `npm test` and `npm run typecheck`
  before committing.
- Small, meaningful commits (Conventional Commits style). Never commit `.env`,
  databases, keys or anything under `.local/`.
- Record notable trade-offs in `docs/DECISIONS.md`.
