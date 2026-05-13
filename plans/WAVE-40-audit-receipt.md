# Wave 40 audit receipt

## Frame

- **Wave plan**: `plans/WAVE-40.md`
- **Start**: `98fd176c` (`docs(plan): open wave 40`)
- **Closure HEAD**: `e41d8a9a` (`fix(runtime): close wave 40 audit blockers`)
- **Gate**: `bun run gate` passed at `e41d8a9a`
- **Rule applied**: W40 closes here. No recursive W41 is opened in this task.

## Tally

| Lane                               | Result           | Disposition                                                          |
| ---------------------------------- | ---------------- | -------------------------------------------------------------------- |
| L1 - Effect simplification         | No P0/P1; 7 P2   | P2 ride-along bucket                                                 |
| L2 - Actor + wide-event boundaries | No P0/P1         | Clean                                                                |
| L3 - Schema / storage integrity    | 2 P1, 3 P2       | P1 fixed in `e41d8a9a`; P2 bucket                                    |
| L4 - Public API ceremony           | 2 P1, 2 P2       | P1 fixed in `e41d8a9a`; P2 bucket                                    |
| L5 - Test taxonomy                 | 2 P1, 2 P2       | P1 fixed / satisfied in `e41d8a9a`; P2 bucket                        |
| L6 - File cohesion                 | No P0/P1; 6 P2   | P2 ride-along bucket                                                 |
| L7 - Ctx-as-param leaks            | 4 broad P1, 2 P2 | Reclassified as residual architecture work; not W40 closure blockers |
| L8 - Yield-don't-thread            | 4 broad P1, 2 P2 | Reclassified as residual architecture work; not W40 closure blockers |
| L9 - Composable-method demotions   | 1 P1, 5 P2       | P1 fixed in `e41d8a9a`; P2 bucket                                    |

## W40 Closure Verification

- `bun run typecheck` passed before the closure batch.
- Focused tests passed: `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/extensions/tests/session-tools/session-tools-rpc.test.ts packages/extensions/tests/todo/todo-storage.test.ts packages/sdk/tests/server-lock.test.ts packages/core/tests/server/session-queries.test.ts packages/core/tests/storage/sqlite-session-storage.test.ts packages/core/tests/storage/sqlite-branch-storage.test.ts packages/core/tests/storage/sqlite-message-storage.test.ts`
- Full gate passed: `bun run gate`
- Pre-commit gate passed for `e41d8a9a`.

## P0 Findings

None.

## P1 Findings By Lane

### L3 - Schema / Storage Integrity

- **Fixed**: Storage hydration could still defect through sync `dateFromMillis` during durable row decode. Row hydration now uses Effect-channel `decodeDateFromMillis`.
  - `/Users/cvr/Developer/personal/gent/packages/core/src/domain/message.ts`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite/rows.ts`
- **Fixed**: Todo durable reads coerced invalid `status` to `pending` and dropped invalid metadata. Todo rows now decode through Schema, invalid status/metadata fails loudly, and tests lock both paths.
  - `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo-storage.ts`
  - `/Users/cvr/Developer/personal/gent/packages/extensions/tests/todo/todo-storage.test.ts`

### L4 - Public API Ceremony

- **Fixed**: `RpcHandlersContext` no longer leaves the SDK root public surface; the e2e harness derives the type from core-internal test wiring.
  - `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts`
  - `/Users/cvr/Developer/personal/gent/packages/e2e/tests/transport-harness-boundary.ts`
- **Fixed**: `@gent/sdk/server-lock` public subpath was removed. Server-lock internals moved under core-internal, and TUI/SDK internals import that owner directly.
  - `/Users/cvr/Developer/personal/gent/packages/core/src/server/server-lock.ts`
  - `/Users/cvr/Developer/personal/gent/packages/sdk/package.json`
  - `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts`
  - `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`

### L5 - Test Taxonomy

- **Fixed**: `session.getSnapshot` no longer reaches into `AgentLoop` from server query code. Runtime state read is now a `SessionRuntime.getState` boundary.
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`
  - `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-queries.test.ts`
- **Satisfied**: Session tools now have model-turn RPC acceptance coverage through the per-request host facet path.
  - `/Users/cvr/Developer/personal/gent/packages/extensions/tests/session-tools/session-tools-rpc.test.ts`

### L7 / L8 - Residual Architecture Findings

The L7/L8 agents labeled several broad, pre-existing architecture seams as P1:

- `MakeExtensionHostContextDeps` / host facade construction still carries a service bag.
- `capabilityContext?: Context.Context<never>` remains data on profile/host records.
- RPC registry dispatch still receives an invocation context.
- External driver tool execution still exposes a callback/context bridge.
- Agent-loop build context and Anthropic capability IO closures still have context-capture shapes.

These are valid architecture pressure points, but they are not accepted as W40 closure blockers: they are larger than the concrete W40 closure diff, overlap already-known remaining design seams, and would require another wave-sized redesign. They remain residual architecture work, not a reason to tail-extend W40.

### L9 - Composable-Method Demotions

- **Fixed**: server snapshot query actor command wrapper removed by moving state read behind `SessionRuntime.getState`.
  - `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`
  - `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`

## P2 Ride-Along Bucket

- Effect trace naming / simplification around approval service, process runner, Anthropic keychain client, agent-loop handler nesting, and a dead message clone.
- File cohesion candidates: lint plugin, TUI client context/main/session controller, session runtime, agent-loop handlers.
- Durable integrity candidates: auto journal replay, agent-loop queue FK coverage, background bash row decode.
- Public ceremony candidates: server-lock lifecycle split, `AuthOauth` / `PermissionResult` exports.
- Test naming candidates in Anthropic keychain transform and host-facet survivor tests.
- Composable-method candidates: `DriverRegistry` map reads, `listSlashCommands`, `resolveDriverToolSurface`, process execution free function, `EventPublisher.append` / `deliver`.

## Disposition

W40 is closed at `e41d8a9a`. The accepted closure-blocking P1 findings were fixed and gated. No P0 remains. No W41 is opened from this task.
