# AGENTS.md

Building gent - minimal, opinionated agent harness (built with Effect).

## Quick Start

```bash
bun install
bun run typecheck  # Must pass clean (no errors, no suggestions)
bun run lint       # ESLint: no any, no floating promises
bun run test       # Uses bun test, NOT vitest (bun:sqlite compat)
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
- **No `any` casts** - ESLint enforces. Causes type drift bugs. Import types from `@gent/core`, don't redeclare.
- **Effect.fn recursive** - For recursive generators, annotate variable type: `const fn: (...) => Effect<A,E,R> = Effect.fn(...)`

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
packages/{name}/
├── src/
│   ├── index.ts      # Public exports (use `export type` for interfaces)
│   └── *.ts
├── package.json      # peerDependencies for effect
└── tsconfig.json     # references to deps
```

## Testing

```typescript
// Use createTestLayer for mocked services
const layer = createTestLayer({ providerResponses: [...] })

// Use createRecordingTestLayer for sequence assertions
const layer = createRecordingTestLayer({ ... })
assertSequence(calls, [{ service: "Provider", method: "stream" }])
```

## Key Files

| File                                     | Purpose                                          |
| ---------------------------------------- | ------------------------------------------------ |
| `packages/storage/src/sqlite-storage.ts` | `decodeMessageParts` for JSON→Schema roundtrip   |
| `packages/test-utils/src/index.ts`       | `SequenceRecorder`, recording layers, assertions |
| `apps/tui/tsconfig.json`                 | `jsxImportSource: "@opentui/solid"` required     |

## Documentation

| Path                            | Focus                                     |
| ------------------------------- | ----------------------------------------- |
| `packages/server/AGENTS.md`     | GentCore, RPC/HTTP API, layer composition |
| `packages/core/AGENTS.md`       | Type exports, schema patterns             |
| `packages/runtime/AGENTS.md`    | AgentLoop, tracing, telemetry             |
| `packages/providers/AGENTS.md`  | Provider setup, Stream.async              |
| `packages/storage/AGENTS.md`    | SQLite, JSON roundtrip                    |
| `packages/test-utils/AGENTS.md` | Test layers, mocking                      |
| `apps/tui/AGENTS.md`            | OpenTUI, Solid patterns                   |
