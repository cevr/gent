# Planify: Wave 30 - Extension Authoring And Actor Idempotency Closure

## Context

Wave 29 closed the narrow extension-authority audit, but the broader recursive
simplicity audit still found P1s. The remaining issues share one shape: Gent is
still carrying more authoring/runtime vocabulary than the product needs.

The north star for this wave is smaller, stricter, and more Effect-native:

- extension authors write ordinary Effect code and `yield* ExtensionContext`;
- requests/actions/tools receive decoded params only;
- builtins are only the starting extension set, not a privileged API lane;
- actor-visible mutating operations carry durable public request identity;
- platform/process ownership stays at explicit host edges;
- file splits earn their existence.

## Scope

**In**

- Remove the remaining `ctx` parameter authoring path from requests/actions.
- Remove public `CapabilityContext` / `CapabilityCoreContext` exports and any
  residual read/write/capability vocabulary that exists only as authority
  metadata.
- Preserve one authoring pattern: `yield* ExtensionContext`, with host-provided
  facades over private runtime things.
- Tighten shipped extension boundaries so `packages/extensions/src` cannot
  import `@gent/core-internal`.
- Expose only the narrow stable primitives needed for shipped/user extensions
  through `@gent/core/extensions/api`, then migrate builtins to that API.
- Add durable request ids to `steer.command` and `queue.drain`.
- Move actor command identity for retryable mutating operations to deterministic
  public request ids and cover duplicate/retry behavior through public APIs.
- Fix platform leaks where extension setup or executor sidecars bypass the
  configured host process boundary.
- Continue the file-merit lane for small wrapper files and single-use helpers.
- Fold upstream-owned library simplifications into the wave where they reduce
  Gent code or duplicate Effect identity risk.

**Out**

- Feature removal.
- Reintroducing a builtin/private extension class.
- Splitting public extension authoring into separate read/write APIs.
- Reintroducing `effect-machine` around the AgentLoop.
- Compatibility shims for removed private/ctx-parameter APIs.

## Constraints

- Correctness over pragmatism.
- No compatibility lane for old private extension APIs.
- High-blast-radius changes must be sub-committed with gates between logical
  units.
- Mechanical migrations after one worked example should be delegated.
- Runtime/actor batches run `bun run test:e2e` in addition to `bun run gate`.
- TUI/transport batches run `bun run smoke` where behavior crosses the client.

## Gate Command

- Standard: `bun run gate`
- Actor/runtime/storage: `bun run test:e2e`
- TUI/transport: `bun run smoke`
- Upstream owned libraries: run the upstream repo gate, then refresh Gent and
  run Gent focused checks plus `bun run gate`.

## Audit Receipts

Principles:

- `/Users/cvr/.brain/principles/never-block-on-the-human.md`
- `/Users/cvr/.brain/principles/redesign-from-first-principles.md`
- `/Users/cvr/.brain/principles/subtract-before-you-add.md`
- `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`
- `/Users/cvr/.brain/principles/use-the-platform.md`
- `/Users/cvr/.brain/principles/small-interface-deep-implementation.md`
- `/Users/cvr/.brain/principles/boundary-discipline.md`
- `/Users/cvr/.brain/principles/composition-over-flags.md`
- `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md`
- `/Users/cvr/.brain/principles/test-through-public-interfaces.md`

Current Gent evidence:

- `/Users/cvr/Developer/personal/gent/PLAN.md`
- `/Users/cvr/Developer/personal/gent/AGENTS.md`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/docs/extensions.md`
- `/Users/cvr/Developer/personal/gent/README.md`
- `/Users/cvr/Developer/personal/gent/package.json`
- `/Users/cvr/Developer/personal/gent/bun.lock`
- `/Users/cvr/Developer/personal/gent/packages/extensions/package.json`
- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts`
- `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts`
- `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/tooling/fixtures/no-bun-outside-adapter.invalid.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/steer.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.commands.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.session-governance.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/host-platform.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/loader.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts-protocol.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/index.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/read-service.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/edit.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo-service.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/platform-adapter.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/sidecar.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/services/child-session-tracker.ts`

External/reference evidence:

- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/Context.ts`
- `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/effect/src/unstable/ai/Tool.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts`
- `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/README.md`
- `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/specs/tui-plugins.md`
- `/Users/cvr/Developer/personal/effect-encore/src/actor.ts`
- `/Users/cvr/Developer/personal/effect-encore/src/actor-state.ts`
- `/Users/cvr/Developer/personal/effect-encore/package.json`
- `/Users/cvr/Developer/personal/effect-machine/src/actor.ts`
- `/Users/cvr/Developer/personal/effect-machine/src/cluster/to-entity.ts`
- `/Users/cvr/Developer/personal/effect-machine/src/cluster/entity-machine.ts`
- `/Users/cvr/Developer/personal/effect-machine/package.json`
- `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts`
- `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts`
- `/Users/cvr/Developer/personal/effect-wide-event/package.json`

## Findings To Close

### P1: Extension authoring still has two models

Requests/actions still receive `ctx`, while tools use Effect services. Public
exports still include `CapabilityContext` and `CapabilityCoreContext`.

Evidence:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:95`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:111`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts:97`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:195`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:58`

### P1: Shipped extensions still use a private import lane

Docs say shipped/project/user extensions share the same contract, but
`packages/extensions/src` imports `@gent/core-internal` and the guard permits
that dependency.

Evidence:

- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:313`
- `/Users/cvr/Developer/personal/gent/docs/extensions.md:55`
- `/Users/cvr/Developer/personal/gent/README.md:70`
- `/Users/cvr/Developer/personal/gent/packages/extensions/package.json:30`
- `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts:397`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts:22`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts:4`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts-protocol.ts:3`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/artifacts/index.ts:10`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:27`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/read-service.ts:7`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/edit.ts:3`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/fs-tools/write.ts:3`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo-service.ts:3`

### P1: Mutating actor operations lack public durable identity

`steer.command` and `queue.drain` generate random actor command ids inside
`SessionRuntime`, so a retry can become a second mutation or a different drain
result.

Evidence:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/steer.ts:14`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:117`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:264`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:267`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:715`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:776`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:295`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:324`

### P1: Platform process authority leaks around setup/sidecars

Public setup is facts-only, but shipped setup compensates by yielding
`GentPlatform`/`ChildProcessSpawner`; executor sidecar signaling uses
`process.kill` instead of the configured host signal function.

Evidence:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/host-platform.ts:39`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/loader.ts:254`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:245`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts:274`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts:230`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/platform-adapter.ts:37`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/sidecar.ts:464`

## Commit 1: docs(plan): promote wave 30 audit findings

**Justification**: Wave 29 is clean only for its narrow final lane. The active
plan must reflect the broader P1 findings before implementation continues.

**Principles**

- `never-block-on-the-human`: proceed with the next wave once audits find P1s.
- `redesign-from-first-principles`: encode the intended authoring model before
  mechanical migration.

**Changes**

| File                                                  | Change                                                   |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/PLAN.md`          | Point active work to Wave 30 and its continuation rules. |
| `/Users/cvr/Developer/personal/gent/plans/WAVE-30.md` | Add the commit-batched plan and recursive audit lane.    |

**Verification**

- `bun run fmt:check`

## Commit 2: refactor(extensions): make requests and actions params-only

**Status**: Completed in current batch.

**Justification**: Extension code should not receive facts by parameter in one
leaf kind and services by Effect context in another. The only authoring model is
ordinary Effect code using `yield* ExtensionContext`.

**Principles**

- `small-interface-deep-implementation`: one deep context service beats several
  shallow parameter/capability contexts.
- `subtract-before-you-add`: delete the ctx-parameter lane before reshaping
  public exports.

**Changes**

| File                                                                                  | Change                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts`           | Remove public `CapabilityContext` as an authoring concept or reduce it to private runtime plumbing.           |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts`   | Change `execute` to params-only and preserve request intent only if it names product behavior, not authority. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/action.ts`    | Change `execute` to params-only.                                                                              |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`              | Stop exporting capability context types.                                                                      |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts` | Provide `ExtensionContext` around request/action execution instead of threading ctx into handlers.            |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`         | Dispatch through the registry without exposing handler ctx to authors.                                        |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/**/*.ts`                  | Migrate shipped request/action handlers to `yield* ExtensionContext`.                                         |

**Worked example**

Before:

```typescript
request({
  id: "todo.list",
  intent: "read",
  execute: (_input, ctx) => ctx.storage.get(...)
})
```

After:

```typescript
request({
  id: "todo.list",
  intent: "read",
  execute: (_input) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      return yield* ctx.Session.getDetail(ctx.sessionId)
    }),
})
```

**Verification**

- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/extensions/extension-surface-locks.test.ts packages/core/tests/extensions/capability-host.test.ts packages/core/tests/server/extension-commands-rpc.test.ts`
- `bun run typecheck`
- `bun run lint`
- `bun run gate`

## Commit 3: refactor(extension-api): remove private shipped-extension imports

**Status**: Completed in current batch. Code imports and the package manifest are
clean of `@gent/core-internal` under `packages/extensions`; the guardrail now
fails shipped extension source that imports it. Broader docs are left to the
extension-context/API collapse batch so the contract is documented after the
facade shape is final.

**Justification**: If builtins need a primitive, user/project extensions should
either get the same stable primitive or the design should move behind a host
service. `@gent/core-internal` in shipped extensions is a privileged lane.

**Principles**

- `boundary-discipline`: one extension import contract for shipped, project,
  and user extensions.
- `make-impossible-states-unrepresentable`: lint must make private imports
  impossible, not merely discouraged.

**Changes**

| File                                                                                            | Change                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/lint/no-direct-env.ts`                                      | Ban `@gent/core-internal` in `packages/extensions/src`.                                                                                                                                           |
| `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts` | Add/adjust expectations for the stricter extension import guard.                                                                                                                                  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/package.json`                           | Remove `@gent/core-internal`.                                                                                                                                                                     |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                        | Export stable ids/types/helpers actually needed by shipped extensions, such as `ArtifactId`, guards, output helpers, and file-lock/file-index facades only if they are real extension primitives. |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/**/*.ts`                            | Replace internal imports with public API imports or local extension-owned implementations.                                                                                                        |
| `/Users/cvr/Developer/personal/gent/docs/extensions.md`                                         | Update the authoring contract after code matches it.                                                                                                                                              |
| `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`                                            | Keep the no-private-lane statement and update the inventory.                                                                                                                                      |

**Verification**

- `rg -n '@gent/core-internal' packages/extensions/src packages/extensions/package.json`
- `bun run lint`
- `bun run typecheck`
- `bun run gate`

## Commit 4: refactor(extensions): collapse authority vocabulary into ExtensionContext

**Status**: Completed in current batch. Public `ReadOnly` branding and
`withReadOnly` helpers are deleted; read-intent authority now comes from the
host-provided `ExtensionContext` facade. Extension-owned read services remain
ordinary small Effect services instead of branded capability services.

**Justification**: The user-facing API should not ask authors to model access
control with `capability`, `needs`, `read`, or `write` ceremony. The host owns
which facade implementation is provided at each runtime boundary.

**Principles**

- `composition-over-flags`: real behavior comes from provided services, not
  author-declared flags.
- `use-the-platform`: Effect context is already the capability system.

**Changes**

| File                                                                                                | Change                                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`                 | Keep one public `ExtensionContext` accessor service; move any read-only enforcement vocabulary behind runtime-private host provisioning. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/read-only.ts`                          | Delete or reduce once no public authoring path consumes read-only capability context.                                                    |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`                 | Provide the appropriate `ExtensionContext` implementation without exposing capability context.                                           |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts`       | Remove read/write/capability projection helpers that only exist for old handler parameters.                                              |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/tool-runner.test.ts`                | Replace tests that intentionally compile forbidden read operations with public behavior tests for the provided facade.                   |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-surface-locks.test.ts` | Lock the single authoring API: params-only leaves plus `yield* ExtensionContext`.                                                        |

**Verification**

- `rg -n 'CapabilityContext|CapabilityCoreContext|readOnlyCapabilityContext|ToolNeeds|needs|read/write' packages/core/src packages/extensions/src docs README.md ARCHITECTURE.md`
- Focused extension surface tests.
- `bun run gate`

## Commit 5: fix(runtime): make steer and queue drain retry-safe

**Status**: Completed in current batch. `steer.command` and `queue.drain`
now require public request ids; `SessionRuntime` derives actor command ids from
those ids instead of random runtime ids. `DrainQueue` is persisted so retried
drains replay the original snapshot, and steering interjections use deterministic
message ids plus queue de-duplication for at-most-once display.

**Justification**: Mutating public operations need durable operation identity at
the public boundary. Actor primary keys cannot be random inside
`SessionRuntime`.

**Principles**

- `test-through-public-interfaces`: retry behavior should be locked through
  transport/runtime tests, not private actor metadata.
- `composition-over-flags`: actor operation identity is part of the operation,
  not an incidental runtime side map.

**Changes**

| File                                                                                     | Change                                                                                                                |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/steer.ts`                   | Add `requestId` to mutating steer payloads or wrap the command in a request envelope.                                 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`      | Add a request id to `queue.drain`.                                                                                    |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`            | Thread request ids into `SessionRuntime`.                                                                             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`        | Derive actor `commandId` from public request ids and stop calling `platform.randomId` for retryable public mutations. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts` | Mark retryable mutating ops persisted where completion semantics require it.                                          |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`                     | Generate/stash request ids at the client call boundary.                                                               |
| Runtime/RPC tests                                                                        | Duplicate `Interject` creates one interjection; retried `queue.drain` returns the original drained snapshot.          |

**Verification**

- Focused actor/runtime idempotency tests.
- `bun run test:e2e`
- `bun run smoke`
- `bun run gate`

## Commit 6: refactor(platform): keep process authority at host edges

**Status**: Completed in current batch. Runtime setup now receives the
host-owned process facade; `defineExtension` continues to expose setup facts.
Anthropic and executor adapters reuse `ctx.host` for env/process/signal work,
and the duplication guard now catches `process.kill` outside platform roots.

**Justification**: Shipped setup code should not rebuild platform access through
`GentPlatform` or raw Bun/Node. If setup needs process authority, it should get
it from a host-provided internal service or be moved to runtime resources.

**Principles**

- `use-the-platform`: route process execution/signaling through the configured
  platform services.
- `boundary-discipline`: public setup remains facts-only; host process
  authority is an implementation service, not a public extension privilege.

**Changes**

| File                                                                                            | Change                                                                                    |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/host-platform.ts`      | Keep the single host process adapter.                                                     |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/loader.ts`             | Provide any internal host setup services through Effect context, not setup object fields. |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts`                 | Stop yielding `GentPlatform` for setup env/process work.                                  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/index.ts`                | Stop yielding `GentPlatform` for setup env/process work.                                  |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/executor/platform-adapter.ts`       | Use `host.signalPid`, not `process.kill`.                                                 |
| `/Users/cvr/Developer/personal/gent/packages/tooling/src/platform-duplication-guards.ts`        | Ban raw `process.kill` outside platform roots.                                            |
| `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts` | Assert `process.kill` is caught.                                                          |

**Verification**

- Focused Anthropic/ACP/executor tests.
- `bun run lint`
- `bun run gate`

## Commit 7: refactor(schema): retire TaggedEnumClass from shipped extension leaves

**Status**: Completed by earlier Wave 30 batches. `packages/extensions/src` no
longer imports `TaggedEnumClass` or `schema-tagged-enum-class`; the remaining
uses are persisted core/domain schemas, SDK/TUI local state, tests for the
helper itself, and a public-surface negative lock.

**Justification**: `TaggedEnumClass` is a large local schema dialect. It should
not be needed in shipped extensions once those extensions no longer import
internals.

**Principles**

- `use-the-platform`: prefer Effect Schema primitives.
- `subtract-before-you-add`: start with non-persisted extension-local unions
  before touching domain wire events.

**Changes**

| File                                                                                      | Change                                                                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/**/*.ts`                      | Replace `TaggedEnumClass` with `Schema.TaggedStruct` / `Schema.Union` for extension-local types. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/schema-tagged-enum-class.ts` | Keep only if still needed by persisted core domain types; otherwise delete.                      |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                  | Do not export `TaggedEnumClass` publicly.                                                        |

**Verification**

- Focused extension tests for migrated protocols.
- `bun run typecheck`
- `bun run gate`

## Commit 8: refactor(files): collapse wrapper files that do not earn existence

**Status**: Completed in current batch.

**Justification**: File count is architectural surface. Tiny single-import
wrappers and naming-only `index.ts` files slow readers down without protecting a
boundary.

**Principles**

- `subtract-before-you-add`: remove unnecessary splits before further
  abstraction.
- `small-interface-deep-implementation`: bigger cohesive files are preferable
  when the split encodes no boundary.

**Initial candidates**

| File                                                                                   | Reason to audit                                |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/theme/index.ts`                       | 7-line wrapper.                                |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/file-url.ts`                    | 11-line single helper.                         |
| `/Users/cvr/Developer/personal/gent/packages/sdk/src/transport-headers.ts`             | 14-line helper.                                |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/projection-error.ts`      | 7-line error leaf.                             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/guards.ts`                | 16-line helper currently leaked to extensions. |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/runtime-environment.ts`  | 18-line environment wrapper.                   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/run-with-built-layer.ts` | 20-line wrapper.                               |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/audit/index.ts`            | 24-line extension wrapper.                     |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/index.ts`       | 33-line extension wrapper.                     |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/index.ts`        | 36-line extension wrapper.                     |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/index.ts`           | 39-line extension wrapper.                     |

**Audit result**

| File                                                                                   | Result                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/file-url.ts`                    | Deleted. The helpers were used only by file tool renderers and their own test, so they now live with `apps/tui/src/utils/file-refs.ts`.                               |
| `/Users/cvr/Developer/personal/gent/apps/tui/tests/file-url.test.ts`                   | Deleted. Assertions moved into `apps/tui/tests/file-refs.test.ts`.                                                                                                    |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/theme/index.ts`                       | Kept. It is the TUI theme entrypoint used by app setup, routes, and renderers.                                                                                        |
| `/Users/cvr/Developer/personal/gent/packages/sdk/src/transport-headers.ts`             | Kept. It centralizes SDK workspace identity for both client and server transport paths and has direct SDK behavior tests.                                             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/projection-error.ts`      | Kept. It is a public extension projection failure type exported through `@gent/core/extensions/api`.                                                                  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/guards.ts`                | Kept. It is a small but shared boundary guard module consumed by core, TUI, and shipped extensions.                                                                   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/runtime-environment.ts`  | Kept. It is a high-fan-in runtime service Tag used by server, runtime services, and tests.                                                                            |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/run-with-built-layer.ts` | Kept. It is the shared runtime layer execution helper used by both `SessionProfileCache` and child agent runs; moving it into either caller would create worse drift. |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/audit/index.ts`            | Kept. It is a shipped extension entrypoint consumed by the extension preset and builtin agent registry.                                                               |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/index.ts`       | Kept. It is a shipped extension entrypoint consumed by the extension preset.                                                                                          |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/librarian/index.ts`        | Kept. It exports both the shipped extension and `GitReader` test/integration fixture service.                                                                         |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/skills/index.ts`           | Kept. It is a shipped extension entrypoint consumed by the extension preset and skills RPC tests.                                                                     |

**Verification**

- Import fan-in/fan-out audit for each candidate.
- `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots apps/tui/tests/file-refs.test.ts`
- `bun run typecheck`
- `bun run gate`

## Commit 9: build(effect-wide-event): make effect peer-only

**Status**: Completed in current batch.

**Justification**: Owned Effect libraries should not risk duplicate Effect
identity. `effect-wide-event` should match `effect-machine` and
`effect-encore`.

**Principles**

- `use-the-platform`: one Effect runtime identity.
- `boundary-discipline`: owned packages should keep dependency contracts
  consistent.

**Changes**

| File                                                                           | Change                                                                                                 |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `/Users/cvr/Developer/personal/effect-wide-event/package.json`                 | Moved `effect` from runtime dependencies to dev dependencies while keeping it peer-only for consumers. |
| `/Users/cvr/Developer/personal/effect-wide-event/README.md`                    | Documented peer-only Effect installation and development contract.                                     |
| `/Users/cvr/Developer/personal/effect-wide-event/.changeset/soft-boxes-tap.md` | Added patch changeset for the peer-only runtime identity fix.                                          |
| `/Users/cvr/Developer/personal/gent/bun.lock`                                  | Refreshed local file dependency metadata after upstream package change.                                |

**Verification**

- Upstream `bun run gate`.
- Gent `bun install`.
- Gent `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/wide-event-boundary.test.ts packages/core/tests/runtime/session-runtime-context.test.ts`
- Gent `bun run gate`.

## Commit 10: feat(effect-encore): absorb actor activation ceremony

**Status**: Completed in current batch.

**Justification**: Gent should not define no-op actor operations just to make
cold state reads possible.

**Principles**

- `use-the-platform`: push actor lifecycle primitives into the owned actor
  library when they are generic.
- `small-interface-deep-implementation`: one actor helper is better than every
  consumer defining an `EnsureStarted` operation.

**Changes**

| File                                                                                     | Change                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/effect-encore/src/actor.ts`                               | Added a hidden activation operation used by `getState`/`watchState` to materialize cold entities without exposing a public handle. |
| `/Users/cvr/Developer/personal/effect-encore/v3/src/actor.ts`                            | Mirrored hidden activation behavior for the v3 surface.                                                                            |
| `/Users/cvr/Developer/personal/effect-encore/test/actor-state.test.ts`                   | Covered cold `getState` and `watchState` materialization.                                                                          |
| `/Users/cvr/Developer/personal/effect-encore/v3/test/actor-state.test.ts`                | Mirrored the v3 materialization regression tests.                                                                                  |
| `/Users/cvr/Developer/personal/effect-encore/README.md`                                  | Documented that cold state reads materialize automatically.                                                                        |
| `/Users/cvr/Developer/personal/effect-encore/.changeset/sharp-actors-happen.md`          | Added a minor changeset for actor state materialization.                                                                           |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts` | Deleted Gent's public `EnsureStarted` actor operation.                                                                             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`        | Removed explicit materialization effects from `getState`/`watchState` and respond-interaction wakeup.                              |

**Verification**

- Upstream `bun run gate`.
- Gent `bun test --preload ./packages/tooling/src/test-log-preload.ts --reporter=dots packages/core/tests/runtime/session-runtime.test.ts packages/core/tests/runtime/session-runtime-context.test.ts packages/core/tests/runtime/agent-loop-streaming.test.ts packages/core/tests/runtime/agent-loop-queue.test.ts`
- Gent `bun run test:e2e`
- Gent `bun run gate`

## Commit 11: refactor(tui): use Effect subscription primitives for child sessions

**Status**: Completed in current batch.

**Justification**: `Ref + PubSub` manual publishing reimplements a reactive
store. `SubscriptionRef` is the Effect primitive for snapshot plus changes.

**Principles**

- `use-the-platform`: prefer Effect primitives over local mini-runtimes.
- `subtract-before-you-add`: delete manual publish bookkeeping.

**Changes**

| File                                                                                | Change                                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/services/child-session-tracker.ts` | Replaced manual `Ref`/`PubSub` change publishing with `SubscriptionRef` snapshot state.                 |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-child-sessions.ts`       | Consumes full tracker snapshots directly instead of interpreting added/updated/removed deltas.          |
| `/Users/cvr/Developer/personal/gent/apps/tui/tests/child-session-tracker.test.ts`   | Added coverage for the snapshot stream contract while preserving the interleaved-completion regression. |

**Verification**

- `bun test --preload ../../packages/tooling/src/test-log-preload.ts --preload ./node_modules/@opentui/solid/scripts/preload.ts --reporter=dots tests/child-session-tracker.test.ts`
- `bun run typecheck`
- `bun run smoke`
- `bun run gate`

## Final Batch: Independent Recursive Audit

**Status**: Completed. Independent audit found no P0, but found P1s. Wave 30
does not close; findings are synthesized into
`/Users/cvr/Developer/personal/gent/plans/WAVE-31.md`.

1. How can we simplify and minimize our codebase while maintaining features? how can we reduce code as much as possible? are we using effect properly? are we redeclaring types, schemas, features that effect natively provides via effect/unstable/ai or STM with txQueue etc?
2. are we following the actor model properly?
3. are we using bun/node platform code directly and not creating service layers for maximum portability and testability? GentPlatform etc?
4. is our extension system as minimal yet expressive as can be? compared to other harnesses that i mentioned - expressive enough to implement our current extensions, but more minimal? rearchitetcing completely is acceptable. this codebase is experimental, complete rerwites are fine of our schemas, types, assumptions - correctness, minimalism, is the goal within the effect ecosystem.
5. we own effect-machine, effect-encore, effect-wide-event - can we improve these upstream so that DX is better? are there other libraries we can make to abstract certain concepts that better align with our north star (actor model).
6. do files merit their existence? prefer bigger cohesive files when a split does not encode a real boundary, public entrypoint, platform boundary, independently testable domain, generated fixture, or meaningful multi-import reuse.
7. does the extension authoring experience follow this spirit: it should be simple to author extensions by creating facades over private things through `yield* ExtensionContext`; no ctx parameters, no privileged builtin API, and no capability/read/write ceremony when access can be expressed in code by accessing what is needed from ctx.

Close Wave 30 only after this independent audit reports no P0/P1. If it finds
P1s, synthesize the next wave and continue.
