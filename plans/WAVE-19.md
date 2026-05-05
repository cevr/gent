# Planify: Wave 19 — Membrane Collapse, Effect AI Adoption, And Platform Discipline

## Thesis

Wave 18 closed Wave 17's carry-forward and absorbed a five-lane audit. Wave 19
runs a fresh four-lane audit (Effect platform alignment, pi-mono, opencode,
GentPlatform/portability) against the post-Wave-18 codebase and synthesizes the
findings into a deletion-and-realignment wave.

Two structural problems dominate:

1. **The membrane / composer indirection** (Lane 1 #12). `composer.ts` +
   `effect-membrane.ts` + `scope-brands.ts` snapshot parent context as
   `Context.Context<never>`, erase its tag identity, and re-merge with explicit
   omit-lists, `Layer.fresh`, and 12 escape hatches. The right shape is
   `Layer.provideMerge(childOverrides, parentLayer)`. Highest leverage in the
   audit.
2. **Parallel re-implementations of Effect AI primitives** (Lane 1 #1, #2, #3,
   #9). `agent-loop.ts` + `agent-loop.state.ts` + `phases/turn.ts` re-implement
   `LanguageModel.streamText`, `Toolkit` execution, and approval resolution.
   `domain/message.ts` parts duplicate `effect/unstable/ai/Prompt` parts and
   force `ai-transcript.ts` (439 lines) to convert on every turn. `Provider`
   wraps `LanguageModel` with no semantic addition.

The north stars are unchanged from Wave 18:

1. **Effect is the platform.** Use `effect-encore` actors (the user's
   declarative wrapper over Effect Cluster `Entity` + `@effect/workflow` —
   `Actor.fromEntity` / `Actor.fromWorkflow` / `Actor.toLayer` /
   `Actor.toTestLayer`), Effect AI primitives (`LanguageModel`, `Tool`,
   `Toolkit`, `Prompt`, `Response`), Effect SQL (`SqlSchema`, `SqlModel`),
   Effect platform services (`KeyValueStore`, `FileSystem`, `Path`,
   `ChildProcessSpawner`, `BunHttpServer`). Stop wrapping. Stop snapshotting
   parent context.
2. **Preserve gent-owned product features.** Per
   `feedback_preserve_features_during_collapse.md`: collapse "thin bridge over
   library" but keep "gent-owned product capability". Concretely, the
   following remain regardless of concept count:
   - Helper-agent / ephemeral-run distinction (durable vs ephemeral with
     parent-store mirroring).
   - Cold-pattern interactions / `WaitingForInteraction` survives restarts.
   - Branch model (sessions own branches; fork from message).
   - `effect-wide-event` boundary (per memory pin
     `feedback_keep_wide_event.md`).
   - Typed extension buckets + capability tokens
     (`tools` / `actions` / `requests` / `resources` / `reactions`).
   - Tool intent (`read`/`write`/`exec`/`net`) + `ToolNeeds` capability tokens.
3. **Correctness, not pragmatism.** Schema rewrites and DB resets are fine.
   Public SDK and RPC surface breaks are fine. No deprecation cycles, no
   compatibility shims, no migration aliases.

## Non-Negotiable Execution Rules

- No deprecation layers, compatibility aliases, compatibility migrations, or
  old-shape shims. If a SQLite schema is cleaner reset, reset it.
- Every commit runs `bun run gate`. Boundary commits run focused tests first;
  significant boundary commits run `bun run test:e2e`.
- High-blast-radius work splits into sub-commits by owner. Each sub-commit must
  compile and pass gate.
- One independent review per implementation commit. Counsel runs after every
  **named commit (C1-C34)** per `feedback_counsel_after_batch.md`, not after
  every sub-commit (~60-80 sub-commits collapse to 34 review surfaces). Codex
  is rate-limited until 2026-05-05; until then, fall back to an independent
  Opus Agent review per `feedback_counsel_fallback_opus.md` — never defer.
- Mechanical rewrites are delegated after one manual before/after pair proves
  the pattern. Recipes carry exact rename rules, transformation rules, two
  worked examples, the validation command, and "stop and report on misfit".
- Every new behavior ships tests in the same commit. Every new tagged union
  uses `TaggedEnumClass` / `Schema.TaggedStruct` / `Schema.TaggedErrorClass`.
- **Apply the preserve-features filter on every commit.** For each deletion
  candidate, ask: "If I delete this and nothing else changed, what
  user-visible behavior disappears?" If the answer is "nothing" or "thin
  re-export", proceed. If a real product capability disappears, only thin the
  bridge code, not the feature.

## External Audit Synthesis

Receipts: each lane's full report lives at
`/private/tmp/claude-501/-Users-cvr-Developer-personal-gent/334e2608-0c1e-477d-9cb1-aeb7bbee33a6/tasks/{lane-id}.output`.

### Effect Platform (Lane 1)

12 surfaces audited. Verdicts:

- **COLLAPSE** — `agent-loop.ts` + `agent-loop.state.ts` (custom FSM driver,
  ~2229 lines). Comments at `agent-loop.ts:156, 191, 193` admit it: "replaces
  effect-machine `actor.call(Event)`". Going via `effect-encore`
  (`Actor.fromEntity` + `Actor.toLayer`) which compresses Effect Cluster's
  `Schema.Class` + `Rpc.make` + `RpcGroup` + `Entity.make` + handler wiring +
  client service into a single declarative DSL with built-in op-payload
  dedup (the `id(payload) → primaryKey` semantic), `peek`/`watch`/`waitFor`
  on `ExecId`, and `Actor.toTestLayer` for tests. The `loopsRef` Map +
  `mutationSemaphoresRef` Map + `loopsSemaphore` + per-key
  `Semaphore.make(1)` cache are the Sharding + Entity protocol re-implemented
  by hand. `LoopDriverEvent` TaggedEnum collapses to entity ops keyed by
  `(sessionId, branchId)`.
- **COLLAPSE** — `phases/turn.ts` four-phase split. `LanguageModel.streamText`
  at `effect-smol/packages/effect/src/unstable/ai/LanguageModel.ts:1745-2200`
  encapsulates the resolveTurn → runStream → executeTools → finalize
  pipeline. Move durable-event derivation into a `Stream.tap` over the Effect
  AI `StreamPart` stream.
- **COLLAPSE** — `providers/provider.ts` (667 lines). Wraps
  `LanguageModel.LanguageModel` with no semantic addition. Static test layers
  (`Provider.Sequence`/`Signal`/`Debug`/`Failing`) already construct via
  `LanguageModel.make`. Replace `Provider` Tag with thin `ModelResolver`
  service (~80 lines). `parseModelId` moves to `domain/model.ts`.
  Stream-part wrapper helpers (`textDeltaPart` etc.) collapse to
  `Response.makePart`.
- **COLLAPSE** — `domain/message.ts` parts. `TextPart` / `ImagePart` /
  `ToolCallPart` / `ToolResultPart` / `ReasoningPart` / `MessagePart` are
  Schema.Class duplicates of `Prompt.AnyPart` / `Response.AnyPart`. The header
  comment at `message.ts:17` itself admits this. `ai-transcript.ts` shrinks
  from 439 → ~100 lines.
- **THIN, partial COLLAPSE** — `storage/*-storage.ts` CRUD. Five+ row-shaped
  storage methods are textbook `SqlSchema.findOne` / `SqlSchema.single` /
  `SqlModel.makeRepository` calls (`effect-smol/packages/effect/src/unstable/sql/SqlSchema.ts:16-150`).
  Recursive CTE `deleteSession` keeps raw SQL.
- **KEEP** — `server/rpcs.ts` shape. `RpcGroup.make().merge(...)` per-domain
  sub-groups is the correct factoring.
- **KEEP** — `wide-event-boundary.ts` (per user pin).
- **COLLAPSE / split** — `gent-platform.ts` + `gent-platform-bun.ts` (covered
  in detail in Lane 4 below).
- **THIN, partial COLLAPSE** — `sdk/supervisor.ts` (752 lines).
  `launchWorkerUntilReady` is a hand-rolled `Effect.retry`. `findOpenPort`
  bridges `node:net` directly. `BunHttpServer.layer({port: 0})` from inside
  the worker eliminates the parent-pre-allocate dance. `handle.kill` timeout
  semantics (`supervisor.ts:336-340`) is an upstream
  `effect/unstable/process` bug to file. Process-isolation supervisor stays
  (gent product feature: workspace isolation).
- **THIN COLLAPSE** — Transport DTOs. Trivial single-field `*Input` aliases
  (`ListMessagesInput`, `GetSessionTreeInput`, `GetChildSessionsInput`,
  `ListBranchesInput`, `GetBranchTreeInput`, `WatchRuntimeInput`,
  `ListExtensionStatusInput`, `ListExtensionSlashCommandsInput`) and
  pure-realiases (`SessionTreeNodeSchema`, `BranchTreeNodeSchema`, the
  `SessionRuntime = SessionRuntimeStateSchema` alias) inline directly on
  `Rpc.make` payload arguments.
- **AUDIT FINDINGS — escape hatches** — 9 `@effect-diagnostics` suppressions
  in `composer.ts`, three `as unknown as <Brand>Scope` lines in
  `scope-brands.ts`, three `Effect.runSync(PubSub.unbounded())` sites
  (`event-store-live.ts:25`, `domain/event.ts:547`, `session-profile.ts:204`).
  Almost all collapse with #12.
- **COLLAPSE — highest leverage** — `composer.ts` + `effect-membrane.ts` +
  `scope-brands.ts`. ~600 lines, 9 `anyUnknownInErrorContext:off`
  suppressions, an explicit "omit these 11 Tags from parent context" map,
  `Layer.CurrentMemoMap` separately omitted, `Layer.fresh` wrap. Replace
  with `Layer.provideMerge(Layer.mergeAll(...overrides), parentLayer)` and a
  child `Sharding` per child run for scope isolation.

North-star violations not in the surface list:

- `makeAmbientExtensionHostContextDeps` in `session-runtime.ts:398-405` passes
  `agentLoop.queueFollowUp` as a closure into the extension host context.
  Hidden circular dep between SessionRuntime and AgentLoop. When AgentLoop
  becomes its own Entity, this becomes an `Rpc.make("queueFollowUp", ...)`
  call.
- `commandGate = Semaphore.make(1)` at `session-runtime.ts:395` serializes
  ALL writes to a SessionRuntime, but Cluster `Entity.toLayer` already
  serializes per-entity-instance via the entity mailbox. `commandGate`
  deletes outright when AgentLoop is its own Entity.
- `agent-runner.ts:600-700` `shouldMirrorEphemeralChildEvent` reimplements an
  event-routing predicate. Should be a `Stream.merge` of two entity event
  streams.
- `Effect.runSync(PubSub.unbounded())` sites should construct fiber-resident
  in `Effect.gen`, not lazy-runSync in a getter. Latent fork-safety hazard.

### pi-mono (Lane 2 — already filtered through preserve-features)

Findings carried forward from pre-compaction filtering (raw report retained
in conversation history):

- **APPLY (filtered)** — Collapse `tool` / `request` / `action` token
  hierarchy onto a single `Capability` discriminator. The three-token split
  is structurally a single-tag union with three constructors. Preserve
  intent + needs metadata as fields.
- **APPLY** — Collapse `ModelDriver` + `ExternalDriver` into a single
  `Driver` Tag with a discriminator. The two parallel Tag types share
  identical lifecycle and registry.
- **APPLY** — Collapse 8 storage sub-tags into 3
  (`Storage` / `EventStore` / `Search`). Sequence with Lane 1's
  `SqlModel.makeRepository` adoption — this is the same commit shape from a
  different angle. Keep `BranchStorage` boundary as a feature
  (branch-as-first-class).
- **APPLY** — Collapse 12 RPC sub-groups into ≤4 (`session`, `branch`,
  `message`, `extension`). Sub-group prefix files exist for nothing.
- **APPLY** — Collapse 3-file AuthGuard split into a single file.
- **REJECT** (preserve-features) — pi-mono's "delete Branch entirely;
  fork = new session with `parent_id`". Branches are user-visible: TUI
  `/branch` and `/fork` slash commands, branch picker, named branches in the
  TUI tree. Keeping Branch.

### opencode (Lane 3)

Verdicts (preserve-features filter applied):

- **ADOPT** — Auth subsystem collapse. `apps/opencode/src/auth/index.ts` is
  98 lines total: plain JSON file at `~/.gent/auth.json`, file mode 0600,
  three types (`Oauth | Api | WellKnown`). Gent's
  `auth-storage.ts` (513) + `auth-store.ts` (193) + `auth-guard.ts` (84) +
  `auth-method.ts` (19) ≈ 800 lines. Keychain encryption is overkill for a
  threat model where the attacker already has filesystem access. Saves ~700
  lines.
- **REJECT** — Permission cold-pattern → warm Deferred. The cold-pattern
  (`WaitingForInteraction` survives restarts) is a gent-owned product
  feature listed in the preserve-features memo. Keep.
- **PARTIAL ADOPT** — Server topology. opencode's `apps/opencode/src/server/server.ts`
  (333 lines) routes via `x-opencode-directory` header from a single
  long-running process. Gent's per-DB hash + supervisor + registry +
  worker-http + cross-process lock is ~1500 lines for a multi-workspace
  story. Keep workspace isolation as a feature (sessions don't bleed across
  workspaces) but collapse the implementation to a single server with
  workspace-id routing. Drops supervisor's process-isolation responsibility
  back to a one-process baseline. Saves ~1500 lines, simplifies SDK
  connect/disconnect, removes the registry concept.
- **REJECT** — TUI auth-as-overlay (Lane 3 Surface 1). `apps/tui/CLAUDE.md`
  line 80 said "auth and permissions are session overlays, not routes" but
  the practical UX requires a full auth screen on first run; route is the
  right shape. Update the doc instead.
- **APPLY** — Headless richness. `apps/tui/src/headless-runner.ts`
  (111 lines) is dramatically leaner than opencode's
  `apps/opencode/src/cli/cmd/run.ts` (678 lines), but the headless surface
  doesn't render named tool calls (bash command + truncated output, etc.).
  Add tool renderers via extensions.

The audit also flagged:

- 27 builtin extensions is too many; some are tool-runner shims that should
  collapse. Audit list in C19 below.
- `effect-membrane.ts` lives in extensions/runtime/effect-membrane.ts; covered
  by Lane 1 #12.

### GentPlatform / Portability (Lane 4)

GentPlatform is "currently both too big and too small". Concrete migration
table:

**Service additions (P1 — needed before removals):**

- `GentPlatform.osInfo: Effect<{ platform, arch, release, hostname, type }>`.
- `GentPlatform.pid: Effect<number>`.
- `GentPlatform.execPath: Effect<string>`.
- `GentPlatform.signal: (pid, signal) => Effect<void, SignalError>`.
- `GentPlatform.exit: (code) => Effect<never>` (Effect-scope-aware exit).
- `GentPlatform.now: Effect<number>` (monotonic for supervisor backoff math).

**Service removals (P2):**

- `GentPlatform.serve` — replace with `BunHttpServer.layer({port: 0})` (file
  reference: `effect-smol/packages/platform-bun/src/BunHttpServer.ts:241`).
- `GentPlatform.inspect` — vendor a tiny inspect helper or use `JSON.stringify`
  with a custom replacer at the 4 call sites.
- `GentPlatform.readFileText` — `FileSystem.FileSystem.readFileString`.
- `GentPlatform.spawnSync` — `ChildProcessSpawner` (already used for async).
- `GentPlatform.which` — `Path.Path` resolution + `FileSystem.exists`.

**38 process.\* sites to route through service:**

- `process.exit` — 7 sites including `apps/tui/src/main.tsx:520-536`
  (which violates the gotcha doc by bypassing Effect scope finalizers).
- `process.pid` — 4 sites (supervisor, server-registry, sidecar).
- `process.platform` — 5 sites in extensions.
- `process.execPath` — 2 sites (supervisor, server-registry).
- `process.kill` — 3 sites in supervisor.
- `process.hrtime.bigint()` — 2 sites in supervisor backoff math.
- The remaining 15 are read-only `process.env.X` reads — covered by the
  existing `gent/no-direct-env` lint plus C25 in Wave 18 (not yet landed).

**packages/sdk supervisor.ts is half-migrated** to `effect/unstable/process`.
Finish the migration in one focused commit (`ChildProcess.make` instead of
`Bun.spawn`; `ChildProcessSpawner` for the typed handle; remove the manual
`appendFileSync` log writer).

**Bun.Glob in fallback-adapter.ts** is the only genuinely Bun-locked source
code. Replace with `picomatch` (zero-dep, MIT, ~300 lines, used by every
glob-aware tool in the JS ecosystem).

**`/packages/sdk/` lint allowlist removable** after P1+P2 complete. The only
remaining justification was supervisor process control.

Lane 4 estimates 17 commits for full P1+P2 migration.

## Local Findings — Carry-Forward From Wave 18

These Wave 18 commits did not land before closeout and roll into Wave 19 as
first-class commits:

- **C9 (Wave 18) — make session runtime an actor/entity protocol.** Wave 18
  C9 was the largest single commit and was cut from the wave. Now C5 below.
- **C10 (Wave 18) — IdService.** Already shipped under another name:
  `GentPlatform.randomId` is the live service (see audit recorded in C13).
  Wave 19's C13 narrows to "lock the regression with a guard pattern".
- **C11 (Wave 18) — `@effect/opentelemetry` tracer.** `tracer.ts` (205 lines)
  still hand-rolled. Now C14. Platform duplication guard already locks
  re-introduction.
- **C12 (Wave 18) — `SqliteMigrator`.** `resetIncompatibleStorageSchema` still
  destructive. Now C15.
- **C13 (Wave 18) — `KeyValueStore` for auth and auto pointer.** `LiveFile`
  still hand-rolled. Now C2 (folds into auth simplification).
- **C14 (Wave 18) — ChildProcess and FileSystem migration.** Now C8/C9 below
  (split by owner — supervisor vs extensions).
- **C15 (Wave 18) — OAuth flows as Effect.gen.** Now C16.
- **C17 (Wave 18) — TaggedEnumClass conversions.** Most still pending. Now C20.
- **C18 (Wave 18) — `EventStore.Live` SQL-backed.** Platform guard locks
  re-introduction of the alias but the underlying fix is unwritten. Now C17.
- **C20 (Wave 18) — `Schema.transform` for storage rows.** Now C18.
- **C21 (Wave 18) — module-private service tags.** Now C19.
- **C22 (Wave 18) — typed errors instead of `throw new Error`.** Now C21.
- **C23 (Wave 18) — `Effect.sleep` state polls.** Now C22.
- **C24 (Wave 18) — `Bun.sleep` in tests.** Now C23.
- **C25 (Wave 18) — `ConfigService` for provider env reads.** Now C24.
- **C26 (Wave 18) — `LoopRuntimeState` shadow collapse.** Folds into C5.
- **C27 (Wave 18) — merge per-handler RPC files.** Now C12.
- **C28 (Wave 18) — `SessionCwdRegistry` decision.** Now C26.
- **C29 (Wave 18) — collapse event-publisher files.** Now C27.
- **C30 (Wave 18) — delete or fully specify Test layer stubs.** Now C28.
- **C31 (Wave 18) — close lint rule fixture gaps.** Now C29.
- **C32 (Wave 18) — `no-bun-outside-adapter` lint.** Now C30.

The Wave 18 doc + duplication-guard commits (C38, C39) landed and need
extension to cover Wave 19 deletions. New guard surfaces appear in C32.

**Wave 20 starts empty** (2026-05-04 reshape). Earlier draft deferred
two clusters to Wave 20 — the server-topology collapse
(server-registry / worker-http / WorkerLifecycleState / supervisor
slim) and `session-controller.ts`. Both are now folded into Wave 19:

- The server-topology cluster expands C10 from a single-sub-commit
  header introduction to a five-sub-commit collapse (C10.1-C10.5).
  Reason: splitting "introduce header" from "delete legacy registry"
  creates a deprecation-cycle interim state — exactly the pattern the
  project rules forbid. Better to rewrite once.
- `session-controller.ts` rewrites once as new commit C12B, sequenced
  after C5/C6/C12 and after C25 (which moves up — see C25's
  execution-order note). Reason: the controller's three upstream
  inputs (AgentLoop actor, Effect AI Prompt parts, inlined transport
  DTOs) all settle by C12B; touching it earlier would force three
  rewrites.

Net Wave 19 size: 34 → 36 named commits (C10 stays one named commit
with five sub-commits; C12B added; C25 moves but doesn't add).

### Counsel Schedule

Counsel runs after every named commit per the global rule. Additional
inflection-point counsel runs (overrides the "named commits only"
default):

- **C4.2** — membrane snapshot collapse, structural inflection.
- **C5.0** — cold-pattern persistence design lock.
- **C10.1** — workspaceId header introduction (whole C10 sequence
  larger than C4+C5 combined).
- **C12B.1** — session-controller design lock (no code commit).
- **C12B.2** — session-controller structural rewrite.

### Execution Order (canonical)

Numbering tracks narrative grouping (Phases 1-8). Execution order
diverges where a downstream consumer commit must wait for a "later"
numbered commit's input shape. Canonical execution order:

C1 → C2 → C3 (incl. C3.5) → C4 → **C5 → C6 → C25 → C7** → C8 → C9 →
**C10 (5 sub-commits) → C11 → C12 → C26 → C12B (3 sub-commits)** → C13
→ C14 → C15 → C16 → C17 → C18 → C19 → C20 → C21 → C22 → C23 → C24 →
C27 → C28 → C29 → C30 → C31 → C32 → C33 → C34.

Two execution-order divergences from numerical order:

- **C25 ahead of C7**: C25 inlines transport DTOs; downstream
  consumers (incl. session-controller in C12B) need them inlined
  before they're touched.
- **C26 ahead of C12B**: C26's `SessionCwdRegistry` decision affects
  the session-controller's input shape; lock C26 first.

## Commit Wave

Sequenced by leverage and dependency order. The first three commits set up
the platform service shape that downstream commits depend on. The membrane
collapse (C4) lands before the AgentLoop entity migration (C5) so the
ephemeral-runtime story is clean before per-entity scopes arrive.

### Phase 1 — Platform Discipline Foundation

#### C1 — `feat(platform): add osInfo, pid, execPath, signal, exit, now to GentPlatform`

Add the six missing methods to `GentPlatform` Tag with `BunPlatformLive`
implementations. Each method is `Effect<A, PlatformError>` (or `Effect<never>`
for `exit`).

Tests: `gent-platform.test.ts` adds happy-path + a `Test` layer per method
that returns a fixed value. Tests for `exit` use a `Deferred` to capture the
intended exit code instead of letting it fire.

Verification: focused platform tests, `bun run gate`.

#### C2 — `refactor(auth): collapse to single ~100-line module backed by KeyValueStore`

Replace `auth-storage.ts` (513) + `auth-store.ts` (193) + `auth-guard.ts`
(84) + `auth-method.ts` (19) with a single `domain/auth.ts` (~120 lines)
backed by `KeyValueStore.layerFile("~/.gent/auth.json")` + `toSchemaStore`.
Three discriminator variants via `TaggedEnumClass`: `Oauth | Api | WellKnown`.
Delete `KeychainExit` TaggedEnum and the keychain integration. Delete
`LiveFile` hand-rolled JSON KV.

`apps/tui/src/routes/auth.tsx` (769 lines) drops to ~400 by deleting the
keychain failure-mode branches. Auth stays as a route (per Lane 3 surface 1
verdict, override the stale doc comment in `apps/tui/CLAUDE.md`).

Sub-commits:

- **C2.1** — Add `domain/auth.ts`. Per counsel P2-1: **drop the migration
  script entirely** — accept reset. Existing `~/.gent/auth.json` content
  is unreadable by the new module; users re-authenticate on next launch.
  Document in C34 release notes that auth state resets at this commit.
- **C2.2** — Delete `auth-storage.ts`, `auth-store.ts`, `auth-guard.ts`,
  `auth-method.ts`. Update all callers.
- **C2.3** — Slim `apps/tui/src/routes/auth.tsx`. Delete keychain UX paths.
  Update `apps/tui/CLAUDE.md` line 80.

Verification: auth tests, RPC auth acceptance test, `bun run gate`.

Breaking change: existing `~/.gent/auth.json` content shape changes. Reset.

#### C3 — `refactor(platform): replace serve, inspect, readFileText, spawnSync, which with platform primitives`

Drop the five duplicate methods from `GentPlatform`. Migrate call sites:

- `serve` → `BunHttpServer.layer({port: 0})` from inside the worker. Worker
  reports its bound port via `WORKER_READY <port>` stdout line. Eliminates
  parent-side `findOpenPort` (folds into C8).
- `inspect` → vendor `inspect.ts` helper (~30 lines, JSON.stringify with
  circular-reference replacer) or use `JSON.stringify` directly at each call
  site if the value is shape-known.
- `readFileText` → `FileSystem.FileSystem.readFileString` (~6 sites).
- `spawnSync` → `ChildProcessSpawner` synchronous variant (~2 sites in
  `which.ts` adjacent code).
- `which` → `Path.Path` + `FileSystem.exists` traversal of `$PATH`.

Sub-commits:

- **C3.1** — `serve` → `BunHttpServer.layer({port: 0})` (folds into C8).
- **C3.2** — `inspect` → vendor 30-line helper or call-site
  `JSON.stringify`.
- **C3.3** — `readFileText` → `FileSystem.readFileString`.
- **C3.4** — `spawnSync` + `which` → `ChildProcessSpawner` /
  `Path` + `FileSystem.exists`.
- **C3.5** — `process.*` migration. **Pre-flight audit (2026-05-04):**
  `rg -n "process\\.(exit|pid|platform|execPath|kill)" packages/ apps/`
  returns 63 raw matches across 23 files. Subtracting exempt locations
  (`main.ts`, `*-adapter.ts`, `scripts/`, `packages/tooling/`,
  `/tests/`, `/e2e/`, `AGENTS.md` doc-strings) and the
  `sdk/src/server-registry.ts` file (deleted whole in C10.2 — its 4
  sites die with the file) leaves these migration sites:

  **Migrate in C3.5:**
  - `apps/tui/src/services/os-service.ts:20` — `process.platform`.
  - `apps/tui/src/theme/detect.ts:43` — `process.platform`.
  - `packages/core/src/server/build-fingerprint.ts:13,31` —
    `process.execPath` (×2).
  - `packages/extensions/src/executor/sidecar.ts:320,327,431,445,448`
    — `process.platform`, `process.execPath`, three `process.kill`.

  **Migrate in their owning commit (cross-reference here, not in C3.5):**
  - `packages/extensions/src/anthropic/oauth.ts:211,216,245,411` (×4
    `process.platform`) — folds into C16.1 (OAuth → `Effect.gen`).
  - `packages/sdk/src/server.ts:196,220,247,391` (×4) —
    `process.platform` and `process.pid` for runtime info reporting;
    folds into C10.5 (supervisor slim) which rewrites the lifecycle
    surface.
  - `packages/sdk/src/supervisor.ts:101,359,385` — `process.execPath`
    - two `process.kill`. Folds into C10.5 (supervisor slim);
      Effect Cluster's mailbox replaces hand-rolled SIGKILL paths.

  **Dies with deleted file:**
  - `packages/sdk/src/server-registry.ts:120,239,298,319` (×4) —
    deleted whole in C10.2.

  **Exempt-by-context (do not migrate):**
  `packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:114`
  — the `process.exit(exitCode)` is inside a template literal that gent
  emits as the body of a _generated user job script_. It's not gent
  calling `process.exit`; it's gent emitting the literal text that the
  user's job will run. Add inline `// not gent runtime` note.

  **Exempt by location:** `apps/tui/src/utils/client-logger.ts:7,28`
  and `apps/tui/src/env/context.tsx:14` are doc-comments. `apps/tui/src/main.tsx:524`
  and `apps/tui/scripts/build.ts:35` are entry-point exits.

  Migrate the 9 C3.5-scoped sites via Recipe E. The `process.env` swap
  to `Config.option` from memory note remains a workaround; this commit
  only handles the five non-env families.

Verification: focused platform tests, supervisor tests (now using
`ChildProcessSpawner`), `bun run gate`, `bun run test:e2e`.

### Phase 2 — Membrane And Loop Collapse (Highest Leverage)

**Note on C4 vs C5 sequencing:** Counsel review confirmed C4 (composer
collapse) and C5 (AgentLoop actor) touch independent code paths
(`agent-runner.ts` vs `agent-loop.ts`); encore's actor scopes are
independent of `buildEphemeralRuntime`. C4 is listed first because the
composer is the more-localized work and its counsel-corrected design is
already locked. C5 may begin in parallel once C4's design is approved if
attention permits — but per `feedback_counsel_after_batch.md` only one
implementation track runs at a time so we don't queue counsel reviews.

#### C4 — `refactor(runtime): collapse composer + scope-brands; split effect-membrane`

Highest-leverage commit in the wave. Per Lane 1 #12. Counsel review
clarified three load-bearing details that this slot must address.

**C4 design decision (locked before sub-commits start):**

The composer's `Layer.fresh` wrap + `Layer.CurrentMemoMap` omit are
co-load-bearing: together they prevent parent-memo replay during ephemeral
child builds. Two viable shapes:

- **(a) Snapshot form (chosen).** Keep `Context.Context<never>` parent
  snapshot but drop the membrane indirection. Use
  `Layer.succeedContext(parentContext)` as the parent layer and
  `Layer.provideMerge(Layer.mergeAll(...overrides), parentLayer)` for
  composition. No construction → no memo-map concern → drop `Layer.fresh`
  and the explicit memo-map omit. This matches `feedback_preserve_features_during_collapse.md`:
  collapse the indirection, keep the snapshot semantics.
- (b) Source-`Layer` form. Plumb the parent's source layer; parent services
  rebuild for each ephemeral child. Wrong for SQLite client identity.
  Rejected.

`Sharding.make` does not exist. The Effect Cluster API is `Sharding.layer`
(`effect-smol/packages/effect/src/unstable/cluster/Sharding.ts:1436`) which
requires `ShardingConfig | Runners | MessageStorage | RunnerStorage |
RunnerHealth`. The plan's earlier "child Sharding per child run" line was
wrong. Replacement: ephemeral runs share the parent runtime's Sharding
(memo-map sharing is fine for cluster identity) and only override the
gent-side mailbox-relevant services. The `Layer.fresh` wrap was guarding
gent's local memo-map, which the snapshot form does not have.

**`effect-membrane.ts` is a mixed file.** Counsel verified
`packages/core/src/runtime/extensions/effect-membrane.ts` (116 lines, not
~150) contains two unrelated helper sets:

- Layer-erasure helpers (`eraseLayer`, `mergeErasedLayers`,
  `omitErasedContext`, `restoreErasedLayer`, `eraseContextKey`) — used only
  by `composer.ts`. Delete with the composer.
- Effect-channel + Resource-layer helpers (`sealErasedEffect`,
  `exitErasedEffect`, `eraseResourceLayer`, `emptyErasedResourceLayer`) —
  used by `extensions/extension-reactions.ts` (8 sites),
  `extensions/registry.ts:220`, and `extensions/resource-host/resource-layer.ts:40,52,66`.
  These erase heterogeneous `R`/`E` from third-party extension code and are
  independent of the parent-context-snapshot story. Keep, rename to
  `extensions/extension-effect-membrane.ts`.

Sub-commits:

- **C4.1** — Pre-work split. Move the Effect-channel + Resource-layer
  helpers out of `effect-membrane.ts` into a new
  `extensions/extension-effect-membrane.ts`. Update the 11 import sites in
  `extension-reactions.ts`, `registry.ts`, `resource-host/resource-layer.ts`.
  No behavior change. Validates that the file split is clean before later
  sub-commits delete the rest.
- **C4.2** — In `composer.ts:buildEphemeralRuntime`, replace the explicit
  override-family map with
  `Layer.provideMerge(Layer.mergeAll(...overrides), Layer.succeedContext(parentContext))`.
  Drop the `Layer.fresh` wrap and the explicit `Layer.CurrentMemoMap` omit
  in the same edit (they are no-ops on a `Layer.succeedContext`-based
  parent). Last-writer-wins occlusion comes for free
  (`effect-smol/packages/effect/src/Layer.ts:1237-1264`).
- **C4.3** — Audit the 11-Tag explicit override map. After C4.2 the map is
  redundant: any Tag the child layer provides occludes the parent. Inline
  the override list at the call site or delete it entirely if every entry
  is now occluded automatically.
- **C4.4** — Delete the now-empty `composer.ts` and what remains of
  `effect-membrane.ts` (Layer-erasure helpers; the Effect-channel helpers
  moved in C4.1). Delete `scope-brands.ts` (`ServerProfile`,
  `CwdProfile`, `EphemeralProfile` brands and the 3
  `as unknown as <Brand>Scope` lines). Update `agent-runner.ts:buildEphemeralRuntime`
  callers and the `parent: ServerProfile` type signature.
- **C4.5** — Delete the 9 `@effect-diagnostics anyUnknownInErrorContext:off`
  suppressions in `composer.ts` (now-deleted file). Audit the 1 remaining
  `anyUnknownInErrorContext:off` in `session-runtime.ts:747` — if it's an
  upstream Cluster middleware-requirements bleed, file an upstream issue
  and link in a comment.

Verification: full gate per sub-commit. C4.2 + C4.4 require
`bun run test:e2e` because the ephemeral-runtime path is exercised end-to-end
by the supervisor + helper-agent tests. The helper-agent ephemeral-vs-durable
distinction MUST still pass — preserve-features filter applies.

Counsel exception (overrides the global "named commits only" rule at the
top): C4.2 is THE structural inflection point of the wave — the
membrane collapse that everything downstream assumes. Run counsel
after C4.2 specifically (not after every C4.x), expecting feedback that
may force a correction before C4.3/C4.4 land.

#### C5 — `refactor(runtime): promote AgentLoop to an effect-encore actor`

Per Lane 1 #1. Folds in Wave 18 carry-forward C9, C26. Built on
`effect-encore` (the user's `@effect/cluster` wrapper at
`/Users/cvr/Developer/personal/effect-encore`, npm `effect-encore`).

Why effect-encore and not raw `Entity.make`:

1. Declarative shape. `Actor.fromEntity("AgentLoop", { Submit: {...}, Steer:
{...}, ... })` replaces the `Schema.Class` + `Rpc.make` + `RpcGroup` +
   `Entity.make` + handler wiring + client service quintet with one object.
2. Built-in dedup via `id(payload) → primaryKey`. Each loop op (Submit,
   Steer, QueueFollowUp) gets persisted-and-deduped semantics by returning
   `{ entityId: \`${sessionId} ${branchId}\`, primaryKey: opPrimaryKey }`from`id`. This replaces gent's hand-rolled
`agent_loop_checkpoints` dedup logic.
3. `peek` / `watch` / `waitFor` on `ExecId` is exactly the
   `awaitIdleStateSince` / `awaitTurnFailure` / `failIfTurnFailedSince`
   shape — gent built that by hand; encore provides it.
4. `Actor.toTestLayer` collapses test-layer authoring to one call.
5. `withProtocol(p => p.middleware(...))` lets us thread the wide-event
   boundary through the entity protocol via `RpcMiddleware` instead of
   patching it from the outside.

Sub-commits:

- **C5.0** — Cold-pattern persistence design. Document where
  `WaitingForInteraction` / `interactionRequest` durability lives in the
  post-actor model. Two viable shapes:
  - (a) Persisted as actor handler state via `agent_loop_checkpoints`
    (encore's storage layout). Recovery on actor wake-up reads the
    checkpoint, resumes the Submit op from the cold state.
  - (b) Persisted via Cluster `MessageStorage` mailbox replay — the Submit
    op stays unacked, mailbox redelivers on shard rebalance.

  **Decision: (a) for cold-state recovery; (b) still owns ingress
  delivery + dedup.** Gent's existing `interaction_requests` table +
  the cold-state read path match (a); Cluster mailbox replay is not
  durable for cold approval state in the way `interaction_requests`
  is. (a) is **not** a strict superset of (b): encore's
  `MessageStorage` still owns per-op delivery/dedup/redelivery for
  Submit/Steer/etc., specifically pre-handler-checkpoint windows
  where an op is accepted into the actor mailbox but the handler
  hasn't yet written checkpoint state. C5.1's `EncoreMessageStorage`
  adapter carries that ingress contract. This is a no-code commit.

  **Schema posture (verified `packages/core/src/storage/schema.ts:124-149`):**
  - `agent_loop_checkpoints` PK `(session_id, branch_id)` with
    `state_tag` / `state_json` / `version` columns. Encore's actor
    persistence layout will replace this table's role; the table
    itself will be reshaped in **C5.3** (reset acceptable per plan).
  - `interaction_requests` PK `request_id` with type/params/status,
    plus unique partial index
    `idx_interaction_requests_pending_singleton` on `(session_id,
branch_id) WHERE status = 'pending'`. **Not foreign-keyed to
    `agent_loop_checkpoints`** — schema-independent.
  - **Runtime independence is NOT total.** Today's
    persist-then-checkpoint ordering already has a crash window:
    `packages/core/src/domain/interaction-request.ts:239-257` writes
    the `interaction_requests` row before the loop writes
    `WaitingForInteraction` at
    `packages/core/src/runtime/agent/agent-loop.ts:1100-1108`.
    Crashing between those two writes leaves a pending interaction
    row whose actor checkpoint never recorded the cold state. C5.3
    must reconcile.

  **Migration surfaces moving into the encore handler (full list):**
  - State variant —
    `packages/core/src/runtime/agent/agent-loop.state.ts:242-254`:
    `LoopState` `TaggedEnumClass`, `WaitingForInteraction` variant
    carrying `pendingRequestId: InteractionRequestId` +
    `pendingToolCallId: Schema.String` on top of `RunningTurnFields`.
    Becomes encore actor handler state.
  - Read/recovery branches —
    `packages/core/src/runtime/agent/agent-loop.ts:370-381`
    (`replay-running` + `restore-cold` `publishRecovery` calls).
    `publishRecovery` still fires from the encore handler so the
    transport boundary (`SessionRuntimeState`) sees the same
    projection.
  - Checkpoint write/upsert/remove —
    `packages/core/src/runtime/agent/agent-loop.ts:670-758`
    (Idle/Running checkpoint persist) and
    `packages/core/src/storage/checkpoint-storage.ts:47-105`
    (`upsert` / `get` / `list` / `remove` SQL). Encore's actor
    storage replaces the SQL surface; the gent `CheckpointStorage`
    Tag is deleted in C5.3.
  - Cold transition write —
    `packages/core/src/runtime/agent/agent-loop.ts:1100-1108`
    (the explicit `WaitingForInteraction` checkpoint write at the
    point a tool requests human approval).
  - Interrupt-from-cold resume —
    `packages/core/src/runtime/agent/agent-loop.ts:1181-1208`.
  - Interaction response resume —
    `packages/core/src/runtime/agent/agent-loop.ts:1237-1272`
    (the `respondInteraction` path that re-enters the suspended
    fiber from the cold state).
  - `findOrRestoreLoop` —
    `packages/core/src/runtime/agent/agent-loop.ts:1536-1568`
    (the path `respondInteraction` calls when the loop fiber is
    cold; in encore terms this becomes the actor wake-up flow).
  - Startup interaction rehydrate —
    `packages/core/src/server/dependencies.ts:250-279`
    (`interactionRecoveryLive` `Layer.effectDiscard` calling
    `InteractionStorage.listPending()` →
    `ApprovalService.rehydrate()`). Stays gent-owned but C5.0
    constrains its ordering relative to RPC acceptance — see below.

  **Restoration ordering — explicit gate (counsel finding 1).** The
  pre-encore design has a startup-ordering hazard the migration must
  NOT inherit:
  `packages/core/src/server/interaction-commands.ts:39-90`'s
  `respond` rejects with `InteractionRequestMismatchError` unless
  `ApprovalService.pendingRequestId()` has already been seeded
  in-memory by `rehydrate()`
  (`packages/core/src/domain/interaction-request.ts:217-290`). If a
  client replies before `interactionRecoveryLive` finishes seeding,
  the response is dropped. Two acceptable resolutions for C5.4:
  - **(g1) Gate the RPC server on recovery completion.** Treat
    `interactionRecoveryLive` as a startup barrier — RPC routes do
    not accept connections until rehydrate signals completion.
    Simplest; cost is a startup latency window.
  - **(g2) Make `respond` fall back to durable storage.** When
    `approvalService.pendingRequestId()` returns `undefined`,
    `respond` re-checks `InteractionStorage.listPending()` for the
    `(sessionId, branchId)` key; if the row exists, accept the
    response and seed the approval service inline. Avoids the
    barrier; cost is one extra storage read on the cold path.

  C5.4 picks one. Wave defaults to (g1) unless a test surfaces a
  startup-latency regression — (g2) is the escape hatch. Either way
  C5.0 locks the constraint: **a client response from before the
  restart must not be silently dropped.**

  **Orphan reconciliation in C5.3 (counsel finding 2).** Resetting
  `agent_loop_checkpoints` while leaving pending
  `interaction_requests` rows in place creates a class of orphans
  whose `pendingRequestId` cannot resume any loop. C5.3 must
  reconcile in one of two shapes:
  - **(r1) Delete orphans during reset.** Inside the same migration
    that reshapes `agent_loop_checkpoints`, delete any
    `interaction_requests` rows whose `(session_id, branch_id)` no
    longer maps to a (post-reset) checkpoint. Loses the pending
    prompt visibly; the user has to retrigger the action.
  - **(r2) Mark abandoned + emit recovery event.** Add an
    `'abandoned'` status to `interaction_requests` (or use a
    dedicated marker), set orphans to that status during the
    migration, and emit an `InteractionAbandoned` event the TUI can
    render so the user knows why the prompt vanished.

  Wave defaults to **(r1)** for simplicity; (r2) is reachable if the
  TUI needs the visible event. The choice is C5.3-local; C5.0 just
  locks the constraint: **C5.3 cannot leave orphan pending
  interactions whose actor checkpoint is absent.**

  **Required regression tests for C5.4 / C5.5 (counsel finding 5).**
  Public-interface RPC acceptance tests via `createRpcHarness`, not
  direct-service tests:
  1. **Restart with pending approval, single re-presentation.**
     Persist `WaitingForInteraction` checkpoint + matching pending
     `interaction_requests` row. Restart the runtime. Assert exactly
     one `InteractionPresented` event lands on the transport (not
     duplicated by both `restore-cold` and `rehydrate`).
  2. **Respond before explicit actor wake.** With (1)'s state, send
     `respond` over RPC before any other op forces actor wake.
     Assert the turn resumes (not dropped with
     `InteractionRequestMismatchError`). Validates the (g1) barrier
     or (g2) fallback chosen in C5.4.
  3. **Orphan reconciliation.** Persist a pending
     `interaction_requests` row with no matching checkpoint. Run
     C5.3's migration. Assert orphan handled per chosen shape: (r1)
     row deleted; (r2) row marked abandoned + event emitted.

  These three tests are blocking deliverables for C5.5 — without
  them the preserve-features gate isn't actually validated.

  This is the **preserve-features gate** for the wave: human-in-the-loop
  approval durability is the load-bearing product behavior. If (a)
  doesn't fit during C5.3-C5.5 implementation, stop and reconsider C5
  entirely.

- **C5.1** — Add `effect-encore` dependency to `packages/core`. The
  v4 entrypoint targets `effect@>=4.0.0-beta.46`; gent is on
  `4.0.0-beta.59`. Wire `EncoreMessageStorage` adapter against gent's
  existing SQLite storage so `Actor.rerun` works: compose
  `effect/unstable/cluster/SqlMessageStorage.layer` (provides upstream
  `MessageStorage`) with `encoreMessageStorageLayer(...)` adding a
  `deleteEnvelope` that surgically removes the row from the cluster
  `messages` + `replies` tables (per the encore AGENTS.md gotcha:
  adapters MUST implement `deleteEnvelope` or `.rerun` dies loudly).
  No callers yet — C5.2/C5.4 consume it.
- **C5.2** — Define `AgentLoop = Actor.fromEntity("AgentLoop", { Submit:
{...}, Steer: {...}, QueueFollowUp: {...}, Interrupt: {...}, Snapshot:
{...}, Subscribe: {...} })`. `id(payload)` returns
  `{ entityId, primaryKey }` keyed by `(sessionId, branchId)` for entityId
  and the op-specific dedup key for primaryKey. Schemas live alongside
  the actor definition.
- **C5.3** — Migrate persistence keys; reset `agent_loop_checkpoints` table
  shape to match encore's storage layout. Reset is acceptable. Adapter
  layer uses `encoreMessageStorageLayer` over the existing SQLite
  `MessageStorage` shape.
- **C5.4** — Move loop body into `Actor.toLayer(AgentLoop, { Submit:
({operation}) => ..., Steer: ..., ... })`. Delete `loopsRef` Map,
  `mutationSemaphoresRef` Map, `loopsSemaphore`, per-key
  `Semaphore.make(1)` cache, `LoopHandle` structure, `LoopDriverEvent`
  TaggedEnum, `dispatch` function, `awaitIdleStateSince`,
  `awaitTurnFailure`, `failIfTurnFailedSince`, `stateKey` keying — all
  replaced by encore's `peek` / `watch` / `waitFor` on `ExecId`.
- **C5.5** — Replace `runTurnFiber` body with `LanguageModel.streamText`
  inside the actor handler. Move durable-event derivation
  (`StreamStarted`, `StreamEnded`, `ToolCallStarted`, ...) into a
  `Stream.tap` over the Effect AI `StreamPart` stream. Delete
  `resolveTurnPhase` / `executeToolsPhase` / `finalizeTurnPhase` named
  functions; their bodies become `Effect.tap` callbacks on the streamText
  pipeline. Delete `phases/turn.ts` four-phase split.
- **C5.6** — Collapse `LoopState` and `LoopRuntimeState` into a single
  `SubscriptionRef<AgentLoopState>` owned by the actor handler. Delete
  `LoopRuntimeState` shadow. Remove the three eslint-disabled
  `@typescript-eslint/no-unsafe-type-assertion` lines for variant-constructor
  narrowing in `agent-loop.state.ts:329-335`.
- **C5.7** — Replace `commandGate = Semaphore.make(1)` at
  `session-runtime.ts:395` with reliance on encore's per-entity-instance
  mailbox serialization (Cluster guarantee). Delete the duplicate command
  union in `session-runtime.ts`. Replace the closure-captured
  `agentLoop.queueFollowUp` in `makeAmbientExtensionHostContextDeps` with
  `AgentLoop.QueueFollowUp.send({...})` through the actor.
- **C5.8** — Migrate `agent-runner.ts:600-700` `shouldMirrorEphemeralChildEvent`.
  Counsel flagged `Stream.merge` as wrong shape — the predicate is a
  _filter_ over child events deciding which propagate to the parent
  event store, not a merge. Replace with
  `childActor.watch(execId).pipe(Stream.filter(shouldMirror), Stream.runForEach(parentPublisher.publish))`.
  The predicate body collapses to a single line because encore's `ExecId`
  already carries the parent/child relationship. Delete the file-level
  helper.
- **C5.9** — Convert all gent test layers that wrapped `agent-loop` to
  `Actor.toTestLayer(AgentLoop, { ... })`. Delete the bespoke test
  harness. `it.scopedLive.layer(Layer.provide(AgentLoopTest,
TestShardingConfig))` is the new shape.

Verification per sub-commit: focused agent-loop tests, recovery/checkpoint
tests, queue tests, `bun run gate`. C5.4, C5.5, C5.7, C5.8 each run
`bun run test:e2e` because the actor boundary is exercised end-to-end.

Preserve-features check at C5.5: the helper-agent ephemeral-run distinction
(durable vs ephemeral with parent-store mirroring) MUST still pass after
the actor migration. Run targeted ephemeral-helper tests in the same gate.
The encore `id(payload) → { entityId, primaryKey }` shape supports the
helper-agent semantics directly: parent session's entityId for mailbox
ordering, child run's primaryKey for dedup.

Open question for C5.1: the local `effect-encore` (`bun.lock` shows
`peerDependencies.effect: ">=4.0.0-beta.46"`, gent is on beta.47) — verify
peer compatibility before adding. If a local link is preferred over the
published version, document the dev-link path in the commit message.

#### C6 — `refactor(ai): collapse domain/message parts onto Effect AI Prompt and Response`

Per Lane 1 #9.

Sub-commits:

- **C6.1** — Replace `domain/message.ts` part schemas with re-exports of
  `Prompt.AnyPart` (request side) and `Response.AnyPart` (assistant side).
  `Message.Regular` / `Message.Interjection` keep their session/branch/role/
  createdAt envelope but their `parts` field becomes
  `Schema.Array(Prompt.AnyPart)` (or response side as appropriate).
- **C6.2** — Delete `providers/ai-transcript.ts` per-part conversion (~340
  lines). Keep only the message-envelope wrap/unwrap (~100 lines remain).
  **C6.2 + C6.3 must land in the same commit** (per counsel P1-7): C6.2
  removes the conversion helpers that the storage path consumes; C6.3
  switches the storage path to upstream part schemas. Splitting them
  leaves an intermediate state where storage still calls deleted helpers.
  Sub-commit IDs are kept for tracking but are produced atomically.
- **C6.3** — Storage SQL serialization uses
  `Schema.encodeUnknownSync(Prompt.AnyPart)` directly. Update
  `message-storage.ts` and `content-chunks` storage if needed.
  See C6.2 atomicity note above.
- **C6.4** — Update TUI `apps/tui/src/components/message-list.tsx` and
  related projection consumers to read from upstream part shapes.
  `MessageMetadata` envelope and `ProjectedMessage.toolInteractions` stay —
  these are gent-owned product surfaces.

Verification per sub-commit: message storage tests, TUI projection tests,
provider integration tests, `bun run gate`. C6.4 runs `bun run test:e2e`.

#### C7 — `refactor(provider): replace Provider Tag with thin ModelResolver`

Per Lane 1 #3.

Sub-commits:

- **C7.1** — Add `ModelResolver` service:
  `(modelId: ModelId, agentName: AgentName) => Effect<LanguageModel.LanguageModel, ResolveError>`.
  Live impl reads `ModelDriver`/`ExternalDriver` registry + `AuthStore`.
- **C7.2** — Move `parseModelId` to `domain/model.ts` as a pure helper.
  Move static test layers (`Provider.Sequence`/`Signal`/`Debug`/`Failing`)
  into `test-utils/language-model.ts`, exposing pure
  `Layer.Layer<LanguageModel.LanguageModel>` factories. No wrapper Tag.
- **C7.3** — Production code yields `LanguageModel.LanguageModel` directly.
  Delete `Provider` Tag and the `providers/provider.ts` wrapper file
  (~547 of 667 lines deleted). Delete `textDeltaPart` /
  `toolCallPart` / `reasoningDeltaPart` / `finishPart` wrapper helpers
  — `Response.makePart` is already public.
- **C7.4** — Update all test files importing from
  `@gent/core/providers/provider`. The path moves to
  `@gent/core/test-utils/language-model`.

Verification: provider auth tests, sequence/signal tests, turn-phase tests,
`bun run gate`, `bun run test:e2e`.

### Phase 3 — Platform Reach Completion

#### C8 — `refactor(supervisor): finish Effect platform migration`

Lane 4 P2 finish. Per Lane 1 supervisor surface.

- **C8.1** — Replace `Bun.spawn` with `ChildProcessSpawner` typed handle.
  Replace `appendFileSync` log writer with an Effect-based log writer that
  uses `FileSystem.FileSystem.open` + `Stream.run`.
- **C8.2** — Replace `launchWorkerUntilReady` body with
  `Effect.retry(spawn, {schedule: Schedule.exponential(...).pipe(Schedule.intersect(Schedule.recurs(STARTUP_MAX_ATTEMPTS - 1))), while: isRetryableStartupError})`.
  ~50 lines of imperative loop deleted.
- **C8.3** — Delete `findOpenPort` + `WORKER_HOST` port pre-allocation.
  Worker boots `BunHttpServer.layer({port: 0})` and reports back its port
  via stdout `WORKER_READY` line.
- **C8.4** — File upstream issue on `effect/unstable/process` `handle.kill`
  timeout semantics (`supervisor.ts:336-340` documented bug). Once fixed,
  drop the `process.kill(pid, "SIGKILL")` fallback.

Verification: supervisor tests + e2e PTY tests, `bun run gate`, `bun run test:e2e`.

#### C9 — `refactor(extensions): FileSystem and ChildProcess migration`

- **C9.1** — Replace `Bun.spawn` in `shell.ts`, `bash.ts`,
  `subagent-runner.ts` with `ChildProcessSpawner`.
- **C9.2** — Replace 15+ sync `Fs.*` calls in
  `packages/extensions/src/memory/vault.ts` with `FileSystem.FileSystem`
  effects. Delete 4 `node:` imports.
- **C9.3** — Replace `node:fs.watch` in `apps/tui/src/workspace/context.tsx`
  with `FileSystem.FileSystem.watch` (or wrap in `Effect.acquireRelease`).
- **C9.4** — Replace `Bun.Glob` in `fallback-adapter.ts` with `picomatch`.
  This is the only genuinely Bun-locked source-code site.

Verification per sub-commit: focused extension tests, TUI workspace tests,
`bun run gate`.

#### C10 — `refactor(server): collapse server topology to single-server with workspace routing`

Per Lane 3 server topology verdict. **Reshape (2026-05-04): the original
counsel deferral of C10.2-C10.5 to Wave 20 is reverted.** Splitting
header (Wave 19) from registry/worker-http deletion (Wave 20) creates an
interim state where both old and new topologies coexist — exactly the
deprecation-cycle pattern this project forbids. Better to rewrite once
against the final shape. Wave 20 starts empty.

**Depends on C5.** Effect Cluster's mailbox replaces hand-rolled
supervisor lifecycle; the supervisor slim is downstream of the AgentLoop
actor maturing, not parallel to it. Land C10 after C5 within Phase 3.

**Counsel exception** (overrides the global "named commits only" rule):
run counsel after C10.1 (header + internal routing — the structural
inflection point) before C10.2-C10.5 land. The five sub-commits are
larger than C4+C5 combined; the inflection-point counsel is mandatory.

Sub-commits (ordered per counsel P1-5: C10.4 → C10.3 → C10.2 reorders
the deletion sequence so the dependency chain unwinds cleanly):

- **C10.1** — Add `workspaceId` (sha256 of canonical cwd) to all RPCs as
  a header. **C10.1 is self-contained per counsel BUG-2 (2026-05-04
  re-counsel):** the commit ships _both_ server-side header
  enforcement AND SDK-side header injection in the same commit. The
  SDK computes the sha256 cwd hash at client construction (one
  function in `packages/sdk/src/transport-headers.ts`) and threads it
  into every Rpc invocation; the server reads the header and routes
  to per-workspace `AgentLoop` actor instances internally (entityId
  already encodes session/branch; workspaceId becomes a routing prefix
  on the actor-host scope key). Existing per-workspace server-instance
  lookup in the SDK still functions — it remains until C10.2 deletes
  it. **Crucial:** at C10.1 close, SDK clients on either path (legacy
  registry-resolved per-workspace server, or future single-port
  server) all carry the header; both paths route correctly. No
  intermediate broken state.
- **C10.4** — Delete `WorkerLifecycleState` TaggedEnum
  (`packages/sdk/src/supervisor.ts:16-38`). The post-C5 supervisor
  doesn't have a hand-rolled lifecycle FSM — it has Effect Cluster's
  mailbox + an idle-shutdown timer. Folds C20.1.
- **C10.3** — Delete `packages/core/src/server/worker-http.ts` subprocess
  worker mode and the cross-process file lock at the SDK seam.
  Single-process server keeps idle-shutdown timer
  (`~/.gent/server.lock` vacated on idle).
- **C10.2** — Delete `packages/sdk/src/server-registry.ts` (~345 lines)
  and `~/.gent/servers/<hash>.json` registry. Replace with: server runs
  on a single port; clients always connect to that port and pass
  `workspaceId` (header from C10.1). Single port discovery via
  `~/.gent/server.lock` + ephemeral-port pidfile.
- **C10.5** — Slim `packages/sdk/src/supervisor.ts` from 752 → ~200
  lines. The remaining responsibility is "auto-start server if not
  running, reuse if running". The ~500 lines deleted were
  process-isolation supervision — now Effect Cluster's job. Migrate
  `Bun.randomUUIDv7()` at `:407` to `platform.randomId` (pulls
  forward from C13's regression-patrol scope). **Migrate the 4
  `process.*` sites in `sdk/src/server.ts` and 3 in `sdk/src/supervisor.ts`
  per C3.5 cross-reference** (counsel item 5 cleanup): server.ts
  `process.platform` / `process.pid` (×4) and supervisor.ts
  `process.execPath` + 2 `process.kill`. Live impls go through
  `GentPlatform.osInfo` / `pid` / `execPath` / `signal` (added in C1).

Verification per sub-commit: supervisor tests, server-registry tests
(deleted in C10.2), `bun run gate`, `bun run test:e2e`. C10.3 + C10.2
will reveal test gaps — add tests for the single-server path before
each deletion lands.

Preserve-features check: workspace isolation (sessions don't leak
across workspaces) MUST still pass. Add an explicit test if missing.

#### C11 — `refactor(domain): collapse capability tokens onto single Capability discriminator`

Per Lane 2 (filtered).

Replace `ToolToken` / `ActionToken` / `RequestToken` with a single
`Capability` `TaggedEnumClass` with `Tool` / `Action` / `Request` variants.
Each variant carries `intent` + `needs` metadata as fields. Update
`defineExtension({tools, actions, requests, ...})` typed buckets to construct
via `Capability.Tool({...})` / etc. The `tools`/`actions`/`requests` typed
buckets remain (gent-owned product surface).

Verification: extension lifecycle tests, contribution registration tests,
`bun run gate`.

#### C12 — `refactor(server): consolidate RPC sub-groups against actor boundaries`

Wave 18 carry-forward C27. Per Lane 2. **Depends on C5** — the consolidation
target shifts based on which Rpcs move into the `AgentLoop` actor.

After C5, the `AgentLoop` actor exposes `Submit/Steer/QueueFollowUp/
Interrupt/Snapshot/Subscribe` as encore-derived Rpcs _inside the actor_.
The 12 server-side RPC sub-groups
(`packages/core/src/server/rpcs/{auth,branch,driver,extension,interaction,message,model,permission,queue,server,session,steer}.ts`)
collapse against that boundary:

- `steer.ts` → moves into the AgentLoop actor (deleted from server).
- `queue.ts` → AgentLoop's `QueueFollowUp` op (deleted from server).
- `interaction.ts` → folded into `session` group (interaction lifecycle is
  session-scoped).
- `model.ts` + `driver.ts` + `permission.ts` → folded into `extension`
  group (these are extension-surface concerns).
- `server.ts` → folded into a new `runtime` server-level group.

Target shape (4 groups + AgentLoop actor):

- `session` — session lifecycle + branch + message + interaction
- `extension` — extension RPCs + driver + model + permission
- `auth` — auth flows
- `runtime` — health, info, server-level
- `AgentLoop` actor — Submit/Steer/QueueFollowUp/Interrupt/Snapshot/Subscribe
  (not a server RPC group; reached via encore actor client)

Verification: RPC drift test, RPC acceptance tests, `bun run gate`.

#### C12B — `refactor(tui): rewrite session-controller against final input shape`

**New commit (2026-05-04 reshape).** Land immediately after C12. Single
rewrite of `apps/tui/src/routes/session-controller.ts` (826 lines)
against the _final_ input shape. Per re-counsel BUG-3, the input set
covers more than C5/C6/C25; the controller also reads from these
surfaces that change in Wave 19:

1. **AgentLoop actor** (C5) — controller consumes the loop via encore
   actor client (`Submit`/`Subscribe` ops), not direct service calls.
2. **Effect AI Prompt parts** (C6) — controller's projection logic
   reads `Prompt.AnyPart` / `Response.AnyPart`, not `domain/message.ts`
   part shapes.
3. **Inlined transport DTOs** (C25, executed after C6 per its
   execution-order note) — controller deserializes the inlined Rpc
   payload args, not `*Input` aliases.
4. **Server topology** (C10) — controller talks to a single-port
   server via workspaceId header; legacy per-workspace registry calls
   removed.
5. **`SessionCwdRegistry`** (C26) — if the controller reads it today,
   C26's "delete or scope" decision changes the surface. **C26 must
   land before C12B** (counsel BUG-3 cross-ref check); the
   execution-order note for C26 is added to that commit.
6. **`MessageMetadata` envelope and `ProjectedMessage`** — kept per
   C6's "preserve gent-owned product surfaces" note; the controller
   continues to read these directly.

The whole point of this commit existing — and of the 2026-05-04 reshape
that promoted it from "Wave 20+ candidate" to a Wave 19 named commit
— is that touching the controller before C5/C6/C10/C25/C26 settle
would force multiple sequential rewrites. Counsel's "land it once
against the final shape" rule applies.

**C12B.1 is a no-code design commit** (counsel BUG-3 fix; mirrors C5.0
pattern). Counsel runs after C12B.1 _before_ C12B.2 attempts the
rewrite. The C12B.1 design output is reviewable in isolation.

Sub-commits:

- **C12B.1 (DESIGN, NO CODE)** — Produce the controller's full
  input-shape table. Inline in this sub-commit's body, listing every
  call site:
  - File + line of every external symbol the controller imports
    (services, schemas, projection types, DTOs, registry tags).
  - Post-C5/C6/C10/C25/C26 replacement for each — the _exact_
    actor RPC, the _exact_ Prompt/Response part shape, the _exact_
    inlined Rpc payload arg, the _exact_ workspace-aware client
    method, the _exact_ SessionCwdRegistry resolution (or its
    deletion).
  - Reducer-vs-orchestrator split: which symbols belong to the pure
    state reducer (transitions only, no Effect requirements) and
    which belong to the effect orchestrator (actor calls, scope
    lifetime, mount/unmount). List the planned reducer state
    fields and the planned orchestrator services.
  - Cold-pattern interaction restoration thread: how does
    `WaitingForInteraction` revive across controller mount? The
    durability path (C5.0's `interaction_requests` recovery) and
    the UI restoration path (controller side) must both be
    documented.
  - Preserve-features checklist: cold-pattern interactions, branch
    fork from message UI, helper-agent ephemeral runs in
    projection. Each entry maps to one or more reducer/orchestrator
    elements.

  No code changes land in C12B.1 — only the design document
  embedded in the commit body. **Counsel runs after C12B.1.**

- **C12B.2 (CODE)** — Rewrite the controller against the C12B.1
  design. Reducer split implemented as designed. Target shape:
  well under 826 lines; counsel will assess against the design
  table from C12B.1.
- **C12B.3 (TESTS)** — Update controller tests to match. Three-tier
  taxonomy applies: pure reducer tests for state behavior,
  integration tests via `baseLocalLayer()` for orchestrator
  behavior. Add explicit tests for each preserve-features
  checklist item from C12B.1.

Verification: TUI integration tests, headless mode smoke,
`bun run gate`, `bun run test:e2e`. The post-C12B controller MUST
still satisfy: cold-pattern interactions survive restart (gent
product feature), branch fork from message UI unchanged, helper-agent
ephemeral runs visible in projection. Preserve-features filter
applies.

Counsel exception: run counsel after **C12B.1** (design lock) AND
**C12B.2** (structural rewrite); C12B.3 is the only bookend commit
without dedicated counsel.

### Phase 4 — Wave 18 Carry-Forward

#### C13 — `feat(runtime): finish the GentPlatform.randomId migration`

Wave 18 C10. Recipe B at the bottom of this file.

**Pre-flight audit (2026-05-04) reshapes this commit dramatically.**
`rg -n "Bun\\.randomUUIDv7\\(\\)" packages/ apps/` returns 13 raw matches
across 8 files. The Wave 18 estimate of "~24 runtime call sites" is
stale: production code already yields `platform.randomId` via
`GentPlatform` (the existing `Context.Service` at
`packages/core/src/runtime/gent-platform.ts:43-55`). Its docstring
explicitly says `randomId` "replaces the standalone `IdService`". The
"introduce IdService" framing of this commit is therefore wrong — the
service exists, just under another name.

Real Wave 19 scope, after subtracting exempt locations (`main.ts`,
`scripts/`, `packages/tooling/`, `/tests/`, `/e2e/`) and the live impl
itself:

- `packages/core/src/runtime/gent-platform-bun.ts:19` — the **Live**
  impl of `randomId`; this is the single sanctioned `Bun.randomUUIDv7()`
  call. Lock with a platform-duplication-guard pattern: only
  `gent-platform-bun.ts` may reference `Bun.randomUUIDv7`.
- `packages/sdk/src/supervisor.ts:407` — `GENT_TRACE_ID` env var built
  for spawned worker. **C10.5 (Phase 3) removes the live call site as
  part of supervisor slim; C13.1 (Phase 4) then locks the
  `Bun.randomUUIDv7` guard pattern against future regressions.** Phase
  ordering is correct: migration first, regression-patrol guard
  second. (Counsel BUG-1 fix — earlier prose described the opposite
  ordering.)

Sub-commits:

- **C13.1** — Extend the platform-duplication-guard at
  `packages/tooling/src/platform-duplication-guards.ts` with a pattern:
  `\bBun\\.randomUUIDv7\\b` is forbidden outside
  `packages/core/src/runtime/gent-platform-bun.ts`. Update
  `bannedActiveSourcePatterns` and add a fixture proving the guard
  catches a regression. (Folds C13's audit-the-list intent into a
  permanent guard, replacing C13.1+C13.2+C13.3.)
- **C13.2** — Update `apps/tui/CLAUDE.md` and any stale
  `IdService`-naming comments to refer to `platform.randomId`. No
  Tag rename — the existing surface is correct.

What this commit explicitly does NOT do (counsel correction):

- Does not add a new `IdService` Tag (it would duplicate `GentPlatform.randomId`).
- Does not delegate Recipe B over ~24 sites (the sites already migrated
  in earlier waves; the only adapter-shaped outlier in `supervisor.ts`
  is migrated by C10.5, not by Recipe B).

Recipe B is repurposed to a "guard regression" recipe — see Recipes
section below.

Verification: runtime tests, sequence-recording tests for ID stability,
tooling guard tests, `bun run gate`.

#### C14 — `refactor(runtime): adopt @effect/opentelemetry tracer`

Wave 18 C11. Delete `runtime/tracer.ts` (`GentTracerLive`, `GentSpan`).
Replace with `NodeSdk.layer({resource, spanProcessor})`. The platform
duplication guard already locks reintroduction of `GentSpan`.

Verification: tracing assertions, `bun run gate`.

#### C15 — `refactor(storage): adopt @effect/sql SqliteMigrator + SqlSchema/SqlModel`

Wave 18 C12 + Lane 1 storage CRUD verdict.

Sub-commits:

- **C15.1** — Replace `resetIncompatibleStorageSchema` with
  `SqliteMigrator.layer({loader: Migrator.fromArray([Migration1, ...])})`.
  Each migration is a `Migrator.make` value with explicit forward SQL.
  Reset local DBs; release notes mention.
- **C15.2** — Replace per-method `Effect.fn` + `sql<Row>` body in
  `session-storage.ts`, `branch-storage.ts`, `message-storage.ts`,
  `event-storage.ts`, `relationship-storage.ts` with a single
  `SqlModel.makeRepository(SchemaClass, {tableName, idColumn})` call per
  storage. Custom queries (recursive CTE `deleteSession`, FTS,
  `getLastSessionByCwd`) keep hand-written `sql` templates as additions.
- **C15.3** — Delete `storage/sqlite/rows.ts` row-converter helpers
  (`sessionFromRow`, `branchFromRow`, etc.) — `SqlSchema` decode does this
  via the schema.
- **C15.4** — Collapse 8 storage sub-tags into 3:
  `Storage` (CRUD facade exposing per-entity methods),
  `EventStore` (append-only stream + PubSub), `Search` (FTS).
  `BranchStorage` / `MessageStorage` / `SessionStorage` / `RelationshipStorage`
  / `CheckpointStorage` / `InteractionStorage` / `InteractionPendingReader`
  / `TaskStorageReadOnly` are deleted as tags; their methods live on
  `Storage`.

Verification per sub-commit: storage tests with fresh + seeded DB,
`bun run gate`. C15.4 runs `bun run test:e2e`.

#### C16 — `refactor(extensions): rewrite OAuth flows as Effect.gen`

Wave 18 C15. Recipe D.

- **C16.1** — Rewrite `extensions/src/openai/oauth.ts` as `Effect.fn` /
  `Effect.gen`. Replace `Bun.serve` for redirect listener with
  `HttpServer.layer`. Replace `setTimeout`/`clearTimeout` with
  `Effect.timeout` and `Deferred`. Eliminate all `async`/`Promise<>` from
  the public surface.
- **C16.2** — Same rewrite for `extensions/src/anthropic/oauth.ts`.
- **C16.3** — Update `openai/index.ts:178`, `credential-service.ts:126`,
  and Anthropic equivalents to call the Effect API directly. Delete
  `Effect.tryPromise` wrappers.

Verification: OAuth tests with Effect HTTP fixtures, `bun run gate`.

#### C17 — `fix(domain): EventStore.Live points to SQL-backed implementation`

Wave 18 C18. Make `EventStore.Live` resolve to `EventStoreLive` (SQL-backed)
with a required `SqlClient` dependency. Delete the `static Live = Memory`
alias at `domain/event.ts:629`. Audit all callers; tests intending in-memory
must explicitly request `EventStore.Memory`.

Replace **all three** `Effect.runSync(PubSub.unbounded())` sites with
fiber-resident construction in `Effect.gen` (counsel things-missed):

- `packages/core/src/server/event-store-live.ts:25`
- `packages/core/src/domain/event.ts:547`
- `packages/core/src/runtime/profiles/session-profile.ts:204`

The `session-profile.ts` site was missed in the Wave 18 carry-forward
inventory. Before landing, re-grep
`rg -n "Effect\\.runSync\\(PubSub" packages/ apps/` and confirm exactly
three matches; if more turn up they merge into this commit, not a
follow-up.

Verification: event-store tests, fresh failures from misuse, `bun run gate`.

#### C18 — `refactor(storage): Schema.transform for checkpoint and interaction rows`

Wave 18 C20. Replace `checkpoint-storage.ts:fromRow` and
`interaction-storage.ts:fromRow` with `Schema.transform` from row shape to
record schema. Add `Schema.Class` for `AgentLoopCheckpointRecord` and
`InteractionRequestRecord` if they don't already own the wire shape.

Folds with C15 if executed in the same wave; listed separately for
independent landing.

Verification: storage tests with row-drift cases, `bun run gate`.

#### C19 — `refactor(server): collapse module-private service tags into config values`

Wave 18 C21.

- **C19.1** — Delete `InteractionRecoveryTag` and `BasePromptSectionsTag`
  from `server/dependencies.ts`. Replace with direct Effect parameter
  passing or a single `DependenciesConfig` `Layer.succeed` value.
- **C19.2** — Delete `SessionRuntimeTerminator` from
  `server/session-commands.ts`.
- **C19.3** — Decide on `TaskStorageReadOnly` parallel tag: delete it,
  return a read-only branded view from `TaskStorage`. (Folds with C15.4.)

Verification: server tests, dependency wiring tests, `bun run gate`.

#### C20 — `refactor(domain): convert hand-rolled tagged unions to TaggedEnumClass`

Wave 18 C17. Recipe C.

Sub-commits per file or related cluster:

- **C20.1** — _(Folds into C10.4.)_ `WorkerLifecycleState`
  (`packages/sdk/src/supervisor.ts:16-38`) is deleted entirely as part
  of C10.4 (Wave 19, per 2026-05-04 reshape). There is nothing to
  convert; it dies with the FSM. Tracking ID retained for audit.
- **C20.2** — `StateSpec`, `ProviderSpec`, `GentServer`
  (`packages/sdk/src/server.ts:49-76`).
- **C20.3** — `ConnectionState`
  (`packages/core/src/server/transport-contract.ts:391-395`). Folds with C25
  (transport DTO simplification) if the type collapses entirely.
- **C20.4** — `SidecarRecord`, `PortProbe`
  (`packages/extensions/src/executor/sidecar.ts:56-91`).
- **C20.5** — `ConnState` (`packages/extensions/src/acp-agents/protocol.ts:89-91`).
- **C20.6** — _(deleted per counsel P2-4)_ `CommittedEvent<A>` lived inside
  `phases/turn.ts`, which is itself deleted by C5.4 (turn-phase folder
  removed). There is nothing left to convert — the symbol vanishes with
  its container. Tracking ID retained for audit.
- **C20.7** — `KeychainExit`. Already deleted in C2; verify gone.
- **C20.8** — Inline `{ _tag: "X" as const }` literal constructions in
  `extensions/src/artifacts/index.ts:58-59`. Migrate to `Variant.make`.

Each sub-commit constructs values via `.make({...})` per
`feedback_tagged_enum_class.md`.

Verification per sub-commit: `bun run gate`.

#### C21 — `refactor(domain): replace throw new Error with typed Schema.TaggedError`

Wave 18 C22.

- **C21.1** — Production-source bail-outs:
  `dependencies.ts:294`, `message-part-projection.ts:381`,
  `capability/tool.ts:80`, `git-reader.ts:191,195`, `mcp-codemode.ts:101`,
  `openai/index.ts:126`, `app-bootstrap.ts:84`, `client-facets.ts:350`,
  `resolve.ts:73,311`. Each becomes a `Schema.TaggedError` routed through
  `Effect.fail`.
- **C21.2** — Delete the "Info not implemented" stub return in
  `extensions/src/librarian/repo-explorer.ts:364`.

Verification: error-path tests, `bun run gate`.

#### C22 — `refactor(runtime): replace Effect.sleep state polls with Deferred / waitFor`

Wave 18 C23.

- **C22.1** — `native-adapter.ts:44` (`waitForScan` polling loop) →
  `Deferred` signaled by scanner completion.
- **C22.2** — `apps/tui/src/utils/file-finder.ts:100` (`Effect.sleep(0)`) →
  `Effect.yieldNow()`.
- **C22.3** — `apps/tui/src/hooks/use-scroll-sync.ts:53,58` → `waitFor`
  helper or MutationObserver effect.
- **C22.4** — `extensions/src/executor/sidecar.ts:403` (result polling) →
  `Deferred` or `Queue`.

Verification: focused tests with `TestClock`, `bun run gate`.

#### C23 — `test(sdk): replace Bun.sleep with Effect.sleep + TestClock`

Wave 18 C24. Replace `Effect.promise(() => Bun.sleep(N))` calls in
`packages/sdk/tests/supervisor.test.ts:61,88,99,110` and
`server-registry.test.ts:501` with `Effect.sleep` (under `TestClock`) plus
`Deferred` / `controls.waitForCall` / `waitFor` for state coordination.

After C10 (server-registry deleted) some of these tests change shape or
disappear; C23 handles whatever remains.

Verification: SDK supervisor tests, `bun run gate`.

#### C24 — `refactor(extensions): ConfigService for provider environment reads`

Wave 18 C25. Replace top-level `Bun.env[name]` reads in
`google/index.ts`, `anthropic/index.ts`, `openai/index.ts`,
`mistral/index.ts` with `ConfigService.get(name)` (or
`Effect.config(Config.string(name))`). Add a `ConfigService.Test(overrides)`
static factory for integration tests.

Verification: provider extension tests with config overrides, `bun run gate`.

### Phase 5 — Surface Area Reductions

#### C25 — `refactor(api): inline trivial transport DTO aliases`

**Execution order:** lands immediately after C6, before C7. See the
canonical Execution Order subsection at the top of the Commit Wave
section. Numbering stays in Phase 5 for narrative grouping; the
divergence exists so session-controller's input shapes are settled
before C12B rewrites it.

Per Lane 1 #10. Delete trivial single-field `*Input` aliases:
`ListMessagesInput`, `GetSessionTreeInput`, `GetChildSessionsInput`,
`ListBranchesInput`, `GetBranchTreeInput`, `WatchRuntimeInput`,
`ListExtensionStatusInput`, `ListExtensionSlashCommandsInput`. Inline their
`Schema.Struct` field maps as `Rpc.make` payload arguments.

Delete `*Result` DTOs whose entire body is a `Schema.Struct` with ≤3 fields
directly tied to the Rpc; inline as `success` parameter.

Delete pure re-aliases: `SessionTreeNodeSchema`, `BranchTreeNodeSchema`,
`SessionRuntime` alias.

KEEP: `SessionSnapshot` (Schema.Class with derivations), `ExtensionHealth*`
(TaggedEnumClass surfaces), `DriverInfo`, `DriverListResult` (composite
types), `RespondInteractionInput`, `UpdateSessionReasoningLevelInput`,
`SetAuthKeyInput`, `DeleteAuthKeyInput`, `AuthorizeAuthInput`,
`CallbackAuthInput`, `ExtensionRpcRequestInput` (multi-field, public
contract).

Verification: RPC tests, transport tests, `bun run gate`.

#### C26 — `refactor(server): delete or scope SessionCwdRegistry`

**Execution order:** lands BEFORE C12B (session-controller). See the
canonical Execution Order subsection at the top of the Commit Wave
section. C26's decision (delete/scope) defines the final shape that
C12B.1's design table must lock.

Wave 18 C28. After C10 (single-server with workspace routing), the
SessionCwdRegistry's role overlaps with workspace routing. Decide:

- If single-cwd-per-workspace is the model, delete the registry entirely.
- If multi-cwd-per-workspace is required, scope the registry to genuine
  multi-cwd entrypoints only.

Verification: server tests, `bun run gate`.

#### C27 — `refactor(domain): collapse event-publisher files`

Wave 18 C29. Merge `domain/event-publisher.ts` (interfaces + tags) and
`server/event-publisher.ts` (Live layer) into one file.

Verification: server tests, `bun run gate`.

#### C28 — `refactor(runtime): delete or fully specify Test layer stubs`

Wave 18 C30. `SessionRuntime.Test()`, `AgentLoop.Test()`, `ToolRunner.Test()`
return `Effect.die("not implemented")` for most methods. Per
`feedback_static_methods_on_tags.md`: test/debug variants belong as static
methods on the Tag only when they are real alternative implementations.
After C5 (AgentLoop entity) and C7 (Provider deletion), most of these stubs
have lost their reason to exist. Delete; force tests to use
`baseLocalLayer()`.

Verification: extension lifecycle tests, `bun run gate`.

### Phase 6 — Extensions And Headless

#### C29 — `refactor(extensions): audit and trim 27 → ~12 builtin extensions`

Per Lane 3 finding. Concrete consolidation candidates (validate before
deleting):

Sub-commits:

- **C29.0** — Audit `packages/core/src/runtime/extensions/` directory
  against the post-C5 entity model. After AgentLoop becomes an
  effect-encore actor (C5) and Provider becomes a thin ModelResolver (C7),
  several files in `runtime/extensions/` likely lose their reason to
  exist or shrink dramatically: `registry.ts`, `activation.ts`,
  `loader.ts`, `extension-reactions.ts`, `driver-registry.ts`,
  `disabled.ts`, `resource-host/`, plus the
  `extension-effect-membrane.ts` retained from C4.1. For each, decide:
  keep as-is / fold into another file / delete. Output: an inline
  sub-table inside this commit's body listing each file with verdict
  before any deletion lands.
- **C29.1** — `tools.client.ts` + `task-tools.client.tsx` +
  `interaction-tools.client.ts` share TUI infrastructure; collapse into
  `tool-renderers.client.ts`.
- **C29.2** — `auto.ts` + `auto-checkpoint.ts` are one feature (auto loop
  modality with signal); merge into `auto/`.
- **C29.3** — `librarian/git-reader.ts` + `librarian/repo-explorer.ts` are
  one feature; one of the two has a `throw new Error` stub already (C21).

Audit each of the 27 per the preserve-features filter: which provide a
user-visible capability vs which are bundling shims? Land as one
sub-commit per consolidation.

Verification: extension lifecycle tests, TUI integration tests, `bun run gate`.

#### C30 — `feat(headless): named tool renderers via extensions`

Per Lane 3 surface 10. Enrich `apps/tui/src/headless-runner.ts` with named
tool renderers from extensions (so `bash` shows command + truncated output,
not just raw events). Reuse the same renderer interface the TUI extension
layer exposes.

Verification: headless e2e tests, `bun run gate`, `bun run test:e2e`.

### Phase 7 — Lint And Tooling

#### C31 — `feat(tooling): no-bun-outside-adapter lint`

Wave 18 C32. Custom oxlint rule banning `Bun.` references outside
`*-adapter.ts`, `main.ts`, `scripts/`, and `packages/tooling/`. After C8 + C9

- C10, the only remaining `Bun.*` sites are adapter files plus the entrypoints.

Verification: lint tests, `bun run gate`.

#### C32 — `test(audit): extend platform duplication guards for Wave 19 deletions`

Extend `packages/tooling/src/platform-duplication-guards.ts` with patterns
locking the wave's deletions:

- `composer.ts` patterns: `eraseLayer`, `restoreErasedLayer`, `ServerProfile`
  / `CwdProfile` / `EphemeralProfile` brand identifiers (post-C4).
- `loopsRef`, `LoopDriverEvent`, `LoopHandle`, `mutationSemaphoresRef`
  patterns (post-C5).
- `Provider.Sequence` / `Provider.Signal` / `Provider.Debug` / `Provider.Failing`
  reads outside `test-utils/language-model.ts` (post-C7).
- `domain/auth-storage`, `domain/auth-store`, `domain/auth-method` paths
  flagged as deleted module paths (post-C2).
- `findOpenPort`, `WORKER_HOST` patterns (post-C8.3).
- `Bun.Glob` (post-C9.4).
- `Bun.randomUUIDv7` outside `gent-platform-bun.ts` (post-C13.1).
- `server-registry.ts` and `worker-http.ts` path guards (post-C10.2 /
  C10.3 — both files deleted in Wave 19 per the 2026-05-04 reshape).
- `WorkerLifecycleState` symbol guard (post-C10.4).
- `TextPart` / `ImagePart` / `ToolCallPart` / `ToolResultPart` /
  `ReasoningPart` / `MessagePart` references in `domain/` (post-C6).

Each pattern ships with a fixture (positive + negative case) in
`packages/tooling/tests/platform-duplication-guards.test.ts`.

**Validation requirement (counsel P2-5):** for every new pattern, the
sub-commit's verification block must record a manual `bun run test
packages/tooling/tests/platform-duplication-guards.test.ts` invocation
where the matching guard pattern is temporarily removed and the test
suite is shown to fail on the positive fixture (and a snippet of the
expected failure output is pasted into the commit body). Then the
pattern is restored and the test passes. This proves the regression
test actually catches the regression, per memory pin
`feedback_validate_test_catches_regression.md`. Do not skip — a guard
that doesn't fail when its protection is gone is dead weight.

Verification: tooling tests, `bun run gate`.

#### C33 — `test(tooling): close lint rule fixture gaps`

Wave 18 C31. Add fixtures in `packages/tooling/tests/fixtures.test.ts` for:
`no-projection-writes`, `no-runpromise-outside-boundary`,
`all-errors-are-tagged`, `no-define-extension-throw`. Each must include a
positive (rule fires) and negative (rule passes) case.

Verification: lint tests, `bun run gate`.

### Phase 8 — Documentation

#### C34 — `docs: rewrite around Wave 19 platform-native shape`

Update `ARCHITECTURE.md`, `CLAUDE.md`, `apps/tui/AGENTS.md`,
`docs/extensions.md` so vocabulary matches the post-Wave-19 codebase:
`Layer.provideMerge` ephemeral runtime, `AgentLoopEntity`,
`LanguageModel.streamText`, `ModelResolver`, `Storage` / `EventStore` /
`Search` storage triad, single-server with workspace routing, `Capability`
discriminator, `ChildProcessSpawner`, `KeyValueStore`-backed auth.

Update `apps/tui/CLAUDE.md` line 80 to reflect that auth is a route (per
C2.3).

Update `CONTRIBUTING.md` if any post-Wave-19 example diverges from the
post-Wave-18 examples.

Verification: doc lint, `bun run gate`.

## Mechanical Delegation Recipes

### Recipe A — Trivial transport DTO inline (after C25 manual proof)

- Replace `payload: SomeInput` on an `Rpc.make` call with the inline
  `Schema.Struct` field map from the deleted `SomeInput` type.
- Replace `success: SomeResult` similarly when the type body is a
  `Schema.Struct` with ≤3 fields directly tied to the Rpc.
- Stop and report if the type is referenced by ≥3 distinct call sites
  (worth keeping as a named type).
- Validate each batch with `bun run typecheck`; final batch runs `bun run gate`.

### Recipe B — `Bun.randomUUIDv7()` → `platform.randomId` regression patrol (after C13 audit)

The pre-flight audit revealed only 13 raw matches across 8 files, of
which only 2 are non-exempt (and both are adapter-shaped). Recipe B
is therefore not a bulk migration — it's a regression patrol. Use
when a future commit accidentally reintroduces `Bun.randomUUIDv7()`
inside product code:

- Replace `Bun.randomUUIDv7()` with `yield* platform.randomId` (where
  `platform = yield* GentPlatform`). Production code should already be
  doing this; the only legitimate live call site is
  `packages/core/src/runtime/gent-platform-bun.ts`.
- Add `GentPlatform` to the requirement signature of the surrounding
  function; prefer `Effect.fn` wrappers if the function has none.
- Stop and report if the call site is inside a `Layer.unsafeMakeContext`,
  module-top-level expression, or other location where yielding is
  impossible — those need a different fix (e.g. lift the call into a
  scoped layer).
- Validate with the platform-duplication-guard test
  (`packages/tooling/tests/platform-duplication-guards.test.ts`); a
  passing guard test is the stop condition.

### Recipe C — `{ _tag: "X" } | { _tag: "Y" }` → `TaggedEnumClass` (after one C20 sub-commit proof)

- Define
  `class Name extends TaggedEnumClass<Name>()({X: {...fields}, Y: {...fields}}) {}`.
- Construct with `Name.X({...})` / `Name.Y({...})` (matches `Variant.make`).
- Replace narrowing `if (x._tag === "X")` with `Match` or
  `match(x, Name.exhaustive({...}))`.
- Stop and report if a variant has a field that itself is a hand-rolled
  union (chain it).
- Validate each batch with `bun run gate`.

### Recipe D — `async`/`Promise<>` OAuth → `Effect.gen` (after C16.1 manual proof)

- Wrap leaf-level `crypto.subtle` calls in
  `Effect.tryPromise({try, catch})` with a `Schema.TaggedError` for `catch`.
- Replace `setTimeout`/`clearTimeout` with `Effect.timeout` and `Deferred`.
- Replace `Bun.serve` redirect listener with `HttpServer.layer` and an
  ephemeral port allocation.
- Eliminate every `async` function; the public API returns
  `Effect.Effect<A, E, R>`.
- Stop and report if a leaf depends on a non-Effect-portable API.
- Validate each batch with focused OAuth tests; final batch runs
  `bun run gate`.

### Recipe E — `process.*` → `GentPlatform` (after C3 manual proof)

- Replace `process.exit(code)` with `yield* GentPlatform.exit(code)`.
- Replace `process.pid` with `yield* GentPlatform.pid`.
- Replace `process.platform` with
  `(yield* GentPlatform.osInfo).platform`.
- Replace `process.execPath` with `yield* GentPlatform.execPath`.
- Replace `process.kill(pid, sig)` with
  `yield* GentPlatform.signal(pid, sig)`.
- Stop and report if the call site is in `main.ts`, `*-adapter.ts`,
  `scripts/`, or `packages/tooling/` (already exempt).
- Validate each batch with `bun run typecheck`; final batch runs
  `bun run gate`.

### Recipe F — `Provider` Tag → direct `LanguageModel.LanguageModel` (after C7.1/C7.2 manual proofs)

- Replace `import { Provider } from "@gent/core/providers/provider"` in
  test files with
  `import { LanguageModelLayers } from "@gent/core/test-utils/language-model"`.
  Production code that yielded `Provider` now yields `LanguageModel.LanguageModel`
  directly (`import * as LanguageModel from "effect/unstable/ai/LanguageModel"`).
- Replace `Provider.Sequence([...])` with
  `LanguageModelLayers.sequence([...])` (returns
  `Layer.Layer<LanguageModel.LanguageModel>`). Same for `.Signal` /
  `.Debug` / `.Failing` → `LanguageModelLayers.signal/debug/failing`.
- Replace stream-part wrapper helpers (`textDeltaPart`, `toolCallPart`,
  `reasoningDeltaPart`, `finishPart`) with `Response.makePart({...})`
  from `effect/unstable/ai/Response`.
- Replace step builders (`textStep`, `toolCallStep`,
  `textThenToolCallStep`, `multiToolCallStep`) — these stay; they are
  gent-owned test ergonomics over `Response.AnyPart`. Update their
  internal wiring to construct `Response.AnyPart` directly.
- For services depending on `Provider`, change requirement to
  `LanguageModel.LanguageModel` and yield it directly.
- Stop and report if a call site uses `Provider` for non-streamText
  capabilities (the migration target only covers streamText / generate
  / objects exposed by `LanguageModel`); flag for design review.
- Validate each batch with `bun run typecheck`; final batch runs `bun run gate`.

## Closure Audit

To be filled at wave close. Each implementation commit appends its hash and
one-line summary to the ledger below. Counsel and Codex reviews append
accepted / rejected / deferred findings with receipts. The wave closes when
C32 + C33 + C34 land green.

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
- `/Users/cvr/Developer/personal/gent/plans/WAVE-18.md`
- `/Users/cvr/Developer/personal/gent/CONTRIBUTING.md`
- `/Users/cvr/Developer/personal/gent/README.md`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/composer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/effect-membrane.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/scope-brands.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-runner.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/phases/turn.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/event-store-live.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform-bun.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/tracer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/providers/ai-transcript.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/checkpoint-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/storage/interaction-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/auth-storage.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/auth-store.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/auth-guard.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/auth-method.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/contribution.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/supervisor.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/server-registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/oauth.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/openai/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/oauth.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/memory/vault.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/file-index/fallback-adapter.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/auth.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/headless-runner.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/workspace/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/CLAUDE.md`

External (Effect platform):

- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/LanguageModel.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Toolkit.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Prompt.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Response.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/cluster/Entity.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/cluster/Sharding.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/sql/SqlSchema.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/sql/SqlModel.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/sql/SqliteMigrator.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/platform/KeyValueStore.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/platform/FileSystem.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/process/ChildProcessSpawner.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/observability/NodeSdk.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/platform-bun/src/BunHttpServer.ts`

External (comparison repos):

- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent-loop.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/agent/src/agent.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/server/server.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/auth/index.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/permission/index.ts`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.sql.ts`

Lane reports (full text):

- Lane 1 (Effect-platform): `/private/tmp/claude-501/-Users-cvr-Developer-personal-gent/334e2608-0c1e-477d-9cb1-aeb7bbee33a6/tasks/a951fc411167e96bb.output`
- Lane 2 (pi-mono): captured pre-compaction in conversation transcript
- Lane 3 (opencode): `/private/tmp/claude-501/-Users-cvr-Developer-personal-gent/334e2608-0c1e-477d-9cb1-aeb7bbee33a6/tasks/aca8d86bf23253ddf.output`
- Lane 4 (GentPlatform/portability): `/private/tmp/claude-501/-Users-cvr-Developer-personal-gent/334e2608-0c1e-477d-9cb1-aeb7bbee33a6/tasks/a550684b68c43024c.output`

Project memory (apply throughout):

- `/Users/cvr/.claude/projects/-Users-cvr-Developer-personal-gent/memory/feedback_preserve_features_during_collapse.md`
- `/Users/cvr/.claude/projects/-Users-cvr-Developer-personal-gent/memory/feedback_keep_wide_event.md`
- `/Users/cvr/.claude/projects/-Users-cvr-Developer-personal-gent/memory/feedback_counsel_after_batch.md`
- `/Users/cvr/.claude/projects/-Users-cvr-Developer-personal-gent/memory/feedback_counsel_fallback_opus.md`
- `/Users/cvr/.claude/projects/-Users-cvr-Developer-personal-gent/memory/feedback_tagged_enum_class.md`
- `/Users/cvr/.claude/projects/-Users-cvr-Developer-personal-gent/memory/feedback_tests_per_feature.md`
- `/Users/cvr/.claude/projects/-Users-cvr-Developer-personal-gent/memory/feedback_static_methods_on_tags.md`
- `/Users/cvr/.claude/projects/-Users-cvr-Developer-personal-gent/memory/feedback_test_coverage_blocking.md`
