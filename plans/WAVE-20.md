# Planify: Wave 20 — Platform-Owned Primitives, Narrow Extension API, And Test Ownership

## Thesis

Wave 19 removed the largest membrane and Effect AI duplication layers, but the
fresh five-lane audit found enough remaining P1/P2 work to justify a new wave.
Scope is not a constraint: this wave may become dozens of commits if that is
what structural correctness requires. The constraint is sequencing, not size.

The new structural center is:

1. **Upstream primitives before Gent workarounds.** Gent currently carries
   unsafe layer erasure and a live-state registry because `effect-encore` does
   not type entity handler context or expose an actor-owned state stream.
   Fix the owned libraries first, then delete the local workaround.
2. **Effect AI owns tool contracts.** Gent now uses Effect AI tool shapes, but
   tool result schemas are still erased to `Schema.Unknown`; `ToolRunner`
   manually revalidates results instead of letting `Toolkit` own both input and
   output.
3. **The extension API must become small.** Third-party authors should see an
   authoring API, not runtime internals, host seams, task/session/domain model
   internals, and builtin-only affordances.
4. **Suppressions are signals until proven otherwise.** Most compile-time
   `@ts-expect-error` tests are warranted, but block disables, host-context
   casts, and repeated SDK/TUI fake casts are architectural debt.
5. **Tests must live with their owner and verify behavior.** Extension tests
   currently live under `@gent/core`, several files are god tests, and too many
   extension checks bypass the RPC/request-scope boundary.

## Principles Applied

- `/Users/cvr/.brain/principles/never-block-on-the-human.md` — do not ask for a
  smaller scope when the direction is clear.
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md` — redesign
  around platform-owned primitives instead of bolting guardrails onto
  workarounds.
- `/Users/cvr/.brain/principles/correctness-over-pragmatism.md` — no carveouts
  because the proper fix crosses repositories.
- `/Users/cvr/.brain/principles/subtract-before-you-add.md` — delete stale API,
  examples, facades, and casts before adding replacement affordances.
- `/Users/cvr/.brain/principles/use-the-platform.md` — prefer Effect AI
  schemas, Effect STM/locks, Encore actors, and RPC acceptance boundaries over
  local copies.
- `/Users/cvr/.brain/principles/test-through-public-interfaces.md` — use RPC
  and package-owned tests as the default behavioral proof.

## Non-Negotiable Execution Rules

- No scope trimming for comfort. Split into as many commits as needed; do not
  reduce the wave because it is large.
- Upstream repository commits are allowed and expected:
  `/Users/cvr/Developer/personal/effect-encore` and
  `/Users/cvr/Developer/personal/effect-machine` are part of this wave.
- Every commit runs the narrowest meaningful focused tests first, then
  `bun run gate` for the touched repo. Gent boundary commits also run
  `bun run test:e2e`.
- Apply-tier migration is required after the first worked example for any
  repetitive file moves/cast removals/test relocations.
- No compatibility aliases, deprecation layers, or old-shape examples. Delete
  stale authoring surfaces outright.
- Counsel or independent review runs after each named batch when available; if
  tooling is rate-limited, record the attempted review and proceed with a local
  recursive audit batch.

## Audit Synthesis

### Lane 1 — Owned Libraries: effect-encore and effect-machine

**P1: `effect-encore` leaks `CurrentAddress` as a user-provided requirement.**

Gent imports `CurrentAddress`, defines a local `WithoutCurrentAddress` erasure,
and casts both live and test actor layers because Encore's wrapper type does
not hide the entity-provided service.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:52`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:400`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:476`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:488`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:1175`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:1189`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1026`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1044`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1113`
- `/Users/cvr/Developer/personal/effect-encore/src/observability.ts:21`
- `/Users/cvr/Developer/personal/effect-machine/src/cluster/entity-machine.ts:120`
- `/Users/cvr/Developer/personal/effect-machine/src/cluster/entity-machine.ts:314`

**P1: `effect-encore` has no live actor state stream.**

Gent keeps `AgentLoopStateRegistry`, `EnsureStarted`, and a direct
`SubscriptionRef` stream alongside actor request/reply because Encore's
`watch` surface watches persisted operation receipts, not actor state.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:9`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:175`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:376`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state-registry.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:155`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:118`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:363`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:775`
- `/Users/cvr/Developer/personal/effect-machine/src/cluster/to-entity.ts:95`
- `/Users/cvr/Developer/personal/effect-machine/src/cluster/entity-machine.ts:282`

**P2: Encore rerun SQL storage is implemented in Gent.**

Gent owns cluster table knowledge (`cluster_replies`, `cluster_messages`) to
support Encore `rerun`.

Status: resolved by upstream `effect-encore` commit
`63b4bea feat: add sql message storage layer`, released as
`effect-encore@0.11.0` through version PR `#20`, and adopted in Gent by C8.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/encore-storage.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/encore-storage.ts:35`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/encore-storage.ts:65`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:5`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:26`
- `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:1`
- `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:69`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:385`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:668`

**P2: `effect-machine` pins Effect as a dependency.**

`effect-machine` has `effect` in package dependencies while Gent catalogs
Effect beta.59. This can create duplicate Effect identities across app/library
boundaries.

Receipts:

- `/Users/cvr/Developer/personal/gent/package.json:24`
- `/Users/cvr/Developer/personal/gent/package.json:47`
- `/Users/cvr/Developer/personal/effect-machine/package.json:61`
- `/Users/cvr/Developer/personal/effect-machine/package.json:81`
- `/Users/cvr/Developer/personal/effect-encore/package.json:50`
- `/Users/cvr/Developer/personal/gent/bun.lock:892`

### Lane 2 — Effect / Effect AI / STM

**P1: Gent erases tool output schemas and bypasses Effect AI result validation.**

`tool(...)` accepts params but no result schema, lowers to
`AiTool.dynamic(... success: Schema.Unknown)`, stores `metadata.output:
Schema.Unknown`, and then manually encodes output in `ToolRunner`.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:66`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:230`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:234`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:248`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:251`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:172`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:238`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/unstable/ai/Tool.ts:222`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/unstable/ai/Tool.ts:232`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/unstable/ai/Toolkit.ts:306`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/unstable/ai/Toolkit.ts:310`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/unstable/ai/Toolkit.ts:346`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/unstable/ai/Toolkit.ts:431`

**P2: `ResourceManager` reimplements a read/write lock.**

Per-tag `Semaphore` plus `READ_PERMITS = 1_000_000` models many readers or one
writer. Effect v4 has `TxReentrantLock`.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/resource-manager.ts:21`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/resource-manager.ts:24`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/resource-manager.ts:40`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/resource-manager.ts:58`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/resource-manager.ts:75`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxReentrantLock.ts:1`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxReentrantLock.ts:37`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxReentrantLock.ts:101`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxReentrantLock.ts:134`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxReentrantLock.ts:177`

**P2: Agent-loop queue/state mutation wants an STM design pass.**

The current state path is correct-by-semaphore and scattered across
`SubscriptionRef`, queue mutation semaphores, storage persistence, and actor
handlers. Effect `TxRef` / `TxQueue` are built for transactional coordination.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:333`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:336`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:382`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:406`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:606`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:673`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:822`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:976`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxRef.ts:1`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxRef.ts:20`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxQueue.ts:1`
- `/Users/cvr/Developer/personal/gent/node_modules/effect/src/TxQueue.ts:6`

### Lane 3 — Architecture / Extension API / Harness References

**P1: Public extension API exposes too much internal runtime.**

`packages/core/src/extensions/api.ts` is the only intended public authoring
surface, but it re-exports agents/run specs, turn contexts, events, tasks,
messages, host seams, platform seams, and builtin-oriented helpers.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:78`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:96`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:134`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:190`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:266`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:300`
- `/Users/cvr/Developer/personal/gent/docs/extensions.md:36`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:57`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:222`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:4`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:11`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:124`

**P1: `SessionRuntime` and `AgentLoop` still expose overlapping control planes.**

Architecture says `SessionRuntime` is public and `AgentLoop` internal, but
`AgentLoop.Live` remains a service facade while `SessionRuntime` also exposes
and routes actor control.

Receipts:

- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:152`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:28`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:177`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:265`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:533`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:724`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:836`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:980`

Status: resolved by C7. The service facade was deleted; `SessionRuntime` now
owns its remaining local actor helper functions and `LiveWithEntity` exposes
only `SessionRuntime`.

- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:31`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:155`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:35`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:82`

**P2: Extension examples teach deleted `pipeline` / `subscription` API.**

Receipts:

- `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts:11`
- `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts:17`
- `/Users/cvr/Developer/personal/gent/examples/extensions/prompt-rules.ts:6`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:485`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:512`
- `/Users/cvr/Developer/personal/gent/docs/extensions.md:173`

### Lane 4 — Suppression Discipline

Counts from the audit over tracked TS/JS source: `eslint-disable` 112,
`eslint-enable` 5, `oxlint-disable` 5, `@ts-expect-error` 40, `@ts-ignore` 0,
`as unknown as` 55, direct `as any` 0, explicit any-ish type leaves 10.

**P1: Named block disables are still architectural carveouts.**

The existing checker bans blanket rule-less disables, but named
`/* eslint-disable ... */` blocks can still hide future assertions.

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-load-boundary.ts:5`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-load-boundary.ts:45`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-effect-membrane.ts:4`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-effect-membrane.ts:29`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-effect-membrane.ts:39`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-effect-membrane.ts:53`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:165`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts:170`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/extension-harness.ts:156`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/e2e-layer.ts:148`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/blanket-eslint-disable.ts:6`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/check-blanket-eslint-disable.ts:24`
- `/Users/cvr/Developer/personal/gent/package.json:11`

**P1: Extension-host tests cast partial objects to `ExtensionHostContext`.**

Receipts:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:36`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:45`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:48`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:51`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/session-tools.test.ts:18`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/prompt-slots.test.ts:10`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/runtime-reactions.test.ts:17`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-reactions.test.ts:23`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/define-extension.test.ts:34`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/scope-precedence.test.ts:28`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/acp-system-prompt-slot.test.ts:31`

**P2: TUI lifecycle and Claude SDK tests centralize too little fake typing.**

Receipts:

- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts:51`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts:62`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts:123`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts:166`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts:392`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts:478`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts:533`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/claude-code-executor.test.ts:13`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/claude-code-executor.test.ts:27`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/claude-code-executor.test.ts:42`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/claude-code-executor.test.ts:60`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/claude-code-executor.test.ts:72`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/claude-code-executor.test.ts:94`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/claude-code-executor.test.ts:104`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/claude-code-executor.test.ts:127`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/claude-code-executor.test.ts:155`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/claude-code-executor.test.ts:173`

### Lane 5 — Test Ownership and Behavior

**P1: Extension tests are owned by `@gent/core`, not `@gent/extensions`.**

Receipts:

- `/Users/cvr/Developer/personal/gent/AGENTS.md:105`
- `/Users/cvr/Developer/personal/gent/AGENTS.md:125`
- `/Users/cvr/Developer/personal/gent/packages/extensions/package.json:165`
- `/Users/cvr/Developer/personal/gent/packages/extensions/package.json:204`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/workspace-test-runner.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/task-tools/task-tools.test.ts:4`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/task-tools/task-tools.test.ts:20`

**P1: Several tests are god tests.**

Receipts:

- `/Users/cvr/Developer/personal/gent/AGENTS.md:105`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop.test.ts:512`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop.test.ts:1938`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop.test.ts:2060`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-commands.test.ts:341`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-commands.test.ts:1683`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-commands.test.ts:1808`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/storage/sqlite-storage.test.ts:20`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/storage/sqlite-storage.test.ts:1636`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/storage/sqlite-storage.test.ts:1680`

**P2: Some tests are implementation-shaped and several RPC tests bypass the
canonical harness.**

Receipts:

- `/Users/cvr/Developer/personal/gent/AGENTS.md:113`
- `/Users/cvr/Developer/personal/gent/AGENTS.md:117`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/plan.test.ts:8`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/plan.ts:13`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/counsel/counsel-tool.test.ts:33`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/delegate/delegate-tool.test.ts:174`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/rpc-harness.ts:1`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/rpc-harness.ts:58`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts:158`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/skills/skills-rpc.test.ts:105`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/e2e-layer.ts:59`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/e2e-layer.ts:100`

## Wave Execution Plan

### Part A — Upstream Library Primitives

#### C1: fix(effect-machine): make Effect a peer-only dependency

Move `effect` out of `dependencies` in
`/Users/cvr/Developer/personal/effect-machine/package.json`. Keep the version
in dev dependencies/catalog only. Verify local package tests, then refresh
Gent install/lock.

Status: complete in upstream commit `0c48101 build: modernize effect-machine toolchain`.

Additional upstream scope completed in the same commit:

- replaced the old `.effect-lsp.json` diagnostics path with `tsgo` +
  `@effect/tsgo`;
- updated Effect v4 to `4.0.0-beta.63`;
- enabled `serviceNotAsClass` as an error and migrated v4 service tags to
  `Context.Service` classes;
- mirrored strict-toolchain fixes into `v3/`;
- kept `effect` as a peer/runtime-external dependency while using dev-only
  aliases for v4 and v3 validation.

Definition of done:

- `effect-machine` has no runtime dependency on `effect`.
- Gent lock no longer pulls a second Effect copy for `effect-machine`.
- `bun run gate` in `effect-machine` passed on 2026-05-07.
- `bun install && bun run gate` in Gent passed on 2026-05-07.

#### C2: feat(effect-encore): type entity handler context

Add an Encore API that either:

- passes `{ address }` as an explicit handler context parameter, or
- exports `Actor.CurrentAddress` and excludes it from `Actor.toLayer` /
  `Actor.toTestLayer` `RIn`.

Prefer the explicit handler context if the type surface is cleaner. Use
`exhaust-the-design-space`: sketch both approaches in code/tests, keep the one
with smaller author burden.

Status: complete in upstream commit `77231b1 feat: hide current address context`.

Chosen API: `Actor.CurrentAddress` / named `CurrentAddress` export. This keeps
the existing request-first handler shape and mirrors Effect Cluster's own
entity-provided context exclusion. The explicit second handler-context
parameter would add author burden without removing a layer requirement that
Effect Cluster already owns internally.

Definition of done:

- Type regression proves a handler can access entity address without the final
  layer requiring `CurrentAddress`.
- Gent no longer needs `WithoutCurrentAddress` or the actor-layer casts.
- `bun run gate` in `effect-encore` passed on 2026-05-07.
- `bun run --cwd packages/core typecheck`, the core test runner, and full
  `bun run gate` in Gent passed on 2026-05-07.

#### C3: feat(effect-encore): add live actor state protocol

Add an Encore-owned primitive for entity-local state snapshots and streaming.
The API can be `Actor.withState`, `OperationDef.stream`, or a named
`stateProtocol` helper after the C2 design pass. It must cover:

- materialize/start entity if needed;
- get current state;
- watch state changes;
- close stream when entity scope closes.

Definition of done:

- Encore tests prove state watch is entity-owned, not side-registry-owned.
- Gent can delete `AgentLoopStateRegistry` after adoption.
- `bun run gate` in `effect-encore`.

Status: complete in upstream commit `8729916 feat: add live actor state protocol`
and released through version PR `#19` as `effect-encore@0.10.0`.

The shipped API is `Actor.registerState`, plus typed `getState`, `watchState`,
and `listStateEntityIds` helpers on each entity actor. `Actor.toLayer` /
`Actor.toTestLayer` provide the shared `ActorStateRegistry` support layer so
consumers do not wire a side registry.

#### C4: feat(effect-encore): own SQL message storage for rerun

Move Gent's Encore SQL table knowledge into `effect-encore`.

Definition of done:

- `effect-encore` exposes `EncoreMessageStorageLayer.fromSqlClient` or an
  equivalent constructor.
- Gent deletes `packages/core/src/runtime/agent/encore-storage.ts` or reduces it
  to a one-line import/wire.
- `bun run gate` in both repos.

Status: complete in upstream commit
`63b4bea feat: add sql message storage layer`, released through version PR `#20`
as `effect-encore@0.11.0`.

The shipped API is `fromSqlClient()` / `fromSqlClientWithShardingConfig()`.
It provides both upstream `MessageStorage.MessageStorage` and Encore's
`EncoreMessageStorage`, including surgical `deleteEnvelope` support for the
default `cluster_messages` / `cluster_replies` tables.

### Part B — Gent Actor and Session Control Collapse

#### C5: refactor(runtime): remove `CurrentAddress` erasure from AgentLoop actor

Adopt C2 in Gent.

Definition of done:

- Delete local `WithoutCurrentAddress`.
- Delete actor-layer unsafe casts.
- Focused tests: `packages/core/tests/runtime/agent-loop.test.ts` and
  `packages/core/tests/runtime/agent/agent-loop.actor.test.ts`.
- `bun run gate`.

#### C6: refactor(runtime): replace AgentLoopStateRegistry with Encore state stream

Adopt C3 in Gent.

Definition of done:

- Delete `packages/core/src/runtime/agent/agent-loop.state-registry.ts`.
- `watchState` goes through Encore's state stream.
- No `EnsureStarted` no-op solely for registry materialization.
- Focused runtime state/watch tests plus `bun run test:e2e`.
- `bun run gate`.

Status: complete in Gent commit pending after upstream release adoption.

Implementation notes:

- Deleted Gent's `AgentLoopStateRegistry` service and direct registry unit test.
- The `AgentLoop` actor registers projected runtime state with
  `Actor.registerState`.
- `AgentLoop.getState` / `watchState` use Encore actor-state helpers with an
  actor materialization operation.
- `terminateSession` lists Encore-registered entity ids and routes branch
  shutdown through actor operations.
- `EnsureStarted` remains, but no longer exists solely to populate a Gent side
  registry; it is the actor materialization/wake operation used by state reads
  and restart interaction recovery.
- Test runner sharding changed from `xargs -n 10 -P 6` to `xargs -n 6 -P 4`
  after the root budget probe showed CPU contention; `bun run test` now reports
  4.677s against the 5s budget.
- TUI test sharding changed from `xargs -n 10 -P 5` to `xargs -n 10 -P 2`
  after the pre-commit hook reproduced budget flake under package-level CPU
  contention; root `bun run test` reports 4.841s after the change.

Verification on 2026-05-07:

- `bun run typecheck`
- `bun run lint`
- `bun run test`

#### C7: refactor(runtime): collapse AgentLoop.Live into SessionRuntime internals

Keep the actor and behavior modules, but remove the public-ish
`AgentLoopService` facade where `SessionRuntime` can call the actor helper
directly.

Definition of done:

- `SessionRuntime` remains the public session engine.
- `AgentLoop` is internal actor plumbing only.
- No runtime callers depend on `AgentLoop.Live` except test-only actor helpers.
- Focused session/runtime tests and `bun run test:e2e`.

Status: complete in this Gent commit.

Implementation notes:

- Deleted `packages/core/src/runtime/agent/agent-loop.ts`.
- Moved `runPrompt`, runtime state read/watch, and session termination sweep
  helper logic into `makeLiveSessionRuntime`.
- `SessionRuntime.EntityLive` / `LiveWithEntity` no longer expose `AgentLoop`.
- Runtime tests now use direct actor test harnesses plus local helper objects,
  not a Context service facade.
- Architecture and runtime comments now point at the actor/behavior modules.

Verification on 2026-05-07:

- `bun run --cwd packages/core typecheck`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/agent-loop.test.ts packages/core/tests/runtime/external-turn.test.ts packages/core/tests/runtime/session-runtime.test.ts`

#### C8: refactor(runtime): adopt Encore SQL storage constructor

Adopt C4 in Gent.

Definition of done:

- Delete local table-specific Encore storage implementation.
- SQLite storage wiring uses upstream Encore layer.
- Focused storage + rerun tests.
- `bun run gate`.

Status: complete in this Gent commit.

Implementation notes:

- Deleted `packages/core/src/runtime/agent/encore-storage.ts`.
- Removed the public package export for the deleted local adapter.
- Deleted the duplicate local SQL storage test because the behavior now lives in
  `effect-encore/test/sql-storage.test.ts`.
- `SqliteStorage` now wires `effect-encore`'s `fromSqlClient()` directly.

Verification on 2026-05-07:

- `bun run typecheck`
- `bun run lint`
- `bun run test`
- `bun run gate`

### Part C — Effect AI Owns Tool Contracts

#### C9: feat(extensions): add author-facing tool result schemas

Extend `ToolInput` with a required `result` / `output` schema. This is a
breaking internal API change; migrate builtins directly. No compatibility
fallback to `Schema.Unknown`.

Definition of done:

- `tool({...})` requires output schema.
- `AiTool.dynamic(... success: outputSchema)` is used.
- Compile failures drive all builtins to state their output.
- Focused extension API type locks.

Status: complete in this Gent commit.

Implementation notes:

- `ToolInput` now requires an `output` schema.
- `tool(...)` stores that schema in Gent metadata and passes it to Effect AI
  `AiTool.dynamic(... success: output)`.
- The public extension API re-exports agent-run result schemas needed by
  extension-owned tool output schemas.
- Core tests and extension-surface type locks now author explicit output
  schemas.

Verification on 2026-05-07:

- `bun run --cwd packages/core typecheck`
- `bun run --cwd packages/extensions typecheck`
- `bun run typecheck`
- `bun run lint`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/tool-runner.test.ts packages/core/tests/extensions/skills/skills-tool.test.ts packages/core/tests/extensions/extension-surface-locks.test.ts packages/core/tests/extensions/registry.test.ts`

#### C10-C20: refactor(extensions): migrate builtin tools to typed output schemas

Migrate in capability families, one or more commits per family:

- fs tools;
- exec/network tools;
- session/task tools;
- audit/review/counsel/research/delegate/plan;
- artifacts/interactions/skills/memory/auto/executor;
- ACP / Claude Code bridge.

After the first two migrations, delegate the rest with exact recipe:

- add `output` schema;
- replace implicit unknown output with the concrete schema;
- update tests to assert encoded tool result shape;
- stop on tools whose output is genuinely polymorphic.

Definition of done:

- No builtin `tool(...)` call omits output schema.
- Tool output validation failures are surfaced through Effect AI
  `ToolResultEncodingError` paths.
- Focused tests per family, then `bun run gate`.

Status: complete in this Gent commit.

Implementation notes:

- Migrated builtin extension tools to concrete result schemas across fs,
  exec, network, interaction, skills, principles, session, task, memory,
  artifacts, audit/review/counsel/research/delegate/plan, librarian/repo,
  auto, executor, and handoff.
- `Schema.Unknown` remains only for genuinely polymorphic payload fields
  such as MCP executor structured content and repository info blobs.
- Core test fixtures now declare outputs instead of relying on unknown.

Verification on 2026-05-07:

- `bun run --cwd packages/extensions typecheck`
- `bun run --cwd packages/core typecheck`
- `bun run typecheck`
- `bun run lint`

#### C21: refactor(runtime): let `Toolkit.handle` own result encoding

Remove Gent's duplicate output encoding from `ToolRunner` where Effect AI can
own it. Keep Gent-owned lifecycle events, permission checks, resource needs,
wide-event annotations, and extension reactions.

Definition of done:

- `ToolRunner` no longer encodes successful results through
  `Schema.Unknown`.
- Failure/result schema behavior is covered by behavioral tests.
- `bun run gate` and `bun run test:e2e`.

Status: complete in this Gent commit.

Implementation notes:

- `ToolRunner` now builds an Effect AI toolkit with handlers and delegates
  parameter decoding plus successful-result encoding to `Toolkit.asEffect()`.
- Gent still owns permission checks, resource-needs scoping, lifecycle events,
  wide-event annotations, capability context injection, and extension
  execute/result reactions.
- The invalid-output regression is behavioral: a result reaction mutates a
  valid output into a schema-invalid value, and the runner returns the
  structured tool failure from Effect AI encoding.

Verification on 2026-05-07:

- `bun run --cwd packages/core typecheck`
- `bun run lint`
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/tool-runner.test.ts packages/core/tests/providers/provider-resolution.test.ts`

#### C22: refactor(runtime): replace ResourceManager semaphores with Effect locks

Spike `TxReentrantLock` against current read/write needs. If it fits, migrate.
If it does not, write an audit receipt explaining the exact mismatch and keep
the local manager with a stronger guard.

Definition of done:

- No arbitrary `READ_PERMITS = 1_000_000`, or a documented verified reason why
  Effect lock primitive cannot express the behavior.
- Concurrency tests prove read sharing and write exclusion.
- `bun run gate`.

#### C23: design(runtime): STM queue/state prototype

Build a small isolated prototype for `TxRef` / `TxQueue` replacing the current
queue reservation invariant. This is the one part where exploration is the
deliverable before committing migration.

Definition of done:

- Prototype compares current semaphore model vs STM model with executable
  tests.
- Decision recorded inline in Wave 20 closure notes.
- If STM is strictly better, create follow-up implementation commits
  C24-C30; otherwise keep the current model with documented proof.

#### C24-C30: refactor(runtime): adopt STM queue/state model if C23 proves it

Reserved implementation range. Use only if the prototype proves the migration.

Definition of done:

- Queue reservation/dequeue/persist invariants are transactional.
- Runtime queue tests and e2e queue contract tests pass.
- `bun run gate` and `bun run test:e2e`.

### Part D — Extension API Narrowing

#### C31: docs/extensions): define public vs builtin-internal API inventory

Write the target API inventory before moving imports:

- public authoring: `defineExtension`, `tool`, `request`, `action`,
  `resource`, `reaction`, `defineAgent`, minimal ids/schemas/errors;
- builtin internal: host context, session mutation helpers, runtime/platform
  seams, raw events, task internals, driver internals.

Definition of done:

- `ARCHITECTURE.md` and `docs/extensions.md` agree.
- No code moved yet; this commit locks the target.

#### C32-C45: refactor(extensions): move builtin-only imports behind internal API

Migrate builtins away from public `@gent/core/extensions/api` exports that
should be internal-only. Use `packages/extensions/internal/builtin.ts` as the
privileged path.

Definition of done:

- Third-party authoring imports remain small.
- Builtins still compile through internal path.
- No product feature removed.
- Focused extension tests per family, then `bun run gate`.

#### C46: refactor(core): narrow `packages/core/src/extensions/api.ts`

Delete public re-exports that are now internal-only.

Definition of done:

- Public API matches C31 inventory.
- Extension surface lock tests prove forbidden imports fail.
- `bun run gate`.

#### C47: docs(examples): delete or migrate stale pipeline/subscription examples

Migrate examples to reactions or delete them if they no longer teach a live
surface.

Definition of done:

- No example imports `pipeline` or `subscription`.
- Examples compile if examples are part of test/lint; otherwise add a focused
  smoke check or delete stale examples.

### Part E — Suppression Guardrails and Test Boundary Fixtures

#### C48: test(tooling): ban named eslint-disable blocks

Extend suppression checker to fail any `/* eslint-disable ... */` block outside
explicit fixture files.

Definition of done:

- Existing block disables converted to line-local disables.
- Checker tests cover rule-named blocks.
- `bun run lint` catches new block disables.

#### C49: test(core): add `testExtensionHostContext`

Create a typed test fixture with die-stubbed facets. Migrate the extension
reaction/prompt/session tests that currently cast partial objects.

Definition of done:

- No `as unknown as ExtensionHostContext` in core extension tests.
- Focused tests pass.

#### C50: test(tui): centralize extension lifecycle fake runtime/setup

Create typed TUI test helpers for client runtime, transport, and builtin setup
execution.

Definition of done:

- Repeated casts in `apps/tui/tests/extension-lifecycle.test.ts` removed.
- Autocomplete/lifecycle tests use the helper.

#### C51: test(extensions): add Claude SDK message builders

Replace partial `SDKMessage` casts with typed variant fixture constructors.

Definition of done:

- Claude executor mapper tests use real variant shapes.
- Drift against SDK message shape becomes compile-visible.

#### C52: test(tooling): add suppression inventory guard

Add a guard that fails on:

- `@ts-ignore`;
- direct `as any`;
- `as unknown as ExtensionHostContext`;
- new block disables;
- unreviewed `@effect-diagnostics` outside approved files.

Definition of done:

- Guard has fixture tests.
- `bun run lint` runs it.

### Part F — Test Ownership, Taxonomy, and Harness Collapse

#### C53: test(extensions): give `@gent/extensions` its own test lane

Add `packages/extensions/tests/**`, a package `test` script, and include the
package in `workspace-test-runner.ts`.

Definition of done:

- Root `bun run test` includes extensions.
- Empty or seed test proves runner ownership before migration.

#### C54-C75: test(extensions): move extension-owned tests out of core

Move extension tests by family:

- fs/exec/network;
- task/session;
- artifacts/interactions/skills/memory;
- audit/review/counsel/delegate/research/plan;
- provider-auth extensions;
- ACP/Claude bridge;
- auto/executor/resources.

Definition of done:

- Tests live with source package unless they are truly core extension-host
  tests.
- Imports and fixtures still use public or internal package boundaries
  intentionally.
- `bun run test` and `bun run gate`.

#### C76: test(core): make `createRpcHarness` the default extension acceptance helper

Demote raw `createE2ELayer` usage to advanced wiring. Migrate repeated RPC tests
that manually compose lower-level layers.

Definition of done:

- `extension-commands-rpc` and `skills-rpc` use `createRpcHarness` unless they
  test the harness itself.
- Docs/AGENTS test section names the default helper.

#### C77-C85: test(core): split god tests by behavior area

Split:

- `runtime/agent-loop.test.ts`;
- `server/session-commands.test.ts`;
- `storage/sqlite-storage.test.ts`.

Target names should describe behavior areas, not implementation methods:

- `agent-loop-streaming`;
- `agent-loop-continuation`;
- `agent-loop-interactions`;
- `session-delete`;
- `session-idempotency`;
- `message-send`;
- `sqlite-session-storage`;
- `sqlite-message-storage`;
- `sqlite-event-storage`;
- `sqlite-concurrency`.

Definition of done:

- No single test file remains a multi-thousand-line god test.
- File names mirror feature area and source ownership.
- No assertion weakened during moves.

#### C86-C92: test(tui): mirror TUI source structure

Move/split flat TUI tests into area directories where it improves ownership:

- `components/command-palette.test.tsx`;
- `components/interaction-renderers/{ask-user,prompt,handoff}.test.tsx`;
- additional flat tests only when they are true app-level behavior.

Definition of done:

- TUI tests mirror source areas or document why a flat app-level test is
  correct.
- `bun run --cwd apps/tui test`.

#### C93-C96: test(extensions): add missing RPC/model-turn acceptance coverage

For request-capability extensions, add one RPC acceptance test. For tool-only
model-facing extensions, add one model-turn acceptance test through the real
extension layer.

Definition of done:

- Direct service tests remain for local behavior.
- At least one public-boundary test exists for each extension family.

### Part G — Recursive Audit and Closure

#### C97: audit: rerun five-lane residue search

Rerun the same five lanes:

1. owned library workarounds;
2. Effect / Effect AI / STM ownership;
3. architecture and extension API;
4. suppressions;
5. tests.

Definition of done:

- No P0/P1/P2 remains, or this plan is extended before closure.

#### C98: docs: update architecture and AGENTS receipts

Update `ARCHITECTURE.md`, `docs/extensions.md`, and AGENTS test guidance if the
implemented shape diverges from current docs.

#### C99: test: full verification sweep

Run:

- upstream repo gates for touched repos;
- Gent `bun run gate`;
- Gent `bun run test:e2e`;
- suppression inventory;
- residue searches for deleted APIs.

#### C100: docs(plan): close Wave 20 ledger

Record:

- implementation ledger;
- accepted/rejected findings;
- verification receipts;
- any upstream commits and Gent dependency refreshes;
- final recursive audit result.

## Completion Definition

Wave 20 is not done when a subset is green. It is done when:

- Gent no longer carries Encore `CurrentAddress` erasure or live-state registry
  workarounds after upstream primitives exist.
- Effect AI owns tool input and output schemas.
- Public extension API is author-facing and small; builtin internals are behind
  an internal path.
- Named block disables are banned; recurring test/host/SDK casts are replaced
  with typed fixtures.
- Extension tests live under `@gent/extensions`; god tests are split; RPC/model
  acceptance coverage exists for extension families.
- Final recursive audit finds no P0/P1/P2 findings, or the wave is extended
  with the new findings before closure.
