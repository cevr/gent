# W10 Phase B — Resource.machine → ActorHost Collapse

**Status:** Plan only — pending counsel review (codex usage limit until 2026-04-28 14:25) and user green-light before execution.
**Predecessor:** W10 Phase A/A2 (commit `80b8908a`) — legacy `capabilities:` bucket deleted; typed buckets are the sole authoring surface.
**Branch:** `main`. **Gate:** `bun run typecheck && bun run lint && bun run test`.

---

## Context

Two parallel actor systems coexist in the runtime:

|                     | `Resource.machine` (legacy)                                                                                                          | `actors:` bucket (new)                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **Author shape**    | `defineResource({ machine: { machine, mapEvent, mapCommand, mapRequest, afterTransition, slots, stateSchema, protocols, onInit } })` | `defineExtension({ actors: [behavior(b)] })` where `b: Behavior<M, S, R>`               |
| **Execution model** | `effect-machine` FSM (explicit state tags, `Machine.spawn`)                                                                          | Reduce-loop actor (`receive: (msg, state, ctx) => Effect<S>`)                           |
| **Spawn cadence**   | Lazy per-session (`getOrSpawnActors(sessionId)`)                                                                                     | Eager process/profile-scoped (once at startup)                                          |
| **Mailbox**         | `SessionMailbox` (per-session serialization, reentrancy guard, terminal slot)                                                        | Per-actor semaphore in `ActorEngine`                                                    |
| **Supervision**     | `runSupervised` retries 1× before terminal                                                                                           | Defects kill fiber (no restart)                                                         |
| **Persistence**     | `extension_state` table — `(session_id, extension_id)` — synchronous on every transition                                             | `actor_persistence` table — `(profile_id, persistence_key)` — periodic + flush-on-close |
| **Discovery**       | `ExtensionId` keyed via `MachineLifecycle.actorsRef`                                                                                 | `ServiceKey` via `Receptionist`                                                         |
| **Protocol decode** | `MachineProtocol.decodeCommand/decodeRequest` (schema-validated dispatch)                                                            | None — `receive` accepts any `M`                                                        |
| **Event fan-out**   | `publish(AgentEvent)` runs `mapEvent` per FSM                                                                                        | None — actors do not subscribe to `AgentEvent`                                          |

**Production usage:** Zero extensions use `machine:` in production. All production actor code (`auto`, `handoff`, `artifacts`, `executor`, `skills`) uses `actors:`. The `machine:` field is **test-only**.

**The bridge:** `MachineEngine.send/execute` falls through to `ActorEngine` via `Receptionist` when no FSM is registered for the extension (`machine-engine.ts:183-209`). This is how `ext.send(msg)` reaches `actors:`-bucket actors at all.

## Why collapse

1. **`make-impossible-states-unrepresentable`** — Two execution models for "extension actor" is one too many. Authors must choose; the runtime branches on which they chose. The new typed-bucket world (Phase A complete) has one bucket name per audience; we should also have one primitive per concept.
2. **`subtract-before-you-add`** — Production has zero `machine:` users. The path is dead weight.
3. **`correctness-over-pragmatism`** — Personal library, no parallel APIs. The shim era ends.
4. **MachineEngine carries unique features (per-session lazy spawn, session mailbox, FSM transition semantics, schema-validated protocol decode, event fan-out, `onInit` hydration, `mapEvent`/`mapCommand`/`mapRequest`).** These are not vestigial — they are real capabilities the test suite exercises. We must decide: port to ActorHost, drop, or keep MachineEngine as-is and delete only `Resource.machine` authoring.

## Approach options

### Option 1: Port MachineEngine features to ActorHost; delete MachineEngine

Ship per-session spawning, session mailboxes, supervision, FSM-style transition guards, schema-validated protocols, and event-mapping into `Behavior` / `ActorHost`.

- **Cost:** High — 6+ new features in `ActorEngine`. Likely ~2000 LoC across runtime + tests. Risk of regressions in feature parity for edge cases (concurrency reentrancy, restart limits).
- **Win:** One primitive, one substrate, one persistence path, one registry. Future authors don't pick.

### Option 2: Delete `Resource.machine` authoring surface; collapse MachineEngine into "session-scoped layer over ActorHost"

Recognize that `MachineEngine` is _already_ mostly a session-scoping wrapper that delegates to `ActorEngine` on the fallback path. Re-architect so all actors are `Behavior`s; `MachineEngine` becomes a session-level supervisor strategy on top of `ActorHost` rather than a separate registry. FSM-style state machines become reducers (the `effect-machine` library is still usable inside a `receive` handler if authors want it).

- **Cost:** Medium — delete `ResourceMachine`, `MachineProtocol`, `spawnMachineExtensionRef`, `machine-lifecycle.ts`, `machine-mailbox.ts`. Migrate the test fixtures (the only consumers). Generalize `ActorHost` to support session-scoped instances or accept that all actors are profile-scoped. Move `mapEvent`/`mapCommand`/`mapRequest` into a runtime "router" that translates AgentEvents → actor messages.
- **Win:** Same as Option 1, less ported code (drop the FSM features the production codebase doesn't actually need).

### Option 3: Keep both; delete only the `machine:` authoring field on `defineResource`

Authors write `actors:` only; runtime keeps `MachineEngine` for whatever still routes through it (currently nothing in production except the `actor-route` fallback bridge). Delete the `machine:` field, the FSM-protocol decode, the test fixtures.

- **Cost:** Lowest — purely subtractive. ~500 LoC test deletions, ~300 LoC runtime feature deletions.
- **Win:** Smaller. The two-system reality persists in the runtime; future readers still wonder why MachineEngine exists at all.

## Recommendation

**Option 2.** Per `subtract-before-you-add` and `correctness-over-pragmatism`: production has zero `machine:` users; the FSM-only features (`mapEvent`/`afterTransition`/`onInit` hydration) are unique but unused. The session-scoped mailbox + supervision is the real value of MachineEngine, and it can be lifted to a property of `ActorHost` itself rather than a separate engine.

Concretely: **`MachineEngine` becomes a session-scoping policy on the `ActorHost`-managed `Behavior` registry**, not a separate substrate.

This decision is non-trivial — it deletes ~30 test cases worth of FSM-specific coverage. **The plan below assumes Option 2 but the user must confirm before any commit lands.**

## Scope (Option 2)

**In:**

- Delete `ResourceMachine`, `AnyResourceMachine` types
- Delete `defineResource({ machine: ... })` field
- Delete `MachineEngine`, `MachineLifecycle`, `MachineProtocol`, `spawnMachineExtensionRef`, `machine-execute`, `machine-mailbox`, `subscription-engine`, `resource-host/index.ts` (except what is genuinely used by `Resource.start/stop/schedule/subscriptions`)
- Migrate test fixtures off `machine:` (rewrite as `Behavior` with manual reducer or delete tests that exclusively cover FSM features)
- Lift session-scoping + per-session mailbox + supervision into `ActorHost` (or document that all actors are profile-scoped going forward)
- Wire `ext.send/ask` through `ActorHost` only
- Migrate `mapEvent`/`mapCommand`/`mapRequest` callers to either `pulseTags` + `reactions` (existing seam) or a new `eventRouter:` bucket if needed

**Out:**

- Refactoring of `Resource.start`/`Resource.stop`/`Resource.schedule`/`Resource.subscriptions` (the layer/start/stop side of `Resource` stays)
- Public-API surface changes beyond removing `machine:` and `MachineEngine` re-exports
- Storage migration (just stop writing to `extension_state`; old rows become dead data)

## Constraints

- TypeScript clean (`tsgo --noEmit`) after each commit
- Lint clean
- Full test gate green after each commit (per W10 standing rule and global pacing principle)
- Lefthook pre-commit must not be skipped (`--no-verify` forbidden)

## Applicable Skills

- `effect` — for runtime layer reshaping
- `counsel` — between commits per memory `feedback_counsel_after_batch`
- `planify` — this document is the plan; counsel-gate Phase B execution as a planify Phase 5

## Gate Command

```bash
bun run typecheck && bun run lint && bun run test
```

## Commit Plan (Option 2)

The collapse is high-blast-radius. Following CLAUDE.md guidance: "If a single commit touches 20+ files across multiple subsystems, break it into 3-5 reviewable sub-commits in one wave."

### B1 — Inventory + test triage

**Justification:** Before deleting features, classify every test that touches `machine:` into (port-to-Behavior | delete-as-FSM-only-coverage | reframe). Without this, B2 can't move correctly.

**Principles:** `correctness-over-pragmatism` (decide each test deliberately); `validate-regression-tests-catch-regression` (don't silently drop coverage we still need).

**Files (read-only):**

- `tests/extensions/actor.test.ts`
- `tests/extensions/actor-lifecycle.test.ts`
- `tests/extensions/persistence.test.ts`
- `tests/extensions/concurrency.test.ts`
- `tests/extensions/resource-host.test.ts`
- `tests/server/extension-commands-rpc.test.ts`

**Output:** A table appended to this plan: `{ test name → port | delete | reframe → reason }`.

**Verification:** Plan section approved by user before any deletion.

### B2 — Delete `Resource.machine` authoring surface (test fixtures only)

**Justification:** Land the subtractive change in test fixtures first to prove the FSM features are honestly redundant. Production is already free of `machine:`, so this commit moves _only_ test fixtures.

**Changes:**

- For each "port" test in B1: rewrite the fixture to use `Behavior` with a hand-rolled reducer instead of `Machine.Machine`
- For each "delete" test in B1: delete (the test exclusively covered FSM features that are now out of scope)
- Update test helpers (`makeActorRuntimeLayer`, `createE2ELayer`, RPC harness) to stop wiring `machine:` paths

**Verification:** Gate clean. The runtime still compiles because production doesn't use `machine:`. MachineEngine is still loaded but increasingly unreferenced from tests.

### B3 — Delete `Resource.machine` field + FSM types

**Changes:**

- Remove `machine?` from `ResourceContribution`
- Delete `ResourceMachine`, `AnyResourceMachine`, `ResourceMachineInitContext`
- Delete `MachineProtocol` (if not also needed by Phase A's protocol decode for `actors:` — verify)
- Delete `extractMachine` helper
- `extension_state` storage interface: keep the table for now (zero writers), drop the service from `RuntimeComposer.OVERRIDE_TAG_SETS` references that target it

**Verification:** Typecheck catches every now-broken caller; fix or delete each. Gate must be green at end of commit.

### B4 — Delete MachineEngine + migrate `ext.send/ask` to ActorHost

**Changes:**

- Wire `ext.send/ask` directly to `ActorHost`'s `tell/ask` via `Receptionist.findOne(serviceKey)` (this is _the same code path MachineEngine already falls through to_ in the actor-route case)
- Delete `MachineEngine`, `MachineLifecycle`, `spawn-machine-ref`, `machine-mailbox`, `subscription-engine` (audit each — `subscription-engine` may still be used for `Resource.subscriptions`; verify)
- Move per-session lazy-spawn (if needed for any actors) into a new `ActorHost` policy or accept profile-scoped semantics
- Delete `extension_state` storage table + service (zero readers/writers after B3)

**Verification:** Gate clean. Production code paths unchanged at the seam (`ext.send` still works); only the substrate is replaced.

### B5 — Counsel + verification pass

**Changes:** None (review-only commit if any cleanup found).

**Steps:**

1. Counsel review of B2/B3/B4 collectively
2. If counsel flags real issues → fix in fixup commits
3. Run `bun run smoke` headless test
4. Update `ARCHITECTURE.md` to remove MachineEngine references
5. Update memory: `project_w10_6_findings` resolved; `project_w10_phaseB_complete` written

## Open questions (for user)

1. **Option choice:** Confirm Option 2 (collapse) vs Option 1 (port everything) vs Option 3 (delete only the field). My recommendation is Option 2; this plan assumes it.
2. **`mapEvent`/`afterTransition`/`onInit` futures:** These features are zero-use in production but are unique to MachineEngine. Delete them entirely, or design a successor on the `actors:` path? Recommendation: delete; we can re-add a generalized event-router bucket later if a real use case appears.
3. **Per-session vs profile-scoped actors:** MachineEngine spawns lazily per session. ActorHost spawns once per profile. The collapse forces a choice. Production extensions (`auto`, `handoff`, `artifacts`, `executor`, `skills`) already work at profile scope — so profile-scoped is the honest default. Confirm: drop per-session spawning?
4. **Counsel timing:** Codex limit lifts 2026-04-28 14:25. Wait for that and run counsel on the plan before execution? Or proceed if you accept self-review-only for B1 inventory?

## Risks

- **B4 deletes MachineEngine but `ext.send/ask` still routes through it today.** Switching the seam is the highest-risk single-commit step. Mitigation: B4 is gated; counsel before merging; smoke + e2e suite must pass.
- **Per-session vs profile-scoped semantics drift.** If any production extension implicitly relies on per-session actor identity (e.g., spawning fresh state per session), profile-scoping breaks it. The Explore survey says current production uses are all profile-scoped, but this needs B1 verification.
- **Storage abandonment.** `extension_state` rows become dead data after B3. Accept (personal library, no migration needed) — confirmed.

## B1 inventory (completed)

User decision: **Option 2** chosen, profile-scoped semantics chosen, FSM-only features deleted, codex counsel deferred (`never-block-on-the-human`). B1 inventory follows.

### Key findings

1. **Production has zero `Resource.machine` users** — confirmed. All `machine:` consumers are test fixtures.
2. **`MachineEngine.terminateAll(sessionId)` is real production behavior** — wired into `deleteSession` cascade. **B4 must port `terminateAll` to ActorHost or accept `deleteSession` no longer terminates runtime actors.** Recommendation: port. Per-session message routing through ActorHost will need a session-aware key, OR session deletion purges durable state and lets profile-scoped actors GC naturally.
3. **`session-commands.test.ts` (8 tests)** stub `MachineEngine` directly via `Layer.succeed(MachineEngine, ...)`. These need migration to whatever replaces `MachineEngine` as the actor-lifecycle tag.
4. **`extension-surface-locks.test.ts` (3 tests)** use compile-time type checks to assert `MachineEngine` and `ResourceMachine` are not exported. After deletion these tests become tautologies — delete them.

### Classification table

50 tests total: 19 port, 25 delete, 6 reframe. Full table tracked in conversation; condensed below by file.

| File                              | Port | Delete | Reframe | Notes                                                                                                |
| --------------------------------- | ---- | ------ | ------- | ---------------------------------------------------------------------------------------------------- |
| `actor.test.ts`                   | 2    | 6      | 2       | 2 reframes are `Resource.machine end-to-end` cases — port to `actors:` Behavior                      |
| `concurrency.test.ts`             | 1    | 9      | 0       | 9 deletes cover session-mailbox + reentrancy + per-session-spawn — all FSM-only                      |
| `persistence.test.ts`             | 0    | 9      | 0       | All synchronous-persistence to `extension_state`. ActorHost has periodic persistence; covered there. |
| `loader.test.ts`                  | 1    | 0      | 0       | "rejects 2+ Resource.machine" — delete the test (the field is gone)                                  |
| `actor-lifecycle.test.ts`         | 0    | 0      | 3       | All three reframes — actor lifecycle across RPC, port to Behavior                                    |
| `resource-host.test.ts`           | 3    | 0      | 0       | Validation tests for `machine:` field — delete (field is gone)                                       |
| `extension-surface-locks.test.ts` | 2    | 1      | 0       | Compile-time locks; delete after removal                                                             |
| `extension-commands-rpc.test.ts`  | 4    | 0      | 1       | Boundary RPC fixture; rewrite as Behavior                                                            |
| `session-commands.test.ts`        | 8    | 0      | 0       | Stubs `MachineEngine` Tag — port to ActorHost-equivalent terminateAll                                |

### Revised B2/B3/B4 sequencing implications

- **B2 must include `session-commands.test.ts` migration** — these tests block any deletion of the `MachineEngine` Tag.
- **B4 must port `terminateAll(sessionId)`** to ActorHost as a real feature, not delete it. This is a runtime behavior, not an FSM-only feature.
- **`actor-lifecycle.test.ts` (3 reframes)** — these prove `ext.ask` works across RPC scopes. Their replacements should run on a `Behavior`-based fixture and prove the same property on ActorHost.

## Next step

Begin B2: migrate test fixtures off `Resource.machine`.
