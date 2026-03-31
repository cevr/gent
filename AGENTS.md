# AGENTS.md

Building gent - minimal, opinionated agent harness (built with Effect).

## Quick Start

```bash
bun install
bun run typecheck  # Must pass clean (no errors, no suggestions)
bun run lint       # ESLint: no any, no floating promises
bun run test       # Gate tests. NOT bare `bun test` (picks up flaky e2e)
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
- **No `any` casts** - ESLint enforces. Causes type drift bugs. Import types from `@gent/core/domain/<file>`, don't redeclare.
- **No barrels** - `@gent/core` uses subpath exports. Import from specific files: `@gent/core/domain/event`, `@gent/core/runtime/agent/agent-loop`, etc.
- **No self-imports** - Inside `packages/core/src/`, always use relative imports. Never `@gent/core/*`.
- **Effect.fn recursive** - For recursive generators, annotate variable type: `const fn: (...) => Effect<A,E,R> = Effect.fn(...)`
- **Wide event boundaries** - `WideEvent.set()` requires a `withWideEvent` boundary in scope. Use domain context factories from `wide-event-boundary.ts`.
- **Structured logging** - Use `Effect.logWarning("msg").pipe(Effect.annotateLogs({ error: String(e) }))`. Never pass error as second positional arg to `Effect.logWarning`.
- **bun:test timeouts bypass Effect finalizers** - Always use `Effect.timeout` inside the Effect, shorter than the bun timeout, so scope finalizers run on timeout.
- **Integration tests: in-process first** - Prefer `Gent.test(baseLocalLayer())` from `@gent/core/test-utils/in-process-layer.js`. Only use subprocess workers for tests that specifically need process isolation (supervisor lifecycle, PTY).
- **Signal provider for lifecycle assertions** - Use `createSignalProvider(reply)` for deterministic per-chunk control (thinking→streaming→idle). `controls.waitForStreamStart` then `controls.emitNext()/emitAll()`. Shared Queue gates all `stream()` calls — multi-turn tests need multiple `emitAll()` rounds.
- **DebugProvider({ delayMs })** - Replaces old `DebugSlowProvider`. Use `TestClock.layer()` from `effect/testing` + `TestClock.adjust()` to make delays instant in tests.

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
- Every service: `Live` + `Test` layers
- Schema validation everywhere
- Discriminated unions via `Schema.TaggedClass`
- **File naming**: kebab-case everywhere (`agent-loop.ts`, `message-list.tsx`)

## Package Structure

```
packages/core/src/       # Everything non-UI
  domain/                # Schemas + services (ids, message, event, tool, agent, etc.)
  storage/               # SQLite
  providers/             # AI SDK adapters
  runtime/               # AgentLoop, ActorProcess, context-estimation, retry
  tools/                 # Tool implementations
  server/                # transport contract, commands, queries, handlers, startup wiring
  test-utils/            # Mock layers, sequence recording, in-process layer
  debug/                 # Debug providers (DebugProvider, DebugFailingProvider, createSignalProvider)
packages/sdk/            # Client wrappers
apps/tui/                # @opentui/solid TUI
apps/server/             # BunHttpServer
```

## Testing

```bash
bun run test              # unit/integration (~2s)
bun run test:integration  # direct-transport seam tests (~2s)
bun run test:e2e          # PTY + supervisor + worker-http (slow)
bun run gate              # typecheck + lint + fmt + build + test
```

Test files mirror `packages/core/src/` structure: `tests/domain/`, `tests/runtime/`, `tests/tools/`, etc. One file per source owner, no god tests.

```typescript
// Use createTestLayer for mocked services
const layer = createTestLayer({ providerResponses: [...] })

// Use createRecordingTestLayer for sequence assertions
const layer = createRecordingTestLayer({ ... })
assertSequence(calls, [{ service: "Provider", method: "stream" }])
```

## Key Files

| File                                               | Purpose                                             |
| -------------------------------------------------- | --------------------------------------------------- |
| `packages/core/src/storage/sqlite-storage.ts`      | `decodeMessageParts` for JSON→Schema roundtrip      |
| `packages/core/src/test-utils/index.ts`            | `SequenceRecorder`, recording layers                |
| `packages/core/src/server/dependencies.ts`         | startup wiring + dependency graph                   |
| `packages/core/src/server/transport-contract.ts`   | shared client contract                              |
| `packages/core/src/runtime/agent/agent-loop.ts`    | flat loop machine assembly                          |
| `packages/core/src/runtime/wide-event-boundary.ts` | `effect-wide-event` integration + context factories |
| `packages/core/src/test-utils/in-process-layer.ts` | `baseLocalLayer` / `baseLocalLayerWithProvider`     |
| `packages/core/src/debug/provider.ts`              | debug providers + `createSignalProvider`            |
| `packages/core/src/extensions/auto.ts`             | auto loop modality extension (fromMachine)          |
| `packages/core/src/tools/auto-checkpoint.ts`       | signal tool for auto loop iteration                 |
| `apps/tui/tsconfig.json`                           | `jsxImportSource: "@opentui/solid"` required        |

## Documentation

| Path                 | Focus                       |
| -------------------- | --------------------------- |
| `ARCHITECTURE.md`    | Package structure, concepts |
| `apps/tui/AGENTS.md` | OpenTUI, Solid patterns     |
