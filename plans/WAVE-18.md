# Planify: Wave 18 — Platform Reach, Hand-Rolled Substrate, And Loop Collapse

## Thesis

Wave 18 closes Wave 17's open carry-forward and absorbs the fresh four-lane
audit (Effect platform alignment, pi-mono shape, opencode shape, gent
self-audit, lintable learnings) into one plan. The codebase has no users and no
compatibility contract. The correct move is to delete every parallel substrate
that Effect, `@effect/ai`, `@effect/platform`, `@effect/sql`, and
`@effect/cluster` already own, then collapse the residual hand-rolled shapes
that the Wave 17 audit caught at the same time.

The north stars are unchanged:

1. **Effect is the platform.** Use Effect RPC, Effect AI, Effect Schema,
   Effect SQL, Effect Cluster Entity, `@effect/platform` services, and
   `@effect/opentelemetry` where they already own a concept. Stop wrapping.
2. **Actors are the runtime shape.** Durable coordination is a typed entity
   protocol. Plain resources are for services. DTO bridges, marker services,
   in-process registries, parallel command unions, and reimplemented platform
   primitives do not survive.
3. **Correctness, not pragmatism.** Schema rewrites and DB resets are fine.
   Public SDK and RPC surface breaks are fine. No deprecation cycles, no
   compatibility shims, no migration aliases.

## Non-Negotiable Execution Rules

- No deprecation layers, compatibility aliases, compatibility migrations, or
  old-shape shims. If a SQLite schema is cleaner reset, reset it.
- Every commit runs `bun run gate`. Boundary commits run focused tests first;
  significant boundary commits run `bun run test:e2e`.
- High-blast-radius work splits into sub-commits by owner (e.g. C7.1 / C7.2 /
  C7.3). Each sub-commit must compile and pass gate.
- One independent review per implementation commit. Counsel runs after every
  commit per `feedback_counsel_after_batch.md`. If `okra counsel` reports the
  destination model is rate-limited, fall back to an independent Opus Agent
  review per `feedback_counsel_fallback_opus.md` — never defer. If counsel or
  review surfaces a structural correction, apply it in the next commit instead
  of preserving the old path.
- Mechanical rewrites are delegated after one manual before/after pair proves
  the pattern. Recipes carry exact rename rules, transformation rules, two
  worked examples, the validation command, and "stop and report on a misfit".
- Every new behavior ships tests in the same commit. Every new tagged union
  uses `TaggedEnumClass` / `Schema.TaggedStruct` / `Schema.TaggedErrorClass`.
- No process-shaped names enter active source. `wave18`, `c12`, `migration` and
  similar belong only to this plan and dated audit receipts.

## Carry-Forward From Wave 17

Wave 17 landed C10-C17 (storage facade deletion, canonical tool interactions,
TUI projection unification, dead extension storage, doc rewrite, platform
duplication guards). The following items remained open and roll into Wave 18
as first-class commits:

- **C1 Wave 17** — Delete `ExtensionRuntime` empty marker service.
- **C2 Wave 17** — Delete `makeNamespacedClient`'s manual mirror; derive
  namespaced SDK access from RPC keys (or expose flat client as primary).
- **C3 Wave 17** — Delete `SessionInfo`, `BranchInfo`, flat `SessionTreeNode`,
  and `sessionToInfo` / `branchToInfo` mappers. Return domain `Session`,
  `Branch`, and domain-owned tree shapes.
- **C4 Wave 17** — Delete public `actor.*` RPCs. Route remaining use cases
  through product RPCs.
- **C5 Wave 17** — Collapse `ExtensionTurnControl` into the session
  protocol. Delete the turn-control mailbox, ack envelopes, owner stack, and
  global stream consumer.
- **C6 Wave 17** — External drivers stream `Response.AnyPart` directly.
  Delete `TurnEvent`, `TurnEventUsage`, and the conversion switch in
  `collectExternalTurnResponse`.
- **C7 Wave 17** — Shrink `ProviderService` to model/auth resolution. Replace
  `ProviderRequest`, `GenerateRequest`, and `ProviderService.stream` with
  upstream `LanguageModel.streamText` calls in runtime.
- **C8 Wave 17** — Unify tool execution with Effect `Tool.Any` / `Toolkit`.
  Delete the advertise-only provider toolkit. Keep Gent metadata as
  annotations.
- **C9 Wave 17** — Make session runtime an actor/entity protocol. Replace
  the loop maps, semaphore, and duplicate command union with a typed entity
  protocol (Effect Entity if it fits; minimal local adapter otherwise, with the
  mismatch written down).

These carry-forward items become C1-C9 of this wave. Subsequent commits
introduce the new findings.

## External Audit Synthesis

### Effect Platform (Lane 1)

Effect already owns the primitives this codebase is recreating. The gent-side
re-implementations should be deleted in favor of the upstream service:

- **Identity / UUIDs** — `Bun.randomUUIDv7()` is hard-coded in 25+ runtime call
  sites (`agent-loop.commands.ts`, `session-runtime.ts`, `agent-runner.ts`,
  `session-commands.ts`, `interaction-request.ts`, `provider-auth.ts`,
  `task-tools-service.ts`, `tracer.ts`). Effect's platform path is to depend on
  a service for non-deterministic IDs so tests can pin them.
- **Tracing / Spans** — `packages/core/src/runtime/tracer.ts` (205 lines) is a
  hand-rolled `Tracer.Tracer` with custom `GentSpan` wrapping. `@effect/opentelemetry`
  - `NodeSdk.layer` + `OtlpTracer.layer` is the upstream path.
- **SQLite migrations** — `storage/schema.ts` (`CORE_SCHEMA_VERSION = "1"` plus
  `resetIncompatibleStorageSchema` dropping all tables on mismatch) is a
  destructive migration system. `@effect/sql/SqliteMigrator` with
  `Migrator.fromArray([...])` is the upstream path. Concrete user-data risk:
  bumping the version silently deletes session history.
- **File-backed key-value** — `domain/auth-storage.ts:LiveFile` (80 lines of
  hand-rolled JSON KV with `node:fs` + `node:os` + `node:buffer`) is reinventing
  `KeyValueStore.layerFileSystem` + `toSchemaStore`.
- **Child processes** — `Bun.spawn` in `supervisor.ts`, `shell.ts`, `bash.ts`,
  `auth-storage.ts`, `subagent-runner.ts` should be `ChildProcess.make` from
  `@effect/platform`. The beta.21 fix in memory unblocks this.
- **OpenAI / Anthropic OAuth** — `extensions/src/openai/oauth.ts` is 7
  `async`/`await` functions wrapped in `Effect.tryPromise` at every caller.
  Native `Effect.gen` plus `HttpServer.layer` for the OAuth redirect listener
  collapse the layer.

The Effect RPC, `@effect/cluster/Entity`, and `@effect/sql/SqlClient`
conclusions remain identical to Wave 17.

### pi-mono Shape (Lane 2)

pi-mono's lower-level loop shape is the relevant lesson, not its
`AgentSession`. The structural compactions worth importing:

- **Loop split** — Gent's loop is 5,039 lines across 7 files
  (`agent-loop.ts`, `agent-loop.state.ts`, `agent-loop.commands.ts`,
  `agent-loop.checkpoint.ts`, `agent-loop.utils.ts`, `phases/turn.ts`,
  `turn-response/collectors.ts`). pi-mono is 1,238 lines in 2 files
  (`agent-loop.ts`, `agent.ts`) — a 3.1× ratio. Most of the difference is
  parallel state-builders, projection helpers, and the epoch counter.
- **Loop state shadow** — `LoopState` is a `TaggedEnumClass`, but
  `LoopRuntimeState` shadows it for projections. Collapse to a single source.
- **Branch ID threading** — `branchId` is a parameter on roughly 65 internal
  call sites because the loop is keyed by `(sessionId, branchId)` rather than
  by a single branch-scoped fiber. Either rebuild the loop as a per-branch
  entity (preferred) or carry a single `BranchScope` value through phases.
- **State epoch counter → Deferred** — The epoch counter pattern is replaceable
  by a `Deferred` per resolution, keyed by request id.
- **Two-pass prompt reaction** — system-prompt assembly currently runs in two
  passes via a reaction slot. pi-mono assembles in one pass.
- **Activation stages** — Five-stage activation pipeline collapses to three
  stages without losing observability.

### opencode Shape (Lane 3)

opencode keeps one source of truth for domain/session/tool state across server
routes and persistence. The structural takeaways:

- **Transport contract is overlaid on domain** — Delete
  `server/transport-contract.ts` (already in C3). Domain `Session` / `Branch`
  / `SessionTreeNode` flow through RPC directly.
- **Tool state lives in one canonical projection** — Already landed via Wave
  17 C13. Continue deleting any remaining client-side rejoin paths.
- **Storage = one service plus session-owned operations** — Already mostly
  landed via Wave 17 C12. Confirm no facade remnants.
- **Session-cwd registry is over-engineered for single-cwd usage** —
  `SessionCwdRegistry` adds a routing layer on top of session lookup. Either
  delete it or scope it to genuine multi-cwd entrypoints.
- **Server/SDK split has 5 handler-group files** — Merge the per-group RPC
  handler files. The grouping serves no boundary.

### Gent Self-Audit (Lane 4)

15 zones, top 10 structural fixes:

1. Move `Bun.randomUUIDv7()` behind `IdService` platform service (~25 sites).
2. Rewrite `extensions/src/openai/oauth.ts` as `Effect.gen` (7 async, 6
   `Promise<>`, raw timers, `Bun.serve`).
3. Fix `EventStore.Live = EventStore.Memory` lie. `Live` should be the SQL-backed
   `EventStoreLive` with required `SqlClient` dependency.
4. Convert 12 hand-rolled `{ _tag: "X" } | { _tag: "Y" }` unions to
   `TaggedEnumClass` (per `feedback_tagged_enum_class.md`).
5. Move `node:fs` / `Bun.file` / `Bun.write` in `extensions/src/memory/vault.ts`
   behind `FileSystem.FileSystem` (15+ sync calls, 4 `node:` imports).
6. Add lint rule banning `Bun.` outside `*-adapter.ts`, `main.ts`, `scripts/`,
   and `packages/tooling/`.
7. Collapse `InteractionRecoveryTag` and `BasePromptSectionsTag` (module-private
   tags used only as value-threading workarounds in `dependencies.ts`).
8. Delete or fully specify `SessionRuntime.Test()` and `AgentLoop.Test()`
   (return `Effect.die("not implemented")` for most methods today).
9. Replace `checkpoint-storage.ts:fromRow` and `interaction-storage.ts:fromRow`
   with `Schema.transform` from row shape to record schema.
10. Move `Bun.env` reads in provider extensions behind `ConfigService` /
    `Effect.config(Config.string(...))`.

Plus: 7 `throw new Error` bail-outs in production source, 6 `Effect.sleep`
state-transition polls in `vault.ts`/`use-scroll-sync.ts`/`sidecar.ts`/
`native-adapter.ts`, 5 `Bun.sleep` test waits bypassing Effect finalizers, and
~35 `node:` imports that should route through `@effect/platform`.

### Lintable Learnings (Lane 5)

15 candidate rules; top priorities:

- **A-tier (do now)**: `no-bun-outside-adapter`, `no-process-shaped-name-source`,
  `tagged-enum-class-required` (already enforced via
  `no-hand-rolled-tagged-union` lint, but four hand-rolled fixtures missing).
- **B-tier (after structural fixes settle)**: `no-effect-sleep-for-state-wait`,
  `no-sync-fs-outside-tooling`, `no-async-await-non-test`, `no-throw-in-effect`,
  `no-promise-leak-in-effect-typed-surface`,
  `require-effect-fn-for-service-method`, `no-pascalcase-filename`,
  `no-promise-return-in-core-domain`, `no-standalone-test-variant-export`.
- **D-tier (test fixture gaps)**: 4 existing rules
  (`no-projection-writes`, `no-runpromise-outside-boundary`,
  `all-errors-are-tagged`, `no-define-extension-throw`) lack fixture tests.
  CONTRIBUTING.md still has `async`/`Promise` examples that contradict
  enforcement.
- **Drop**: `AgentName` brand work — already landed at `domain/agent.ts:10`.
  Memory note `project_agent_name_unbranded.md` is stale.

## Local Findings — New In Wave 18

### F1 — Identity service is missing

`Bun.randomUUIDv7()` is the source of every loop, command, request, and event
id. `RuntimePlatform` exposes platform-style helpers but no `IdService`. Tests
pin ids by patching call sites or accepting non-determinism. Effect's pattern
is `Random` for deterministic IDs in tests.

### F2 — Tracer is hand-rolled

`packages/core/src/runtime/tracer.ts` (205 lines) implements `Tracer.Tracer`
with `GentSpan` wrapping plus a `Bun.write` exporter at line 22. The
`@effect/opentelemetry` `NodeSdk.layer` returns a `Tracer` that integrates
with OTLP collectors. The hand-rolled tracer also leaks `Bun.randomUUIDv7()`
at line 49.

### F3 — SQLite migrator is destructive

`packages/core/src/storage/schema.ts:107-125` calls `resetIncompatibleStorageSchema`
on schema-version mismatch, dropping all tables. `@effect/sql/SqliteMigrator`
runs forward migrations idempotently and tracks state in a metadata table.

### F4 — Auth storage and auto journal pointer are hand-rolled KV

`domain/auth-storage.ts:LiveFile` (80 lines) and `extensions/auto.ts` active
pointer (~25 lines) reimplement what `KeyValueStore.layerFileSystem` +
`toSchemaStore` provide.

### F5 — OpenAI OAuth is `async`/`Promise` from top to bottom

`extensions/src/openai/oauth.ts` has 7 `async` functions plus raw
`setTimeout`/`clearTimeout`, `Bun.serve` for the redirect listener, and
6 `Promise<>` types in the public surface. Anthropic's OAuth has the same
shape (`extensions/src/anthropic/oauth.ts:4` imports `node:os`).

### F6 — `Bun.spawn` and sync `node:fs` outside the platform service

- `packages/sdk/src/server-registry.ts` uses `mkdirSync`, `writeFileSync`,
  `readFileSync`, `existsSync`, `readdirSync`, `rmSync` from `node:fs`.
- `packages/sdk/src/supervisor.ts` uses `Bun.spawn`, `appendFileSync`,
  raw `setTimeout`/`clearTimeout`, and `node:net` for port probing.
- `packages/extensions/src/memory/vault.ts` has 15+ sync `Fs.*` calls and 4
  `node:` imports.
- `apps/tui/src/workspace/context.tsx` uses `node:fs.watch` directly.

### F7 — Hand-rolled tagged unions (12 occurrences)

`WorkerLifecycleState`, `ConnectionState`, `GentServer`, `StateSpec`,
`ProviderSpec`, `SidecarRecord`, `PortProbe`, `ConnState`, `CommittedEvent`,
`KeychainExit`, plus inline literal `{ _tag: "X" as const }` constructions in
`extensions/src/artifacts/index.ts` and `runtime/agent/phases/turn.ts`.

### F8 — Bail-out `throw new Error` in production source

`dependencies.ts:294`, `message-part-projection.ts:381`, `capability/tool.ts:80`,
`librarian/git-reader.ts:191,195`, `acp-agents/mcp-codemode.ts:101`,
`openai/index.ts:126`, `librarian/repo-explorer.ts:364` (a stub disguised as
return), `app-bootstrap.ts:84`, `client-facets.ts:350`, `resolve.ts:73,311`.
Each must become a typed `Schema.TaggedError` routed through `Effect.fail`.

### F9 — `Effect.sleep` state-transition polls

`native-adapter.ts:44` (waitForScan loop), `use-scroll-sync.ts:53,58` (DOM
retry loop), `sidecar.ts:403` (result polling), `apps/tui/src/utils/file-finder.ts:100`
(`Effect.sleep(0)` scheduler hack). Each becomes a `Deferred` or `waitFor`
helper.

### F10 — `Bun.sleep` in tests bypasses Effect finalizers

`packages/sdk/tests/supervisor.test.ts:61,88,99,110` and
`server-registry.test.ts:501` use `Effect.promise(() => Bun.sleep(N))` for
state-transition waits. Per CLAUDE.md these must use `Effect.sleep` (which
respects `TestClock`) and `Deferred`/`waitFor` for state coordination.

### F11 — `EventStore.Live = EventStore.Memory` aliases

`packages/core/src/domain/event.ts:629` aliases `static Live` to the in-memory
implementation. The real SQL-backed `EventStoreLive` lives in
`server/dependencies.ts:108` and is wired by hand. Production tests using
`EventStore.Live` get an in-memory store silently.

### F12 — Module-private service tags as value-threading workarounds

`server/dependencies.ts:40,45` — `InteractionRecoveryTag`, `BasePromptSectionsTag`.
`server/session-commands.ts:124` — `SessionRuntimeTerminator`.
`task-tools-storage.ts:226,393` — `TaskStorageReadOnly` parallel to `TaskStorage`.

### F13 — Schema-driven storage rows missing

`storage/checkpoint-storage.ts:fromRow` and `storage/interaction-storage.ts:fromRow`
are hand-coded mappers. Both should be `Schema.transform` from row shape to
record class so column drift is caught at validate time.

### F14 — Loop file count and state shadow

7 files / 5,039 lines for loop work that pi-mono solves in 2 files / 1,238
lines. The actor/entity migration in C9 is the structural lever, but `LoopState`
and `LoopRuntimeState` already overlap and can collapse before that work.

### F15 — Lint rule fixtures missing

`no-projection-writes`, `no-runpromise-outside-boundary`,
`all-errors-are-tagged`, and `no-define-extension-throw` exist in
`lint/no-direct-env.ts` but have no fixtures in
`packages/tooling/tests/fixtures.test.ts`. Without fixtures these rules can
silently regress.

### F16 — Provider extension `Bun.env` reads

`google/index.ts`, `anthropic/index.ts`, `openai/index.ts`, `mistral/index.ts`
each contain top-level `const v = Bun.env[name]` patterns. These bypass
`ConfigService` entirely and break test isolation.

## Commit Wave

Each commit specifies its scope, the rule it enforces, and the verification
gate. Sub-commits are listed inline where the blast radius warrants them.
Counsel runs after every commit; review findings fold into the next commit.

### Carry-Forward From Wave 17

#### C1 — `refactor(runtime): delete extension runtime marker`

Delete `ExtensionRuntime` and remove from session runtime, agent loop,
host-context deps, RPC handlers, profile composition, tests, and docs. Keep
real services explicit: `ExtensionRegistry`, `DriverRegistry`, `ActorEngine`,
`Receptionist`, `ExtensionTurnControl` until later commits delete or replace.

Verification: focused runtime/profile tests, `bun run gate`.

#### C2 — `refactor(sdk): remove manual namespace mirror`

Make the SDK either expose flat Effect RPC client as primary or derive the
namespaced convenience value mechanically from dotted keys. Add a drift test
that every `GentRpcs` key is reachable by the selected SDK surface.

Verification: SDK tests, TUI client tests, `bun run gate`.

#### C3 — `refactor(api): return domain session and branch contracts`

Delete `SessionInfo`, `BranchInfo`, flattened `SessionTreeNode`,
`sessionToInfo`, `branchToInfo`. Return domain `Session`, `Branch`, and
domain-owned recursive session tree shapes. Update TUI route state and tests.

Breaking change: public SDK types change immediately.

Verification: transport/RPC tests, TUI session tree tests, `bun run gate`.

**First mechanical delegation point.** After one consumer migrates manually,
delegate the remaining transport DTO call-site migration with the recipe at
the bottom of this file.

#### C4 — `refactor(api): remove public actor rpc surface`

Remove public `actor.*` RPCs. Route remaining use cases through product RPCs
(`message.send`, `steer.command`, `queue.*`, `session.watchRuntime`, snapshot,
or a narrow session metrics query). Keep internal entity tests in core.

Verification: RPC tests, TUI agent lifecycle tests, `bun run gate`.

#### C5 — `refactor(runtime): collapse turn control into session protocol`

Delete `ExtensionTurnControl.commands`, ack envelopes, owner stacks, and the
global stream consumer. `ctx.session.queueFollowUp` and interjection paths
call the session engine/entity protocol directly for the active target.

Verification: agent-loop queue tests, extension follow-up tests, `bun run gate`,
`bun run test:e2e`.

#### C6 — `refactor(ai): stream effect response parts from external drivers`

External drivers stream Effect AI `Response.AnyPart` directly. Delete
`TurnEvent`, `TurnEventUsage`, and the conversion switch in
`collectExternalTurnResponse`. Derive Gent durable events from response parts.

Breaking change: external driver authoring API changes immediately.

Verification: provider/external driver tests, ACP/executor tests, `bun run gate`,
`bun run test:e2e`.

#### C7 — `refactor(provider): make language model the runtime boundary`

Sub-commits:

- **C7.1** — Delete `ProviderRequest`, `GenerateRequest`, `ProviderService.stream`.
- **C7.2** — Replace turn-phase callers with `LanguageModel.streamText`.
- **C7.3** — Preserve deterministic test helpers as `LanguageModel` test
  layers, not parallel provider APIs.

Verification: provider auth tests, provider sequence/signal tests, turn phase
tests, `bun run gate`, `bun run test:e2e`.

#### C8 — `refactor(tools): unify tool execution with effect toolkit`

Move permission, decode, execution, result encoding, and event emission behind
a single tool execution adapter built from Effect `Tool.Any` / `Toolkit`.
Delete the advertise-only provider toolkit. Keep Gent metadata as annotations
or a small domain-owned descriptor attached to upstream tools.

Sub-commits:

- **C8.1** — Adapter built from `Toolkit.toLayer`, decode/encode via Schema
  annotations.
- **C8.2** — Delete `ToolDefinition`, `ToolContext`, `makeToolContext` in
  `domain/tool.ts`. Redirect remaining callers to `capability/tool.ts`.
- **C8.3** — Collapse `ToolRunnerToolkit` (re-declared `AiToolkit.WithHandler`)
  into the upstream type.

Verification: tool runner tests, provider tool schema tests, extension tool
tests, `bun run gate`, `bun run test:e2e`.

#### C9 — `refactor(runtime): make session runtime an actor/entity protocol`

Replace the loop maps and duplicate command union with a typed session-actor
protocol. Prefer Effect Cluster Entity if the local Bun cluster requirements
and persistence semantics fit. If they don't, isolate a minimal entity-compatible
adapter and document the mismatch in this file before continuing.

No compatibility shell survives the commit. Callers migrate in the same batch.

Sub-commits (depend on profile of mismatch found):

- **C9.1** — Define entity protocol (request schemas, reply types).
- **C9.2** — Migrate persistence keys; reset SQLite snapshot table if shape
  changes.
- **C9.3** — Replace `AgentLoop` map indirection with entity client; delete
  the dispatch + duplicate command union in `session-runtime.ts`.
- **C9.4** — Move `LoopState` consumers to entity views; delete
  `LoopRuntimeState` shadow.

Verification: session runtime tests, recovery/checkpoint tests, queue tests,
`bun run gate`, `bun run test:e2e`.

### New Commits — Platform Reach Collapse

#### C10 — `feat(runtime): introduce IdService platform service`

Sub-commits:

- **C10.1** — Add `IdService` to `RuntimePlatform` (or as standalone Tag) with
  `Live` (`Bun.randomUUIDv7()`) and `Test` (deterministic counter) layers.
  Use Effect `Random` semantics where appropriate.
- **C10.2** — One manual migration pair (e.g. `agent-loop.commands.ts:1793`)
  proves the pattern.
- **C10.3** — Delegate the remaining ~24 call sites to a `general-purpose`
  Agent with the recipe at the bottom of this file. Validate per batch with
  `bun run typecheck`. Final batch runs `bun run gate`.

Verification: runtime tests, sequence-recording tests for ID stability,
`bun run gate`.

#### C11 — `refactor(runtime): adopt @effect/opentelemetry tracer`

Delete `packages/core/src/runtime/tracer.ts` (`GentTracerLive`, `GentSpan`).
Replace with `NodeSdk.layer({ resource, spanProcessor })` from
`@effect/opentelemetry`. Use `OtlpTracer.layer` if a collector endpoint is
configured; otherwise use a no-op exporter.

Verification: tracing assertions, `bun run gate`.

#### C12 — `refactor(storage): adopt @effect/sql SqliteMigrator`

Sub-commits:

- **C12.1** — Replace `resetIncompatibleStorageSchema` with `SqliteMigrator.layer({
loader: Migrator.fromArray([Migration1, Migration2, ...]) })`. Each migration
  is a `Migrator.make` value with explicit forward SQL.
- **C12.2** — Delete `CORE_SCHEMA_VERSION` and the destructive drop logic.
- **C12.3** — Reset local development DBs in the wave's release notes (no
  user data preservation guarantee).

Verification: storage tests with fresh DB, storage tests with seeded DB,
`bun run gate`.

#### C13 — `refactor(storage): KeyValueStore for auth and auto pointer`

Sub-commits:

- **C13.1** — Replace `domain/auth-storage.ts:LiveFile` with
  `KeyValueStore.layerFileSystem("~/.gent/auth")` wrapped via `toSchemaStore`.
  Delete the hand-rolled JSON KV.
- **C13.2** — Replace `auto.ts` active-pointer file logic with a `KeyValueStore`
  - Schema-typed pointer.
- **C13.3** — Delete `node:os` / `node:buffer` imports from auth files.

Verification: auth storage tests, auto extension tests, `bun run gate`.

#### C14 — `refactor(platform): ChildProcess and FileSystem for supervisor and registry`

Sub-commits:

- **C14.1** — Replace `Bun.spawn` in `packages/sdk/src/supervisor.ts` with
  `ChildProcess.make` from `@effect/platform`. Replace raw
  `setTimeout`/`clearTimeout` in `findOpenPort` with `Effect.async` plus
  `Effect.timeout`.
- **C14.2** — Replace sync `node:fs` calls in `packages/sdk/src/server-registry.ts`
  with `FileSystem.FileSystem` effects. Replace `node:path` with
  `Path.Path`.
- **C14.3** — Replace `appendFileSync` log writer in supervisor with an
  Effect-based log writer.
- **C14.4** — Replace `Bun.spawn` in `shell.ts`, `bash.ts`,
  `auth-storage.ts`, `subagent-runner.ts` with `ChildProcess.make`.
- **C14.5** — Replace `node:fs.watch` in `apps/tui/src/workspace/context.tsx`
  with `FileSystem.FileSystem.watch` (or wrap in `Effect.acquireRelease`).

Verification: supervisor tests (incl. `bun run test:e2e`), server-registry
tests, TUI workspace tests, `bun run gate`, `bun run test:e2e`.

#### C15 — `refactor(extensions): rewrite OAuth flows as Effect.gen`

Sub-commits:

- **C15.1** — Rewrite `extensions/src/openai/oauth.ts` as `Effect.fn` /
  `Effect.gen`. Replace `Bun.serve` for redirect listener with
  `HttpServer.layer`. Replace `setTimeout`/`clearTimeout` with `Effect.timeout`
  and `Deferred`. Eliminate all `async`/`Promise<>` from the public surface.
- **C15.2** — Same rewrite for `extensions/src/anthropic/oauth.ts`.
- **C15.3** — Update `openai/index.ts:178`, `credential-service.ts:126`, and
  Anthropic equivalents to call the Effect API directly (delete
  `Effect.tryPromise` wrappers).

Verification: OAuth tests with Effect HTTP fixtures, `bun run gate`.

#### C16 — `refactor(extensions): FileSystem for memory vault`

Replace 15+ sync `Fs.*` calls in `packages/extensions/src/memory/vault.ts`
with `FileSystem.FileSystem` effects. Delete 4 `node:` imports.
`serializeFrontmatter` becomes a `Schema.Class` with `Schema.encodeSync`.

Verification: memory extension tests with virtual FS layer, `bun run gate`.

### New Commits — Hand-Rolled Substrate Collapse

#### C17 — `refactor(domain): convert hand-rolled tagged unions to TaggedEnumClass`

Sub-commits (one per file or related cluster):

- **C17.1** — `WorkerLifecycleState` (`packages/sdk/src/supervisor.ts:16-38`).
- **C17.2** — `StateSpec`, `ProviderSpec`, `GentServer` (`packages/sdk/src/server.ts:49-76`).
- **C17.3** — `ConnectionState` (`packages/core/src/server/transport-contract.ts:391-395`).
  Aligned with C3 (transport delete) — folds into that commit if the type can
  be deleted entirely.
- **C17.4** — `SidecarRecord`, `PortProbe` (`packages/extensions/src/executor/sidecar.ts:56-91`).
- **C17.5** — `ConnState` (`packages/extensions/src/acp-agents/protocol.ts:89-91`).
- **C17.6** — `CommittedEvent<A>` (`packages/core/src/runtime/agent/phases/turn.ts:89-91`).
- **C17.7** — `KeychainExit` (`packages/core/src/domain/auth-storage.ts:99-102`).
- **C17.8** — Inline `{ _tag: "X" as const }` literal constructions in
  `extensions/src/artifacts/index.ts:58-59`. Migrate to `Variant.make`.

Each sub-commit constructs values via `.make({...})` per
`feedback_tagged_enum_class.md`. Verification per file: `bun run gate`.

#### C18 — `fix(domain): EventStore.Live points to SQL-backed implementation`

Make `EventStore.Live` resolve to `EventStoreLive` (SQL-backed) with a required
`SqlClient` dependency. Delete the `static Live = Memory` alias at
`domain/event.ts:629`. Audit all callers; tests intending in-memory must
explicitly request `EventStore.Memory`.

Verification: event-store tests, fresh failures from tests that misused
`Live`, `bun run gate`.

#### C19 — `refactor(domain): collapse domain/tool.ts into capability/tool.ts`

Delete `packages/core/src/domain/tool.ts` (`ToolDefinition`, `ToolContext`,
`makeToolContext`). Redirect `tool-runner.ts` to import `ToolCapabilityContext`
from `capability/tool.ts`. Type-test the unification with `Schema.is`.

Verification: tool tests, `bun run gate`. Folds into C8.2 if executed first;
listed separately because it can land independently.

#### C20 — `refactor(storage): Schema.transform for checkpoint and interaction rows`

Replace `checkpoint-storage.ts:fromRow` and `interaction-storage.ts:fromRow`
hand-coded mappers with `Schema.transform` from row shape to record schema.
Add `Schema.Class` for `AgentLoopCheckpointRecord` and
`InteractionRequestRecord` if they don't already own the wire shape.

Verification: storage tests with row drift cases, `bun run gate`.

#### C21 — `refactor(server): collapse module-private service tags into config values`

Sub-commits:

- **C21.1** — Delete `InteractionRecoveryTag` and `BasePromptSectionsTag` from
  `server/dependencies.ts`. Replace with direct Effect parameter passing or a
  single `DependenciesConfig` `Layer.succeed` value.
- **C21.2** — Delete `SessionRuntimeTerminator` from `server/session-commands.ts`.
- **C21.3** — Decide on `TaskStorageReadOnly` parallel tag: either delete it
  (return a read-only branded view from `TaskStorage`) or document why both
  must exist.

Verification: server tests, dependency wiring tests, `bun run gate`.

#### C22 — `refactor(domain): replace throw new Error with typed Schema.TaggedError`

Sub-commits:

- **C22.1** — Production-source bail-outs:
  `dependencies.ts:294`, `message-part-projection.ts:381`,
  `capability/tool.ts:80`, `git-reader.ts:191,195`, `mcp-codemode.ts:101`,
  `openai/index.ts:126`, `app-bootstrap.ts:84`, `client-facets.ts:350`,
  `resolve.ts:73,311`. Each becomes a `Schema.TaggedError` routed through
  `Effect.fail`.
- **C22.2** — Delete the "Info not implemented" stub return in
  `extensions/src/librarian/repo-explorer.ts:364`.

Verification: error-path tests, `bun run gate`.

#### C23 — `refactor(runtime): replace Effect.sleep state polls with Deferred / waitFor`

Sub-commits:

- **C23.1** — `native-adapter.ts:44` (`waitForScan` polling loop) →
  `Deferred` signaled by scanner completion.
- **C23.2** — `apps/tui/src/utils/file-finder.ts:100` (`Effect.sleep(0)`) →
  `Effect.yieldNow()`.
- **C23.3** — `apps/tui/src/hooks/use-scroll-sync.ts:53,58` → `waitFor`
  helper or MutationObserver effect.
- **C23.4** — `extensions/src/executor/sidecar.ts:403` (result polling) →
  `Deferred` or `Queue`.

Verification: focused tests with `TestClock`, `bun run gate`.

#### C24 — `test(sdk): replace Bun.sleep with Effect.sleep + TestClock`

Replace `Effect.promise(() => Bun.sleep(N))` calls in
`packages/sdk/tests/supervisor.test.ts:61,88,99,110` and
`server-registry.test.ts:501` with `Effect.sleep` (under `TestClock`) plus
`Deferred` / `controls.waitForCall` / `waitFor` for state coordination.

Verification: SDK supervisor tests, server-registry tests, `bun run gate`.

#### C25 — `refactor(extensions): ConfigService for provider environment reads`

Replace top-level `Bun.env[name]` reads in `google/index.ts`,
`anthropic/index.ts`, `openai/index.ts`, `mistral/index.ts` with
`ConfigService.get(name)` (or `Effect.config(Config.string(name))`). Add a
`ConfigService.Test(overrides)` static factory for integration tests.

Verification: provider extension tests with config overrides, `bun run gate`.

#### C26 — `refactor(runtime): collapse LoopRuntimeState shadow`

Delete `LoopRuntimeState` and merge its fields into `LoopState` (or a derived
projection accessor). Update consumers. This is independent of C9 and lands
ahead of it to reduce the C9 blast radius.

Verification: agent-loop state tests, `bun run gate`.

#### C27 — `refactor(server): merge per-handler RPC files`

The five server/rpcs handler-group files were grouped for nothing. Merge them
into one or two files keyed by domain (e.g. `session-rpcs.ts`,
`extension-rpcs.ts`). Folds into C3 if executed concurrently.

Verification: RPC tests, `bun run gate`.

#### C28 — `refactor(server): delete or scope SessionCwdRegistry`

Confirm whether multi-cwd is in scope. If single-cwd is acceptable, delete
`SessionCwdRegistry` and its routing layer. If multi-cwd remains, scope the
registry to genuine multi-cwd entrypoints only.

Verification: server tests, `bun run gate`.

#### C29 — `refactor(domain): collapse event-publisher files`

Merge `domain/event-publisher.ts` (interfaces + tags) and
`server/event-publisher.ts` (Live layer) into one file. The interface-vs-impl
split was for an old circular-dependency concern that no longer applies.

Verification: server tests, `bun run gate`.

### New Commits — Test Surface And Documentation

#### C30 — `refactor(runtime): delete or fully specify Test layer stubs`

`SessionRuntime.Test()`, `AgentLoop.Test()`, `ToolRunner.Test()` return
`Effect.die("not implemented")` for most methods. Either delete them entirely
(forcing all tests to use `baseLocalLayer()`) or give them complete typed
implementations.

Verification: extension lifecycle tests, `bun run gate`.

#### C31 — `test(tooling): close lint rule fixture gaps`

Add fixtures in `packages/tooling/tests/fixtures.test.ts` for:
`no-projection-writes`, `no-runpromise-outside-boundary`,
`all-errors-are-tagged`, `no-define-extension-throw`. Each must include a
positive (rule fires) and negative (rule passes) case.

Verification: lint tests, `bun run gate`.

### New Commits — Lint Additions

#### C32 — `feat(tooling): no-bun-outside-adapter lint`

Add a custom oxlint rule to `lint/no-direct-env.ts` that bans `Bun.` references
outside `*-adapter.ts`, `main.ts`, `scripts/`, and `packages/tooling/`. Wire
fixtures.

Verification: lint tests, `bun run gate`.

#### C33 — `feat(tooling): tagged-enum-class-required lint`

Add a custom oxlint rule that flags `type X = { _tag: "Y" } | { _tag: "Z" }`
literal unions in `.ts` files. Wire fixtures. Builds on existing
`no-hand-rolled-tagged-union` to catch the four C17 patterns at lint time
(this is what was missing fixture coverage at the start of the wave).

Verification: lint tests, `bun run gate`.

#### C34 — `chore(tooling): drop redundant lint rules covered by @effect/language-service`

After auditing `effect-ts/tsgo` source (`internal/rules/`), the three rules
proposed in this slot are already enforced at "error" severity by
`@effect/language-service` running through `@effect/tsgo`:

- `asyncFunction` — bans every `async` function/method/arrow declaration. Set
  to `error` in `tsconfig.json`. Documented boundary opt-outs use
  `// @effect-diagnostics asyncFunction:off`.
- `floatingEffect` + `lazyPromiseInEffectSync` + `newPromise` — cover Promise
  leaks. Plus `oxlint-tsgolint`'s `no_floating_promises`,
  `no_misused_promises`, `await_thenable`.
- `extendsNativeError` — covers `class X extends Error`, the structural shape
  that `gent/all-errors-are-tagged` (now removed) was checking.
- `processEnv` — covers raw `process.env.X` reads, plus `node/no-process-env`
  in oxlint.

The only gap was `no-throw-in-effect` (bare `throw new Error()` inside
`Effect.gen` body). After review, gent already uses `Schema.TaggedErrorClass`
everywhere; no production source has bare throws, and the recent C22 commit
explicitly migrated remaining sites. Adding a custom rule for an empty
violation set is dead weight.

Instead this commit removes redundant gent lint rules:

- `gent/no-direct-env` — `process.env` covered by tsgo `processEnv` +
  oxlint `node/no-process-env`. `Bun.env` covered by `gent/no-bun-outside-adapter`.
- `gent/all-errors-are-tagged` — covered by tsgo `extendsNativeError`.

Updates plugin docstring, `.oxlintrc.json` rule keys + override, fixtures
config, fixture test cases, and source-comment cross-references in
`packages/core/src/domain/sdk-boundary.ts`.

Verification: lint tests, `bun run gate`.

#### C35 — `feat(tooling): no-effect-sleep-for-state-wait, no-bun-sleep-in-test`

- `no-effect-sleep-for-state-wait` — flags `Effect.sleep` immediately followed
  by a state read or `while (cond)` loop.
- `no-bun-sleep-in-test` — flags `Bun.sleep` references in `*.test.ts`.

Verification: lint tests, `bun run gate`.

#### C36 — `feat(tooling): require-effect-fn-for-service-method`

Heuristic AST rule that flags `*.Live` / `Layer.effect(Tag, ...)` blocks where
service methods are defined as plain `Effect.gen` instead of `Effect.fn(name)`
(missing tracing).

Verification: lint tests, `bun run gate`.

#### C37 — `feat(tooling): no-process-shaped-name and no-pascalcase-filename walker`

Use `packages/tooling/src/check-platform-duplication-guards.ts` infrastructure
(or a sibling walker) to fail on:

- Process-shaped active source names (`wave\d+`, `batch\d+`,
  `c\d+\.\d+`, `migration`) outside `plans/` and dated audit receipts.
- PascalCase filename outside `apps/tui/src/components/`.

Verification: tooling tests, `bun run gate`.

### New Commits — Documentation And Closeout

#### C38 — `docs(architecture): rewrite around Wave 18 platform-native shape`

Update `ARCHITECTURE.md`, `CLAUDE.md` if needed, `apps/tui/AGENTS.md`,
`docs/extensions.md`, and active comments/tests so vocabulary matches:
`@effect/cluster/Entity` session protocol, `@effect/opentelemetry` tracing,
`@effect/sql/SqliteMigrator` storage, `KeyValueStore`-backed auth/journal,
`ChildProcess.make` supervisor, `LanguageModel` runtime boundary.

Update `CONTRIBUTING.md` to remove the `async`/`Promise` examples that
contradict enforced lints (lane 5 finding).

Verification: doc lint, `bun run gate`.

#### C39 — `test(audit): update platform duplication guards`

Extend `packages/tooling/src/check-platform-duplication-guards.ts` to lock the
deletions performed in this wave:

- `Bun.randomUUIDv7()` outside the `IdService.Live` adapter.
- Hand-rolled `Tracer.Tracer` / `GentSpan` patterns.
- Destructive `resetIncompatibleStorageSchema`-style migrations.
- `LiveFile` JSON KV pattern.
- `EventStore.Live = EventStore.Memory` alias.

Verification: tooling tests, `bun run gate`.

#### C40 — `docs(plan): close wave 18 with recursive audit`

Run fresh local audit, one Codex review, and one counsel review against the
final diff. Record accepted/rejected findings in this file with receipts. The
wave is not closed by green tests alone.

Verification: `bun run gate`, `bun run test:e2e`.

## Mechanical Delegation Recipes

### Recipe A — Transport DTO call-site migration (after C3 manual proof)

- Replace `SessionInfo` imports with domain `Session`.
- Replace `BranchInfo` imports with domain `Branch`.
- Replace `node.id` / `node.name` on session-tree consumers with
  `node.session.id` / `node.session.name`.
- Delete mapper call sites; do not add adapter functions.
- Stop and report if a consumer needs fields not present on the domain class.
- Validate each batch with `bun run typecheck`; final batch runs `bun run gate`.

### Recipe B — `Bun.randomUUIDv7()` → `IdService` migration (after C10 manual proof)

- Replace `Bun.randomUUIDv7()` with `yield* IdService.next()` (or the chosen
  method name from C10).
- Add `IdService` to the requirement signature of the surrounding function;
  prefer `Effect.fn` wrappers if the function has none.
- Stop and report if the call site is inside a `Layer.unsafeMakeContext`,
  module-top-level expression, or other location where yielding is impossible.
- Validate each batch with `bun run typecheck`; final batch runs `bun run gate`.

### Recipe C — `{ _tag: "X" } | { _tag: "Y" }` → `TaggedEnumClass` (after one C17 sub-commit proof)

- Define `class Name extends TaggedEnumClass<Name>()({ X: { ... fields }, Y: { ... fields } }) {}`.
- Construct with `Name.X({...})` / `Name.Y({...})` (matches `Variant.make`).
- Replace narrowing `if (x._tag === "X")` with `Match` or
  `match(x, Name.exhaustive({...}))`.
- Stop and report if a variant has a field that itself is a hand-rolled union
  (chain it).
- Validate each batch with `bun run gate`.

### Recipe D — `async`/`Promise<>` OAuth → `Effect.gen` (after C15.1 manual proof)

- Wrap leaf-level `crypto.subtle` calls in `Effect.tryPromise({ try, catch })`
  with a `Schema.TaggedError` for `catch`.
- Replace `setTimeout`/`clearTimeout` with `Effect.timeout` and `Deferred`.
- Replace `Bun.serve` redirect listener with `HttpServer.layer` and an
  ephemeral port allocation.
- Eliminate every `async` function; the public API returns
  `Effect.Effect<A, E, R>`.
- Stop and report if a leaf depends on a non-Effect-portable API (e.g.
  `BroadcastChannel`).
- Validate each batch with focused OAuth tests; final batch runs `bun run gate`.

## Closure Audit

To be filled at C40. Each implementation commit appends its hash and one-line
summary to the ledger below. Counsel and Codex reviews append accepted /
rejected / deferred findings with receipts.

### Implementation Ledger

(empty — populate as commits land)

### Accepted Review Findings

(empty — populate as reviews complete)

### Rejected Or Deferred Findings

(empty — populate as reviews complete)

### Verification Receipts

(empty — populate as gates pass)

## Current Source Trail

Brain principles:

- `/Users/cvr/.brain/principles/never-block-on-the-human.md`
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/use-the-platform.md`
- `/Users/cvr/.brain/principles/migrate-callers-then-delete-legacy-apis.md`
- `/Users/cvr/.brain/principles/small-interface-deep-implementation.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md`
- `/Users/cvr/.brain/principles/serialize-shared-state-mutations.md`
- `/Users/cvr/.brain/principles/derive-dont-sync.md`
- `/Users/cvr/.brain/principles/fix-root-causes.md`

Gent:

- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/CLAUDE.md`
- `/Users/cvr/Developer/personal/gent/plans/WAVE-17.md`
- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/check-platform-duplication-guards.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/auth-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/tracer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/runtime-platform.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.commands.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/phases/turn.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response/collectors.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/file-index/native-adapter.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/checkpoint-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/interaction-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-utils.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs/actor.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/supervisor.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/server-registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/oauth.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/oauth.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/vault.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/sidecar.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/protocol.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/workspace/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/file-finder.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-scroll-sync.ts`

External:

- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/LanguageModel.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Chat.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/rpc/Rpc.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/rpc/RpcGroup.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/cluster/Entity.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/sql/SqlClient.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/sql/SqliteMigrator.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/platform/KeyValueStore.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/platform/FileSystem.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/platform/ChildProcess.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/observability/NodeSdk.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/storage/storage.ts`
