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
- **Requirement ownership rule**: passing services, facades, Effect
  contexts, or callbacks as ordinary parameters is the smell. A service
  layer yielding its dependencies at construction time and returning
  methods that close over those concrete handles is valid; it keeps
  method call sites requirement-free while preserving the layer's honest
  requirements.
- **External reference points**:
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/ai/anthropic/src/AnthropicClient.ts:210`,
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/ai/anthropic/src/AnthropicClient.ts:212`,
  `/Users/cvr/.cache/repo/effect-ts/effect-smol/packages/ai/anthropic/src/AnthropicClient.ts:358`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/llm/src/route/executor.ts:355`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/llm/src/route/executor.ts:358`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/llm/src/route/executor.ts:366`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/account/account.ts:184`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/account/account.ts:187`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/account/account.ts:193`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:510`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:513`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:517`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/project/project.ts:130`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/project/project.ts:137`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/project/project.ts:142`.

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
- **C3**: Preserve legitimate service-internal closure. If
  `makeExtensionHostContext` becomes a service layer, it may yield
  storage/session/process dependencies once and return requirement-free
  methods that close over them. Do not force every helper method to leak
  those requirements in its public signature.
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

- **C4**: Replace capability context record fields with a scoped Tag or
  layer boundary. Host/profile data should describe product state;
  Effect context belongs in the runtime environment.
- **C5**: Migrate tool runner, extension reactions, capability tool
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

- **C6**: Drop the invocation-context parameter from compiled RPC
  registry dispatch. `CompiledRpcRegistry.run` should yield the current
  request/host boundary, not receive it as a positional argument.
- **C7**: Move extension-service provision to the RPC boundary in
  `rpc-handlers.ts`, keeping registry dispatch focused on lookup and
  execution.
- **C8**: If the compiled registry itself owns a layer/service, it may
  instantiate its dependencies once and close over them. The boundary to
  delete is caller-provided invocation context, not service-local
  dependency capture.
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

- **C9**: Remove external driver `runTool` callback/context plumbing.
  Introduce a tool-execution service that is yielded inside the
  execution scope.
- **C10**: Migrate ACP executor and Claude Code executor call sites to
  the new service. Preserve existing lifecycle and failure reporting
  behavior while removing the callback bridge.
- **C11**: Model driver tool execution like a service-owned executor:
  the executor layer owns process/session/tool dependencies; its public
  method accepts domain input only.
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

- **C12**: Replace AgentLoop behavior runtime-context/provide-runtime
  plumbing with honest R-channel requirements or focused Tags at the
  helper boundary.
- **C13**: Resolve the explicit layer-build context closure in
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

- **C14**: Replace closed `getFresh` and transform callback contexts
  with layer-carried requirements or first-class service Tags.
- **C15**: Verify Anthropic keychain and OAuth paths still preserve
  refresh, transform, and account-listing behavior without
  context-capturing callbacks.
- **C16**: Keep the good part of the pattern from Effect/opencode:
  Anthropic assembly can yield credential, HTTP, and keychain services
  inside its layer and return methods that use those handles. The banned
  shape is exporting fresh context/getter callbacks as data.
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

After S6 lands and gate is clean at W41 HEAD, run a collapsed 9-lane
audit. Keep lanes independent, but do not split one concern across two
agents just because previous waves used separate labels.

- **L1 - Effect simplicity + composable methods**: `Effect.fn`
  trace-name gaps, dead/redundant Effect wraps, `Effect.gen` arrows
  that could be `Effect.succeed`, service interface methods that
  thin-wrap other public methods or actor commands, helpers with zero
  non-test callers, pure functions masquerading as service methods.
- **L2 - Runtime, actor, and request boundaries**:
  `withWideEvent(rpcBoundary(...))` coverage on new/changed RPC
  handlers, actor handler trace wraps, race conditions,
  `Effect.forkScoped` vs `Effect.fork` mistakes, entityIdOf argument
  mismatches, Runtime Boundary respect.
- **L3 - Requirement ownership and scoped services**: service Tags,
  facades, Effect contexts, and callbacks passed as ordinary function
  parameters; registry Tags scoped wrong; services threaded through
  scope-crossing closures; helper call sites re-threading requirements
  the caller already yielded. Do not flag service layers that yield
  dependencies during construction and return requirement-free methods
  that close over those handles.
- **L4 - Schema, storage, and durable integrity**: row Schemas, decode
  safety, no `Schema.decodeSync` throws, brand erasure at boundaries,
  TaggedUnion vs hand-rolled `_tag` literals, `Effect.option` silent
  drops on durable storage, queue/foreign-key/journal replay integrity.
- **L5 - Public and acceptance contracts**: dead exports from
  `@gent/core/extensions/api` and `@gent/sdk`, parallel API names,
  double-exports, internal transports leaked through public surface,
  behavioral describe naming, RPC acceptance coverage for new extension
  surface, `Effect.sleep` proxies for state transitions.
- **L6 - File and module cohesion**: files over 700 lines mixing
  concerns, empty residue directories, generic utilities living in
  feature-specific files, process-shaped names left in active source or
  tests.
- **L7 - Extension API expressiveness and ceremony**: whether extension
  authors can compose behavior around the agent loop with a simple,
  expressive API; whether static buckets block dynamic registration;
  whether request/tool/resource authoring repeats identity or exposes
  too much Effect ceremony for common state. Compare against opencode's
  typed hook bag and pi-mono's `ExtensionAPI` registration/event model.
- **L8 - Architecture simplification against actor north star**:
  whether W41 can remove LOC and concepts by making actors the owning
  boundary; whether `SessionRuntime`, AgentLoop helper scopes,
  extension host context construction, and runtime context snapshots
  still duplicate actor ownership. Compare against opencode's
  service-layer closure pattern and pi-mono's single-session-owner
  compression without copying pi's monolith.
- **L9 - Owned upstream package leverage**: audit `effect-wide-event`
  and `effect-encore` as code we own, not fixed constraints. Look for
  Gent workarounds, subpar local code, repeated DX ceremony, missing
  primitives, and upstream API decisions that force Gent away from the
  actor-model north star. Recommend upstream redesigns freely, including
  breaking/rearchitecting `effect-wide-event` or `effect-encore` when
  the upstream shape is the root cause.

Each lane: independent Opus `general-purpose` Agent against fresh HEAD;
no cross-pollination; cap at 6-8 findings; severity-prefixed
(P0/P1/P2); file:line citations for every claim. L3 must include a
short "not a leak" paragraph for any service-internal closure pattern it
chooses not to flag. L7 and L8 must cite concrete opencode and pi-mono
reference files alongside Gent findings. L9 must cite both Gent call
sites and upstream source in `/Users/cvr/Developer/personal/effect-wide-event`
or `/Users/cvr/Developer/personal/effect-encore`.

When all 9 return, write `plans/WAVE-41-audit-receipt.md` using the
same template: Frame -> Tally table -> W41 closure verification -> P0
findings -> P1 findings by lane -> P2 ride-along bucket -> Wave 42
disposition.

## Fresh lane audit seeds

These lanes were launched while drafting W41 so their findings can
shape the final plan. Treat them as seed findings, not the final W41
closure audit; L7/L8/L9 must rerun after S6 at W41 HEAD.

### L7 seed - Extension API expressiveness

No P0.

- **P1 - Gent lacks a broad interception/event API**. Current reactions
  are limited to `systemPrompt`, `turnProjection`, `turnAfter`, and
  `toolResult`, and the runtime only collects/runs those named slots.
  Add a typed `events`/`hooks` bucket or `on(event, handler)` authoring
  helper that lowers to runtime reactions for provider payloads, tool
  calls, input, message lifecycle, model selection, and shutdown. Keep
  existing named reactions as sugar.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:179`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:185`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:190`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:191`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:198`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:157`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:185`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:241`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:279`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:280`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:335`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:589`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:613`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:674`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:769`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:222`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:260`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:281`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:332`.
- **P1 - Contributions are setup-time immutable, blocking dynamic
  composition**. `defineExtension` resolves buckets once, `LoadedExtension`
  stores the snapshot, and registry resolution compiles that snapshot.
  Static buckets can remain the default, but add an explicit
  process/session-scoped dynamic registration facet for tools, model
  drivers, and active-tool changes.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:331`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:357`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:21`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:32`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:58`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:70`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1248`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1251`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/loader.ts:217`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/loader.ts:224`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/dynamic-tools.ts:24`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/dynamic-tools.ts:73`.
- **P2 - Request authoring repeats extension and error identity**.
  `defineExtension` already has `id`, but every `request` still requires
  `extensionId`, and handlers repeat ids again in `CapabilityError`.
  Consider extension-scoped authoring helpers such as
  `defineExtension({ id, setup: ({ request, tool, error }) => ... })`
  where identity is derived from the surrounding extension/capability.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:201`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:53`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:58`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:18`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:30`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:52`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:105`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/plan.ts:32`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/plan.ts:55`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/llm/src/tool.ts:158`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/llm/src/tool.ts:172`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/loader.ts:208`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/loader.ts:233`.
- **P2 - Resource authoring is powerful but high ceremony for common
  extension state**. Keep `defineResource` as the advanced Effect-native
  primitive, but add low-ceremony helpers for common state/lifecycle:
  `state(name, initial)`, `sessionState(name)`, `processService(Tag, Live)`,
  and `onDispose`, lowering to `ResourceContribution` internally.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:64`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:89`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:108`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:137`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff.ts:57`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff.ts:77`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff.ts:146`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff.ts:148`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1192`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/tools.ts:21`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/tools.ts:35`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/specs/tui-plugins.md:236`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/specs/tui-plugins.md:244`.

Reference lessons:

- opencode: typed hook object, narrow plugin function, host API passed
  once; hook names are extension points.
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:56`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:75`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:222`.
- opencode: record keys own LLM tool wire identity, reducing leaf
  repetition.
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/llm/src/tool.ts:158`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/llm/src/tool.ts:180`.
- pi-mono: imperative registration is the simple authoring path; a
  default factory receives `ExtensionAPI`, then calls `pi.on`,
  `pi.registerTool`, `pi.registerCommand`, and `pi.registerProvider`.
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:55`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:99`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1084`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1310`.

### L8 seed - Architecture simplification

No P0.

- **P1 - `SessionRuntime` is still a second session engine around the
  actor**. It owns message construction, target validation, support
  context assembly, redelivery, completion waiting, metrics projection,
  termination fanout, and error diagnostics. Make `SessionRuntime` a thin
  actor gateway or fold command shaping into `AgentLoop` commands.
  Actor-owned state, queue, metrics, completion, redelivery, and
  termination should live behind actor messages.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:152`,
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:153`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:255`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:292`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:310`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:458`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:520`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:647`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:699`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:724`.
- **P1 - AgentLoop internals duplicate the actor model with private
  scope-service mini-DI**. `AgentLoopQueueScope`,
  `AgentLoopTurnExecutionScope`, and `AgentLoopWorkerScope` wrap
  actor-owned refs/queues/semaphores/callbacks as Effect services. Keep
  the file split if useful, but pass one actor-owned handle/object to
  local factories and delete per-file Context services unless the
  dependency is truly runtime-provided.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.queue.ts:37`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.queue.ts:46`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:61`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:73`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.worker.ts:18`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.worker.ts:34`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:316`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:382`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:394`.
- **P1 - Layer-build/runtime context snapshots signal an inverted actor
  boundary**. Treat the Effect actor limitation as one named
  actor-runtime adapter, document the single exception if it remains,
  and delete local copies such as `provideRuntime`.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:13`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:14`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:215`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:221`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:231`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:247`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:761`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:789`.
- **P1 - Extension host context is a service bag plus ambient reference
  system**. Promote this to an owned host-capability service/factory that
  yields dependencies once and exposes `forSession(...)`. Do not pass
  `MakeExtensionHostContextDeps` as product data.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:46`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:121`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:262`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:279`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:345`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:390`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:426`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:262`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:612`.
- **P2 - RPC extension request dispatch still has two context
  channels**. `CompiledRpcRegistry.run` receives context positionally,
  while `rpc-handlers` also provides `capabilityContext`. Make request
  scope ambient through one Tag/layer boundary; registry dispatch should
  only resolve and run the selected capability.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:89`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:253`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:269`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:272`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:607`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:631`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:642`.

Reference lessons:

- opencode: service layers yield dependencies at construction and
  return methods that close over concrete handles, without passing a
  service bag per call.
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/llm/src/route/executor.ts:355`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/llm/src/route/executor.ts:358`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/llm/src/route/executor.ts:366`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/account/account.ts:184`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/account/account.ts:187`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/project/project.ts:130`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/project/project.ts:137`.
- pi-mono: useful lesson is ownership compression, not the monolith:
  `AgentSession` owns session event subscription, queues, tool hooks,
  extension emission, and disposal; `AgentSessionRuntime` swaps whole
  session runtimes.
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:313`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:328`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:750`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts:60`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts:67`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session-runtime.ts:149`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session-services.ts:60`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session-services.ts:129`.

### L9 seed - Owned upstream package leverage

No P0.

- **P1 - `effect-encore` `Actor.toLayer` still forces Gent to snapshot
  layer-build context locally**. Gent has a bespoke
  `provideLayerBuildContext` wrapper because `Actor.toLayer(actor, build)`
  does not make the handler-build R-channel an honest layer requirement
  under the child runtime composition Gent needs. `ToLayerOptions.withScope`
  helps derive per-entity context, but it runs inside handler dispatch; it
  does not replace build-time capture of storage/event/model services.
  Upstream should own this as a first-class actor-layer API, e.g.
  `Actor.toLayer(actor, build, { captureLayerContext: [...] })` or a
  scoped layer constructor that binds build requirements before Sharding
  registers the entity.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:13`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:16`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:773`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:776`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:789`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:328`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:341`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1310`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1321`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1402`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1410`.
- **P1 - `effect-encore` state APIs make `SessionRuntime` rebuild an
  actor-state service context instead of yielding a bound actor state
  client**. Gent yields actor services once, builds an `actorContext`,
  then re-provides it into `watchState`/`listStateEntityIds`. That is a
  local workaround around Encore's state methods requiring
  `ActorAddressResolver | ActorStateRegistry | ActorClientService` at
  each call. Upstream should expose a bound state client/service from
  `Actor.toLayer` so host runtimes call actor state operations through
  one yielded handle instead of reconstructing context.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:255`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:260`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:292`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:299`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:369`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:373`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1065`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1071`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1086`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1092`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1109`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1116`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:2222`.
- **P1 - `effect-wide-event` leaves domain boundary factories and
  semantic outcomes to Gent**. Gent keeps local factories for turn/tool/
  provider/RPC/agent-run boundaries plus local tool error/warning
  vocabularies because upstream only exposes generic `service`, `method`,
  and `"ok" | "error"` status. Upstream should add a typed boundary
  builder, reserved-field schema, and semantic outcome model such as
  `"ok" | "error" | "interrupted" | "partial"` plus domain outcome fields,
  so Gent does not encode non-fatal tool failures as ad hoc envelope data.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:13`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:20`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:59`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:70`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:76`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:82`,
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:632`,
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:646`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:10`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:14`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:42`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:50`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:197`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:201`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:214`.
- **P2 - `effect-wide-event` offers only hard scoped `set/get/reset`,
  so Gent audits keep finding missing boundaries instead of getting an
  API-level guarantee**. `WideEvent.set` requires an ambient
  `WideEventRef`; missing `withWideEvent` is a runtime/coverage problem
  caught by wave audits and tooling tests. Upstream could provide
  boundary-required helpers like `withRpcBoundary`, `withActorBoundary`,
  or a branded `BoundaryToken` API that makes "set outside boundary" a
  typed/design error for common entry points.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/AGENTS.md:51`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:272`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:284`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:293`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/wide-event-boundary.test.ts:29`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/wide-event-boundary.test.ts:44`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts:18`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts:30`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:145`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:180`.
- **P2 - `effect-encore` storage still exposes the upstream/Encore dual
  tag to Gent composition**. Gent's focused storage layer must carry both
  `MessageStorage.MessageStorage` and `EncoreMessageStorage`, and wire
  `fromSqlClient()` directly. That is acceptable today, but the package
  can own a higher-level `ActorStorage.Sqlite` / actor-runtime storage
  layer that hides the dual-tag contract and makes rerun/delete-envelope
  support a capability of the actor runtime rather than Gent storage
  wiring.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:5`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:6`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:52`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:63`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:79`,
  `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:9`,
  `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:15`,
  `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:89`,
  `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:108`,
  `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:142`.

## Disposition rule

P0/P1 findings from the W41 closing audit open Wave 42. Do not
tail-extend W41. P2s roll into the W42 ride-along bucket.
