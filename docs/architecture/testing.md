# Testing

Use the smallest honest boundary:

- pure helpers: unit tests
- transport/app services: Effect tests
- TUI render/capture: OpenTUI renderer tests
- runtime ordering/turn semantics: recording layers + runtime tests

**A scripted model checks its own script**: `controls.assertDone` on a
`LanguageModelLayers.sequence` dies when a step's `assertOptions` or
`assertRequest` check failed, not only when steps are left. The failed check
also fails its model call, which a turn reads as a provider error and goes
past, so only `assertDone` makes the test fail on it.

**Names describe behavior**: active test modules are behavior-named. Historical process names belong only in `plans/` and dated audit receipts; a guard (`findProcessNames` in `packages/tooling/src/guards.ts`) refuses a ledger id or a pass name in source and tests.

**Lint strength never drops**: the guards read source through `oxc-parser`, the parser oxlint uses, so a comment, a string and code are told apart as oxlint tells them; a file oxc cannot parse is a finding. When a gent rule retires for an upstream one, its invalid lines stay in `packages/tooling/fixtures/held/`, each marked with the rule that holds it now, and `packages/tooling/tests/gent-rules.test.ts` lints them with the repo's own config. The TUI rule that a reactive scope tracks the session identity, not the record, is the oxlint rule `gent/no-tracked-session-record`.

## Test philosophy

- **Default is integration**: use `createRpcHarness` for extension RPC acceptance, `baseLocalLayer` for runtime integration, or `testSqliteStorage()` from the test utilities for focused storage behavior. Drop to raw `createE2ELayer` only for advanced host/profile wiring.
- **Pure unit tests only for pure functions**: reducers, formatters, schema transforms, context-estimation math.
- **Mock at system boundaries**: only the LLM via `LanguageModelLayers.sequence(...)`, `LanguageModelLayers.signal(...)`, or `LanguageModelLayers.debug()`. Use real services inside the boundary.
- **`Provider.Test()` / provider wrapper statics and `EventStore.Test()` are deleted** — use `LanguageModelLayers.sequence([...])` or `LanguageModelLayers.debug()` for model mocking, `EventStore.Memory` for in-memory event stores. `LanguageModelLayers` lives in `packages/core/src/test-utils/harness.ts`. The stream-part helpers (`textDeltaPart`, `toolCallPart`, `reasoningDeltaPart`, `finishPart`), the step builders (`textStep`, `toolCallStep`, `multiToolCallStep`) and the scripted model behind `LanguageModelLayers.debug()` and `Gent.provider.mock()` (`ScriptedLanguageModel`) live in `packages/core/src/runtime/provider.ts`. The scripted model plays a multi-step tool turn (real tools in the session cwd) for a message that holds `debug tools`. Tests outside core import them from `@gent/core/test-utils`.
- **Behavioral naming**: describe outcomes, not method calls. "missing auth key returns undefined", not "get returns undefined for missing key".
- **No `Effect.sleep` for state transitions** — use `Deferred`, `controls.waitForCall`, or `waitFor` polling helpers.

## Test gotchas

- **bun:sqlite** - Can't use vitest (runs in Node). Use `bun test` directly.
- **bun:test timeouts bypass Effect finalizers** - Always use `Effect.timeout` inside the Effect, shorter than the bun timeout, so scope finalizers run on timeout.
- **A failed extension fails the test** - Test roots stop with `Extensions failed to load: <id> (<scope>, <phase>): <reason>`. Fix the extension; set `allowFailedExtensions: true` only in a test about the failure report.
- **Integration tests: in-process first** - Prefer `createRpcClient(baseLocalLayer())` or `createRpcHarness(...)` from `@gent/core/test-utils`; `Gent.test` from `@gent/sdk` is for SDK and app tests. Only use subprocess workers for tests that specifically need process isolation (supervisor lifecycle, PTY).
- **Model catalog in tests** - Tests never reach models.dev, and the test preload refuses every request or connection to a host other than this machine. An in-process root takes `modelCatalogFixture` (a counting HTTP client that answers 304 to a current ETag) or `fixtureModelCatalog` (the parsed catalog, for a driver test with no server); a spawned gent sets `GENT_MODEL_CATALOG_URL` to the origin `serveModelCatalogFixture` returns, and an SDK `Gent.server` whose turns read the catalog gets that origin through a `ConfigProvider` layer. All come from `@gent/core/test-utils`.
- **Signal language model for lifecycle assertions** - Use `LanguageModelLayers.signal(reply)` for deterministic per-chunk control (thinking→streaming→idle). `controls.waitForStreamStart` then `controls.emitNext()/emitAll()`. Shared Queue gates all `streamText()` calls — multi-turn tests need multiple `emitAll()` rounds.
- **`LanguageModelLayers.debug({ delayMs })`** - The scripted model with a delay between chunks. Use `TestClock.layer()` from `effect/testing` + `TestClock.adjust()` to make delays instant in tests.
- **Test control flow** - Test files must not use `async`/`await`, Promise chains, raw Promise-returning test bodies, or hook cleanup patterns. Use `it.live` / `it.scopedLive`, `Effect.promise` only at real async boundaries, and scoped resources such as `makeTempDirectoryScoped`.

## Three-tier test taxonomy

| Tier           | Layer               | Exercises                       | Use for                           |
| -------------- | ------------------- | ------------------------------- | --------------------------------- |
| Pure reducer   | local reducer tests | State transitions, projections  | Pure state behavior               |
| Runtime        | `baseLocalLayer()`  | Real services and storage       | Supervisor, protocol, persistence |
| RPC acceptance | `createRpcHarness`  | Full RPC → runtime → reply path | Lifecycle, scope, schema, wiring  |

New extension tests should include at least one RPC acceptance test via `createRpcHarness` to catch scope lifetime bugs. Direct service tests are for behavior — they bypass the per-request scope boundary that production uses.

## Test layers

```typescript lint=test
import { Effect, Fiber, Schema, Stream } from "effect"
import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api"
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

// The tool the scripted model calls: a step may call only a registered tool
const echoExtension = defineExtension({
  id: "echo",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "tool",
      tool({
        id: "echo",
        description: "Echo the text back",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.String,
        execute: ({ text }) => Effect.succeed(text),
      }),
    )
  }),
})

export const acceptance = Effect.gen(function* () {
  // Sequence provider for deterministic LLM responses
  const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
    toolCallStep("echo", { text: "hello" }),
    textStep("Done."),
  ])
  // RPC acceptance harness (real per-request scopes)
  const { client, sessionId, branchId } = yield* createRpcHarness({
    agents: [testAgent],
    extensionInputs: [testTurnExtension, echoExtension],
    providerLayer,
  })
  // `send` returns at admission: subscribe first, then wait for the turn to end
  const turnCompleted = yield* client.session.events({ sessionId, branchId }).pipe(
    Stream.filter(({ event }) => event._tag === "TurnCompleted"),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped,
  )
  yield* client.message.send({ sessionId, branchId, content: "hi" })
  yield* Fiber.join(turnCompleted)
  yield* controls.assertDone
}).pipe(Effect.scoped, Effect.timeout("8 seconds"))
```

Core tests record the event sequence for assertions with `recordingEventStore(ref)` (the in-memory store that also keeps each published event, live chunks included, in a `Ref`), imported by relative path from `packages/core/src/test-utils/harness.ts`.

## Commands

| Command            | Scope                                                 |
| ------------------ | ----------------------------------------------------- |
| `bun run test`     | product behavior: core + tui + sdk + fast integration |
| `bun run test:e2e` | PTY e2e + focused server-process lifecycle coverage   |
| `bun run gate`     | typecheck + lint + fmt + build + test                 |

The history archive keeps the measured wall-clock times.

## Test structure

`packages/core/tests/` mirrors `packages/core/src/`. A test imports the modules it tests, and every other core module, by relative path into that source tree. A test that authors a fixture extension takes the authoring names (`defineExtension`, `tool`, `ExtensionHost`, …) from `@gent/core/extensions/api`, as any extension does; the entry resolves to the same source file (`packages/core/package.json`), so module identity is the same. `tests/extensions/api.test.ts` also reads the entry as the public surface it checks:

```text
tests/
├── domain/        # agent, agent-loop, capability, event, extension, message, ...
├── extensions/    # api
├── helpers/       # agent-loop (the actor test root), test-preset
├── runtime/       # agent-loop, config, extension-host, model-context, provider, session, tools, turn, ...
├── server/        # hosted-storage, interaction, rpc, server, workspace-rpc
├── storage/       # schema, storage
└── test-utils/    # index (the harness entry and its scripted models)
```

One test file per source file. No god tests. Names match source owners.

`packages/e2e/tests/` holds only the slow end-to-end suite; in-process contract tests live in each package's `test` task:

- `test:e2e` — PTY TUI tests, focused server-process lifecycle coverage, and machine runs across a SIGKILL of their host

## Important files

- `packages/core/src/test-utils/harness.ts` — `recordingEventStore`, the
  in-memory event store that keeps each published event in a `Ref`;
  `baseLocalLayer`, a production-root preset over
  `createDependencies` with in-memory SQLite, storage-backed events, debug
  providers, and test service overrides; `createE2ELayer`, a preset that keeps
  real `ToolRunner.Live`, extension setup/resource startup, event publishing,
  and interaction recovery while expressing test
  storage/provider/auth/approval differences through dependency overrides; and
  `createRpcHarness`, the thin RPC acceptance helper that chains
  `createE2ELayer` → `createRpcClient` (the in-process RPC client,
  `makeInProcessClient` in `packages/core/src/server/server.ts`) → seeded
  `session.create`. The same file holds `LanguageModelLayers` (`debug`, `sequence`,
  `signal`, `failing`), `waitFor` and the temp-directory, port and
  worker-environment fixtures; the step and stream-part helpers live in
  `packages/core/src/runtime/provider.ts`.
- `apps/tui/tests/render-harness-boundary.tsx` — TUI render test harness
