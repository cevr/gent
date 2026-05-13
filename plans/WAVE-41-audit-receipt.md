# Wave 41 audit receipt

## Frame

- **Wave**: W41 requirement-ownership cleanup.
- **Start HEAD**: `7dd9eed8` (`docs(plan): close wave 40`).
- **Implementation HEAD**: `22e23c41` (`refactor(runtime): isolate agent loop context adapter`).
- **Implementation commits**:
  - `9fe42a6f` - `docs(plan): expand wave 41 audit lanes`
  - `7ef006ec` - `refactor(extensions): make rpc dispatch use host boundary`
  - `ff8c78bd` - `refactor(extensions): yield host context provider`
  - `a2a8c415` - `refactor(extensions): provide capability scope ambiently`
  - `93c92331` - `refactor(drivers): yield external tool runner`
  - `128a4758` - `refactor(anthropic): close credential io in layers`
  - `22e23c41` - `refactor(runtime): isolate agent loop context adapter`
- **Closing audit HEAD**: `22e23c416251db2df219ae1b4674e1aee2b7259a`.
- **P0**: none.
- **Disposition**: W41 implementation is complete and gate-clean. The
  closing audit found P1s, so W42 opens. Do not tail-extend W41.

## Tally

| Lane      | Focus                                                |    P0 |     P1 |     P2 |
| --------- | ---------------------------------------------------- | ----: | -----: | -----: |
| L1        | Effect simplicity + composable methods               |     0 |      1 |      5 |
| L2        | Runtime, actor, and request boundaries               |     0 |      2 |      1 |
| L3        | Requirement ownership and scoped services            |     0 |      3 |      2 |
| L4        | Schema, storage, and durable integrity               |     0 |      3 |      4 |
| L5        | Public and acceptance contracts                      |     0 |      2 |      4 |
| L6        | File and module cohesion                             |     0 |      2 |      4 |
| L7        | Extension API expressiveness and ceremony            |     0 |      4 |      2 |
| L8        | Architecture simplification against actor north star |     0 |      4 |      2 |
| L9        | Owned upstream package leverage                      |     0 |      4 |      2 |
| **Total** |                                                      | **0** | **25** | **26** |

## W41 closure verification

- `bun run gate` passed at W41 HEAD
  `22e23c416251db2df219ae1b4674e1aee2b7259a`.
- Focused tests passed during the implementation spines:
  host provider/RPC, ambient capability scope, external driver runner,
  Anthropic credential IO, and runtime context adapter coverage.
- Closing audit was read-only; no audit lane edited files or reran gate.

## P0 findings

None.

## P1 findings by lane

### L1 - Effect simplicity + composable methods

- **P1 - Turn response collectors lose `Effect.fn` trace names on the
  hot stream path**. `collectModelTurnResponse`,
  `collectFailedModelTurnResponse`, and `collectExternalTurnResponse`
  are exported raw `Effect.gen` helpers used by turn execution.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:176`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:248`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:361`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:176`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:187`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:195`.

### L2 - Runtime, actor, and request boundaries

- **P1 - Actor reopen can self-deadlock on recovery/start failure**.
  Reopen holds `startupSemaphore`, starts recovered work, then failure
  cleanup re-enters `closeBehavior`, which tries to acquire the same
  semaphore.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:408`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:363`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:379`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:368`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:219`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:148`.
- **P1 - External-driver tool calls erase cold interaction semantics**.
  `ToolRunner.run` can fail with `InteractionPendingError`; the external
  driver bridge converts it to a defect, while the native model-tool path
  preserves parking/resume semantics.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:42`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:99`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:212`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:448`.

### L3 - Requirement ownership and scoped services

- **P1 - Cached external codemode sessions retain the first turn's tool
  callback**. The external tool runner callback closes over the current
  host context/registry/event publisher, but ACP/Claude session reuse
  fingerprints tools by name/config, not callback authority.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:92`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:106`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:252`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:260`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:486`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:492`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:48`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:67`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:228`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:234`.
- **P1 - Background bash jobs carry full `ExtensionContext` across a
  long-lived fork**. The supervisor snapshots the full host facade into a
  background fiber, though the job only needs narrow target/follow-up
  authority.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:384`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:390`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:391`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:421`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:211`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:226`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:220`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:277`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:341`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:360`.
- **P1 - Delegate background todo fibers close over request authority**.
  The delegate tool yields `ExtensionContext`, then background todo
  fibers call `ctx.Agent` through a scope-crossing closure.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:78`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:80`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:118`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:145`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:178`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:200`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:203`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:231`.
- **Not flagged**: service-internal closure patterns remain valid when a
  layer yields dependencies during construction and returns methods that
  close over those handles. Examples: `AutoControllerLive` and
  `createAcpSessionManager`.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/controller.ts:401`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/controller.ts:429`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:70`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:82`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:114`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:120`.

### L4 - Schema, storage, and durable integrity

- **P1 - Queue rows are outside SQLite foreign-key integrity**.
  Agent-loop queue storage persists session/branch rows without the same
  referential coverage as related tables.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:203`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:238`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/agent-loop-queue-storage.ts:89`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:19`.
- **P1 - Durable operation rows can replay deleted session results**.
  Operation rows outlive deleted sessions and can be observed through
  idempotency/replay paths.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:273`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-operation-storage.ts:93`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:243`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:218`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-storage.ts:162`.
- **P1 - Idempotent migrations ignore every `ALTER` failure**.
  Migration helpers swallow all `ALTER TABLE` failures, not just the
  already-applied cases.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:217`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:260`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:306`.

### L5 - Public and acceptance contracts

- **P1 - `@gent/sdk` publishes the internal RPC graph as client
  contract**. The namespaced client exposes internal method/path shape
  instead of a stable SDK surface.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:4`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:30`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:58`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/tests/client.test.ts:98`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts:49`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts:93`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts:181`.
- **P1 - `@gent/sdk` leaks core-internal runtime transport
  constructors through the public barrel**.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/sdk/package.json:14`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/package.json:15`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts:1`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts:8`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:37`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:111`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:338`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/queue.ts:15`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/queue.ts:25`.

### L6 - File and module cohesion

- **P1 - TUI client context is four state modules plus event bus in one
  file**. The file owns connection state, session state, command helpers,
  event subscriptions, and optimistic UI transitions.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:114`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:154`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:184`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:201`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:315`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:469`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:503`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:622`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:658`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:869`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:906`.
- **P1 - `session-controller.ts` is a TUI session god hook**. It mixes
  session actions, event reaction, input state, navigation, command
  submission, scroll behavior, and lifecycle wiring.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:77`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:137`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:175`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:224`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:316`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:418`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:454`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:660`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:713`.

### L7 - Extension API expressiveness and ceremony

- **P1 - Gent lacks first-class loop interception for
  input/context/tool preflight**. Current public reactions cannot handle
  user input, transform context messages, or block/patch a tool before
  execution through the extension API.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:179`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:199`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:156`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:185`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:222`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:280`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1084`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1127`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:270`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:300`.
- **P1 - Static bucket setup blocks dynamic registration**. Extension
  setup snapshots contributions once; there is no live registration API
  for session/process-scoped tools or commands.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:332`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:359`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:185`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:226`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:290`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:350`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:37`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:50`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:68`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:89`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/tool/registry.ts:188`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/tool/registry.ts:207`.
- **P1 - Request and action authoring repeats extension identity**.
  Requests repeat `extensionId` even though `defineExtension` already has
  an id, and simple UI actions inherit RPC capability ceremony.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:52`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:78`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:18`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:23`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:28`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:45`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:50`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/todo/requests.ts:67`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/plan.ts:32`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/plan.ts:59`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:46`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:55`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/example.ts:4`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/example.ts:17`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:63`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/docs/extensions.md:99`.
- **P1 - Common state requires Effect resource ceremony or unsafe
  module globals**. Docs ask authors to create Tags/Layers/resources;
  the lightweight example uses module-global mutable state.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:280`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:319`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts:1`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts:25`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts:292`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto/index.ts:305`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/todo.ts:105`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/examples/extensions/todo.ts:133`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:56`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:75`.

### L8 - Architecture simplification against actor north star

- **P1 - `SessionRuntime` is still a second session owner, not just an
  actor port**. It resolves actor refs, builds actor context, validates
  branches, waits for events, publishes diagnostics, lists actor state,
  and synthesizes actor payloads.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:152`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:166`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:255`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:292`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:335`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:369`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:380`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:458`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:510`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:517`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:812`.
- **P1 - `provideLayerBuildContext` is a structural upstream pressure
  point**. Gent snapshots actor build context because `Actor.toLayer`
  does not make entity build dependencies first-class under child
  overrides.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts:40`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts:46`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts:58`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:14`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:17`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:86`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:103`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:807`.
- **P1 - AgentLoop has actor ownership plus extra helper-scope
  ownership models**. `AgentLoopBehavior`, worker/turn/queue scopes,
  refs, semaphores, and worker queues recreate an actor runtime inside
  the actor handler.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:101`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:109`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:142`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:106`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:273`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:357`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:369`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.worker.ts:18`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:61`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:1`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:313`.
- **P1 - Extension host context is built outside the actor even though
  it is run/session authority**. Host context construction duplicates
  actor identity and runtime binding logic.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:376`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:46`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:298`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:364`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:445`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:469`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts:63`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts:78`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:234`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:266`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:636`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:3087`.

### L9 - Owned upstream package leverage

- **P1 - `effect-wide-event` cannot model semantic outcomes, so Gent
  reimplements them locally**. Gent defines local tool error/warning
  metadata and manually sets domain failure fields while upstream
  hardcodes envelope status from `Exit`.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:24`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:53`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:238`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:315`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:197`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:215`,
  `/Users/cvr/Developer/personal/effect-wide-event/test/wide-event.test.ts:38`,
  `/Users/cvr/Developer/personal/effect-wide-event/test/wide-event.test.ts:53`.
- **P1 - Wide-event boundary coverage is caller ceremony instead of an
  API guarantee**. RPC handlers hand-compose `WideEvent.set` and
  `withWideEvent`, while upstream only exposes generic boundary fields
  and an ambient ref.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:256`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:306`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:322`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:439`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:577`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:639`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:59`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:96`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:42`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:56`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts:18`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts:33`.
- **P1 - `effect-encore` forces Gent to snapshot layer-build context
  around actor construction**. This is the upstream root of
  `provideLayerBuildContext`.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts:46`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts:69`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:11`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:39`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1300`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1328`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1404`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1414`.
- **P1 - Actor state reads require `SessionRuntime` to rebuild Encore
  internals**. Gent captures and re-provides actor support context for
  state/read/redelivery operations; upstream state APIs require private
  support services at each call.
  **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:255`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:302`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:369`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:401`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:452`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:456`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1066`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1118`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor-state.ts:35`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor-state.ts:84`.

## P2 ride-along bucket

- **L1**: nested anonymous generators in actor handlers; public
  `SessionRuntime` arrow wrappers; pure `DriverRegistry` map reads as
  effects; dead `flatMap(...Effect.succeed(...))` in `runCommand`;
  duplicated/test-only `toResponseFinishReason`.
- **L2**: external driver stream execution lacks a dedicated
  provider/external wide-event boundary.
- **L3**: `ExtensionContext.State.changed` lets callers choose
  extension identity; todo mutation helpers re-thread context the caller
  already yielded.
- **L4**: queue JSON is shape-decoded but not target-validated;
  `messages.kind = NULL` becomes regular; event tag index can drift
  from decoded event payload; sync Schema decoder remains exported.
- **L5**: public extension API carries dead/raw helper types; public
  surface tests use negative locks instead of exact allow-lists; TUI
  lifecycle tests use `Effect.sleep`; some `describe` labels are
  structural.
- **L6**: CLI entrypoint mixes parsing/runtime/server/doctor/storage
  reset/signals; `SessionRuntime` mixes schemas/actor plumbing/commands;
  server debug scenario is too broad; empty residue directories and
  process-shaped names remain.
- **L7**: docs promise an unexported `action` API; `toolResult` uses
  `unknown` at the public seam.
- **L8**: ephemeral helper runs duplicate runtime ownership through
  parent context snapshots; `AgentLoop` protocol can absorb more facade
  code.
- **L9**: entity identity is duplicated across every actor operation;
  Encore storage leaks dual cluster/Encore tags into Gent's storage root.

## Wave 42 disposition

Open W42. Prioritize P1s by causal depth:

1. Owned upstream redesigns in `effect-wide-event` and `effect-encore`
   where Gent workarounds exist only because the upstream surface is
   insufficient.
2. Actor ownership simplification, especially `SessionRuntime`,
   `provideLayerBuildContext`, AgentLoop helper scopes, and extension
   host context construction.
3. External-driver correctness and background authority leakage.
4. Extension API expressiveness/ceremony and SDK/public contract shape.
5. Durable integrity and TUI cohesion after the core ownership seams are
   stable.
