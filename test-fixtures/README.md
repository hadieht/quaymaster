# Test fixtures

Throw-away Docker resources for the integration tests. **Everything is named `qmtest-*` and labelled
`quaymaster.test=true`**; the scripts refuse to touch anything else and never prune.

| Fixture                                  | What it is                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `stacks/qmtest-multi`                    | 3 services, `depends_on` with `service_healthy`, healthchecks, named volume, labelled network                                    |
| `stacks/qmtest-single`                   | one service                                                                                                                      |
| `stacks/qmtest-dynamic`                   | one service whose directory the dynamic-discovery tests deliberately do not list as a stack path (not part of `all`; set `QM_TEST_IMAGE` to use another local image)             |
| `stacks/qmtest-secrets`                  | carries fake secrets (`fx-…`) in env, labels, command, healthcheck, URL, inline config — used to prove redaction                  |
| standalone container `qmtest-standalone` | `docker run` container without Compose labels                                                                                    |

The images are `alpine:latest` from the local image cache (`pull_policy: never`), so no registry access
is needed and no existing tag is moved.

```
test-fixtures/scripts/up.sh [all|multi|single|secrets|dynamic|standalone]
test-fixtures/scripts/down.sh
```
