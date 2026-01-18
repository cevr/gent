# AGENTS.md

Building gent - minimal, opinionated, Effect-native agent harness.

## Quick Start

```bash
bun install
bun run typecheck  # Must pass clean (no errors, no suggestions)
bun run test       # Uses bun test, NOT vitest (bun:sqlite compat)
```

## Gotchas

- **bun:sqlite** - Can't use vitest (runs in Node). Use `bun test` directly.
- **Schema.Class JSON roundtrip** - `JSON.parse` returns plain objects. Use `Schema.decodeUnknownSync` to reconstruct instances.
- **exactOptionalPropertyTypes** - `string | undefined` ≠ `string?`. Define explicit interface types.
- **Effect LSP suggestions** - TS41 messages are suggestions, not errors. Still must fix them.
- **Bun peer deps** - Bun resolves to minimum version; can cause version mismatches with @effect packages.

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

| File | Purpose |
|------|---------|
| `packages/storage/src/SqliteStorage.ts` | Uses `decodeMessageParts` for JSON→Schema roundtrip |
| `packages/test-utils/src/index.ts` | `SequenceRecorder`, recording layers, assertions |
| `apps/tui/tsconfig.json` | `jsxImportSource: "@opentui/solid"` required |
