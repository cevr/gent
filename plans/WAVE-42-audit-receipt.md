# Wave 42 audit receipt

## Frame

- **Wave**: W42 closing pass for W41 requirement-ownership findings.
- **Start HEAD**: `22e23c41`
  (`refactor(runtime): isolate agent loop context adapter`).
- **Implementation HEAD**: `a56c50d4`
  (`feat(extensions): add hooks and dynamic registrations`).
- **Closing audit HEAD**:
  `a56c50d48b3520f6382a9eda5c51485162f0e487`.
- **P0**: none.
- **P1**: none.
- **Disposition**: W42 closes. The original W41 P1 set is either fixed
  directly in Gent or fixed upstream through changeset/release/consume
  flow for owned packages.

## Implementation commits

- `59a5c9bc` - `docs(plan): close wave 41`
- `86c570ae` - `refactor(runtime): use upstream wide event outcomes`
- `8e574e51` - `refactor(runtime): use actor state client`
- `4e2f525c` - `refactor(runtime): use upstream actor build context`
- `694aa5d7` - `fix(extensions): refresh codemode tool authority`
- `1d191de6` - `refactor(extensions): narrow background job authority`
- `504169c5` - `fix(runtime): preserve external interaction parking`
- `fb531a4e` - `fix(runtime): avoid recovery startup cleanup deadlock`
- `b09c78de` - `fix(runtime): hide actor protocol requirements`
- `cac7e737` - `fix(storage): enforce durable projection integrity`
- `2ccc4918` - `style(effect): pipe wrapper-style calls`
- `1f041068` - `test(lint): ban wrapper-style with calls`
- `77338352` - `test(sdk): guard public surface`
- `a9506cff` - `docs(extensions): remove unpublished action api`
- `2489b1a8` - `feat(extensions): add scoped state resource helper`
- `beaf574a` - `feat(extensions): derive request refs from extension`
- `d93f4d44` - `refactor(tui): split client controller behavior`
- `a04849c0` - `refactor(runtime): flatten cleanup wrappers`
- `efd67a1a` - `refactor(runtime): route metrics through actor`
- `27862d46` - `refactor(runtime): collapse agent loop scopes`
- `f2b79b8e` - `refactor(runtime): route extension requests through actor`
- `ca0b7c46` - `refactor(runtime): move submit completion into actor`
- `a56c50d4` - `feat(extensions): add hooks and dynamic registrations`

## Tally

| Lane      | Focus                                                |    P0 |    P1 |    P2 |
| --------- | ---------------------------------------------------- | ----: | ----: | ----: |
| L1        | Effect simplicity + composable methods               |     0 |     0 |     0 |
| L2        | Runtime, actor, and request boundaries               |     0 |     0 |     0 |
| L3        | Requirement ownership and scoped services            |     0 |     0 |     0 |
| L4        | Schema, storage, and durable integrity               |     0 |     0 |     0 |
| L5        | Public and acceptance contracts                      |     0 |     0 |     0 |
| L6        | File and module cohesion                             |     0 |     0 |     0 |
| L7        | Extension API expressiveness and ceremony            |     0 |     0 |     0 |
| L8        | Architecture simplification against actor north star |     0 |     0 |     0 |
| L9        | Owned upstream package leverage                      |     0 |     0 |     0 |
| **Total** |                                                      | **0** | **0** | **0** |

## Verification

- `bun run gate` passed at W42 HEAD.
- Focused final C7 verification passed:
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/runtime/session-runtime.test.ts packages/core/tests/runtime/agent-loop/actor-command.test.ts packages/core/tests/server/extension-commands-rpc.test.ts`.
- Focused final C14/C15 verification passed:
  `bun test --preload ./packages/tooling/src/test-log-preload.ts packages/core/tests/extensions/extension-reactions.test.ts packages/core/tests/runtime/tool-runner.test.ts`.
- `git diff --check` passed before both final commits.

## Lane Results

### L1 - Effect simplicity + composable methods

No P0/P1. The wrapper-style `withX(innerCall(...))` cleanup is complete
and now has a guardrail, and the touched runtime helpers keep named
`Effect.fn` boundaries.

**Evidence**:
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:492`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:520`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:257`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:207`,
`/Users/cvr/Developer/personal/gent/packages/tooling/src/check-guardrails.ts`,
`/Users/cvr/Developer/personal/gent/packages/tooling/tests/suppression-inventory.test.ts`.

### L2 - Runtime, actor, and request boundaries

No P0/P1. Runtime completion, state, metrics, queue, extension request,
and branch termination paths are now actor operations or generated
actor state/control facades.

**Evidence**:
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:261`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:323`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:374`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:424`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:458`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts:235`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts:323`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts:332`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts:366`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts:377`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:492`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:520`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:649`,
`/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/session-runtime.test.ts`,
`/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/actor-command.test.ts`.

### L3 - Requirement ownership and scoped services

No P0/P1. Requirement hiding follows the corrected rule: service-owned
requirements may be captured and internally provided by the owning
service; public methods do not leak actor protocol or profile authority
as parameters.

**Evidence**:
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:266`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:280`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:144`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:147`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-profile.ts:24`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:212`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:362`,
`/Users/cvr/Developer/personal/gent/packages/extensions/src/exec-tools/bash.ts`,
`/Users/cvr/Developer/personal/gent/packages/extensions/src/delegate/delegate-tool.ts`.

### L4 - Schema, storage, and durable integrity

No P0/P1. Durable projection integrity is covered by foreign-key
coverage for queue/operation rows and hardened idempotent migrations.

**Evidence**:
`/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:203`,
`/Users/cvr/Developer/personal/gent/packages/core/src/storage/schema.ts:306`,
`/Users/cvr/Developer/personal/gent/packages/core/src/storage/agent-loop-queue-storage.ts:89`,
`/Users/cvr/Developer/personal/gent/packages/core/src/storage/session-operation-storage.ts:93`,
`/Users/cvr/Developer/personal/gent/packages/core/tests/storage/sqlite-schema.test.ts`,
`/Users/cvr/Developer/personal/gent/packages/core/tests/storage/session-operation-storage.test.ts`.

### L5 - Public and acceptance contracts

No P0/P1. SDK public exports are allow-listed, internal transport
constructors stay out of the public runtime surface, and request refs
derive extension identity from `defineExtension`.

**Evidence**:
`/Users/cvr/Developer/personal/gent/packages/sdk/src/index.ts:1`,
`/Users/cvr/Developer/personal/gent/packages/sdk/src/namespaced-client.ts:4`,
`/Users/cvr/Developer/personal/gent/packages/sdk/tests/public-surface.test.ts`,
`/Users/cvr/Developer/personal/gent/packages/tooling/tests/core-public-exports.test.ts`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:52`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:78`,
`/Users/cvr/Developer/personal/gent/packages/core/tests/domain/capability-ref.test.ts`,
`/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/define-extension.test.ts`.

### L6 - File and module cohesion

No P0/P1. The TUI client split moved event hub and controller behavior
out of the prior god surfaces while preserving focused coverage.

**Evidence**:
`/Users/cvr/Developer/personal/gent/apps/tui/src/client/event-hub.ts:14`,
`/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:328`,
`/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts:453`,
`/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-command-registry.ts:76`,
`/Users/cvr/Developer/personal/gent/apps/tui/tests/client-session-state.test.tsx`,
`/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts`,
`/Users/cvr/Developer/personal/gent/apps/tui/tests/composer-render.test.tsx`.

### L7 - Extension API expressiveness and ceremony

No P0/P1. Extension authors now have hook primitives, low-ceremony
state resources, derived request identity, and runtime dynamic
registration without passing privileged host requirements as params.

**Evidence**:
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:158`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:189`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:213`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts:22`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts:48`,
`/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts`,
`/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:332`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:28`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:207`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-reactions.ts:338`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:215`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:258`,
`/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/extension-reactions.test.ts:182`,
`/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/tool-runner.test.ts:92`,
`/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/index.ts:222`,
`/Users/cvr/.cache/repo/anomalyco/opencode/packages/plugin/src/tool.ts:46`,
`/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/types.ts:1084`.

### L8 - Architecture simplification against actor north star

No P0/P1. `SessionRuntime` is now a thin gateway; actor-owned helpers
carry private state directly instead of fake Context scopes; dynamic and
extension request work dispatches through actor/host boundaries.

**Evidence**:
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts:261`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:106`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.behavior.ts:288`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.queue.ts:36`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.worker.ts:18`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:62`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:520`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts:867`,
`/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/session.ts:510`,
`/Users/cvr/.cache/repo/anomalyco/opencode/packages/opencode/src/session/processor.ts:86`,
`/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/agent-session.ts:313`,
`/Users/cvr/.cache/repo/badlogic/pi-mono/packages/coding-agent/src/core/extensions/runner.ts:266`.

### L9 - Owned upstream package leverage

No P0/P1. Owned package issues were fixed upstream, tested with
`file:..`, released via changesets/release PR, and consumed from npm
`latest`; Gent no longer carries local upstream workarounds for those
surfaces.

**Evidence**:
`/Users/cvr/Developer/personal/effect-wide-event/src/wide-event.ts`,
`/Users/cvr/Developer/personal/effect-wide-event/src/boundary.ts`,
`/Users/cvr/Developer/personal/effect-wide-event/.changeset/tall-walls-serve.md`,
`/Users/cvr/Developer/personal/effect-encore/src/actor.ts`,
`/Users/cvr/Developer/personal/effect-encore/src/actor-state.ts`,
`/Users/cvr/Developer/personal/effect-encore/src/storage.ts`,
`/Users/cvr/Developer/personal/effect-encore/CHANGELOG.md`,
`/Users/cvr/Developer/personal/gent/package.json:59`,
`/Users/cvr/Developer/personal/gent/bun.lock:685`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/wide-event-boundary.ts:13`,
`/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.actor.ts:10`.

## Residual Risk

No residual P0/P1/P2 findings from this closing audit. Future work should
start from fresh product direction rather than extending W42.
