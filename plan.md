# Effect LSP Cleanup Plan

## Batch 0 — Honest patched typecheck

- make patched TS run every time
- include `tsconfig.lsp.json` in turbo inputs

Status: done

## Batch 1 — Hard errors

- fix `overriddenSchemaConstructor`
- fix `anyUnknownInErrorContext` in `agent-loop*`

Status: done

## Batch 2 — Shared generic hook typing

- fix runtime extension hook generics so downstream callers stop widening to `unknown`

Status: done

## Batch 3 — Workflow error channels

- fix `runLoop` typing so workflow tools stop inheriting `any`

Status: done

## Batch 4 — Node builtin imports

- replace `node:fs` / `node:path` uses with Effect `FileSystem` / `Path` where the abstraction is actually correct
- keep scope to real warning sites

Status: done

Targets:

- `packages/core/src/domain/output-buffer.ts`
- `packages/core/src/runtime/logger.ts`
- `packages/core/src/runtime/telemetry.ts`
- `packages/core/src/runtime/tracer.ts`
- `packages/core/src/server/index.ts`
- `packages/core/src/tools/librarian.ts`
- `packages/core/src/tools/repo-explorer.ts`

## Batch 5 — Deterministic keys

- normalize service/tag ids to full deterministic paths

Status: done

## Batch 6 — Mechanical Effect style warnings

- `Effect.succeed(undefined)` -> `Effect.void`
- `Effect.fn` opportunities
- `unnecessaryEffectGen`
- `tryCatchInEffectGen`
- `preferSchemaOverJson` where worth fixing

Status: done

## Batch 7 — Final pass

- rerun patched typecheck/lint/test
- promote or suppress remaining diagnostics deliberately

Status: done
