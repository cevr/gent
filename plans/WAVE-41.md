# Wave 41 plan

## Frame

- **Source**: opens from the residual architecture findings and P2
  ride-along bucket in `plans/WAVE-40-audit-receipt.md`.
- **HEAD start**: `7dd9eed8` (`docs(plan): close wave 40`).
- **W40 code closure**: `e41d8a9a` (`fix(runtime): close wave 40
audit blockers`), with `bun run gate` passed there.
- **Execution status**: planned only. Do not start W41 until
  explicitly requested.
- **Rule**: sub-commit by architecture seam; run gate between logical
  units; counsel after each sub-commit where the seam remains
  structural. Do not tail-extend W40.
- **P0**: none.
- **P1 core**: the W40 L7/L8 residual architecture findings become
  W41's first-class scope.
- **P2 bucket**: W40 P2 findings ride along only when touching the same
  files. Do not inflate a P1 structural batch into a broad cleanup
  sweep.

## Spines

### S1 - Extension host construction boundary

Closes the service-bag shape around `MakeExtensionHostContextDeps` and
host facade construction.

- **C1**: Replace `MakeExtensionHostContextDeps` as a threaded data bag
  with a yielded, owned host-capability provider. The provider should
  make each host facade explicit and scoped instead of passing an
  aggregate bag through construction.
- **C2**: Migrate host context construction call sites in
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts`
  and
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`
  to the yielded provider boundary.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:46`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:52`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:121`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:277`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:390`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:428`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:262`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:612`.

### S2 - Capability context is not record data

Removes `capabilityContext?: Context.Context<never>` from profile and
host records.

- **C3**: Replace capability context record fields with a scoped Tag or
  layer boundary. Host/profile data should describe product state;
  Effect context belongs in the runtime environment.
- **C4**: Migrate tool runner, extension reactions, capability tool
  context, and session profile construction to the new boundary.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:36`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-host-context.ts:42`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:207`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:216`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:31`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:36`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts:45`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts:49`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:46`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:89`.

### S3 - RPC registry dispatch context

Removes invocation context from registry dispatch and makes request
scope ambient through declared requirements.

- **C5**: Drop the invocation-context parameter from compiled RPC
  registry dispatch. `CompiledRpcRegistry.run` should yield the current
  request/host boundary, not receive it as a positional argument.
- **C6**: Move extension-service provision to the RPC boundary in
  `rpc-handlers.ts`, keeping registry dispatch focused on lookup and
  execution.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:89`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:95`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:253`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:260`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:272`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:607`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:622`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:632`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:642`.

### S4 - External driver tool execution

Replaces callback/context bridging in external driver tool execution
with a scoped service boundary.

- **C7**: Remove external driver `runTool` callback/context plumbing.
  Introduce a tool-execution service that is yielded inside the
  execution scope.
- **C8**: Migrate ACP executor and Claude Code executor call sites to
  the new service. Preserve existing lifecycle and failure reporting
  behavior while removing the callback bridge.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:207`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:217`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:218`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:97`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:107`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:113`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:245`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:250`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:483`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:485`.

### S5 - AgentLoop context capture leftovers

Removes remaining build-time context snapshots that erase helper
requirements.

- **C9**: Replace AgentLoop behavior runtime-context/provide-runtime
  plumbing with honest R-channel requirements or focused Tags at the
  helper boundary.
- **C10**: Resolve the explicit layer-build context closure in
  AgentLoop actor assembly. If an Effect actor/layer limitation remains,
  isolate it behind one narrow owned service and document why that
  boundary exists.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:215`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:221`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:231`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:247`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:277`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:287`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:775`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:789`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:796`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:799`.

### S6 - Anthropic capability IO closures

Removes closed capability IO contexts from Anthropic assembly.

- **C11**: Replace closed `getFresh` and transform callback contexts
  with layer-carried requirements or first-class service Tags.
- **C12**: Verify Anthropic keychain and OAuth paths still preserve
  refresh, transform, and account-listing behavior without
  context-capturing callbacks.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts:134`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts:138`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts:140`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts:149`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts:151`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/anthropic/index.ts:153`.

### S7 - P2 ride-along bucket

Only apply these when already touching the same files.

- Effect trace naming / simplification around approval service, process
  runner, Anthropic keychain client, agent-loop handler nesting, and a
  dead message clone.
- File cohesion candidates: lint plugin, TUI client context/main/session
  controller, session runtime, agent-loop handlers.
- Durable integrity candidates: auto journal replay, agent-loop queue
  foreign-key coverage, background bash row decode.
- Public ceremony candidates: server-lock lifecycle split,
  `AuthOauth` / `PermissionResult` exports.
- Test naming candidates in Anthropic keychain transform and host-facet
  survivor tests.
- Composable-method candidates: `DriverRegistry` map reads,
  `listSlashCommands`, `resolveDriverToolSurface`, process execution
  free function, `EventPublisher.append` / `deliver`.

## Closing audit (final batch)

After S6 lands and gate is clean at W41 HEAD, run the same 9-lane audit
pattern used to close W37 through W40. Identical scope per lane; do not
vary prompts across waves.

- **L1 - Effect simplification**: `Effect.fn` trace-name gaps,
  `Effect.gen` arrows that could be `Effect.succeed`, dead/redundant
  Effect wraps.
- **L2 - Actor + wide-event boundaries**:
  `withWideEvent(rpcBoundary(...))` coverage on new/changed RPC
  handlers, actor handler trace wraps, race conditions,
  `Effect.forkScoped` vs `Effect.fork` mistakes, entityIdOf argument
  mismatches.
- **L3 - Schema / storage integrity**: row Schemas, decode safety, no
  `Schema.decodeSync` throws, brand erasure at boundaries, TaggedUnion
  vs hand-rolled `_tag` literals, `Effect.option` silent drops on
  durable storage.
- **L4 - Public API ceremony**: dead exports from
  `@gent/core/extensions/api` and `@gent/sdk`, parallel API names,
  double-exports, internal transports leaked through public surface.
- **L5 - Test taxonomy**: behavioral describe naming, Runtime Boundary
  respect, RPC acceptance coverage for new extension surface,
  `Effect.sleep` proxies for state transitions.
- **L6 - File cohesion**: files over 700 lines mixing concerns, empty
  residue directories, generic utilities living in feature-specific
  files.
- **L7 - Ctx-as-param leaks**: service Tags / facades threaded as
  function parameters, callbacks for what should be service methods,
  registry Tags scoped wrong.
- **L8 - Yield-don't-thread**: closure-captured Tags then re-injected
  via `provideService`, services threaded through scope-crossing
  closures, helper call sites re-threading what the caller already
  yielded.
- **L9 - Composable-method demotions**: service interface methods that
  thin-wrap other public methods or actor commands, helpers with zero
  non-test callers, pure functions masquerading as service methods.

Each lane: independent Opus `general-purpose` Agent against fresh HEAD;
no cross-pollination; cap at 6-8 findings; severity-prefixed
(P0/P1/P2); file:line citations for every claim.

When all 9 return, write `plans/WAVE-41-audit-receipt.md` using the
same template: Frame -> Tally table -> W41 closure verification -> P0
findings -> P1 findings by lane -> P2 ride-along bucket -> Wave 42
disposition.

## Disposition rule

P0/P1 findings from the W41 closing audit open Wave 42. Do not
tail-extend W41. P2s roll into the W42 ride-along bucket.
