# Test fold — `packages/core`

One test file per source concern. The target directory mirrors `packages/core/src/`.

Baseline: 128 files, 923 tests, 9.83 s (`cd packages/core && bun run test`).

## Helpers (rule 6 — kept)

| Helper                                      | Why it stays                                                        |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `tests/helpers/effect.ts`                   | 5 core test files plus 7 files in `packages/extensions/tests/`      |
| `tests/helpers/failing-language-model.ts`   | 7 core test files                                                   |
| `tests/runtime/agent-loop/helpers.ts`       | 12 core test files → moves to `tests/runtime/agent-loop-helpers.ts` |
| `tests/server/session-mutations/helpers.ts` | 6 core test files → moves to `tests/server/session-mutations.ts`    |

Rule 4 (bun file-global effects): no core test file uses `mock.module`, a
top-level `beforeAll`/`afterAll`/`afterEach`, a `process.env` write, or
`setSystemTime`. No exception.

Rule 5: no core test file is named in a package.json script or in
`.oxlintignore`. `packages/core/tsconfig.locks.json` names three existing
files, so each keeps its own name and folds nothing in:

- `tests/runtime/runtime-profile.test.ts`
- `tests/extensions/extension-surface-locks.test.ts`
- `tests/extensions/extension-turn-projections.test.ts`

`tsconfig.locks.json` also names `tests/domain/actor.test.ts` and
`tests/runtime/scope-brands.test.ts`. Neither file exists; the entries are
already stale and this fold does not touch them.

## `tests/domain/`

| Target                       | Sources                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `domain/agent.test.ts`       | `agent.test.ts`, `agent-driver-routing.test.ts`, `agent-runspec.test.ts`, `model.test.ts`                  |
| `domain/agent-loop.test.ts`  | `runtime/agent/agent-loop.entity-id.test.ts`, `runtime/agent-loop/session-metrics-fold.test.ts`            |
| `domain/capability.test.ts`  | `capability-ref.test.ts`, `tool-declarations.test.ts`, `prompt.test.ts`                                    |
| `domain/event.test.ts`       | `event.test.ts`, `event-publisher.test.ts`, `event-stream-delivery.test.ts`, `schema-tagged-union.test.ts` |
| `domain/extension.test.ts`   | `file-lock.test.ts`                                                                                        |
| `domain/guards.test.ts`      | keeps its name                                                                                             |
| `domain/ids.test.ts`         | keeps its name                                                                                             |
| `domain/interaction.test.ts` | `interaction-request.test.ts`                                                                              |
| `domain/message.test.ts`     | `message.test.ts`, `head-tail.test.ts`, `message-part-projection.test.ts`                                  |

`domain/auth.test.ts` and `domain/auth-guard.test.ts` exercise
`src/runtime/provider.ts`; they fold into `runtime/provider.test.ts`.

## `tests/extensions/`

| Target                            | Sources                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `extensions/api.test.ts`          | `extensions/authoring-reference.test.ts`, `extensions/define-extension.test.ts` |
| `extensions/branch-tools.test.ts` | `runtime/branch-tool-feature.test.ts`                                           |

`extensions/extension-surface-locks.test.ts` and
`extensions/extension-turn-projections.test.ts` keep their names under rule 5.

The rest of `tests/extensions/` exercises `src/runtime/extension-host.ts`
(activation, capability-host, extension-hooks,
host-facet-survivors, loader, prompt-slots, registry, resource-host,
runtime-hooks, scope-precedence, memory/agent-override, turn-executor) or
`src/runtime/tools.ts` (compile-tool-policy) or `src/server/server.ts`
(session-snapshot-rpc) or `src/runtime/session.ts` (exec-tools-background).

## `tests/runtime/`

| Target                                | Sources                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runtime/agent-loop.test.ts`          | `agent-loop-concurrency`, `agent-loop-continuation`, `agent-loop-empty-final-step`, `agent-loop-max-steps`, `agent-loop-turn-stream`, `agent-runner`, `agent-loop/actor-command`, `agent-loop/admission-withdrawal`, `agent-loop/external-turn`, `agent-loop/interactions`, `agent-loop/model-compaction`, `agent-loop/model-context`, `agent-loop/primary-key-dedup`, `agent-loop/queue`, `agent-loop/recovery-race`, `agent-loop/streaming`, `agent-loop/tool-binding-replay`, `agent-loop/tool-projection-reconciliation`, `agent-loop/turn-lifecycle-hooks`, `agent-loop/turn-lifetime`, `agent-loop/turn-resume`, `agent/agent-loop.session-governance` |
| `runtime/child-agents.test.ts`        | `child-completion-describe.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `runtime/config.test.ts`              | `config-service.test.ts`, `driver-override-routing.test.ts`, `execution-overrides.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `runtime/extension-host.test.ts`      | `ambient-host-context`, `session-profile`, `session-runtime-context`, `drivers/driver-registry`, and the `tests/extensions/` files listed above (`runtime-profile.test.ts` keeps its name under rule 5)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `runtime/gent-platform.test.ts`       | `gent-platform.test.ts`, `run-process.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `runtime/model-context.test.ts`       | `model-context`, `model-context-degrade`, `model-context-ledger`, `model-context-window`, `token-estimation`, `agent/turn-window`, `providers/ai-transcript`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `runtime/provider.test.ts`            | `retry`, `model-registry`, `domain/auth`, `domain/auth-guard`, `providers/provider-auth`, `providers/provider-resolution`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `runtime/session.test.ts`             | `session-runtime`, `session-metrics`, `branch-resources`, `extensions/exec-tools-background`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `runtime/tools.test.ts`               | `tool-runner`, `turn-interruption`, `extensions/compile-tool-policy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `runtime/turn.test.ts`                | `agent-turn-response`, `agent-loop/step-outcome`, `agent-loop/tool-outcome-recording`, `agent/turn-persistence`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `runtime/wide-event-boundary.test.ts` | keeps its name                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

`runtime/agent-loop.test.ts` folds 22 files; if it runs longer than 60 s on
its own, split the longest describe back out (rule 9).

## `tests/server/`

| Target                         | Sources                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/rpc.test.ts`           | `rpc-contract`, `driver-rpc`, `extension-commands-rpc`, `model-context`, `auth-rpc`, `interaction-commands`                                                                                                                                                                               |
| `server/server.test.ts`        | `extension-health`, `get-branch-tree`, `message-send`, `session-command-persistence`, `session-delete`, `session-event-stream`, `session-idempotency`, `session-nesting-depth`, `session-queries`, `session-queue-watch`, `session-transport-contract`, `extensions/session-snapshot-rpc` |
| `server/workspace-rpc.test.ts` | keeps its name                                                                                                                                                                                                                                                                            |

## `tests/storage/`

| Target                    | Sources                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/schema.test.ts`  | `feature-migrations`, `message-search-index-drop`                                                                                                                                                     |
| `storage/storage.test.ts` | `relationship-storage`, `sqlite-branch-storage`, `sqlite-concurrency`, `sqlite-event-storage`, `sqlite-message-storage`, `sqlite-session-storage`, `tool-call-binding-storage`, `turn-record-storage` |

## `tests/test-utils/`

| Target                              | Sources                                          |
| ----------------------------------- | ------------------------------------------------ |
| `test-utils/index.test.ts`          | `ensure-storage-parents`, `extension-tool-layer` |
| `test-utils/language-model.test.ts` | `sequence-steps`, `debug/signal-provider`        |

## Removed directories

`tests/debug/`, `tests/drivers/`, `tests/providers/`, `tests/runtime/agent/`,
`tests/runtime/agent-loop/`, `tests/server/session-mutations/`,
`tests/extensions/memory/`.
