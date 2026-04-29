# Planify: Wave 14 - Independent Actor, Interaction, and Extension Correctness

## Context

Wave 14 is an independent five-lane audit of the current repository, not a
continuation checklist for Wave 13. The audit ran after these Wave 13 commits:

- `5ec297d2 fix(events): serialize event delivery`
- `5b3b1043 fix(agent-loop): derive turn wait state`
- `59745c29 fix(agent-loop): surface recovery abandonment`
- `4d1f910d refactor(agent-loop): extract command and response seams`
- `da55bf5a fix(storage): version search projection startup`
- `54b89069 fix(storage): make sqlite startup fail closed`
- `3ccdff1d test: add failing runtime layers`
- `6cfb495b chore: delete dead lint suppressions`
- `ab079124 test: restore suppression signal`

The fresh audit found no P0 blockers. It did find P1 structural work in
interaction correctness, actor ownership/supervision/durability, extension
authoring unity, runtime composition simplification, and test lifecycle linting.

## Scope

- In: interaction response invariants, durable pending interaction singleton,
  branch-target validation, actor profile ownership, actor supervision,
  durable actor commits, extension authoring unification, test control-flow
  linting, runtime/TUI/storage simplification, and public API narrowing.
- Out: replacing Effect, replacing SQLite, copying pi-mono's imperative API,
  Promise-first extension APIs, broad compatibility shims for deleted surfaces,
  and process-shaped source names for active product code.

## Constraints

- Stay within Effect, Bun, SQLite, OpenTUI/Solid, and current package topology
  unless a batch explicitly narrows the move.
- No `try`/`finally`, `async`/`await`, Promise chains, or Promise-returning
  hooks in test files outside explicit harness allowlists.
- No process-shaped source names such as `batch12`, `wave14`, or
  `planify-migration` outside `plans/` and dated audit receipts.
- Each implementation batch gets one review round only: one Codex subagent and
  one Okra counsel attempt. P0/P1/P2 findings are fixed in that same round.
- Gate after every batch: `bun run typecheck && bun run lint && bun run test`.
- High-blast-radius batches may be split into reviewable sub-commits, but the
  review round remains per batch.

## Applicable Skills

`planify`, `repo`, `counsel`, `architecture`, `effect-v4`, `test`,
`code-style`, `bun`, `review`

## Gate Command

```bash
bun run typecheck && bun run lint && bun run test
```

## Research Streams

| Lane              | Codex                                  | Okra / Opus                                                                                                                                                  |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Simplification    | `019dd75d-d51e-7bf1-9ef7-5804d281070b` | Counsel requested by plan, but recent counsel attempts in this session timed out before producing `claude.md`; rerun at Batch 1 start if counsel is healthy. |
| Correctness       | `019dd75d-d553-73e2-9f59-11e3c41ab611` | Same counsel caveat.                                                                                                                                         |
| Actor north star  | `019dd75d-d568-7ab3-84e7-57e7c278e065` | Same counsel caveat.                                                                                                                                         |
| Extension system  | `019dd75d-d57a-7580-818b-63e44006445d` | Same counsel caveat.                                                                                                                                         |
| Lint suppressions | `019dd75d-d58f-7923-b046-6cbd8991349e` | Same counsel caveat.                                                                                                                                         |

## External Receipts

- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/todo.ts:105`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/todo.ts:136`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/todo.ts:284`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:120`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:220`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:31`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent.ts:152`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:75`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:246`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:265`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:332`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tui.ts:321`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tui.ts:449`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/server/server.ts:44`

## Principle Grounding

| Principle                                                                | Application                                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`            | Interaction and actor invariants are structural, not convenience fixes.                            |
| `/Users/cvr/.brain/principles/redesign-from-first-principles.md`         | Profile ownership, extension authoring, and runtime composition should look designed, not patched. |
| `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`       | Actor persistence rows, interaction rows, and runtime dispatch targets need single writers.        |
| `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md` | Pending interaction ids, branch targets, and actor health become typed state, not conventions.     |
| `/Users/cvr/.brain/principles/derive-dont-sync.md`                       | Extension facets, TUI state, and runtime projections should compile from one source.               |
| `/Users/cvr/.brain/principles/subtract-before-you-add.md`                | Simplify composer, public extension API, TUI provider, and storage before adding new power.        |
| `/Users/cvr/.brain/principles/prove-it-works.md`                         | Every P1 gets failure-injection or restart tests before it is considered fixed.                    |

## Synthesis

### P1 Findings

- Interaction responses are not matched against the pending request id before
  resuming the loop. A stale/wrong response can wake the branch and strand the
  real pending request.
- Durable pending interaction state is modeled as a singleton in memory, but
  storage permits multiple pending rows for one session/branch.
- Runtime dispatch validates session existence but not branch existence or
  branch ownership before constructing loop state.
- Extension actors can crash and unregister, but no host supervisor restarts,
  quarantines, or exposes durable actor death as health.
- The same cwd can produce multiple profile runtimes that own the same durable
  actor persistence rows.
- Durable actor state is written periodically/gracefully, not at the mutation
  boundary, so a crash can lose acknowledged actor state.
- A user-facing extension is split across server and TUI authoring APIs, forcing
  manual RPC/pulse wiring for one conceptual extension.
- `@gent/core/extensions/api` exposes too much internal machinery for the
  "minimal, opinionated harness" goal.
- Test control-flow lint still permits Promise chains and hook cleanup patterns
  that bypass Effect scopes.

### Key Receipts

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:2386`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:2393`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:3066`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/interaction-commands.ts:36`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/interaction-request.ts:144`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:797`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:359`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts:188`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:464`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-host.ts:117`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:109`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts:130`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:285`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts:209`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/auto.client.ts:59`
- `/Users/cvr/Developer/personal/gent/.oxlintrc.json:36`
- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:861`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/file-refs.test.ts:82`

## Batch 1: fix(interaction): key response resume by request id

**Justification**: A response for the wrong interaction id must never resume a
branch waiting on a different pending request.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/runtime/session-runtime.ts` | Brand `RespondInteractionCommand.requestId` as `InteractionRequestId`. |
| `packages/core/src/runtime/agent/agent-loop.ts` | In `WaitingForInteraction`, compare `event.requestId` to `state.pendingRequestId`; mismatches return a typed stale response result and leave state cold. |
| `packages/core/src/domain/interaction-request.ts` | Add/adjust typed stale or mismatched interaction error. |
| `packages/core/tests/runtime/agent-loop.test.ts` | Add direct stale-response test. |
| `packages/core/tests/server/interaction-commands.test.ts` | Add RPC acceptance test proving wrong request id does not consume pending state. |

**Verification**:

- Focused interaction and agent-loop tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 2: fix(interaction): enforce durable pending singleton

**Justification**: In-memory singleton semantics are false if storage can
rehydrate multiple pending rows for the same session/branch.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/storage/sqlite-storage.ts` | Add partial unique pending index or equivalent normalized current-interaction storage. |
| `packages/core/src/storage/interaction-storage.ts` | Make duplicate pending rows impossible or explicit migration failures. |
| `packages/core/src/server/dependencies.ts` | Rehydrate with duplicate-policy tests, not last-row-wins. |
| `packages/core/tests/storage/sqlite-storage.test.ts` | Cover duplicate pending migration policy. |
| `packages/core/tests/server/interaction-commands.test.ts` | Cover restart/rehydrate singleton behavior. |

**Verification**:

- Storage and interaction focused tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 3: fix(runtime): resolve existing session branch targets

**Justification**: Runtime commands must target a proven `(session, branch)`
pair, not raw ids where branch ownership is assumed.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/runtime/session-runtime-context.ts` | Add `resolveExistingSessionBranch` returning a branded target. |
| `packages/core/src/runtime/session-runtime.ts` | Replace session-only validation with target resolution for dispatch. |
| `packages/core/src/server/session-queries.ts` | Use the target for queue/runtime reads where applicable. |
| `packages/core/src/server/interaction-commands.ts` | Validate response target before waking runtime. |
| `packages/core/tests/runtime/session-runtime.test.ts` | Add wrong-branch, deleted-branch, and cross-session branch tests. |

**Verification**:

- Session runtime and interaction focused tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 4: fix(actor): make profile runtime ownership single-source

**Justification**: One cwd must not have multiple actor hosts writing the same
durable actor rows.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/server/dependencies.ts` | Seed `SessionProfileCache` with the launch-cwd profile built by startup. |
| `packages/core/src/runtime/session-profile.ts` | Accept canonicalized initial profiles and share profile construction from resolved runtimes. |
| `packages/core/tests/runtime/session-profile.test.ts` | Prove launch-cwd cache resolution returns the seeded profile instead of rebuilding that cwd. |

**Verification**:

- Focused profile cache test.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 5: feat(actor): add host-level actor supervision

**Justification**: Let-it-crash requires a supervising owner; silent
unregistration is not enough.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/domain/actor.ts` | Add optional behavior supervision policy and typed actor termination event. |
| `packages/core/src/runtime/extensions/actor-engine.ts` | Report actor death to host through spawn options after cleanup/unregister. |
| `packages/core/src/runtime/extensions/actor-host.ts` | Own restart budget and quarantine policy for host-spawned actors. |
| `packages/core/tests/extensions/actor-host.test.ts` | Prove defect restart and restart-budget quarantine. |

**Verification**:

- Actor engine/host focused tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 6: fix(actor): commit durable actor state at mutation boundary

**Justification**: A successful actor message reply must not precede durable
state commit when the actor is declared durable.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/runtime/extensions/actor-engine.ts` | Buffer replies until after durable state commit and report commit encode failures. |
| `packages/core/src/runtime/extensions/actor-host.ts` | Wire mutation-boundary commits to `ActorPersistenceStorage.saveActorState`; keep periodic/finalizer snapshots as compaction and graceful-shutdown backup. |
| `packages/core/tests/extensions/actor-host.test.ts` | Prove ask replies wait for mutation-boundary persistence and encode failures are immediately visible. |

**Verification**:

- Actor persistence focused tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 7: refactor(actor): clarify receive failure and dead-ref contracts

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

**Verification**:

- Actor engine and docs checks.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 8: feat(extension): unify server and client extension authoring

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

**Verification**:

- Extension surface locks, auto tests, TUI extension tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 9: feat(extension): add progressive helper kits

**Justification**: Stateful extensions currently require authors to understand
actors, resources, RPC, reactions, and client pulses too early.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/extensions/api.ts` | Add `defineToolExtension`, `defineStatefulExtension`, and `defineUiExtension`. |
| `packages/core/src/runtime/extensions/*` | Compile helper kits into existing typed buckets. |
| `packages/extensions/src/auto.ts` | Port or partially port to stateful helper. |
| `packages/core/tests/extensions/extension-authoring.test.ts` | Add complete todo-like tool + command + UI fixture. |

**Verification**:

- New authoring fixture tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 10: feat(extension): rationalize lifecycle hooks

**Justification**: Gent's typed reaction model is strong, but missing common
extension seams blocks peer-parity without raw host internals.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/domain/extension.ts` | Add typed seams for tool-before, permission, shell-env, command-before, provider params/headers, and event subscription where justified. |
| `packages/core/src/runtime/extensions/extension-reactions.ts` | Execute new hooks through serialized, typed boundaries. |
| `packages/extensions/src/**/*.ts` | Use new hooks where current builtins hand-roll equivalent behavior. |
| `packages/core/tests/extensions/extension-reactions.test.ts` | Cover ordering, failure policy, and scoped authority. |

**Verification**:

- Extension reaction focused tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 11: refactor(extension): shrink public authoring API

**Justification**: The current extension API re-exports too much internal
machinery for the happy path to be obvious.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/extensions/api.ts` | Split stable author API from advanced/internal exports. |
| `packages/core/package.json` | Add explicit subpath exports if needed. |
| `packages/extensions/src/**/*.ts` | Migrate builtins to stable imports where possible. |
| `packages/core/tests/extensions/extension-surface-locks.test.ts` | Lock what must not leak into stable authoring API. |

**Verification**:

- Typecheck and surface-lock tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 12: test(tooling): close Promise control-flow lint holes

**Justification**: Tests now ban async/await and try/finally, but still permit
Promise chains and hook cleanup outside Effect finalizers.

**Changes**:
| File | Change |
| ---- | ------ |
| `lint/no-direct-env.ts` | Extend `gent/no-promise-control-flow-in-tests` to flag `.then`, `.catch`, `.finally`, Promise-returning hooks, and `Effect.runPromise` in test bodies outside allowlisted harnesses. |
| `packages/tooling/tests/fixtures.test.ts` | Add invalid/valid fixtures. |
| `apps/tui/tests/file-refs.test.ts` | Migrate Promise chains to Effect style. |
| `apps/tui/tests/shell.test.ts` | Migrate Promise-returning tests to Effect style. |
| `packages/e2e/tests/supervisor.test.ts` | Replace Promise waits with Effect/Deferred harness helpers. |

**Verification**:

- Tooling fixture tests.
- TUI/e2e focused tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 13: test: migrate temp-dir lifecycle to scoped Effect resources

**Justification**: Global hook temp dirs and sync teardown hide cleanup from
Effect finalizers.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/tests/extensions/storage.test.ts` | Replace global temp dir hooks with scoped helper. |
| `packages/core/tests/extensions/memory/tools.test.ts` | Same migration. |
| `packages/core/tests/extensions/memory/projection.test.ts` | Same migration. |
| `packages/core/tests/extensions/memory/vault.test.ts` | Same migration. |
| `packages/core/tests/helpers/*` | Add shared `makeTemporaryDir` Effect helper if current platform helper is insufficient. |

**Verification**:

- Focused memory/storage tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 14: refactor(runtime): replace RuntimeComposer with explicit builders

**Justification**: `RuntimeComposer` concentrates override maps, casts, memo
map rules, and merge order into a generic abstraction that is harder to audit
than explicit runtime factories.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/runtime/composer.ts` | Characterize behavior, then replace with explicit builders or delete. |
| `packages/core/src/runtime/agent/agent-runner.ts` | Use `buildEphemeralRuntime` / equivalent named factory. |
| `packages/core/src/server/dependencies.ts` | Use `buildServerRuntime` and `buildCwdRuntime`. |
| `packages/core/tests/runtime/scope-brands.test.ts` | Preserve override-family and memo-map tests against explicit builders. |

**Verification**:

- Runtime/scope tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 15: refactor(extension): consolidate erasure membranes

**Justification**: Repeated local casts and suppressions in runtime composition
and extension plumbing should live behind named, auditable helpers.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/runtime/extensions/effect-membrane.ts` | Add named helpers such as `eraseLayer`, `eraseContextKey`, and `omitErasedContext`. |
| `packages/core/src/runtime/composer.ts` or replacements | Move local erasures into helpers. |
| `packages/core/src/runtime/extensions/receptionist.ts` | Reuse helpers where applicable. |
| `packages/core/src/runtime/extensions/actor-engine.ts` | Reuse helpers where applicable. |

**Verification**:

- Typecheck proves behavior.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 16: refactor(tui): split client provider ownership

**Justification**: `apps/tui/src/client/context.tsx` is a god provider that
owns transport lifecycle, sessions, models, event feeds, extension pulses,
metrics, mutations, and actions.

**Changes**:
| File | Change |
| ---- | ------ |
| `apps/tui/src/client/context.tsx` | Split into focused providers while preserving consumer behavior. |
| `apps/tui/src/client/session-subscription.ts` | Own event feed and subscription lifecycle. |
| `apps/tui/src/extensions/context.tsx` | Own extension pulse/refetch lifecycle. |
| `apps/tui/src/hooks/use-cache.ts` and `apps/tui/src/hooks/use-runtime.ts` | Route through typed adapters instead of call-site casts. |
| `apps/tui/tests/**/*.ts*` | Update tests to narrower providers. |

**Verification**:

- TUI tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 17: refactor(storage): make storage sub-tags real implementation boundaries

**Justification**: Storage has sub-tags, but `sqlite-storage.ts` still owns
schema, migrations, aggregates, FTS, and query implementations in one file.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/storage/sqlite-storage.ts` | Shrink to composition/assembler. |
| `packages/core/src/storage/schema.ts` | Move schema constants and init. |
| `packages/core/src/storage/migrations/*.ts` | Move FK/FTS/versioned migrations. |
| `packages/core/src/storage/impl/*.ts` | Split sessions, branches, messages, events, actors, checkpoints, interactions, and search. |
| `packages/core/tests/storage/sqlite-storage.test.ts` | Keep behavior locked; add fresh-schema equals migrated-schema test. |

**Verification**:

- Storage suite.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 18: refactor(agent-loop): extract remaining turn phases

**Justification**: `agent-loop.ts` remains a mixed orchestration module even
after Wave 13's first carve-outs.

**Changes**:
| File | Change |
| ---- | ------ |
| `packages/core/src/runtime/agent/agent-loop.ts` | Keep public service/coordinator only. |
| `packages/core/src/runtime/agent/phases/*.ts` | Extract event commit, stream, tool, interaction, recovery, and resolution phases. |
| `packages/core/src/runtime/agent/agent-loop.state.ts` | Keep state transitions pure and testable. |
| `packages/core/tests/runtime/agent-loop*.test.ts` | Add phase-focused tests where cheap; keep integration tests. |

**Verification**:

- Agent-loop focused tests.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 19: refactor(tests): remove process-shaped active test modules

**Justification**: `batch12-modules` describes migration history, not product
or behavior.

**Changes**:
| File | Change |
| ---- | ------ |
| `apps/tui/batch12-modules/**` | Move real suites into behavior-named `apps/tui/tests` or `apps/tui/integration`; delete the process-shaped directory. |
| `apps/tui/tests/*.test.ts*` | Replace trampoline imports with direct test contents. |
| `packages/tooling/fixtures/**` | Rename process-shaped fixtures to rule/behavior names. |

**Verification**:

- TUI tests and tooling fixtures.
- Full gate.
- One Codex review plus one Okra counsel attempt.

## Batch 20: docs: align actor, extension, and runtime contracts

**Justification**: Docs should describe current state and explicit non-goals,
not migration-era optimism.

**Changes**:
| File | Change |
| ---- | ------ |
| `docs/actor-model.md` | Align supervision, durability, mailbox replay, and failure semantics with implementation. |
| `ARCHITECTURE.md` | Update runtime composition, extension authoring, and storage boundaries. |
| `AGENTS.md` | Update testing guidance after Promise/temp-dir migrations. |
| `plans/WAVE-14.md` | Record final completion receipts. |

**Verification**:

- Docs grep for stale process-shaped terms.
- Full gate.
- One final recursive audit: one Codex subagent plus one Okra counsel attempt across all lanes, P0/P1/P2 only.

## Open Risks

- Counsel deep runs timed out twice in this session before producing
  `claude.md`. Treat Wave 14 Batch 1 as the first chance to rerun Okra counsel
  if the tool is healthy; do not fabricate counsel findings.
- Some line numbers may drift as batches land. Keep every review grounded in
  current file/line receipts at the time of that batch.
- Several batches are high blast radius. Use sub-commits inside a batch when a
  single change would cross 20+ files or multiple subsystems.

## Current Status

- Wave 14 plan created from independent five-lane Codex audit.
- Batch 1 implemented:
  - Branded interaction response ids across session runtime, agent loop command
    schema, loop driver events, and waiting state.
  - Added `InteractionRequestMismatchError` and an approval-service
    `pendingRequestId` boundary so RPC responses reject stale ids before
    storing resolutions, waking loops, resolving storage, or publishing
    `InteractionResolved`.
  - Added loop-level stale response guard so direct loop dispatch leaves the
    branch in `WaitingForInteraction` when ids do not match.
  - Added direct loop, loop-command schema, session-runtime, and RPC acceptance
    coverage for the stale-id invariant.
  - Focused gate: `bun test packages/core/tests/runtime/agent-loop-commands.test.ts packages/core/tests/server/interaction-commands.test.ts packages/core/tests/runtime/agent-loop.test.ts packages/core/tests/runtime/session-runtime.test.ts --timeout 20000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd91d-afec-7a41-8856-a789c71244fd`; P2 branded
    `AgentLoop.respondInteraction` gap fixed in-batch.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output, matching the documented
    counsel instability risk.
- Batch 2 implemented:
  - Added startup repair for legacy duplicate pending `interaction_requests`
    rows, keeping newest pending by `(created_at DESC, request_id DESC)` and
    marking older duplicates resolved.
  - Added partial unique index
    `idx_interaction_requests_pending_singleton` on `(session_id, branch_id)`
    where `status = 'pending'`.
  - Changed durable interaction persistence to fail closed before publishing a
    new interaction, so rejected singleton persists cannot create non-durable
    UI requests.
  - Added storage migration coverage, direct storage uniqueness coverage, and a
    service-level fail-closed regression for duplicate pending persistence.
  - Focused gate: `bun test packages/core/tests/domain/interaction-request.test.ts packages/core/tests/storage/sqlite-storage.test.ts --timeout 20000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd924-fe5b-7692-abff-2bca898dd598`; P1 swallowed
    persist failure fixed in-batch.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output.
- Batch 3 implemented:
  - Added `resolveExistingSessionBranch` as the shared durable target resolver
    for `(sessionId, branchId)` pairs.
  - Changed `SessionRuntime` dispatch, queue, state, metrics, and watch
    boundaries to reject missing or cross-session branches before touching
    loop state.
  - Changed `InteractionCommands.respond` to validate the branch target before
    storing resolutions, waking runtime state, resolving storage, or publishing
    `InteractionResolved`.
  - Added runtime regression coverage for cross-session branch dispatch and
    missing-branch reads.
  - Focused gate: `bun test packages/core/tests/runtime/session-runtime.test.ts --timeout 20000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd92e-528b-7083-8ee6-87cee1bdbf70`; no P0/P1/P2
    findings.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output.
- Batch 4 implemented:
  - Added `SessionProfileCacheConfig.initialProfiles` and canonicalized initial
    cache keys with `Path.resolve`, so launch-cwd aliases reuse the seeded
    profile.
  - Extracted `sessionProfileFromRuntime` so startup and lazy cwd resolution
    build identical `SessionProfile` values from the resolved runtime owner.
  - Changed `createDependencies` to seed `SessionProfileCache` from the launch
    profile built during server startup, preventing a second actor host/runtime
    owner for the launch cwd.
  - Added `SessionProfileCache` coverage proving `cache.resolve(join(cwd, "."))`
    returns the seeded launch profile by identity instead of rebuilding.
  - Focused gate: `bun test packages/core/tests/runtime/session-profile.test.ts --timeout 20000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd94c-9d9b-7ec2-a103-211118468ec2`; no P0/P1/P2
    findings.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output.
  - Gate note: one first full-gate run hit a transient
    `tests/utils/run-process.test.ts` timeout; the focused file, `bun run test`,
    and the repeated full gate all passed without code changes.
- Batch 5 implemented:
  - Added optional `Behavior.supervision` with `"always"` / `"never"` restart
    policy and max-restart budget.
  - Added typed `ActorTerminated` exit reporting from `ActorEngine.spawn` after
    mailbox cleanup, persistence claim release, and receptionist unregister.
  - Changed `ActorHost` to own actor restart/quarantine decisions, recording
    actor deaths and exhausted restart budgets through `ActorHostFailures`.
  - Preserved durable restore fail-closed semantics: corrupt rows still skip
    the actor instead of restarting from initial state.
  - Added host-level tests proving a defected actor is replaced and a
    zero-budget actor is quarantined.
  - Focused gate: `bun test packages/core/tests/runtime/actor-engine.test.ts packages/core/tests/extensions/actor-host.test.ts --timeout 20000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd956-ec6f-7c71-bbb4-e620f301a2d1`; no P0/P1/P2
    findings.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output.
- Batch 6 implemented:
  - Changed `ActorContext.reply` delivery so ask replies are buffered during
    `receive` and released only after state update plus durable commit.
  - Added `SpawnOptions.onStateCommitted` for durable write-through after a
    changed durable state encodes successfully.
  - Added `SpawnOptions.onCommitFailure` so mutation-boundary encode failures
    are recorded through host health immediately, not only by a later periodic
    snapshot.
  - Wired `ActorHost.fromResolvedWithPersistence` to save committed durable
    rows through `ActorPersistenceStorage.saveActorState`, while preserving
    periodic/finalizer snapshots as backup/compaction.
  - Added regression coverage proving failed mutation-boundary persistence
    withholds an ask reply and records `ActorHostFailures`, and proving encode
    failure is immediately visible.
  - Focused gate: `bun test packages/core/tests/runtime/actor-engine.test.ts packages/core/tests/extensions/actor-host.test.ts packages/core/tests/runtime/actor-persistence.test.ts --timeout 20000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd95e-2382-7560-92cc-be93e0971dab`; P2 immediate
    encode-failure visibility fixed in-batch.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output.
- Batch 7 implemented:
  - Kept `Behavior.receive` defect-only (`E = never`) and documented that
    recoverable behavior outcomes belong in actor state or typed replies.
  - Renamed the surviving typed-failure path from receive failure to runtime
    step failure, because the only intended recoverable typed failure there is
    boundary work such as durable commit hooks.
  - Replaced the artificial typed receive-failure test with a real runtime
    commit-failure continuation test.
  - Documented the dead-ref contract: unknown `tell` no-ops, unknown `ask`
    times out, state/view reads are empty/undefined, and receptionist liveness
    is maintained by actor cleanup rather than a second death-watch policy.
  - Focused gate: `bun test packages/core/tests/runtime/actor-engine.test.ts`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd965-af54-77d1-886f-657b3cf52d24`; no P0/P1/P2
    findings.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output.
- Batch 8 implemented:
  - Added a typed `defineExtension({ client })` facet that preserves the exact
    client-side object on the shared extension artifact while keeping core
    server setup oblivious to client runtime types.
  - Added TUI `defineClientExtension(sharedExtension)` lowering so clients can
    derive their module id from the shared server manifest and reuse the
    facet's setup Effect.
  - Ported the auto TUI builtin to derive `@gent/auto` from `AutoExtension`
    instead of duplicating the extension id literal.
  - Added core and TUI regression tests for client-facet preservation and
    lowering.
  - Focused gate: `bun test packages/core/tests/extensions/define-extension.test.ts apps/tui/tests/extension-client-facets.test.ts apps/tui/tests/extension-effect-setup.test.ts apps/tui/tests/extensions-resolve.test.ts`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd96b-cfc5-7780-8c29-1432582c8170`; no P0/P1/P2
    findings.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output.
- Batch 9 implemented:
  - Added progressive extension helper kits:
    `defineToolExtension`, `defineStatefulExtension`, and
    `defineUiExtension`.
  - Preserved exact client facet typing for helper-authored shared artifacts,
    including stateful helpers that lower into TUI client modules.
  - Ported `AutoExtension` to `defineStatefulExtension` as the stateful helper
    proof case.
  - Added core regression coverage proving helper-authored extensions compile
    into the normal typed contribution buckets.
  - Added TUI regression coverage proving client-bearing stateful helper
    artifacts lower through `defineClientExtension`.
  - Focused gate: `bun test packages/core/tests/extensions/define-extension.test.ts packages/core/tests/extensions/extension-surface-locks.test.ts packages/core/tests/extensions/auto.test.ts apps/tui/tests/extension-client-facets.test.ts`.
  - Focused transient rerun: `bun test packages/core/tests/utils/run-process.test.ts --timeout 30000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd973-cc6f-7790-a75f-e73a88850012`; P2 helper client
    typing gap fixed in-batch.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output.
- Batch 10 implemented:
  - Added typed reaction seams for `messageInput`, `contextMessages`,
    `permissionCheck`, and `toolExecute`.
  - Wired the seams through `compileExtensionReactions` with scope-ordered
    composition and isolated failure handling, matching existing
    `systemPrompt` / `toolResult` behavior.
  - Preserved the base permission service and base tool execution as the first
    authoritative step before extension interceptors.
  - Added focused reaction tests for pass-through behavior, ordering, failure
    isolation, permission decision composition, and tool execution wrapping.
  - Focused gate: `bun test packages/core/tests/extensions/extension-reactions.test.ts --timeout 20000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd97e-9f0f-70a1-895c-ee500abecd57`; no P0/P1/P2
    findings.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output.
- Batch 11 implemented:
  - Added `@gent/core/extensions/authoring` as the smaller stable authoring
    entrypoint for default extension authors.
  - Kept advanced runtime/provider/process plumbing on explicit advanced
    imports or the full-power `extensions/api` facade during migration.
  - Added package subpath exports for `./extensions/authoring` and
    `./extensions/authoring.js`.
  - Added compile-time locks proving the stable entrypoint exposes happy-path
    authoring helpers but not runtime engines, provider internals, driver
    internals, storage details, or subprocess execution helpers.
  - Focused gate: `bun test packages/core/tests/extensions/extension-surface-locks.test.ts --timeout 20000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd983-76e7-7c82-8d39-78f6542d5222`; P2 `runProcess`
    leak fixed in-batch.
  - Okra counsel attempt: one `okra counsel --deep` run was started and killed
    by the 180s batch timeout with no usable output.
- Batch 12 implemented:
  - Extended `gent/no-promise-control-flow-in-tests` to reject Promise-chain
    methods, raw Promise constructors, and `Promise.resolve/reject` in active
    test files and migration test modules.
  - Migrated active test helpers and fixtures to Effect scopes, `Deferred`,
    `Effect.sleep`, `Effect.yieldNow`, and explicit runtime boundaries.
  - Added/updated invalid fixtures for the widened Promise control-flow rule.
  - Focused gate: `bun test packages/tooling/tests/fixtures.test.ts apps/tui/tests/file-refs.test.ts apps/tui/tests/shell.test.ts apps/tui/tests/external-editor.test.ts --preload ./apps/tui/node_modules/@opentui/solid/scripts/preload.ts --timeout 30000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Codex review: `019dd991-6d88-7520-a33b-5c887528120a`; no P0/P1/P2
    findings.
  - Okra counsel attempt:
    `/tmp/counsel/personal-gent-860892a9/20260429-140804-codex-to-claude-395009/claude.md`;
    P1 raw Promise loophole and P2 formatting/count issues fixed in-batch.
- Batch 13 implemented:
  - Added shared scoped temp-dir helper backed by
    `FileSystem.makeTempDirectoryScoped`.
  - Migrated extension storage and memory vault/tool/projection tests away
    from global temp-dir hooks and sync teardown into `it.scopedLive` Effect
    resources.
  - Removed top-level storage runtime execution from validation tests so
    storage creation and operations run inside the scoped platform layer.
  - Consolidated memory temp-dir boilerplate and documented the single
    ToolToken dependency-erasure membrane used by memory tool tests.
  - Focused gate: `bun test packages/core/tests/extensions/storage.test.ts packages/core/tests/extensions/memory/tools.test.ts packages/core/tests/extensions/memory/projection.test.ts packages/core/tests/extensions/memory/vault.test.ts --timeout 30000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Gate note: one first full-gate run hit a transient
    `tests/extensions/exec-tools/bash.test.ts` stdout timeout; the focused
    BashTool file and repeated `bun run test` both passed without code
    changes.
  - Codex review: `019dd99f-7f49-70c1-9616-e72b5c60904e`; no P0/P1/P2
    findings.
  - Okra counsel attempt:
    `/tmp/counsel/personal-gent-860892a9/20260429-142328-codex-to-claude-a28e4c/claude.md`;
    P2 top-level runtime/helper duplication/erased tool-effect notes fixed
    in-batch.
- Batch 14 implemented:
  - Replaced the fluent `RuntimeComposer` API with explicit
    `buildEphemeralRuntime({ parent, parentServices, overrides,
extensionLayers })`.
  - Kept storage sub-Tag omission, EventPublisher/BuiltinEventSink family
    omission, `Layer.CurrentMemoMap` stripping, `Layer.fresh`, child override
    merge-last behavior, and `ServerProfile` proof-of-origin.
  - Tightened override slot types so each child-owned service family must
    provide its expected service instead of relying on an unconstrained
    generic builder claim.
  - Updated scope-brand tests for cross-scope rejection, override-family
    typing, storage sub-Tag omission, event-publisher family omission,
    finalizer attachment, and parent memo-map replacement.
  - Updated `AGENTS.md`, `ARCHITECTURE.md`, and runtime comments that still
    described the deleted fluent API.
  - Focused gate: `bun test packages/core/tests/runtime/scope-brands.test.ts packages/core/tests/runtime/agent-runner.test.ts --timeout 30000`.
  - Full gate: `bun run typecheck && bun run lint && bun run test`.
  - Gate note: full test initially hit transient subprocess timeouts in
    `tests/utils/run-process.test.ts` and `tests/extensions/exec-tools/bash.test.ts`;
    both focused files passed, and the repeated full test passed after
    stopping the timed-out counsel process.
  - Codex review: `019dd9a9-a8a2-7122-82a5-8365c85f5ddd`; P2 override typing,
    type-fence coverage, memo-map coverage, and stale docs fixed in-batch.
  - Okra counsel attempt:
    `/tmp/counsel/personal-gent-860892a9/20260429-143435-codex-to-claude-285ba8`;
    timed out with no usable findings and was stopped to unblock the gate.
- P0 findings: none.
- P1 findings: interaction invariants, actor ownership/supervision/durability,
  extension authoring split/public surface breadth, runtime composition
  simplification, and test Promise/lifecycle lint gaps.
