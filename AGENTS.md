# AGENTS.md

Building gent - minimal, opinionated agent harness (built with Effect).

## Quick Start

```bash
bun install
bun run typecheck  # patched TypeScript 7 + Effect diagnostics, must pass clean; also compiles the ts and tsx blocks of the steering docs
bun run lint       # oxlint (gent rules + type-aware lints), the guards (`bun run guards`), and the lint-offs probe (`bun run lint:offs`)
bun run test       # Gate tests. NOT bare `bun test` (picks up flaky e2e)
bun run smoke      # Headless mode smoke test
bun run link       # Build, then point ~/.bun/bin/gent at this checkout (uncached)
bun run clean      # Remove turbo caches (.turbo)
```

## CLI Usage

```bash
# TUI mode (default)
bun run --cwd apps/tui dev

# Continue last session for cwd
bun run --cwd apps/tui dev resume

# Start with prompt (creates session, goes straight to session view)
bun run --cwd apps/tui dev -p "your prompt"

# Continue specific session
bun run --cwd apps/tui dev -s <session-id>

# Headless mode - streams to stdout, exits after response
bun run --cwd apps/tui dev -H "your prompt here"

# Headless mode that approves every ask (destructive commands included).
# Without the flag, headless declines each ask: no user is present.
bun run --cwd apps/tui dev -H --approve-all "your prompt here"

# List sessions
bun run --cwd apps/tui dev sessions
```

## Gotchas

- **bun:sqlite** - Can't use vitest (runs in Node). Use `bun test` directly.
- **Schema.Class JSON roundtrip** - `JSON.parse` returns plain objects. Use `Schema.decodeUnknownSync` to reconstruct instances.
- **Effect diagnostics** - Effect compiler suggestions are not TypeScript errors. Still fix them.
- **Bun peer deps** - Bun resolves to minimum version; can cause version mismatches with @effect packages.
- **No `any` casts** - oxlint enforces. Causes type drift bugs. Import the owning type instead of redeclaring it.
- **Package boundary imports** - Use `@gent/core/extensions/api` for extension authoring. Use `@gent/core/protocol` for shared client schemas, projections, and RPC types. Use `@gent/core/host` for what a host composes (platform, config loader, storage, workspace headers, server root, the scripted model). Use `@gent/core/test-utils` in tests only; product code never imports it. Each entry re-exports only names with a real consumer; a `host` name needs a product caller, so a name only tests read belongs in `test-utils`. A test outside core arranges host state through `test-utils` operations (`captureTurnTools`, `runtimeHostContext`, `plantToolCallBinding`, `plantInFlightTurn`, `recordInteractionDecision`, `storedEvents`, `staticToolBinding`), never through core's own Tags, and never imports `packages/core/src/` by relative path. Core implementation tests import their owning `packages/core/src/` modules by relative path. Files inside `packages/core/src/` also use relative imports.
- **Extension authority** - Extension leaves receive input/event params only. Use `const ctx = yield* ExtensionContext` for host facades (`Session`, `Interaction`, `FileLock`, `State`) and extension-owned service Tags for private state. Files, paths, processes, and ids come from the Effect platform services (`FileSystem`, `Path`, `ChildProcessSpawner`, `Crypto`), with `runProcess` for commands, `path.resolve(ctx.cwd, p)` for relative paths, and `writeFileAtomic` (`packages/core/src/runtime/gent-platform.ts`, exported from `@gent/core/extensions/api` and `@gent/core/host`) for atomic writes; no facet duplicates an Effect platform service. Shipped extensions never import core internals such as `FileLockService` or `EventStore` — yield the matching `ExtensionContext` facet instead. Every facade verb is uniform: any extension that can yield `ExtensionContext` gets it, including every verb of the `Session` facet (`ExtensionSessionService` in `packages/core/src/domain/extension.ts`), such as `send` with its `delivery` mode `turn`/`queue`/`steer`. Do not add ctx parameters, read/write/capability grants, or privileged builtin registries; a shipped extension is never more privileged than a user extension (the `gent/core-entry-boundary` oxlint rule in `packages/tooling/src/gent-rules.ts` enforces the import side).
- **No self-imports** - Inside `packages/core/src/`, always use relative imports. Never `@gent/core/*`.
- **Effect.fn recursive** - For recursive generators, annotate variable type: `const fn: (...) => Effect<A,E,R> = Effect.fn(...)`
- **Wide event boundaries** - `WideEvent.set()` requires a `withWideEvent` boundary in scope. Import `WideEvent`, `WideEventBoundary`, and `withWideEvent` from `effect-wide-event` directly.
- **Structured logging** - Use `Effect.logWarning("msg").pipe(Effect.annotateLogs({ error: String(e) }))`. Never pass error as second positional arg to `Effect.logWarning`.
- **bun:test timeouts bypass Effect finalizers** - Always use `Effect.timeout` inside the Effect, shorter than the bun timeout, so scope finalizers run on timeout.
- **A failed extension fails the test** - Test roots stop with `Extensions failed to load: <id> (<scope>, <phase>): <reason>`. Fix the extension; set `allowFailedExtensions: true` only in a test about the failure report.
- **Integration tests: in-process first** - Prefer `createRpcClient(baseLocalLayer())` or `createRpcHarness(...)` from `@gent/core/test-utils`; `Gent.test` from `@gent/sdk` is for SDK and app tests. Only use subprocess workers for tests that specifically need process isolation (supervisor lifecycle, PTY).
- **Signal language model for lifecycle assertions** - Use `LanguageModelLayers.signal(reply)` for deterministic per-chunk control (thinking→streaming→idle). `controls.waitForStreamStart` then `controls.emitNext()/emitAll()`. Shared Queue gates all `streamText()` calls — multi-turn tests need multiple `emitAll()` rounds.
- **`LanguageModelLayers.debug({ delayMs })`** - Replaces old `DebugSlowProvider`. Use `TestClock.layer()` from `effect/testing` + `TestClock.adjust()` to make delays instant in tests.
- **Test control flow** - Test files must not use `async`/`await`, Promise chains, raw Promise-returning test bodies, or hook cleanup patterns. Use `it.live` / `it.scopedLive`, `Effect.promise` only at real async boundaries, and scoped resources such as `makeTempDirectoryScoped`.
- **Process-shaped names** - Active source/test/module names should describe product behavior, not migration history. Avoid names like `batch12`, `wave14`, or `planify-migration` outside `plans/` and dated audit receipts.

## Architecture

Read `ARCHITECTURE.md` before implementing. Update when diverging.

## Effect Patterns

Use `effect` skill. Key patterns:

- Services: `Context.Service` + `Layer.effect`/`Layer.succeed`
- Errors: `Schema.TaggedError`
- Data: `Schema.Class` with branded IDs
- Tracing: `Effect.fn` for all service methods

## Code Style

- Telegraph style, minimal tokens
- Every service exposes a `Live` layer; add a `Test` layer only when there is a real alternative implementation worth a Tag. Language model tests use `LanguageModelLayers` instead of provider wrapper statics.
- Schema validation at boundaries
- **Tagged/discriminated unions use Effect Schema primitives.** Prefer `Schema.TaggedUnion` (or `Schema.TaggedStruct` + `Schema.toTaggedUnion` for kebab-case wire tags, or `Schema.TaggedError` for errors); do not hand-roll `{ _tag: "X" } | { _tag: "Y" }` literal unions.
- **File naming**: kebab-case everywhere (`agent-loop.ts`, `message-list.tsx`)
- **One file per concern.** A concern lives in one large file with section banners (`session.ts`, `agent-loop.ts`, `tools.ts`). A new file needs a reason: a process entry, a package entry, a module two concerns share, or a lint-scoped boundary.

## Package Structure

```
packages/core/src/       # Everything non-UI
  domain/                # Schemas + services (ids, message, event, tool, agent, etc.)
  storage/               # SQLite service assembler, schema, migrations, focused sub-tag impls
  runtime/               # SessionRuntime, AgentLoop internals, profiles, context-estimation, retry
  extensions/            # Public extension API surface and branch-tool entry points
  server/                # transport contract, commands, queries, handlers, startup wiring
  test-utils/            # Mock layers, sequence recording, step builders, in-process layer
packages/sdk/            # Client wrappers
apps/tui/                # @opentui/solid TUI
apps/server/             # BunHttpServer
```

## Testing

```bash
bun run test              # unit/integration, one turbo task per package
bun run test:e2e          # PTY + focused server-process lifecycle coverage (slow)
bun run gate              # typecheck + lint + fmt + build + test
```

Test files mirror `packages/core/src/` structure: `tests/domain/`, `tests/runtime/`, `tests/storage/`, etc. One file per feature area, no fix-shaped files or god tests.

### Test philosophy

- **Default is integration**: use `createRpcHarness` for extension RPC acceptance, `baseLocalLayer` for runtime integration, or `testSqliteStorage()` from the test utilities for focused storage behavior. Drop to raw `createE2ELayer` only for advanced host/profile wiring.
- **Pure unit tests only for pure functions**: reducers, formatters, schema transforms, context-estimation math.
- **Mock at system boundaries**: only the LLM via `LanguageModelLayers.sequence(...)`, `LanguageModelLayers.signal(...)`, or `LanguageModelLayers.debug()`. Use real services inside the boundary.
- **`Provider.Test()` / provider wrapper statics and `EventStore.Test()` are deleted** — use `LanguageModelLayers.sequence([...])` or `LanguageModelLayers.debug()` for model mocking, `EventStore.Memory` for in-memory event stores. `LanguageModelLayers` and the step builders (`textStep`, `toolCallStep`, `textThenToolCallStep`, `multiToolCallStep`) live in `packages/core/src/test-utils/language-model.ts`. The stream-part helpers (`textDeltaPart`, `toolCallPart`, `reasoningDeltaPart`, `finishPart`) and the scripted model behind `LanguageModelLayers.debug()` and `Gent.provider.mock()` (`ScriptedLanguageModel`) live in `packages/core/src/runtime/provider.ts`. Tests outside core import them from `@gent/core/test-utils`.
- **Behavioral naming**: describe outcomes, not method calls. "missing auth key returns undefined", not "get returns undefined for missing key".
- **No `Effect.sleep` for state transitions** — use `Deferred`, `controls.waitForCall`, or `waitFor` polling helpers.
- **`Effect.timeout` inside Effect, shorter than bun timeout** — so scope finalizers run on timeout.

### Three-tier test taxonomy

| Tier           | Layer               | Exercises                       | Use for                           |
| -------------- | ------------------- | ------------------------------- | --------------------------------- |
| Pure reducer   | local reducer tests | State transitions, projections  | Pure state behavior               |
| Runtime        | `baseLocalLayer()`  | Real services and storage       | Supervisor, protocol, persistence |
| RPC acceptance | `createRpcHarness`  | Full RPC → runtime → reply path | Lifecycle, scope, schema, wiring  |

New extension tests should include at least one RPC acceptance test via `createRpcHarness` to catch scope lifetime bugs. Direct service tests are for behavior — they bypass the per-request scope boundary that production uses.

### Test layers

```typescript
import { Effect } from "effect"
import {
  baseLocalLayer,
  createRpcHarness,
  LanguageModelLayers,
  testAgent,
  testTurnExtension,
  textStep,
  toolCallStep,
} from "@gent/core/test-utils"

// Full in-process stack (real services, event store, and storage)
export const layer = baseLocalLayer({ agents: [testAgent] })

export const acceptance = Effect.gen(function* () {
  // Sequence provider for deterministic LLM responses
  const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
    toolCallStep("echo", { text: "hello" }),
    textStep("Done."),
  ])
  // RPC acceptance harness (real per-request scopes)
  const { client, sessionId, branchId } = yield* createRpcHarness({
    agents: [testAgent],
    extensionInputs: [testTurnExtension],
    providerLayer,
  })
  yield* client.message.send({ sessionId, branchId, content: "hi" })
  yield* controls.assertDone
})
```

Core tests record the event sequence for assertions with `RecordingEventStore` and `SequenceRecorder`, imported by relative path from `packages/core/src/test-utils/harness.ts`.

## Key Files

| File                                             | Purpose                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| `packages/core/src/storage/storage.ts`           | SQLite layer composition for focused storage tags   |
| `packages/core/src/storage/schema.ts`            | SQLite schema, migration, and initialization logic  |
| `packages/core/src/test-utils/harness.ts`        | recorders, harnesses, and the in-process layers     |
| `packages/core/src/server/server.ts`             | startup wiring + dependency graph                   |
| `packages/core/src/server/rpc.ts`                | shared client contract                              |
| `packages/core/src/domain/agent-loop.ts`         | loop state, entity id, and the actor protocol       |
| `packages/core/src/runtime/agent-loop.ts`        | mailbox, worker, behavior, and the actor            |
| `packages/core/src/runtime/turn.ts`              | per-branch turn engine used by the actor            |
| `packages/core/src/test-utils/language-model.ts` | `LanguageModelLayers`, step and stream-part helpers |
| `apps/tui/tsconfig.json`                         | `jsxImportSource: "@opentui/solid"` required        |

## Documentation

| Path                       | Focus                                                          |
| -------------------------- | -------------------------------------------------------------- |
| `ARCHITECTURE.md`          | Package structure, concepts                                    |
| `apps/tui/AGENTS.md`       | OpenTUI, Solid patterns                                        |
| `testbeds/gamut/README.md` | Live TUI check: `bun run gamut up <preset>`, isolated database |
