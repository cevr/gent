# Planify: Wave 15 - Actor Ownership, Durability, and Extension Surface Closure

## Context

Wave 15 starts after the first Wave 14 correctness batches landed:

- `f1a49217 fix(interaction): key response resume by request id`
- `8f075999 fix(interaction): enforce durable pending singleton`
- `8c20ab86 fix(runtime): resolve session branch targets`

Those commits close the highest-risk interaction and runtime target invariants.
The remaining structural work should continue from first principles instead of
stretching the interaction lane further.

## Scope

- In: profile runtime ownership, actor supervision, durable actor commit
  boundaries, actor receive/dead-ref contracts, extension authoring unity,
  public extension API shrinkage, test lifecycle linting, runtime composition
  simplification, storage decomposition, and final recursive audit.
- Out: replacing Effect, replacing SQLite, Promise-first extension APIs,
  process-shaped active module names, and compatibility shims that preserve
  known-bad APIs.

## Constraints

- Stay within Effect, Bun, SQLite, OpenTUI/Solid, and current package topology.
- No `try`/`finally`, `async`/`await`, Promise chains, or Promise-returning hooks
  in test files outside explicit harness allowlists.
- No process-shaped source names such as `batch12`, `wave15`, or
  `planify-migration` outside `plans/`.
- One review round per batch: one Codex subagent plus one Okra counsel attempt.
  Fix P0/P1/P2 findings from that round only.
- Gate after every batch: `bun run typecheck && bun run lint && bun run test`.

## Applicable Skills

`planify`, `counsel`, `architecture`, `effect-v4`, `test`, `code-style`, `bun`,
`review`

## Gate Command

```bash
bun run typecheck && bun run lint && bun run test
```

## Receipts

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/interaction-commands.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-host.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts`
- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/composer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`

## Principle Grounding

| Principle                                                                | Application                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`            | Actor ownership and durability are semantic guarantees, not cleanup tasks.  |
| `/Users/cvr/.brain/principles/redesign-from-first-principles.md`         | Prefer explicit runtime/extension shapes over migration-era adapters.       |
| `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`       | One durable actor writer per profile; writes happen at mutation boundaries. |
| `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md` | Encode actor health, ownership, and extension facets as typed states.       |
| `/Users/cvr/.brain/principles/subtract-before-you-add.md`                | Shrink public API and runtime composition before adding more seams.         |

## Batch 1: fix(actor): make profile runtime ownership single-source

**Justification**: One cwd must not have multiple actor hosts writing the same
durable actor rows.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/server/dependencies.ts` | Insert launch-cwd profile into `SessionProfileCache` or remove the duplicate launch-cwd actor runtime. |
| `packages/core/src/runtime/session-profile.ts` | Enforce one profile runtime per cwd owner. |
| `packages/core/src/runtime/profile.ts` | Make actor persistence ownership explicit in profile construction. |
| `packages/core/tests/runtime/session-runtime-context.test.ts` | Prove launch-cwd sessions share one profile runtime. |
| `packages/core/tests/extensions/actor-host.test.ts` | Prove durable actor rows have one active owner. |

**Verification**: focused profile/actor-host tests, full gate, one review round.

## Batch 2: feat(actor): add host-level actor supervision

**Justification**: Let-it-crash requires a supervising owner; silent
unregistration is not enough.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/domain/actor.ts` | Add restart policy, actor health, and death/quarantine schemas. |
| `packages/core/src/runtime/extensions/actor-host.ts` | Own supervisor policy and status propagation. |
| `packages/core/src/runtime/extensions/actor-engine.ts` | Report actor death to host; support restartable spawn cells. |
| `packages/core/tests/runtime/actor-engine.test.ts` | Defect -> death record -> restart/quarantine tests. |
| `packages/core/tests/extensions/actor-host.test.ts` | Extension health reflects actor crash loops. |

**Verification**: actor engine/host focused tests, full gate, one review round.

## Batch 3: fix(actor): commit durable actor state at mutation boundary

**Justification**: A successful actor message reply must not precede durable
state commit when the actor is declared durable.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/runtime/extensions/actor-engine.ts` | Return committed state snapshots after successful durable receives or call host commit hook. |
| `packages/core/src/runtime/extensions/actor-host.ts` | Replace periodic-only persistence with write-through/journaled commits; keep snapshots as compaction. |
| `packages/core/src/storage/actor-persistence-storage.ts` | Add commit/journal API if current save API is insufficient. |
| `packages/core/tests/extensions/actor-host.test.ts` | Crash-before-periodic-write restore test. |
| `packages/e2e/tests/actor-persistence.test.ts` | Worker crash/restart durable state acceptance test if feasible. |

**Verification**: actor persistence focused tests, full gate, one review round.

## Batch 4: refactor(actor): clarify receive failure and dead-ref contracts

**Justification**: Actor receive currently says `never` typed failures, while
engine/test code still models typed failures through casts.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/domain/actor.ts` | Choose and encode either defect-only receive or typed recoverable receive failures. |
| `packages/core/src/runtime/extensions/actor-engine.ts` | Delete dead branch or implement typed policy accordingly. |
| `packages/core/src/runtime/extensions/receptionist.ts` | Add death-watch or liveness diagnostics for required refs. |
| `packages/core/tests/runtime/actor-engine.test.ts` | Remove casts and lock final behavior. |
| `docs/actor-model.md` | Align docs with real supervision and durability semantics. |

**Verification**: actor engine/docs checks, full gate, one review round.

## Batch 5: feat(extension): unify server and client extension authoring

**Justification**: One conceptual extension should not require two unrelated
APIs and manual RPC/pulse wiring.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/extensions/api.ts` | Add unified `defineExtension({ server, client })` authoring shape while preserving typed buckets internally. |
| `apps/tui/src/extensions/client-facets.ts` | Accept compiled client facets from the shared manifest. |
| `apps/tui/src/extensions/resolve.ts` | Resolve from the shared extension artifact/compiler. |
| `packages/extensions/src/auto.ts` and `apps/tui/src/extensions/builtins/auto.client.ts` | Port auto as the proof case. |
| `packages/core/tests/extensions/extension-surface-locks.test.ts` | Add type locks for unified authoring. |

**Verification**: extension surface locks, auto/TUI extension tests, full gate,
one review round.

## Batch 6: feat(extension): add progressive helper kits

**Justification**: Stateful extensions should not require authors to understand
actors, resources, RPC, reactions, and client pulses before their first useful
extension.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/extensions/api.ts` | Add `defineToolExtension`, `defineStatefulExtension`, and `defineUiExtension`. |
| `packages/core/src/runtime/extensions/*` | Compile helper kits into existing typed buckets. |
| `packages/extensions/src/auto.ts` | Port or partially port to stateful helper. |
| `packages/core/tests/extensions/extension-authoring.test.ts` | Add complete todo-like tool + command + UI fixture. |

**Verification**: authoring fixture tests, full gate, one review round.

## Batch 7: refactor(extension): shrink public authoring API

**Justification**: `@gent/core/extensions/api` exposes too much internal
machinery for the happy path to be obvious.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/extensions/api.ts` | Split stable author API from advanced/internal exports. |
| `packages/core/package.json` | Add explicit subpath exports if needed. |
| `packages/extensions/src/**/*.ts` | Migrate builtins to stable imports where possible. |
| `packages/core/tests/extensions/extension-surface-locks.test.ts` | Lock what must not leak into stable authoring API. |

**Verification**: typecheck and surface-lock tests, full gate, one review round.

## Batch 8: test(tooling): close Promise control-flow lint holes

**Justification**: Tests ban async/await and try/finally, but still permit
Promise chains and hook cleanup patterns that bypass Effect scopes.

**Changes**:
| File | Change |
| ---- | ------ |
| `lint/no-direct-env.ts` | Extend `gent/no-promise-control-flow-in-tests` to flag `.then`, `.catch`, `.finally`, Promise-returning hooks, and `Effect.runPromise` in test bodies outside allowlisted harnesses. |
| `packages/tooling/tests/fixtures.test.ts` | Add invalid/valid fixtures. |
| `apps/tui/tests/file-refs.test.ts` | Migrate Promise chains to Effect style. |
| `apps/tui/tests/shell.test.ts` | Migrate Promise-returning tests to Effect style. |
| `packages/e2e/tests/supervisor.test.ts` | Replace Promise waits with Effect/Deferred harness helpers. |

**Verification**: tooling fixture tests, TUI/e2e focused tests, full gate, one
review round.

## Batch 9: refactor(runtime): replace RuntimeComposer with explicit builders

**Justification**: Runtime composition should be explicit enough to audit
override families, memo-map behavior, and merge order without generic erasure.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/runtime/composer.ts` | Characterize behavior, then replace with explicit builders or delete. |
| `packages/core/src/runtime/agent/agent-runner.ts` | Use `buildEphemeralRuntime` or equivalent named factory. |
| `packages/core/src/server/dependencies.ts` | Use `buildServerRuntime` and `buildCwdRuntime`. |
| `packages/core/tests/runtime/scope-brands.test.ts` | Preserve override-family and memo-map tests against explicit builders. |

**Verification**: runtime/scope tests, full gate, one review round.

## Batch 10: refactor(storage): split SQLite storage boundaries

**Justification**: Storage has sub-tags, but `sqlite-storage.ts` still owns
schema, migrations, aggregates, FTS, and query implementations in one module.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/storage/sqlite-storage.ts` | Shrink to composition/assembler. |
| `packages/core/src/storage/schema.ts` | Move schema constants and init. |
| `packages/core/src/storage/migrations/*.ts` | Move FK/FTS/versioned migrations. |
| `packages/core/src/storage/impl/*.ts` | Split sessions, branches, messages, events, actors, checkpoints, interactions, and search. |
| `packages/core/tests/storage/sqlite-storage.test.ts` | Keep behavior locked; add fresh-schema equals migrated-schema test. |

**Verification**: storage suite, full gate, one review round.

## Batch 11: refactor(agent-loop): extract remaining turn phases

**Justification**: `agent-loop.ts` remains a mixed orchestration module after
the first carve-outs.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/runtime/agent/agent-loop.ts` | Keep public service/coordinator only. |
| `packages/core/src/runtime/agent/phases/*.ts` | Extract event commit, stream, tool, interaction, recovery, and resolution phases. |
| `packages/core/src/runtime/agent/agent-loop.state.ts` | Keep state transitions pure and testable. |
| `packages/core/tests/runtime/agent-loop*.test.ts` | Add phase-focused tests where cheap; keep integration tests. |

**Verification**: agent-loop focused tests, full gate, one review round.

## Batch 12: docs: recursive audit and Wave 16 handoff

**Justification**: The final batch should prove there are no remaining
P0/P1/P2 findings from the actor, extension, simplification, correctness,
lint-suppression, and runtime lanes before creating the next wave.

**Changes**:
| File | Change |
| ---- | ------ |
| `docs/actor-model.md` | Align supervision, durability, mailbox replay, and failure semantics with implementation. |
| `ARCHITECTURE.md` | Update runtime composition, extension authoring, and storage boundaries. |
| `AGENTS.md` | Update testing guidance after Promise/temp-dir migrations. |
| `plans/WAVE-15.md` | Record completion receipts. |
| `plans/WAVE-16.md` | Create only if the recursive audit finds remaining P2-or-higher work. |

**Verification**:

- Docs grep for stale process-shaped terms.
- Full gate.
- One final recursive audit: one Codex subagent plus one Okra counsel attempt
  across all lanes, P0/P1/P2 only.

## Current Status

- Wave 15 plan created.
- P0 findings: none.
- P1/P2 work remains in actor ownership/supervision/durability, extension
  authoring/API shape, test lifecycle linting, runtime composition, storage
  decomposition, and agent-loop simplification.
