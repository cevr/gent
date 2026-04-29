# Planify: Wave 13 — Actor-Native Correctness + Extension Parity

## Context

Wave 12 closed the old extension substrate cleanup. The fresh Wave 13
audit was intentionally broader: five lanes, each reviewed by one Codex
subagent and one Okra/Opus counsel run, grounded in
`/Users/cvr/.brain/principles/` and current source receipts.

The result is not another naming cleanup. The blockers are structural:
runtime correctness depends on silent repair, recovery swallow paths,
manual state synchronization, and non-actor control planes; extension
parity is missing typed lifecycle seams; suppression policy is porous
enough that future bugs can hide.

## Scope

- **In**: suppressions, storage integrity, agent loop recovery, actor
  supervision, worker supervisor, extension authoring/context/reactions,
  package/dynamic extension parity, runtime/TUI simplification,
  docs and independent Wave 14 discovery.
- **Out**: swapping away from Effect, replacing SQLite, copying pi-mono's
  broad imperative `pi.*` API, Promise-based extension APIs, and
  user-data-destructive repairs without an explicit CLI.

## Constraints

- Stay within Effect, Bun, SQLite, OpenTUI/Solid, and the current package
  structure unless a batch explicitly narrows it.
- No compatibility shims for deleted public surfaces.
- Each batch gets exactly one review round: one Codex subagent and one
  Okra counsel review. P0/P1/P2 findings block the next batch.
- Gate after every batch: `bun run typecheck && bun run lint && bun run test`.
- High-blast-radius batches may contain sub-commits, but the review round
  is per batch, not per sub-commit.
- Final batch is independent discovery: launch fresh Codex subagents and
  Okra counsel across all five lanes again, but brief them to ignore this
  plan's implementation narrative and produce `plans/WAVE-14.md` from the
  codebase, principles, and external repo receipts as they exist then.

## Applicable Skills

`planify`, `repo`, `counsel`, `architecture`, `effect-v4`, `test`,
`code-style`, `bun`, `review`

## Gate Command

```bash
bun run typecheck && bun run lint && bun run test
```

## Research Streams

| Lane              | Codex                                  | Okra / Opus                                                                            |
| ----------------- | -------------------------------------- | -------------------------------------------------------------------------------------- |
| Simplification    | `019dd6d3-5370-7970-8d2e-1f08087aac96` | `/tmp/counsel/personal-gent-860892a9/20260429-012138-codex-to-claude-aad014/claude.md` |
| Correctness       | `019dd6d3-5393-77b0-b139-8d8d60a718ec` | `/tmp/counsel/personal-gent-860892a9/20260429-012138-codex-to-claude-5d82df/claude.md` |
| Actor north star  | `019dd6d3-53a7-7561-b66d-e195a5bb3894` | `/tmp/counsel/personal-gent-860892a9/20260429-012138-codex-to-claude-c97b70/claude.md` |
| Extension system  | `019dd6d3-53b9-7f22-99b7-7a77875bf52a` | `/tmp/counsel/personal-gent-860892a9/20260429-012139-codex-to-claude-374ee7/claude.md` |
| Lint suppressions | `019dd6d3-53d0-78c0-944b-7740a91081d5` | `/tmp/counsel/personal-gent-860892a9/20260429-012139-codex-to-claude-f73836/claude.md` |

## Principle Grounding

| Principle                                                                | Application                                                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`            | Fix root architecture even when the answer is a large rearchitecture.                                           |
| `/Users/cvr/.brain/principles/redesign-from-first-principles.md`         | Treat actors, recovery, storage, and extension parity as foundational, not bolt-ons.                            |
| `/Users/cvr/.brain/principles/subtract-before-you-add.md`                | Delete blanket suppressions, dead deps, stale trampolines, and shallow abstractions before adding new surfaces. |
| `/Users/cvr/.brain/principles/small-interface-deep-implementation.md`    | Narrow extension/TUI/runtime public surfaces while absorbing complexity behind deep modules.                    |
| `/Users/cvr/.brain/principles/boundary-discipline.md`                    | Decode JSON/foreign SDK data at boundaries; trust typed internals.                                              |
| `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md` | Replace flags, optional fallbacks, and wide message shapes with discriminated lifecycle states.                 |
| `/Users/cvr/.brain/principles/derive-dont-sync.md`                       | Remove duplicate active-branch, idle-persisted, metrics, and delivery state.                                    |
| `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`       | Use actor mailboxes, single-writer queues, WAL/busy timeout, and serialized dispatch.                           |
| `/Users/cvr/.brain/principles/prove-it-works.md`                         | Add failure-injection and restart tests before claiming correctness.                                            |
| `/Users/cvr/.brain/principles/test-through-public-interfaces.md`         | Golden extension parity tests use public authoring/transport surfaces.                                          |
| `/Users/cvr/.brain/principles/encode-lessons-in-structure.md`            | Replace comment suppressions with tooling, typed builders, documented waivers, and explicit review invariants.  |

## Synthesis

### Agreed Findings

- Suppression cleanup must come first. Blanket disables in
  `apps/tui/batch12-modules/**`, broad test overrides, and scattered
  erasure comments reduce the trustworthiness of later gates.
- Process-shaped names are code smell in source and test trees. Names such
  as `batch12`, `wave13`, or `planify-migration` describe how work happened,
  not what the system does; they belong in `plans/` receipts, not active
  product paths. Do not add a bespoke lint rule for this; make it an
  explicit Wave 13 review invariant and remove existing instances while
  touching the affected areas.
- Failure-injection layers are required before recovery/storage fixes.
  Without `Storage.Failing`/`EventStore.Failing`/checkpoint failing
  harnesses, the correctness claims cannot be directly proven.
- Storage currently performs dangerous startup work. Unconditional FK
  orphan repair and FTS rebuild belong behind explicit migrations or CLI
  repair paths, not normal boot.
- The agent loop is the largest correctness and simplification target.
  Codex called it a god module; Opus called it the system's biggest
  non-actor. Both converge on actor-native or actor-shaped ownership.
- Actor north star requires supervision, durable ownership, and explicit
  absence semantics. Let-it-crash cannot mean let-it-disappear.
- Extension parity should add typed lifecycle/input/tool/context seams,
  package metadata, dynamic contribution support, command completions, and
  tool progress without copying pi-mono's wide imperative API.

### Divergent Findings Resolved

- Opus actor lane marked the non-actor agent loop and worker supervisor as
  P0, while Codex north-star marked similar issues P1/P2. This plan treats
  both as blocking architecture work and schedules them after the
  failure-injection/storage foundation.
- Simplification suggested decomposing `agent-loop.ts` before semantic
  actorization; actor lane suggested making it an actor directly. This
  plan splits commands/recovery/turn phases first only where it lowers
  review risk, then converts ownership to an actor boundary.
- Extension counsel proposed a lifecycle bus as the core mechanism; Codex
  proposed named typed reaction buckets. This plan uses a typed lifecycle
  event model internally, but exposes small named reaction buckets to
  authors.

## External Repo Receipts

- pi-mono's extension surface is broad and imperative:
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1069`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1117`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1193`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1294`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:760`.
- pi-mono examples define the parity target:
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts:121`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/input-transform.ts:14`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/dynamic-tools.ts:24`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/dynamic-resources/index.ts:7`.
- opencode demonstrates narrower Effect services:
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/plugin/index.ts:40`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/tool/tool.ts:34`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/effect/runner.ts:3`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:55`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/run-state.ts:9`.

---

## Batch 1: test: restore suppression signal

**Justification**: The lint lane found active blanket disables and dead
suppression comments. Later gates only matter if lint signal is trusted.

**Principles**:

- `correctness-over-pragmatism`: no blanket silence of correctness rules.
- `encode-lessons-in-structure`: encode suppression policy in tooling.
- `prove-it-works`: re-run the real lint gate after removal.

**Skills**: `test`, `bun`, `code-style`

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `apps/tui/batch12-modules/tests/*.ts*` | Remove blanket `/* eslint-disable */`; replace only genuine cases with rule-named line suppressions. | ~1 |
| `apps/tui/batch12-modules/integration/*.tsx` | Same blanket removal. | ~1 |
| `apps/tui/batch12-modules/tests/extension-lifecycle.module.ts` | Replace `["awa" + "it"]` obfuscation with `Deferred.await`. | ~18-24 |
| `packages/tooling/src/blanket-eslint-disable.ts` | Add checker banning blanket `eslint-disable` comments; oxlint plugin diagnostics cannot enforce this because the directive suppresses the diagnostic that would report it. | new |
| `packages/tooling/src/check-blanket-eslint-disable.ts` | Wire checker into the lint gate over tracked and untracked source files. | new |
| `packages/tooling/tests/blanket-eslint-disable.test.ts` | Prove blanket disables fail and rule-named suppressions remain legal. | new |
| `package.json` | Run the blanket-disable checker as part of `bun run lint`. | lint script |

**Verification**:

- `bun run lint`
- `bun run test`
- Review round: launch one Codex subagent and one Okra counsel review for this batch only.

---

## Batch 2: chore: delete dead suppression comments

**Justification**: Dead comments train reviewers to ignore real
suppression boundaries.

**Principles**:

- `subtract-before-you-add`: delete no-op suppressions before deeper lint work.
- `fix-root-causes`: remove comments made obsolete by override config.

**Skills**: `bun`, `code-style`

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/tests/**/*.ts` | Remove dead disables for `no-explicit-any`, `no-non-null-assertion`, `no-unsafe-type-assertion` already disabled by test override; keep `@ts-expect-error` proofs. | many |
| `apps/tui/tests/**/*.ts*` | Same dead-disable sweep. | many |
| `packages/extensions/src/anthropic/oauth.ts` | Remove dead `no-process-env` comments under existing override. | ~534, ~711 |

**Verification**:

- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 3: test: add failing runtime layers

**Justification**: Storage, event, checkpoint, and recovery correctness
cannot be proven without deterministic failure injection.

**Principles**:

- `prove-it-works`: directly observe failure paths.
- `test-through-public-interfaces`: faults enter through service layers.
- `fix-root-causes`: reproduce the root failure, not only happy paths.

**Skills**: `test`, `effect-v4`, `bun`

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/test-utils/failing-layers.ts` | Add `Storage.Failing`, `EventStore.Failing`, checkpoint/interaction/storage operation fault wrappers or standalone helpers. | new |
| `packages/core/src/test-utils/index.ts` | Export failing-layer helpers. | exports |
| `packages/core/tests/test-utils/failing-layers.test.ts` | Prove each helper faults selected operations and preserves others. | new |

**Verification**:

- Focused failing-layer tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 4: fix(storage): make sqlite startup fail closed

**Justification**: Startup must not silently delete user data or hide
database corruption.

**Principles**:

- `correctness-over-pragmatism`: no destructive repair on normal boot.
- `fix-root-causes`: quarantine/report state corruption.
- `boundary-discipline`: schema initialization is a DB boundary.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/storage/sqlite-storage.ts` | Remove unconditional `repairForeignKeyOrphans`; call integrity assertion and return typed startup failure. | ~520-553, ~1037 |
| `packages/core/src/storage/db-repair-log.ts` | Add repair-log schema/types if needed. | new |
| `apps/server/src/main.ts` or CLI command module | Add explicit `gent db:repair --dry-run/--yes` path if CLI exists; otherwise add internal repair service plus TODO-free command hook. | relevant |
| `packages/core/tests/storage/sqlite-storage.test.ts` | Replace silent-delete expectations with fail-closed and explicit repair tests. | migration tests |

**Verification**:

- Storage corruption tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 5: fix(storage): version fts and enable sqlite durability pragmas

**Justification**: Search rebuild and missing WAL/busy timeout are shared
state hazards.

**Principles**:

- `serialize-shared-state-mutations`: SQLite is shared mutable state.
- `derive-dont-sync`: FTS is a projection, not startup truth.
- `prove-it-works`: add concurrency/chaos receipts.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/storage/sqlite-storage.ts` | Add WAL, `synchronous=NORMAL`, `busy_timeout`, `wal_autocheckpoint`; move FTS drop/rebuild behind versioned migration. | ~870-1083 |
| `packages/core/src/storage/migrations/*` | Add versioned FTS migration if storage has migration folder after split, or local migration helpers first. | new/updated |
| `packages/core/tests/storage/sqlite-storage.test.ts` | Assert PRAGMAs and FTS migration runs once; add parallel writer test. | storage tests |

**Verification**:

- Focused storage tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 6: refactor(agent-loop): split commands recovery and turn phases

**Justification**: The agent loop is too large to safely rearchitect in
place. Split first where behavior remains identical.

**Principles**:

- `small-interface-deep-implementation`: reduce reader surface.
- `redesign-from-first-principles`: prepare the actor-native shape.
- `subtract-before-you-add`: carve before semantic changes.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/runtime/agent/agent-loop.ts` | Shrink to orchestration/public layer. | broad |
| `packages/core/src/runtime/agent/agent-loop.commands.ts` | Move `LoopCommand` variants and `AgentLoopError`. | new |
| `packages/core/src/runtime/agent/phases/*.ts` | Extract record-tool-result, resolve-turn, run-stream, execute-tools, finalize, persist helpers. | new |
| `packages/core/src/runtime/agent/recovery/*.ts` | Extract recovery decision/failure helpers. | new |
| `packages/core/src/runtime/agent/turn-response/*.ts` | Extract model/external response collectors. | new |
| `packages/core/tests/runtime/agent-loop*.test.ts` | Adjust imports and add focused tests for extracted pure functions where cheap. | tests |

**Verification**:

- Agent-loop focused tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 7: fix(agent-loop): make recovery outcomes explicit

**Justification**: Checkpoint load/decode/version failures currently
collapse into Idle or deletion.

**Principles**:

- `make-impossible-states-unrepresentable`: model recovery outcomes.
- `fix-root-causes`: record why recovery failed.
- `prove-it-works`: inject checkpoint/storage failures.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/runtime/agent/agent-loop.checkpoint.ts` | Add `RecoveryOutcome` schema and audit payloads. | recovery area |
| `packages/core/src/runtime/agent/recovery/*.ts` | Use `Deferred<RecoveryOutcome, AgentLoopError>` instead of `started: boolean`; fail closed on fatal storage errors. | recovery |
| `packages/core/src/domain/event.ts` | Add `AgentLoopRecoveryAbandoned` or equivalent typed runtime event. | event variants |
| `packages/core/src/storage/sqlite-storage.ts` | Add recovery audit storage if event-only is insufficient. | storage |
| `packages/core/tests/runtime/agent-loop-recovery.test.ts` | Cover Idle/Running/WaitingForInteraction checkpoints, decode failure, version mismatch, unreadable storage. | new |

**Verification**:

- Recovery tests with failing layers.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 8: fix(agent-loop): remove synchronized side refs

**Justification**: `idlePersistedRef`, `turnFailureRef`, active stream
handles, and `started` duplicate facts already belonging to loop state.

**Principles**:

- `derive-dont-sync`: one canonical state.
- `make-impossible-states-unrepresentable`: state variants own meaningful fields.
- `serialize-shared-state-mutations`: one mutation boundary.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/runtime/agent/agent-loop.state.ts` | Add `Initializing` and epoch/failure fields to state variants. | state |
| `packages/core/src/runtime/agent/*` | Replace side refs with state projection/subscription. | loop |
| `packages/core/src/runtime/session-runtime.ts` | Expand `LoopRuntimeState` projection with real public fields (`interactive`, current agent, pending interaction, run spec where needed). | ~state projection |
| `apps/tui/src/**` | Consume expanded projection rather than syncing extra queries where applicable. | TUI |
| `packages/core/tests/runtime/agent-loop.test.ts` | Update transition assertions. | tests |

**Verification**:

- Runtime state subscription tests.
- TUI tests that consume session state.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 9: fix(events): serialize event delivery

**Justification**: `Effect.yieldNow` and unsynchronized idempotency are
scheduler coupling, not correctness.

**Principles**:

- `serialize-shared-state-mutations`: event delivery is a mailbox.
- `derive-dont-sync`: delivery derives from committed events.
- `prove-it-works`: crash/replay behavior must be tested.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/server/event-publisher.ts` | Replace yield-dependent delivery with serialized dispatcher/idempotent Ref/queue. | ~32-65 |
| `packages/core/src/runtime/event-store-live.ts` | Add redelivery/watermark support if required. | ~51-66 |
| `packages/core/tests/server/event-publisher.test.ts` | Add concurrent deliver and no-yield tests. | tests |
| `packages/e2e/tests/queue-contract.test.ts` | Subscribe before dispatch rather than relying on scheduler yield. | tests |

**Verification**:

- Event publisher focused tests.
- Queue contract e2e if fast enough; otherwise focused package command plus root test.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 10: fix(interaction): persist cold responses

**Justification**: Interaction responses are currently memory-only
between response and resumed tool consumption.

**Principles**:

- `correctness-over-pragmatism`: no lost approvals on restart.
- `make-impossible-states-unrepresentable`: `Pending -> Resolved -> Consumed`.
- `serialize-shared-state-mutations`: concurrent interactions need structural policy.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/domain/interaction-request.ts` | Model durable interaction lifecycle and concurrent pending behavior. | ~141-205 |
| `packages/core/src/storage/interaction-storage.ts` | Store decision payload and consumed state. | ~7-68 |
| `packages/core/src/server/interaction-commands.ts` | Persist response before wake; consume only after tool result persistence. | ~36-51 |
| `packages/core/src/runtime/agent/*` | Resume interactions from durable decision. | interaction sites |
| `packages/core/tests/server/interaction-commands.test.ts` | Add restart/lost-response tests. | tests |

**Verification**:

- Interaction restart tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 11: feat(runtime): add turn journal

**Justification**: Resume cannot safely replay multi-step turns or
partially completed tool batches without a durable execution journal.

**Principles**:

- `serialize-shared-state-mutations`: journal per tool call status.
- `make-impossible-states-unrepresentable`: resume derives from journal state.
- `prove-it-works`: crash tests at every phase.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/domain/turn-journal.ts` | Add schemas for turn id, step, tool status, pending interaction, finalization. | new |
| `packages/core/src/storage/turn-journal-storage.ts` | Durable journal storage service. | new |
| `packages/core/src/storage/sqlite-storage.ts` | Add tables/migrations/sub-tags for turn journal. | storage |
| `packages/core/src/runtime/agent/phases/*.ts` | Persist per-tool and per-step journal entries. | phases |
| `packages/core/src/runtime/agent/recovery/*.ts` | Resume by journal, not fixed step order. | recovery |
| `packages/core/tests/runtime/turn-journal.test.ts` | Crash/restart tests for streamed turn, parallel tools, interaction pending. | new |

**Verification**:

- Turn journal focused tests.
- Agent-loop recovery tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 12: fix(session): make active branch canonical

**Justification**: `sessions.active_branch_id` is written but some
queries project the first branch instead.

**Principles**:

- `derive-dont-sync`: one source of active-branch truth.
- `make-impossible-states-unrepresentable`: session has active branch after creation.
- `boundary-discipline`: transport DTOs project canonical state.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/domain/message.ts` or session domain file | Require `activeBranchId` on session info where semantically present. | ~session schema |
| `packages/core/src/storage/sqlite-storage.ts` | Query/project active branch from `sessions.active_branch_id`; migrate/repair legacy null rows. | ~1164 |
| `packages/core/src/server/session-queries.ts` | Stop first-branch fallback. | ~60-70 |
| `packages/core/src/server/session-commands.ts` | Enforce transactional active-branch updates. | ~396-422 |
| `apps/tui/src/app-bootstrap.ts` | Consume canonical `activeBranchId`. | ~39-84 |
| `apps/tui/src/routes/session-controller.ts` | Same projection cleanup. | ~698-704 |

**Verification**:

- Session switch/list/get tests.
- TUI routing tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 13: fix(storage): stop hiding projection corruption

**Justification**: Snapshot fallback to Idle/zero and event decode skip hide
real persistent failures.

**Principles**:

- `prove-it-works`: expose unavailable metrics/runtime.
- `fix-root-causes`: quarantine invalid events.
- `boundary-discipline`: projection boundaries return typed errors/variants.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/server/session-queries.ts` | Return explicit snapshot failure variants or typed RPC errors. | ~144-160 |
| `packages/core/src/server/transport-contract.ts` | Add `Ready | RuntimeUnavailable | MetricsUnavailable` shape if variant path chosen. | ~245-253 |
| `packages/core/src/storage/sqlite-storage.ts` | Decode invalid events into quarantine/envelope or typed failure instead of silent skip. | ~1501-1515 |
| `packages/core/tests/storage/sqlite-storage.test.ts` | Assert invalid event behavior and no silent drop. | ~2056 |
| `apps/tui/src/**` | Render unavailable runtime/metrics honestly. | affected |

**Verification**:

- Storage invalid-event tests.
- Session snapshot tests.
- TUI tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 14: feat(actor): introduce supervised actor cells

**Justification**: Let-it-crash must restart or mark health failed; it
cannot silently unregister and disappear.

**Principles**:

- `redesign-from-first-principles`: actors are foundational.
- `correctness-over-pragmatism`: no swallowed receive failures.
- `serialize-shared-state-mutations`: actor cell owns mailbox/state/restart.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/domain/actor.ts` | Add restart policy, `ActorUnavailable`, crash/restart status types. | ~actor types |
| `packages/core/src/runtime/extensions/actor-engine.ts` | Introduce ActorCell/Supervisor internals; unexpected receive failure crashes; restart with bounded policy. | ~220-590 |
| `packages/core/src/runtime/extensions/actor-host.ts` | Register behavior specs with supervisor; expose restart/exhaustion via `ActorHostFailures`. | ~159-404 |
| `packages/core/tests/runtime/actor-engine.test.ts` | Defect -> restart -> discoverable; failure policy; exhaustion tests. | actor tests |
| `packages/core/tests/extensions/actor-host.test.ts` | Host health for restart/exhaustion. | actor host tests |

**Verification**:

- Actor engine/host focused tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 15: fix(actor): commit durable actor state by owner

**Justification**: Durable actor messages currently acknowledge before
checkpoint persistence, losing up to one interval on crash.

**Principles**:

- `serialize-shared-state-mutations`: owner commits state.
- `derive-dont-sync`: sampler is a synced copy, not owner truth.
- `prove-it-works`: crash after message must restore committed state.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/runtime/extensions/actor-engine.ts` | For durable actors, commit encoded state after receive and before ask reply/state publish. | receive loop |
| `packages/core/src/runtime/extensions/actor-host.ts` | Remove or demote periodic writer after per-message commit; keep flush as fallback if needed. | writer |
| `packages/core/src/storage/actor-persistence-storage.ts` | Add per-actor commit API if current save is sufficient no change. | storage |
| `packages/core/tests/runtime/actor-persistence.test.ts` | Crash-after-message restore tests. | tests |

**Verification**:

- Actor persistence focused tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 16: fix(actor): make actor absence explicit

**Justification**: Required actor absence currently becomes no-op,
empty stream, or undefined.

**Principles**:

- `boundary-discipline`: absence is an explicit boundary error.
- `small-interface-deep-implementation`: callers should not infer internals.
- `prove-it-works`: missing required actors must be observable.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/domain/actor.ts` | Add `tryTell`/`tellRequired` or `ActorUnavailable` result shape; introduce `SingletonServiceKey` if chosen. | actor types |
| `packages/core/src/runtime/extensions/receptionist.ts` | Enforce singleton collisions or remove ambiguous `findOne`. | receptionist |
| `packages/core/src/runtime/extensions/actor-engine.ts` | Return explicit absence for required operations. | tell/peek/subscribe |
| `packages/core/src/runtime/make-extension-host-context.ts` | Expose named best-effort vs required APIs. | actors facet |
| `packages/extensions/src/auto.ts` | Stop swallowing required actor absence. | ~559 |
| `packages/extensions/src/executor/controller.ts` | Return explicit unavailable errors. | ~55 |
| `packages/core/tests/runtime/actor-engine.test.ts` | Missing actor and duplicate singleton tests. | tests |

**Verification**:

- Actor absence/collision tests.
- Auto/executor focused tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 17: feat(runtime): make agent loop an actor

**Justification**: The agent loop is the primary session state owner and
should use actor semantics.

**Principles**:

- `serialize-shared-state-mutations`: loop messages go through mailbox.
- `redesign-from-first-principles`: session turn driver is actor-shaped.
- `small-interface-deep-implementation`: shrink public loop service.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/runtime/agent/agent-loop.behavior.ts` | Define `Behavior<LoopDriverEvent, AgentLoopState>`. | new |
| `packages/core/src/runtime/agent/agent-loop.ts` | Re-expose service as actor adapter or delete once migrated. | broad |
| `packages/core/src/runtime/agent/agent-loop.state.ts` | Finalize actor-owned state model. | state |
| `packages/core/src/runtime/session-runtime.ts` | Dispatch through `ActorEngine.tell/ask` to session loop actor. | ~379-498 |
| `packages/core/src/runtime/extensions/turn-control.ts` | Remove owner-array queue; tell session loop actor. | ~51-112 |
| `packages/core/tests/runtime/agent-loop.test.ts` | Migrate to actor-backed loop. | broad |
| `packages/core/tests/extensions/auto-integration.test.ts` | Verify follow-ups/turn control still work. | tests |

**Verification**:

- Agent loop, session runtime, turn-control tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 18: feat(sdk): actorize worker supervisor

**Justification**: Worker supervisor is closure-state-as-actor and owns a
critical subprocess lifecycle.

**Principles**:

- `make-impossible-states-unrepresentable`: supervisor state variants own fields.
- `lifecycle-tasks-cancel-on-reentry`: restart closes stale subprocess work.
- `serialize-shared-state-mutations`: restart/stop/exited are messages.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/sdk/src/supervisor.ts` | Replace closure mutable state with supervised behavior/adapted actor runtime. | ~430-647 |
| `packages/sdk/tests/supervisor*.test.ts` | Add crash-loop, concurrent restart, process-exit tests. | tests |
| `ARCHITECTURE.md` | Document worker supervisor actor boundary. | worker section |

**Verification**:

- SDK supervisor focused tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 19: refactor(runtime): delete ExtensionRuntime marker and composer debt

**Justification**: Empty marker services and one-call-site generic
builders are shallow abstractions.

**Principles**:

- `subtract-before-you-add`: delete surfaces with no behavior.
- `small-interface-deep-implementation`: remove forwarding abstractions.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/runtime/extensions/resource-host/extension-runtime.ts` | Delete empty `ExtensionRuntime` service. | whole file |
| `packages/core/src/runtime/agent/agent-runner.ts` | Inline/localize ephemeral layer composition and override tag sets. | ~549 |
| `packages/core/src/runtime/composer.ts` | Delete if no caller remains. | whole file |
| `packages/core/tests/**/*.ts` | Replace `ExtensionRuntime.Test()` and composer imports. | affected |
| `AGENTS.md`/`ARCHITECTURE.md` | Remove marker references. | docs |

**Verification**:

- Typecheck catches all deleted imports.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 20: refactor(storage): split sqlite storage by boundary

**Justification**: One 1900-line file owns schema, migrations, aggregates,
repair, FTS, and layer wiring.

**Principles**:

- `small-interface-deep-implementation`: split by aggregate/boundary.
- `subtract-before-you-add`: dedupe schema SQL before new storage work.
- `boundary-discipline`: storage boundary owns decoding and migrations.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/storage/sqlite-storage.ts` | Shrink to composition or rename to `storage.ts`. | broad |
| `packages/core/src/storage/schema.ts` | Move schema constants/init. | new |
| `packages/core/src/storage/migrations/*.ts` | Move FK/FTS/versioned migrations. | new |
| `packages/core/src/storage/impl/*.ts` | Split sessions, branches, messages, events, actors, checkpoints, interactions, search. | new |
| `packages/core/tests/storage/*.test.ts` | Keep tests green; add fresh-schema equals repaired-schema test. | tests |

**Verification**:

- Storage test suite.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 21: refactor(storage): collapse storage layer statics

**Justification**: `Live`, `LiveWithSql`, `Memory`, `MemoryWithSql`,
`Test`, `TestWithSql` encode duplicate mental models.

**Principles**:

- `subtract-before-you-add`: delete aliases.
- `small-interface-deep-implementation`: one obvious layer for live, one for memory.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/storage/*.ts` | Keep `Storage.Live(dbPath)` as current full live layer and `Storage.Memory()` as current full memory/sql layer. | statics |
| `packages/core/tests/**/*.ts` | Replace `Storage.TestWithSql()`/`Storage.Test()` with final names. | many |
| `AGENTS.md` | Update testing guidance. | storage test docs |

**Verification**:

- Storage tests.
- Full root gate.
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 22: refactor(extension): split host context by capability

**Justification**: Tools/RPC/reactions currently receive destructive
session controls that should be action-only.

**Principles**:

- `boundary-discipline`: authority belongs at the proper boundary.
- `progressive-disclosure`: reveal destructive controls only where needed.
- `composition-over-flags`: typed contexts over one broad object.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/domain/extension-host-context.ts` | Define `ToolContext`, `RequestContext`, `ActionContext`, `ReactionContext`, common read facets. | ~39-201 |
| `packages/core/src/runtime/make-extension-host-context.ts` | Build per-capability contexts; remove ambient defaults where possible. | ~113-520 |
| `packages/core/src/domain/capability/*.ts` | Narrow `execute` context types. | tool/action/request |
| `packages/extensions/src/**/*.ts` | Migrate builtin extensions to appropriate contexts. | affected |
| `packages/core/tests/extensions/extension-surface-locks.test.ts` | Add negative type locks for destructive controls. | tests |

**Verification**:

- Extension surface locks.
- Builtin extension tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 23: feat(extension): add typed lifecycle reaction matrix

**Justification**: Runtime placeholders exist for input/context/tool
seams, but authors cannot use them.

**Principles**:

- `small-interface-deep-implementation`: expose few named typed seams.
- `redesign-from-first-principles`: replace no-op placeholders with intended matrix.
- `test-through-public-interfaces`: parity fixtures drive design.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/domain/extension.ts` | Add minimal typed reactions: input, context messages, provider request, tool preflight, tool result, turn/session lifecycle. | ~256-284 |
| `packages/core/src/runtime/extensions/extension-reactions.ts` | Implement matrix; delete unsupported no-op slots. | ~34-374 |
| `packages/core/src/runtime/agent/agent-loop*.ts` | Emit/call new seams in correct phases. | affected |
| `packages/core/src/runtime/agent/tool-runner.ts` | Tool preflight re-decodes patched input through tool schema. | ~58-218 |
| `packages/core/tests/extensions/pi-parity/*.test.ts` | Golden fixtures for plan-mode, input-transform, permission gate, context filter, tool result rewrite. | new |

**Verification**:

- Golden parity tests.
- Tool runner tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 24: feat(extension): package server and client entrypoints

**Justification**: Gent's server/client split is sound, but authors need
one manifest/status/diagnostic story.

**Principles**:

- `progressive-disclosure`: one top-level package story, separate boundaries inside.
- `boundary-discipline`: keep server/client runtimes separate.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/domain/extension-package.ts` | Add package manifest schema: id, version, server entry, client entry, disabled/config/diagnostics. | new |
| `packages/core/src/runtime/extensions/loader.ts` | Load package manifests and server entrypoints. | ~21-78 |
| `apps/tui/src/extensions/discovery.ts` | Load client entrypoint from same package metadata. | ~1-8 |
| `apps/tui/src/extensions/client-facets.ts` | Link client extension id/status to package metadata. | ~286-332 |
| `docs/extensions.md` | Document package authoring. | docs |
| `packages/core/tests/extensions/pi-parity/package-extension.test.ts` | Package fixture with server+client. | new |

**Verification**:

- Server/client package loading tests.
- TUI extension integration tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 25: feat(extension): dynamic contribution reconciliation

**Justification**: Static snapshots are simple, but pi parity needs
dynamic tools/providers without imperative global mutation.

**Principles**:

- `composition-over-flags`: dynamic contribution stream as composable primitive.
- `serialize-shared-state-mutations`: registry deltas reconcile through one owner.
- `test-through-public-interfaces`: dynamic-tools fixture proves behavior.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/domain/contribution-registry.ts` | Add validated registry delta schemas. | new |
| `packages/core/src/runtime/extensions/registry.ts` | Add delta reconciliation with same collision/scope validation as startup. | registry |
| `packages/core/src/domain/extension-host-context.ts` | Expose typed dynamic registration stream or actor-owned API. | context |
| `packages/core/src/extensions/api.ts` | Author-facing dynamic contribution helper if needed. | API |
| `packages/core/tests/extensions/pi-parity/dynamic-tools.test.ts` | Golden dynamic tool fixture. | new |
| `packages/core/tests/extensions/pi-parity/custom-provider.test.ts` | Golden custom provider/model fixture. | new |

**Verification**:

- Dynamic contribution tests.
- Registry collision/scope tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 26: feat(extension): add command completions and tool progress

**Justification**: These are lower-priority parity gaps once the package
and dynamic surfaces exist.

**Principles**:

- `progressive-disclosure`: optional hooks, not required authoring surface.
- `boundary-discipline`: progress/rendering crosses event/client boundary.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/domain/capability/action.ts` | Add optional schema-backed completion provider. | ~54-81 |
| `packages/core/src/domain/capability/request.ts` | Add optional slash completion metadata for slash-decorated requests. | ~73-79 |
| `packages/core/src/domain/capability/tool.ts` | Add typed progress events and optional input migration/prepare hook if Schema transforms are insufficient. | ~63-116 |
| `packages/core/src/server/rpcs/extension.ts` | Expose completion RPC. | extension group |
| `apps/tui/src/**` | Wire completions/progress to UI. | TUI |
| `packages/core/tests/extensions/pi-parity/command-completions.test.ts` | Golden completion fixture. | new |

**Verification**:

- Completion/progress tests.
- TUI command tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 27: refactor(tui): delete atom-solid and split client ownership

**Justification**: Custom atom library has little production use, and one
client provider owns unrelated transport/session/event/agent concerns.

**Principles**:

- `use-the-platform`: use Solid primitives directly.
- `small-interface-deep-implementation`: separate providers by ownership.
- `derive-dont-sync`: event feed hydrates and projects state once.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `apps/tui/src/atom-solid/*` | Delete custom atom library. | delete |
| `apps/tui/src/hooks/runtime-result.ts` | Move shared `Result` type if still needed. | new |
| `apps/tui/src/main.tsx` | Remove `RegistryProvider`. | ~319 |
| `apps/tui/src/client/context.tsx` | Split into transport/session/agent/event-feed providers. | ~120-734 |
| `apps/tui/src/client/session-subscription.ts` | Promote event-feed ownership. | ~22 |
| `apps/tui/tests/**` | Update atom/client provider tests. | tests |

**Verification**:

- TUI test suite.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 28: refactor(tests): replace process-shaped trampoline modules

**Justification**: Migration scaffolding should not remain active test
structure after the migration, and active code should be named after domain
behavior rather than the batch that introduced it. `batch12-modules` is not
relevant to the codebase; it is a planning artifact that leaked into runtime
layout.

**Principles**:

- `subtract-before-you-add`: delete no-novel-content wrappers.
- `test-through-public-interfaces`: tests live where they execute.
- `encode-lessons-in-structure`: record the invariant clearly so future
  reviewers treat process-shaped source names as cleanup blockers.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `apps/tui/batch12-modules/**` | Move real test/integration contents into normal `apps/tui/tests` and `apps/tui/integration`; delete directory. | broad |
| `apps/tui/tests/*.test.ts*` | Replace `void batch12Module` wrappers with real suites and domain-named imports if any imports remain. | wrappers |
| `apps/tui/integration/*.test.tsx` | Replace trampoline imports with direct suites. | wrappers |
| `packages/tooling/fixtures/batch12-modules/**` | Rename fixtures to behavior-domain names for the rule they test. | fixture rename |
| `packages/tooling/tests/fixtures.test.ts` | Update fixture paths so tooling tests do not preserve process-shaped directory names. | fixture list |
| `apps/tui/package.json` | Update test globs if needed. | scripts |

**Verification**:

- TUI tests.
- Root gate.
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 29: refactor(boundary): schema-back JSON and SDK adapters

**Justification**: JSON and foreign SDK payload casts should be decoded at
the boundary and repeated record guards should become helpers.

**Principles**:

- `boundary-discipline`: validate exactly once at parse/SDK boundary.
- `make-impossible-states-unrepresentable`: decoded shapes replace casts.
- `encode-lessons-in-structure`: recurring guards become helpers.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/extensions/src/executor/sidecar.ts` | Decode settings/registry files with Schema. | ~123-237 |
| `packages/sdk/src/server-registry.ts` | Decode lock/probe JSON with Schema. | ~146-184 |
| `packages/sdk/src/server.ts` | Decode server identity probe. | ~284 |
| `packages/extensions/src/acp-agents/*` | Introduce shared record/array/string guards or SDK decoders. | executor files |
| `packages/extensions/src/anthropic/keychain-client.ts` | Use helper decoders for foreign payloads. | ~247-543 |
| `packages/extensions/src/openai/codex-transform.ts` | Use helper decoders. | ~252 |
| `packages/core/tests/**`/`packages/extensions/tests/**` | Add malformed boundary tests. | tests |

**Verification**:

- Boundary malformed payload tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 30: refactor(membranes): consolidate type erasure

**Justification**: Merited casts should live at named membranes, not as
scattered suppression comments.

**Principles**:

- `boundary-discipline`: one explicit erasure boundary.
- `encode-lessons-in-structure`: named helpers over repeated comments.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `packages/core/src/runtime/extensions/effect-membrane.ts` | Add `eraseTagSet` or keep in surviving membrane location; add actor erasure helpers. | ~1-63 |
| `packages/core/src/runtime/extensions/actor-engine.ts` | Replace inline casts with helpers. | ~273, ~439, ~561 |
| `packages/core/src/runtime/extensions/receptionist.ts` | Replace actor-ref casts with helpers. | ~87-132 |
| `packages/core/src/runtime/extensions/registry.ts` | Replace schema/context erasure with named helpers where possible. | ~195-240 |
| `packages/core/src/domain/schema-tagged-enum-class.ts` | Consolidate brand-factory casts and `import/namespace` suppressions. | ~235-554 |
| `packages/core/src/domain/capability/*.ts` | Consolidate factory return casts. | tool/request/action |

**Verification**:

- Typecheck is the primary gate.
- Existing extension/actor tests.
- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 31: docs: record suppression waivers and actor/runtime contracts

**Justification**: Remaining intentional suppressions and architecture
exceptions should be discoverable in docs.

**Principles**:

- `encode-lessons-in-structure`: document sanctioned exceptions.
- `prove-it-works`: receipts for future agents.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `ARCHITECTURE.md` | Document actorized loop/supervisor, storage startup, extension package matrix, waiver list for `mcp-codemode.ts` and `git-reader.ts`. | docs |
| `AGENTS.md` | Update test/storage/extension guidance after new APIs. | docs |
| `docs/extensions.md` | Update extension authoring package/dynamic/lifecycle docs. | docs |
| `plans/WAVE-13.md` | Mark completed batch receipts during execution. | plan |

**Verification**:

- `bun run typecheck && bun run lint && bun run test`
- Review round: one Codex subagent plus one Okra counsel.

---

## Batch 32: audit: independent Wave 14 five-lane discovery

**Justification**: The next wave should not be a mirror held too close to
Wave 13. It must be an independent, first-principles audit of the codebase
as it exists after Wave 13, using the same five lanes but allowing fresh
priorities, fresh severities, and a different architecture agenda.

**Principles**:

- `prove-it-works`: trust artifacts, not self-reports.
- `redesign-from-first-principles`: do not let the prior wave define the
  next wave's search space.
- `never-block-on-the-human`: write the next plan when the evidence says
  there is more structural work.

**Changes**:
| File | Change | Lines |
|------|--------|-------|
| `plans/WAVE-13.md` | Record Wave 13 completion receipts and the independent Wave 14 audit command prompts. | final section |
| `plans/WAVE-14.md` | Write a new planify plan synthesized from the independent five-lane audit, not from Wave 13 completion criteria. | new plan |

**Verification**:

- Launch five fresh Codex subagents with a prompt that says:
  "Audit the current repository from first principles for this lane. Do not
  grade Wave 13. Do not assume the next plan should continue Wave 13's
  structure. Use brain principles, source receipts, and external repo
  receipts. Return P0/P1/P2/P3 findings and proposed batches."
- Lanes:
  simplification, correctness, actor north star, extension system,
  lint suppressions.
- Launch five fresh Okra counsel deep reviews for the same lanes with the
  same independence instruction, and ask Okra to launch its own subagents.
- Synthesize results into `plans/WAVE-14.md` using the planify format.
- `plans/WAVE-14.md` may contain any number of batches, including total
  rearchitecture, as long as it stays within Effect and preserves the
  featureset.
- Wave 13 can be marked complete only after `plans/WAVE-14.md` exists and
  records whether the independent audit found P0/P1/P2 work. Any such work
  belongs to Wave 14 unless it proves Wave 13 left the repository broken.
- Final full gate:

```bash
bun run typecheck && bun run lint && bun run test
```

## Open Risks

- Data repair and recovery audit paths may require a new CLI command module
  if no suitable one exists. That is in scope.
- Agent-loop actorization is high blast radius. Batch 6 deliberately
  lowers review risk before semantic conversion.
- Dynamic contribution reconciliation can tempt an imperative pi-mono clone.
  The plan keeps registry deltas typed, validated, and owned by one runtime
  boundary.
- Some P3 items, such as role-specific persisted message variants, may be
  promoted if they block turn journal or snapshot correctness.

## Current Status

- Batch 1 complete.
  - Gate: `bun run typecheck`, `bun run lint`, `bun run test`.
  - Codex review: `019dd6ff-1d33-7e71-8ef8-8a4fb466d5c6`; initial P2 resolved in the same review round.
  - Okra counsel: `/tmp/counsel/personal-gent-860892a9/20260429-020904-codex-to-claude-e5214a/claude.md`; no P0/P1/P2 blockers.
  - Note: blanket-disable enforcement is a standalone tooling check because an oxlint plugin diagnostic can be suppressed by the blanket directive it is trying to report.
- Batch 2 complete.
  - Gate: `bun run lint`, `bun run typecheck`, `bun run test`.
  - Codex review: `019dd707-f1c9-7d01-a937-c7e04a1292d0`; no P0/P1/P2 blockers.
  - Okra counsel: `/tmp/counsel/personal-gent-860892a9/20260429-021844-codex-to-claude-34eb81/claude.md`; no P0/P1/P2 blockers.
- Batch 3 complete.
  - Gate: `bun test packages/core/tests/test-utils/failing-layers.test.ts`, `bun run typecheck`, `bun run lint`, `bun run test`.
  - Codex review: `019dd70f-6a71-7c11-bb51-e0e94dacd3f8`; initial P1/P2 resolved in the same review round.
  - Okra counsel: `/tmp/counsel/personal-gent-860892a9/20260429-022645-codex-to-claude-effb6f/claude.md`; no P0/P1/P2 blockers.
  - Note: `FailingStorage` now overlays the focused storage tags derived from the same wrapped `StorageService`, so later failure-injection tests cannot bypass faults by yielding sub-tags directly.
- Batch 4 complete.
  - Gate: `bun test packages/core/tests/storage/sqlite-storage.test.ts --timeout 20000`, `bun run typecheck`, `bun run lint`, `bun test packages/core/tests/utils/run-process.test.ts --timeout 20000`, `bun run test`.
  - Codex review: `019dd718-1618-7a20-8a1b-4328df8df694`; initial P1/P2 findings resolved in the same review round.
  - Okra counsel: `/tmp/counsel/personal-gent-860892a9/20260429-023613-codex-to-claude-42e8a8/claude.md`; initial typed-failure and repair-surface findings addressed.
  - Note: startup no longer repairs or drops retired tables before failing closed; explicit FK orphan repair lives in internal-only `packages/core/src/storage/sqlite-repair.ts`.
- Batch 5 complete.
  - Gate: `bun test packages/core/tests/storage/sqlite-storage.test.ts --timeout 20000`, `bun run typecheck`, `bun test packages/core/tests/extensions/exec-tools/bash.test.ts packages/core/tests/utils/run-process.test.ts --timeout 20000`, `bun run lint`, `bun run test`.
  - Codex review: `019dd727-1b9e-7cd2-bc1a-6827986d5fd8`; no P0/P1/P2 blockers.
  - Okra counsel: `/tmp/counsel/personal-gent-860892a9/20260429-025237-codex-to-claude-e7fe89/claude.md`; no P0/P1/P2 blockers.
  - Note: SQLite startup now sets WAL/NORMAL/busy-timeout/autocheckpoint pragmas; message FTS rebuild is version-gated through `storage_meta` instead of running on every boot.
