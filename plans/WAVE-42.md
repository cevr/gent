# Wave 42 plan

## Frame

- **Source**: opens from `plans/WAVE-41-audit-receipt.md`.
- **Start HEAD**: `22e23c41` (`refactor(runtime): isolate agent loop
context adapter`).
- **W41 status**: implementation complete; `bun run gate` passed at
  `22e23c416251db2df219ae1b4674e1aee2b7259a`.
- **P0**: none.
- **P1**: 25 findings across the W41 closing audit. W42 exists because
  W41's final verification found P1s.
- **Rule**: fix by causal depth, not by local convenience. Owned
  upstream packages are editable design surfaces. If `effect-wide-event`
  or `effect-encore` forces Gent into workarounds, redesign upstream
  first, add changesets/version flow there, then consume the improved
  API in Gent.
- **Batching**: sub-commit by architecture seam. Run gate between
  logical units. Use focused upstream package gates before consuming
  upstream changes in Gent.

## Spines

## Progress

### S1 status - complete

- `effect-wide-event@0.3.0` published and consumed. Gent now uses
  upstream semantic outcomes plus `WideEventBoundary.rpc/tool/provider`
  instead of local boundary/result metadata conventions.
- Verification:
  `bun run gate` in `/Users/cvr/Developer/personal/effect-wide-event`
  passed before publish; GitHub Release run `25801820614` succeeded;
  `npm view effect-wide-event version --json` returned `"0.3.0"`;
  Gent `bun run gate` passed after consuming the package.
- Evidence:
  `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/v3/src/wide-event.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/v3/src/boundary.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/test/wide-event.test.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/v3/test/wide-event.test.ts`,
  `/Users/cvr/Developer/personal/effect-wide-event/.changeset/tall-walls-serve.md`,
  `/Users/cvr/Developer/personal/gent/package.json`,
  `/Users/cvr/Developer/personal/gent/bun.lock`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/wide-event-boundary.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/tooling/tests/platform-duplication-guards.test.ts`.

### S2 status - partial

- **C5 complete**: `effect-encore@0.12.2` published and consumed. Encore
  now exposes actor-specific `State` services from `Actor.toLayer` and
  `Actor.toTestLayer`, mirrored in v3. Gent now reads/watches/list actor
  state through `AgentLoopActor.State` instead of reconstructing
  `ActorAddressResolver | ActorStateRegistry | ActorClientService`.
- **C4 complete for the Gent-local workaround**: `effect-encore@0.12.3`
  published and consumed. Encore now exposes `Actor.provideLayerBuildContext`,
  mirrored in v3, so Gent deleted its local `provideLayerBuildContext`
  helper and uses the upstream API at actor construction.
- **C6 still open**: actor identity and dual storage tags remain split
  across Gent/Encore. The next upstream question is whether Encore should
  declare entity identity once and hide cluster storage plus Encore message
  storage behind one actor runtime storage layer.
- Verification:
  `bun run gate` in `/Users/cvr/Developer/personal/effect-encore`
  passed before each publish; GitHub Release runs `25802698340` and
  `25803441319` succeeded; `npm view effect-encore version --json`
  returned `"0.12.3"`; Gent `bun run typecheck`, `bun run lint`, and
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/runtime/session-runtime.test.ts packages/core/tests/runtime/agent-runner.test.ts`
  passed after consuming `0.12.2`; Gent `bun run typecheck` passed after
  consuming `0.12.3`.
- Evidence:
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts`,
  `/Users/cvr/Developer/personal/effect-encore/src/index.ts`,
  `/Users/cvr/Developer/personal/effect-encore/test/actor-state.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/test/types.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/test/actor-with-scope.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/v3/src/actor.ts`,
  `/Users/cvr/Developer/personal/effect-encore/v3/src/index.ts`,
  `/Users/cvr/Developer/personal/effect-encore/v3/test/actor-state.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/v3/test/types.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/v3/test/actor-with-scope.test.ts`,
  `/Users/cvr/Developer/personal/effect-encore/CHANGELOG.md`,
  `/Users/cvr/Developer/personal/gent/package.json`,
  `/Users/cvr/Developer/personal/gent/bun.lock`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/session-runtime.test.ts`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-runner.test.ts`.

### S4 status - partial

- **C10 complete**: external-driver tool execution now preserves
  `InteractionPendingError` as a typed external-turn failure instead of
  dying or becoming a generic MCP tool error. `ExternalToolRunner.runTool`
  exposes the pending error, the agent loop converts it to
  `InteractionRequested`, and both ACP protocol and Claude Code codemode
  executors record pending interactions across the Promise/MCP boundary
  before failing their external stream.
- **C11 complete**: cached ACP and Claude Code codemode sessions no
  longer retain the first turn's `runTool` callback authority. The
  codemode MCP server now reads a mutable `CodemodeConfig` per request,
  and both session managers refresh that config on cache hits before
  reusing the external session.
- **C12 complete for captured authority**: background bash jobs now
  capture a narrow target (`sessionId`, `branchId`, `toolCallId`, and
  the specific `Session` methods they need) and run the long-lived fork
  under an explicitly replaced process/filesystem context. Background
  delegate jobs now move the durable todo runner out of the tool closure
  and pass only the resolved agent plus `toolCallId`/`Agent.run` target
  into the background runner. Delegate keeps the existing child-fiber
  inheritance semantics; the fixed bug class is the closure over the
  whole request `ExtensionContext`, not a new independent scope model.
- **C13 partial**: stale external tool authority, external interactive
  tool parking, and background authority scope now have targeted
  regressions. Recovery-start failure deadlock still needs its specific
  regression before C13 is complete.
- Verification:
  For C10, `bun run typecheck` passed and
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/runtime/agent-loop/external-turn.test.ts packages/extensions/tests/acp-agents/acp-agents.test.ts packages/extensions/tests/acp-agents/claude-sdk-lifecycle.test.ts`
  passed.
  `bun run typecheck` passed; `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/extensions/tests/acp-agents/acp-agents.test.ts packages/extensions/tests/acp-agents/claude-sdk-lifecycle.test.ts`
  passed for C11. For C12, `bun run typecheck` passed and
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/extensions/tests/delegate/delegate-background.test.ts packages/extensions/tests/delegate/delegate-tool.test.ts packages/extensions/tests/exec-tools/bash-execution.test.ts`
  passed.
- Evidence:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:221`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:241`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:94`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:96`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:100`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:362`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:395`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:441`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:51`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:134`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor-boundary.ts:25`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:252`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:259`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:345`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:490`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:497`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:538`,
  `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/external-turn.test.ts:335`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/acp-agents/acp-agents.test.ts:538`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:41`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:233`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:244`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:279`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:127`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:378`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/acp-agents/acp-agents.test.ts:342`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:161`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:228`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:245`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:266`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:317`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:376`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:400`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:408`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:413`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:20`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:34`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:44`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:169`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:175`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:165`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:210`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:257`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:286`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:363`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/exec-tools/bash-execution.test.ts:419`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/delegate/delegate-background.test.ts:8`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/tests/delegate/delegate-tool.test.ts:1`.

### S1 - Upstream wide-event outcome and boundary API

Fix `effect-wide-event` so Gent stops hand-modeling domain outcomes and
boundary ceremony.

- **C1**: Add typed semantic outcome support upstream. The API should
  represent domain failures/warnings separately from transport
  interruption/defect failure, so Gent tools do not encode semantic
  failure as ad hoc envelope metadata.
- **C2**: Add boundary-aware helpers/adapters for RPC, actor, provider,
  and tool scopes. Gent should not remember `WideEvent.set` ordering at
  every call site.
- **C3**: Consume the upstream API in Gent by deleting local workaround
  conventions from wide-event/tool/RPC boundaries.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:24`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:53`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:238`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:315`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:256`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:639`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:42`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:56`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:197`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts:215`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts:18`,
  `/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts:33`,
  `/Users/cvr/Developer/personal/effect-wide-event/test/wide-event.test.ts:38`,
  `/Users/cvr/Developer/personal/effect-wide-event/test/wide-event.test.ts:53`.

### S2 - Upstream actor layer/state redesign

Fix `effect-encore` so Gent does not rebuild or snapshot actor runtime
internals.

- **C4**: Redesign `Actor.toLayer` around first-class entity build
  dependencies and child override semantics. Delete Gent's local
  `provideLayerBuildContext` workaround after the upstream API lands.
- **C5**: Expose a bound actor state facade/client from `Actor.toLayer`
  so Gent can watch/read/redeliver through the actor surface, not by
  reconstructing `ActorAddressResolver`, `ActorStateRegistry`,
  `ActorClientService`, storage, and sharding context.
- **C6**: Evaluate declaring entity identity once on the actor
  definition and hiding dual cluster/Encore storage tags behind one
  actor runtime storage layer.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts:24`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.runtime-context.ts:30`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:14`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:30`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:255`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:456`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.entity-id.ts:1`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts:180`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:5`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/sqlite-storage.ts:80`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:974`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:982`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1066`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1118`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1300`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1328`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1404`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:1414`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:419`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor.ts:425`,
  `/Users/cvr/Developer/personal/effect-encore/test/actor-with-scope.test.ts:52`,
  `/Users/cvr/Developer/personal/effect-encore/test/actor-with-scope.test.ts:91`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor-state.ts:35`,
  `/Users/cvr/Developer/personal/effect-encore/src/actor-state.ts:84`,
  `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:1`,
  `/Users/cvr/Developer/personal/effect-encore/src/storage.ts:145`.

### S3 - Collapse Gent runtime ownership into the actor

After upstream Encore support exists, delete Gent's duplicated runtime
ownership.

- **C7**: Reduce `SessionRuntime` to a thin actor gateway plus boundary
  validation. Move completion, state reads, queue reads, redelivery,
  diagnostics, and branch termination behind actor messages or generated
  actor client methods.
- **C8**: Collapse AgentLoop helper scopes into one actor-owned entity
  state/service object. Helpers can remain modules, but ownership should
  live in the actor entity.
- **C9**: Move run-bound extension host context construction under actor
  ownership. The actor owns `(workspaceId, sessionId, branchId, agent)`
  and profile, so host context should not be rebuilt by an external
  runtime facade.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:152`,
  `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:376`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:166`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:255`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:292`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:458`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:101`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:142`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:106`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:369`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.worker.ts:18`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:61`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:46`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:469`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts:63`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime-context.ts:78`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:234`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:510`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:812`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:86`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:807`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:1`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:313`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:266`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:636`.

### S4 - External driver and background authority correctness

Fix authority lifetime bugs introduced by external driver and background
job boundaries.

- **C10**: Preserve `InteractionPendingError` through external driver
  tool calls so interactive tools park/resume instead of becoming MCP
  text errors.
- **C11**: Make cached external codemode sessions refresh or avoid
  retaining request-scoped tool authority across later turns.
- **C12**: Replace background bash/delegate closures over
  `ExtensionContext` with narrow background job input plus runner
  services.
- **C13**: Add targeted regressions for recovery-start failure deadlock,
  external interactive tool parking, stale external tool authority, and
  background authority scope.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:148`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:219`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:363`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:408`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:42`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:92`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:106`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts:99`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:212`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:228`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/mcp-codemode.ts:234`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:252`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/executor.ts:260`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:486`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/claude-code-executor.ts:492`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:48`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/acp-agents/session-manager.ts:132`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:384`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts:421`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:78`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts:231`.

### S5 - Extension API and SDK public surface

Make authoring expressive without ceremony and make client/public
surfaces explicit.

- **C14**: Add first-class loop interception for input, context,
  tool-call preflight, and tool result handling. Keep named reactions as
  sugar over a typed event/hook model.
- **C15**: Add a session/process-scoped dynamic registration facet for
  tools/commands/actions where static buckets are too rigid.
- **C16**: Derive request/action identity from the enclosing extension
  and split simple UI actions from RPC capability ceremony.
- **C17**: Add low-ceremony scoped state helpers that lower to resources
  internally, and fix docs that mention unexported `action`.
- **C18**: Replace SDK internal RPC graph/transport exports with a
  stable client contract and exact public allow-list tests.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:179`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:199`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:156`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:274`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:332`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:359`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:52`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:78`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:39`,
  `/Users/cvr/Developer/personal/gent/docs/extensions.md:319`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts:1`,
  `/Users/cvr/Developer/personal/gent/examples/extensions/turn-counter.ts:25`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:4`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:58`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts:1`,
  `/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts:8`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts:49`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpcs.ts:181`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:37`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:338`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:222`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:280`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:46`,
  `/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:55`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1084`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1127`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:37`,
  `/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/test/agent-session-dynamic-tools.test.ts:89`.

### S6 - Durable integrity and cohesion cleanup

Close the remaining P1s and ride along P2s only when the same files are
already open.

- **C19**: Add durable foreign-key/integrity coverage for agent-loop
  queue and session operation rows. Make idempotent migrations swallow
  only known already-applied cases.
- **C20**: Split TUI client context and session controller along
  behavior boundaries after runtime/SDK shape settles.
- **C21**: Apply L1 trace/composable-method cleanup where touched:
  turn response collectors, handler nested gens, pure registry reads,
  dead wrappers, and duplicated finish-reason helpers.
- **Evidence**:
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:203`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:306`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/agent-loop-queue-storage.ts:89`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-operation-storage.ts:93`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:218`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-commands.ts:243`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:114`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:906`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:77`,
  `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:713`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:176`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-response.ts:361`,
  `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/driver-registry.ts:40`,
  `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflow-helpers.ts:18`.

## Closing audit

After S6 lands and all touched upstream packages have published/consumed
changes, run the same 9-lane audit from W41 against fresh HEAD. The
wave closes only when the closing audit reports no P0/P1. Any P2s become
the next ride-along bucket.
