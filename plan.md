# Gent review TODO

## Findings (refs)

- [x] Tool execution/permission/error handling duplicated -> centralize ToolRunner (refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/agent-actor.ts`)
- [x] Tool registry linear lookup + register no-op -> Map registry (refs: `packages/core/src/tool.ts`)
- [x] Tool output stringify/summarize duplicated -> core util (refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/sdk/src/client.ts`)
- [x] Tool schema rebuilt per call -> cache per tool set (refs: `packages/providers/src/provider.ts`)
- [x] Message list reload per loop -> cache + append (refs: `packages/runtime/src/agent/agent-loop.ts`, `packages/runtime/src/agent/agent-actor.ts`)
- [x] Permission rules rebuild/regex per check -> precompile + return copy (refs: `packages/core/src/permission.ts`)
- [x] Per-tool spinner intervals -> shared clock (refs: `apps/tui/src/components/message-list.tsx`)
- [x] Tool render read output ignores truncated flag -> parse output (refs: `apps/tui/src/components/tool-renderers/read.tsx`)
- [x] Tools missing concurrency hint -> declare serial/parallel (refs: `packages/tools/src/*.ts`)
- [x] Keep bypass default as-is (refs: `packages/runtime/src/config-service.ts`)

## Plan (executed)

- [x] Add ToolRunner service + wire runtime/server
- [x] Add tool concurrency defaults + serial semaphore in loops
- [x] Move tool output formatting to core
- [x] Reduce storage IO via message caching
- [x] Simplify provider streaming + tool schema cache
- [x] TUI spinner clock + read renderer fix

## Tests

- [x] Add ToolRunner failure -> error ToolResultPart test (refs: `tests/runtime.test.ts`)
- [x] Run full gate: `bun run typecheck`, `bun run lint`, `bun run test`
- [x] Add concurrency ordering test (refs: `tests/runtime.test.ts`)
