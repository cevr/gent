# AGENTS.md

Building gent - minimal, opinionated agent harness (built with Effect).

## Quick Start

```bash
bun install
bun run typecheck  # tsgo + @effect/language-service, must pass clean
bun run lint       # oxlint (gent custom rules + oxlint-tsgolint type-aware lints)
bun run test       # Gate tests. NOT bare `bun test` (picks up flaky e2e)
bun run test:diagnose # Print slowest chunks without failing on duration
bun run smoke      # Headless mode smoke test
bun run clean      # Remove dist and tsbuildinfo files
```

## CLI Usage

```bash
# TUI mode (default)
bun run --cwd apps/tui dev

# Continue last session for cwd
bun run --cwd apps/tui dev -c

# Start with prompt (creates session, goes straight to session view)
bun run --cwd apps/tui dev -p "your prompt"

# Continue specific session
bun run --cwd apps/tui dev -s <session-id>

# Headless mode - streams to stdout, exits after response
bun run --cwd apps/tui dev -H "your prompt here"

# List sessions
bun run --cwd apps/tui dev sessions
```

## Gotchas

- **bun:sqlite** - Can't use vitest (runs in Node). Use `bun test` directly.
- **Schema.Class JSON roundtrip** - `JSON.parse` returns plain objects. Use `Schema.decodeUnknownSync` to reconstruct instances.
- **Effect LSP suggestions** - TS41 messages are suggestions, not errors. Still must fix them.
- **Bun peer deps** - Bun resolves to minimum version; can cause version mismatches with @effect packages.
- **@effect/platform imports** - Some types not re-exported from main. Use `import type { PlatformError } from "@effect/platform/Error"`.
- **No `any` casts** - ESLint enforces. Causes type drift bugs. Import the owning type instead of redeclaring it.
- **Package boundary imports** - `@gent/core` only exposes the public extension authoring API at `@gent/core/extensions/api`. Shipped apps, packages, and tests that need core internals import from `@gent/core-internal/*`. Files inside `packages/core/src/` and `packages/core-internal/src/` use relative imports.
- **No self-imports** - Inside `packages/core/src/`, always use relative imports. Never `@gent/core/*`.
- **Effect.fn recursive** - For recursive generators, annotate variable type: `const fn: (...) => Effect<A,E,R> = Effect.fn(...)`
- **Wide event boundaries** - `WideEvent.set()` requires a `withWideEvent` boundary in scope. Use domain context factories from `wide-event-boundary.ts`.
- **Structured logging** - Use `Effect.logWarning("msg").pipe(Effect.annotateLogs({ error: String(e) }))`. Never pass error as second positional arg to `Effect.logWarning`.
- **bun:test timeouts bypass Effect finalizers** - Always use `Effect.timeout` inside the Effect, shorter than the bun timeout, so scope finalizers run on timeout.
- **Integration tests: in-process first** - Prefer `Gent.test(baseLocalLayer())` from `@gent/core-internal/test-utils/in-process-layer.js`. Only use subprocess workers for tests that specifically need process isolation (supervisor lifecycle, PTY).
- **Signal language model for lifecycle assertions** - Use `LanguageModelLayers.signal(reply)` for deterministic per-chunk control (thinking→streaming→idle). `controls.waitForStreamStart` then `controls.emitNext()/emitAll()`. Shared Queue gates all `streamText()` calls — multi-turn tests need multiple `emitAll()` rounds.
- **`LanguageModelLayers.debug({ delayMs })`** - Replaces old `DebugSlowProvider`. Use `TestClock.layer()` from `effect/testing` + `TestClock.adjust()` to make delays instant in tests.
- **Ephemeral runtime composition** - `agent-runner.ts` builds the per-run layer from a parent context snapshot plus explicit child-owned override families. Parent services become a `Layer.succeedContext(...)` source; child overrides merge with `Layer.provideMerge` so child Tags occlude parent Tags. The builder keeps `Layer.fresh` on the final merged layer so ephemeral SQLite and mutable services do not alias the parent memo map.
- **Test control flow** - Test files must not use `async`/`await`, Promise chains, raw Promise-returning test bodies, or hook cleanup patterns. Use `it.live` / `it.scopedLive`, `Effect.promise` only at real async boundaries, and scoped resources such as `makeTempDirectoryScoped`.
- **Process-shaped names** - Active source/test/module names should describe product behavior, not migration history. Avoid names like `batch12`, `wave14`, or `planify-migration` outside `plans/` and dated audit receipts.

## Architecture

Read `ARCHITECTURE.md` before implementing. Update when diverging.

## Effect Patterns

Use `effect` skill. Key patterns:

- Services: `Context.Tag` + `Layer.effect`/`Layer.succeed`
- Errors: `Schema.TaggedError`
- Data: `Schema.Class` with branded IDs
- Tracing: `Effect.fn` for all service methods

## Code Style

- Telegraph style, minimal tokens
- Every service exposes a `Live` layer; add a `Test` layer only when there is a real alternative implementation worth a Tag. Language model tests use `LanguageModelLayers` instead of provider wrapper statics.
- Schema validation at boundaries
- **Tagged/discriminated unions use Effect Schema primitives.** Prefer `Schema.TaggedStruct` / `Schema.Union` / `Schema.TaggedErrorClass`; do not hand-roll `{ _tag: "X" } | { _tag: "Y" }` literal unions. Existing `TaggedEnumClass` use is transitional and should not expand.
- **File naming**: kebab-case everywhere (`agent-loop.actor.ts`, `message-list.tsx`)

## Package Structure

```
packages/core/src/       # Everything non-UI
  domain/                # Schemas + services (ids, message, event, tool, agent, etc.)
  storage/               # SQLite service assembler, schema, migrations, focused sub-tag impls
  providers/             # AI SDK adapters
  runtime/               # SessionRuntime, AgentLoop internals, profiles, context-estimation, retry
  tools/                 # Tool implementations
  server/                # transport contract, commands, queries, handlers, startup wiring
  test-utils/            # Mock layers, sequence recording, in-process layer
  debug/                 # Sequence step builders (textStep, toolCallStep, multiToolCallStep)
packages/sdk/            # Client wrappers
apps/tui/                # @opentui/solid TUI
apps/server/             # BunHttpServer
```

## Testing

```bash
bun run test              # unit/integration (~2s)
bun run test:diagnose     # timing diagnostics; does not fail on duration
bun run test:e2e          # PTY + focused server-process lifecycle coverage (slow)
bun run gate              # typecheck + lint + fmt + build + test
```

Test files mirror `packages/core/src/` structure: `tests/domain/`, `tests/runtime/`, `tests/tools/`, etc. One file per feature area, no fix-shaped files or god tests.

### Test philosophy

- **Default is integration**: use `createRpcHarness` for extension RPC acceptance, `baseLocalLayer` for runtime integration, or `SqliteStorage.TestWithSql()` for focused storage behavior. Drop to raw `createE2ELayer` only for advanced host/profile wiring.
- **Pure unit tests only for pure functions**: reducers, formatters, schema transforms, context-estimation math.
- **Mock at system boundaries**: only the LLM via `LanguageModelLayers.sequence(...)`, `LanguageModelLayers.signal(...)`, or `LanguageModelLayers.debug()`. Use real services inside the boundary.
- **`Provider.Test()` / provider wrapper statics and `EventStore.Test()` are deleted** — use `LanguageModelLayers.sequence([...])` or `LanguageModelLayers.debug()` for model mocking, `EventStore.Memory` for in-memory event stores. `LanguageModelLayers` and stream-part helpers (`textDeltaPart`, `toolCallPart`, `reasoningDeltaPart`, `finishPart`) live in `@gent/core-internal/test-utils/language-model`. Step builders (`textStep`, `toolCallStep`, `textThenToolCallStep`, `multiToolCallStep`) live in `@gent/core-internal/debug/provider`.
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
// Sequence provider for deterministic LLM responses
const { layer: providerLayer, controls } =
  yield * LanguageModelLayers.sequence([toolCallStep("echo", { text: "hello" }), textStep("Done.")])

// Full in-process stack (AppServicesLive + real event store + real storage)
import { baseLocalLayer } from "@gent/core-internal/test-utils/in-process-layer"
const layer = baseLocalLayer()

// RPC acceptance harness (real per-request scopes)
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
const { client, sessionId, branchId } = yield * createRpcHarness({ providerLayer, extensions })

// Sequence recording for event assertions
import {
  SequenceRecorder,
  RecordingEventStore,
  assertSequence,
} from "@gent/core-internal/test-utils"
assertSequence(calls, [
  { service: "EventStore", method: "publish", match: { _tag: "TurnCompleted" } },
])
```

## Key Files

| File                                                     | Purpose                                             |
| -------------------------------------------------------- | --------------------------------------------------- |
| `packages/core/src/storage/sqlite-storage.ts`            | SQLite layer composition for focused storage tags   |
| `packages/core/src/storage/schema.ts`                    | SQLite schema, migration, and initialization logic  |
| `packages/core/src/test-utils/index.ts`                  | `SequenceRecorder`, recording layers                |
| `packages/core/src/server/dependencies.ts`               | startup wiring + dependency graph                   |
| `packages/core/src/server/transport-contract.ts`         | shared client contract                              |
| `packages/core/src/runtime/agent/agent-loop.actor.ts`    | actor protocol, entity id, and mailbox handlers     |
| `packages/core/src/runtime/agent/agent-loop.behavior.ts` | per-branch turn engine used by the actor            |
| `packages/core/src/runtime/wide-event-boundary.ts`       | `effect-wide-event` integration + context factories |
| `packages/core/src/test-utils/in-process-layer.ts`       | `baseLocalLayer` / `baseLocalLayerWithProvider`     |
| `packages/core/src/debug/provider.ts`                    | step builders for `LanguageModelLayers.sequence`    |
| `packages/core/src/test-utils/language-model.ts`         | `LanguageModelLayers` + stream-part helpers         |
| `packages/extensions/src/auto/index.ts`                  | auto loop modality extension                        |
| `packages/extensions/src/auto/checkpoint.ts`             | signal tool for auto loop iteration                 |
| `apps/tui/tsconfig.json`                                 | `jsxImportSource: "@opentui/solid"` required        |

## Documentation

| Path                 | Focus                       |
| -------------------- | --------------------------- |
| `ARCHITECTURE.md`    | Package structure, concepts |
| `apps/tui/AGENTS.md` | OpenTUI, Solid patterns     |
