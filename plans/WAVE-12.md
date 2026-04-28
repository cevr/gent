# Planify: Wave 12 — Substrate Closure + Recursive Audit

## Context

Wave 12 began as a corrective plan after the earlier document overstated
the post-W11 state. It is now an implemented closure wave: extension
authoring has independent leaves, tool concurrency derives from
Effect-backed needs, legacy extension state storage is retired, the actor
runtime owns durable state, slash commands are named as slash commands at
the transport boundary, and tests ban Promise-style control flow.

Current implemented baseline: working tree after `f812864c refactor(extensions): name slash command transport explicitly`
plus stale TUI extension mock/doc cleanup.

## Constraints

- Stay within Effect.
- No compatibility shims for deleted legacy names.
- One review round per batch: one Codex subagent plus one Okra counsel
  review. P0/P1/P2 findings block the next batch.
- Gates run between logical units: `bun run typecheck`, `bun run lint`,
  `bun run test`, and pre-commit `typecheck + build + lint+fmt + test`.
- Final batch is recursive: launch new Codex subagents and Okra counsel
  again, including simplification, and stop only when no P0/P1/P2 remain.

## Skills Used

`planify`, `architecture`, `effect-v4`, `test`, `code-style`, `bun`,
`repo`, `counsel`

## Research Inputs

- Codex subagents audited Wave 12 lanes for runtime ownership, extension
  boundaries, storage, SDK/TUI, tests, domain modeling, suppression debt,
  simplification, and recursive closeout.
- Okra counsel outputs included:
  `/tmp/counsel/personal-gent-860892a9/20260428-124634-codex-to-claude-ed0802/claude.md`,
  `/tmp/counsel/personal-gent-860892a9/20260428-125625-codex-to-claude-93fd67/claude.md`,
  `/tmp/counsel/personal-gent-860892a9/20260428-222321-codex-to-claude-f3733a/claude.md`.
- External comparison repos:
  `/Users/cvr/.cache/repo/badlogic/pi-mono`
  and `/Users/cvr/.cache/repo/anomalyco/opencode`.

## Implemented Batches

### Batch 1 — Legacy Message Surface Removed

**Commits**

- `bd1f0534 refactor(extensions): delete legacy message substrate`
- `78b56df4 refactor(extensions): remove legacy message surface`

**Receipts**

- Legacy message substrate no longer appears in the current extension
  API surface. Current authoring entrypoint is the bucketed
  `defineExtension({ id, resources?, tools?, commands?, rpc?, actors?,
reactions?, modelDrivers?, externalDrivers? })` shape in
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`.
- Architecture now documents the final authoring surface in
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:325`.

**Gate**

- Covered by later full pre-commit gates through `f812864c`.

### Batch 2 — Actor Route RPC Removed

**Commits**

- `42e3b078 refactor(extensions): move executor rpc off actor route`
- `f5fb3645 refactor(extensions): move auto rpc off actor route`

**Receipts**

- Executor public transport enters through RPC/controller services while
  actor messages remain private mailbox language:
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/actor.ts:37`.
- Auto declares RPC leaves directly:
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto.ts:699`.
- Actor views replace route-side projection for prompt/tool policy:
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/actor.ts:93`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto.ts:174`.

**Gate**

- Covered by later full pre-commit gates through `f812864c`.

### Batch 3 — Capability Leaves Made Independent

**Commits**

- `e4905f0b refactor(extensions): make capability leaves independent`

**Receipts**

- Tool leaf is standalone, branded, and uses `needs`:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:32`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:91`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:124`.
- Human command leaf is separate and lives in the `commands` bucket:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts:31`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts:54`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts:98`.
- RPC leaf is separate and lives in the `rpc` bucket:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:35`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:82`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:125`.
- Registry compiles typed buckets and dispatches public RPC only through
  `CompiledRpcRegistry.run`:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:71`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:77`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:83`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:255`.

**Gate**

- Covered by later full pre-commit gates through `f812864c`.

### Batch 4 — RPC and Slash Metadata Separated

**Commits**

- `3d564a34 fix(extensions): separate rpc slash metadata`
- `f812864c refactor(extensions): name slash command transport explicitly`

**Receipts**

- Public transport request payload is named for extension RPC dispatch:
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:359`.
- Slash command list payload and DTO are named as slash command surfaces:
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:374`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:379`.
- RPC group exposes `extension.listSlashCommands`, not
  `extension.listCommands`:
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs/extension.ts:23`.
- Handler map matches the public key and returns `SlashCommandInfo`:
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handler-groups/extension.ts:188`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handler-groups/extension.ts:193`.
- TUI uses the new namespaced client method:
  `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/context.tsx:256`.
- SDK namespaced client maps the flat RPC key:
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:92`.

**Review Receipt**

- Codex subagent `019dd638-7cd9-7a52-825d-1d52c7919a15`: no P0/P1/P2.
- Okra counsel
  `/tmp/counsel/personal-gent-860892a9/20260428-223212-codex-to-claude-2cb7e0/claude.md`:
  no P0/P1/P2 for `f812864c`; it flagged stale pre-existing
  `extension.ask/send` ghosts as non-blocking cleanup.

**Gate**

- `bun run typecheck` passed.
- `bun run lint` passed.
- Focused server/executor tests passed: 29 tests.
- `bun run test` passed.
- Pre-commit gate passed: `typecheck`, `build`, `lint+fmt`, `test`.

### Batch 5 — Actor Persistence Fails Closed

**Commits**

- `ef052e17 fix(runtime): fail closed on actor persistence errors`
- `3cf5793a fix(runtime): preserve healthy actor snapshots`

**Receipts**

- ActorEngine exposes `snapshotSettled` for preserving healthy rows:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:203`.
- ActorHost records snapshot write failures instead of suppressing them:
  `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/actor-host.test.ts:427`.
- Actor persistence storage remains narrow and profile-scoped:
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/actor-persistence-storage.ts:36`.

**Gate**

- Covered by later full pre-commit gates through `f812864c`.

### Batch 6 — Stale Substrate Terminology Removed

**Commits**

- `bb476126 docs(extensions): retire stale substrate terminology`
- `52a463ef docs(extensions): align runtime authoring terminology`
- `97d29b15 docs(runtime): close stale machine terminology`
- `72884d8c refactor(runtime): rename extension runtime marker`
- `af428d8a docs(runtime): rename extension runtime marker`
- `a38a6b63 docs(tests): rename extension runtime taxonomy`

**Receipts**

- Runtime marker is now `ExtensionRuntimeService` in
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/resource-host/extension-runtime.ts`.
- Architecture points at `ExtensionRuntime`, not `ActorRouter`:
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:382`.
- Test taxonomy points at `ExtensionRuntime`, not
  `ExtensionStateRuntime`:
  `/Users/cvr/Developer/personal/gent/AGENTS.md:121`.

**Review Receipt**

- Codex subagent `019dd630-754d-7873-82ad-a1810724b0f2`: P2 stale
  `ActorRouter` architecture reference; fixed in `af428d8a`.
- Okra counsel
  `/tmp/counsel/personal-gent-860892a9/20260428-222321-codex-to-claude-f3733a/claude.md`:
  P2 stale `ExtensionStateRuntime` taxonomy in `AGENTS.md`; fixed in
  `a38a6b63`.

**Gate**

- Pre-commit gates passed for all three latest commits:
  `72884d8c`, `af428d8a`, `a38a6b63`.

### Batch 7 — Extension State Side Channel Removed

**Commits**

- `d54f49b4 refactor(storage): remove extension state side channel`
- `5ed060b3 fix(storage): retire extension state table cleanly`

**Receipts**

- Search for `ExtensionStateRuntime`, `actor-router`, `ActorRouter`,
  `extensionStateRuntime`, `stateRuntimeLayer`, and `stateRuntime`
  across current source/docs returned no current matches after
  `a38a6b63`.
- Actor state storage is the remaining explicit durable actor store:
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/actor-persistence-storage.ts:36`.

**Gate**

- Covered by later full pre-commit gates through `f812864c`.

### Batch 8 — TUI State Schemas Replaced Erased State

**Commits**

- `baa5a690 refactor(tui): replace erased state schemas`

**Receipts**

- TUI state tests and integration suite pass under the full `bun run test`
  gate.
- No P0/P1/P2 review findings remain recorded for this batch.

**Gate**

- Covered by later full pre-commit gates through `f812864c`.

### Batch 9 — Test Promise Control Flow Banned

**Commits**

- Implemented before this plan rewrite in tooling.

**Receipts**

- Custom rule `gent/no-promise-control-flow-in-tests` rejects
  `try/finally`, `async` functions, and `await` in test files:
  `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts`.
- Rule fixtures prove invalid and valid cases:
  `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/no-promise-control-flow-in-tests.invalid.ts`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/no-promise-control-flow-in-tests.valid.ts`.
- Tooling test confirms both invalid and valid fixtures:
  `/Users/cvr/Developer/personal/gent/packages/tooling/tests/fixtures.test.ts`.

**Gate**

- `bun run lint` passed after the rule landed.
- Full `bun run test` passed at `f812864c`.

### Batch 10 — Test Migration Before Final Audit

**Status**

Completed as a verification/migration batch: current AST lint has zero
test violations for `try/finally`, async functions, or `await`. Regex
hits on `Deferred.await` / `Fiber.await` are not Promise control flow and
are intentionally allowed by the AST rule.

**Gate**

- `bun run lint` passed.
- `bun run test` passed.

### Batch 11 — Stale TUI Extension Ghosts Removed

**Status**

Implemented after Okra counsel flagged pre-existing doc/mock drift.

**Receipts**

- TUI extension docs now describe `client.extension.request(...)`, not
  removed `client.extension.ask(...)`:
  `/Users/cvr/Developer/personal/gent/apps/tui/AGENTS.md:174`.
- Render harness no longer mocks removed `extension.ask` or
  `extension.send`; it keeps only current extension transport methods:
  `/Users/cvr/Developer/personal/gent/apps/tui/tests/render-harness.tsx:116`.
- Batch 12 TUI test modules no longer mock removed `extension.ask`:
  `/Users/cvr/Developer/personal/gent/apps/tui/batch12-modules/tests/extension-lifecycle.module.ts:61`,
  `/Users/cvr/Developer/personal/gent/apps/tui/batch12-modules/tests/extension-integration.module.ts:359`.

**Gate**

Pending commit gate.

## Simplification Audit

Gent kept Effect, SQLite durability, typed actor state, and scoped
resources because they are feature-bearing. The simplification outcome
is not "copy pi-mono/opencode"; it is "delete shallow legacy aliases and
keep fewer deeper primitives."

### pi-mono Comparison

- pi-mono keeps its agent loop conceptually direct around provider
  streaming and tool execution. Receipt:
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:155`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts:240`.
- pi-mono exposes extension registration as direct maps and imperative
  registration methods. Receipt:
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1069`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1515`.
- Gent applied the analogous simplification by making the bucket name
  the discriminant and deleting mixed audience dispatch:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:126`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:255`.

### opencode Comparison

- opencode's tool contract is small and deep: id, description,
  parameters, execute, plus centralized execution wrapping. Receipt:
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/tool/tool.ts:34`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/tool/tool.ts:77`.
- opencode plugin runtime uses a compact hook trigger/list/init shape.
  Receipt:
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/plugin/index.ts:40`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/plugin/index.ts:259`.
- Gent applied the same small-interface/deep-implementation pressure by
  narrowing public extension calls to RPC leaves and public slash listing
  to slash DTOs:
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs/extension.ts:12`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs/extension.ts:23`.

### What Remains Intentionally

- `defineResource` remains. It is not the old string-resource lock
  model; it is the Effect layer/lifetime primitive for process, cwd,
  session, and branch resources. Receipt:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:27`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:91`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:164`.
- `ActorEngine.subscribeState` remains as a typed actor observation
  stream on `ActorRef<M, S>`, not a second storage runtime. Receipt:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/actor.ts:123`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:211`.
- `ActorEngine.peekView` remains for pure actor `Behavior.view` prompt
  and tool-policy projection. Receipt:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/actor.ts:143`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/actor-engine.ts:220`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:309`.

## Final Recursive Audit Batch

### Status

Pending after Batch 11 commit.

### Required Steps

1. Run final full gate:
   `bun run typecheck && bun run lint && bun run test`.
2. Launch fresh Codex subagents for:
   extension surface, runtime/actor/storage, SDK/TUI transport,
   test-rule coverage, and simplification/LOC pressure.
3. Run Okra counsel with the same packet and explicitly ask it to
   launch its own subagents.
4. Ask both lanes to search again for P0/P1/P2:
   `CapabilityHost`, stale `listCommands`, stale
   `RequestCapabilityInput`, stale `ActorRouter`,
   stale `ExtensionStateRuntime`, string tool `resources`, tool
   `idempotent`, test `try/finally`, and test `async`/`await`.
5. Fix any P0/P1/P2 with a new batch commit, then repeat this audit
   batch once. No further implementation begins until both lanes report
   no P0/P1/P2.
6. Record the final audit receipts in this file before closeout.

## Current Gate Receipts

- `bun run typecheck`: passed after `f812864c`.
- `bun run lint`: passed after `f812864c`.
- `bun run test`: passed after `f812864c`.
- Pre-commit for `f812864c`: passed `typecheck`, `build`, `lint+fmt`,
  and `test`.
