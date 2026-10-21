# Testing

Use the smallest honest boundary:

- pure helpers: unit tests
- transport/app services: Effect tests
- TUI render/capture: OpenTUI renderer tests
- runtime ordering/turn semantics: recording layers + runtime tests

**Banned test primitives**: `Provider.Test`, provider-wrapper statics, and `EventStore.Test` are deleted. Use `LanguageModelLayers.debug()` / `LanguageModelLayers.sequence([...])` from `@gent/core/test-utils` for model mocking and `EventStore.Memory` for in-memory event stores.

**A scripted model checks its own script**: `controls.assertDone` on a
`LanguageModelLayers.sequence` dies when a step's `assertOptions` or
`assertRequest` check failed, not only when steps are left. The failed check
also fails its model call, which a turn reads as a provider error and goes
past, so only `assertDone` makes the test fail on it.

**Banned test control flow**: test files do not use `async`/`await`, Promise chains, raw Promise-returning test bodies, or hook cleanup patterns. Use `it.live` / `it.scopedLive` and scoped Effect resources so finalizers run under the test runtime.

**Names describe behavior**: active test modules are behavior-named. Historical process names belong only in `plans/` and dated audit receipts; a guard (`findProcessNames` in `packages/tooling/src/guards.ts`) refuses a ledger id or a pass name in source and tests.

**Lint strength never drops**: the guards read source through `oxc-parser`, the parser oxlint uses, so a comment, a string and code are told apart as oxlint tells them; a file oxc cannot parse is a finding. When a gent rule retires for an upstream one, its invalid lines stay in `packages/tooling/fixtures/held/`, each marked with the rule that holds it now, and `packages/tooling/tests/gent-rules.test.ts` lints them with the repo's own config. The TUI rule that a reactive scope tracks the session identity, not the record, is the oxlint rule `gent/no-tracked-session-record`.

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

- `test:e2e` — PTY TUI tests and focused server-process lifecycle coverage

## Important files

- `packages/core/src/test-utils/harness.ts` — `recordingEventStore`, the
  in-memory event store that keeps each appended event in a `Ref`;
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
