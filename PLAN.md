# Planify: Gent First-Principles Simplification

Status: proposed  
Updated: 2026-04-22  
Design stance: correctness over pragmatism. Maximal simplicity over migration convenience.

## Context

`gent` should be a minimal, expressive, composable agent harness. Today it is carrying too many transitional shapes:

- process-scoped policy for session-scoped behavior
- two runtime abstractions for one session loop
- two execution paths for one turn model
- generic middleware hosts for core semantics
- multiple callable extension representations
- app-specific client facets inside core
- duplicate transport surfaces

This plan rewrites the architecture around a smaller set of honest nouns and deletes the residue.

## North Star

If starting from full hindsight, `gent` should center on six nouns:

- `Server`: process-wide services only
- `Profile`: cwd-scoped extension graph and policy
- `SessionRuntime`: the single session actor, inbox, checkpoint, and snapshot source
- `Capability`: the single callable primitive
- `Resource`: long-lived services, schedules, machines, event handlers
- `Projection`: pure derived views for prompts, context, runtime, and client state

Everything else is adapter code and should stay thin.

## Research Basis

| Finding                                                                                                                                | Principles                                                                                                  | File Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permission rules are loaded globally at startup even though runtime profiles are cwd-scoped.                                           | `correctness-over-pragmatism`, `boundary-discipline`, `derive-dont-sync`                                    | `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts:252-276`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts:72-150`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts:95-145`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Runtime truth is duplicated across `AgentLoop`, `ActorProcess`, checkpoint state, and transport DTOs.                                  | `derive-dont-sync`, `make-impossible-states-unrepresentable`, `fix-root-causes`                             | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts:168-320`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.checkpoint.ts:1-43`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:1449-1484`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:1553-1623`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:1721-1853`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts:88-126`; `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts:232-244`; `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts:126-177` |
| Turn execution still forks into separate provider-stream and external-driver collectors.                                               | `small-interface-deep-implementation`, `boundary-discipline`, `subtract-before-you-add`                     | `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:405-500`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:727-1000`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:2038-2089`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Generic pipelines and subscriptions carry core semantics like prompt shaping, permission checks, input transforms, and turn observers. | `encode-lessons-in-structure`, `small-interface-deep-implementation`, `progressive-disclosure`              | `/Users/cvr/Developer/personal/gent/packages/core/src/domain/pipeline.ts:1-64`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/pipeline-host.ts:1-105`; `/Users/cvr/Developer/personal/gent/packages/core/src/domain/subscription.ts:1-62`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/subscription-host.ts:1-132`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:112-127`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts:238-248`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:357-381`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts:541-547`                      |
| Capability unification is still bridged back into tool/query/mutation/command shapes.                                                  | `subtract-before-you-add`, `migrate-callers-then-delete-legacy-apis`, `small-interface-deep-implementation` | `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts:67-220`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/capability-host.ts:43-220`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:72-208`; `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:196-291`; `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts:119-157`; `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:475-559`                                                                                                                                                                                                         |
| TUI client facets live in core and define a second extension system with `_kind` unions.                                               | `boundary-discipline`, `small-interface-deep-implementation`, `redesign-from-first-principles`              | `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-client.ts:1-25`; `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-client.ts:56-172`; `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/resolve.ts:94-315`; `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx:94-164`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| REST duplicates RPC and the SDK still carries dead topology distinctions.                                                              | `boundary-discipline`, `subtract-before-you-add`, `encode-lessons-in-structure`                             | `/Users/cvr/Developer/personal/gent/packages/core/src/server/http-api.ts:1-65`; `/Users/cvr/Developer/personal/gent/packages/core/src/server/server-routes.ts:76-124`; `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts:78-559`; `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts:1-9`; `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts:69-74`; `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts:249-330`                                                                                                                                                                                                                                                                                              |

## Scope

**In**

- redesign runtime architecture around `Server`, `Profile`, `SessionRuntime`
- reduce extension primitives to `Capability`, `Resource`, `Projection`
- delete generic middleware where explicit structure is simpler
- move client facets out of core
- delete dead transport surfaces

**Out**

- feature additions
- provider/model capability expansion
- prompt/content product changes
- UI cosmetics

## Constraints

- No feature loss.
- Redesign is allowed and preferred when it produces a smaller honest architecture.
- Sequential commits only.
- Each commit must be independently shippable.
- High-blast-radius steps may be split into adjacent sub-commits, but the design target must stay intact.
- Legacy surfaces should be deleted once callers are migrated in the same wave.
- Compatibility is not a goal by itself. Preserve only deliberate product contracts.

## Applicable Skills

- `planify`
- `architecture`
- `effect-v4`
- `code-style`
- `bun`
- `test`
- `counsel`
- `react` for TUI edge work

## Gate Command

`bun run gate`

## Semantic Contracts

The redesign is allowed to delete surfaces. It is not allowed to delete these behaviors.

### Runtime Contracts

- Session and branch isolation remains exact: concurrent sessions run independently; interrupts, queue state, and recovery stay scoped to one session/branch.
- Loop creation remains serialized per session/branch.
- Follow-up batching, interjection priority, continuation after tool calls, and turn completion semantics remain unchanged.
- Interaction parking, interrupt during waiting, no-op response outside waiting, and resume-without-extra-model-call semantics remain unchanged.
- Checkpoint recovery remains cursor-correct: running recovery completes, idle recovery resumes queued work, incompatible versions start fresh.
- Runtime snapshot and watch output must come from the same state model.
- External-driver turns and model-backed turns must preserve the same user-visible turn lifecycle while keeping external tool activity observability-only.

Locked by:

- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/external-turn.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/session-queries.test.ts`

### Profile And Policy Contracts

- Session cwd controls auth/provider policy and permission behavior.
- Server-style and per-cwd-style profile resolution must stay observably equivalent.
- Extension wiring through the runtime profile must not drift between startup paths.

Locked by:

- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/auth-rpc.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/runtime-profile.test.ts`

### Extension Contracts

- Scope precedence remains identity-first: higher-precedence entries shadow lower-precedence ones even when the winner narrows audience or intent.
- Capability decode/encode validation, audience filtering, intent filtering, and typed errors remain unchanged.
- The final request boundary must still support full RPC round-trips for task-tool read/write flows.
- Slash-command listing and invocation semantics remain intact.
- Resource lifecycle ordering, schedule/machine round-tripping, and bus semantics remain intact.

Locked by:

- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/capability-host.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/task-tools/task-rpc.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/server/extension-commands-rpc.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/registry.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/resource-host.test.ts`

### Explicit Seam Contracts

- Removing generic pipeline/subscription primitives is only valid if their behavior is re-expressed explicitly:
  - prompt rewriting and ordered composition
  - ACP codemode prompt rewrite
  - permission/input transforms
  - turn-reaction failure semantics equivalent to continue/isolate/halt
- The explicit seams must be directly tested after the migration; deleting the old host tests without replacement is not allowed.

Locked by:

- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/pipeline-host.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/subscription-host.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/acp-prompt-pipeline.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/auto-integration.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/handoff.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/interaction-tools/ask-user.test.ts`

### TUI Contracts

- TUI extension discovery remains deterministic and hidden/test-only filtering remains intact.
- Per-slot resolution semantics remain intact: renderer/widget/command/overlay/interaction-renderer/composer/border-label/autocomplete conflict rules do not drift.
- Session switching, stale-response gating, reconnect behavior, and headless completion behavior remain unchanged.
- Slash parsing and autocomplete behavior remain unchanged.

Locked by:

- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extensions-resolve.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-integration.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/extension-lifecycle.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/client-session-state.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/headless-runner.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/headless-cli-exit.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/slash-commands.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/autocomplete.test.ts`

### SDK And Transport Contracts

- Owned and attached server flows remain intact.
- Supervisor lifecycle readiness, failure, restart, and cleanup semantics remain intact.
- RPC remains the application contract; deleting REST is acceptable because the suite does not establish REST as a required product surface.

Locked by:

- `/Users/cvr/Developer/personal/gent/packages/sdk/tests/client.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/tests/local-supervisor.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/sdk/tests/supervisor.test.ts`

## Per-Commit Review Protocol

Every commit follows this sequence:

1. implement only the files listed in the commit section
2. run `bun run gate`
3. commit with the exact conventional commit message from the plan
4. run `okra counsel` against `HEAD` and the matching plan section
5. if counsel flags issues: fix, rerun `bun run gate`, update the commit, rerun counsel
6. proceed only after gate and counsel are clean

Standard counsel prompt:

```text
Review HEAD against PLAN.md section "[Commit N title]".

Plan:
[paste the exact commit section]

Diff:
[git show --stat --patch --format=medium HEAD]

Check:
1. Scope drift or hidden extra work
2. Principle compliance
3. Missing deletions or leftover bridges
4. Problems the gate would not catch

Flag issues only. Ground claims in file paths.
```

Between waves, run `okra counsel --deep` on the full wave diff against this plan.

## Wave 1: Runtime Truth

Goal: establish one honest architecture for process scope, cwd scope, session scope, and turn execution.

## Commit 1: fix(core): make Profile the owner of cwd-scoped policy

**Justification**: `Profile` is not real if permissions and driver policy still leak from process startup. Make cwd-scoped policy resolve once in `Profile` and nowhere else.

**Principles**

- `correctness-over-pragmatism`: session policy must be derived from the session cwd
- `boundary-discipline`: process scope and cwd scope must not be conflated
- `derive-dont-sync`: resolve policy from the same profile graph as extensions and drivers

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`, `counsel`

**Changes**

| File                                                                                   | Change                                                                                 | Lines      |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/dependencies.ts`          | remove global permission-rule assembly from server boot                                | `~252-276` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/profile.ts`              | make runtime profile resolution return cwd-scoped policy and driver configuration      | `~95-145`  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-profile.ts`      | cache profile policy alongside loaded extensions and registries                        | `~46-150`  |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/actor-process.test.ts` | add multi-cwd regression covering permission isolation until `ActorProcess` is deleted | `~1-245`   |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: two sessions with different cwd configs do not share policy
- preserve `auth.listProviders` session-cwd routing semantics

## Commit 2: refactor(core): introduce SessionRuntime as the only public session engine

**Justification**: there should be one public runtime abstraction for a session. `ActorProcess` and `AgentLoop` as separate public concepts are architecture debt.

**Principles**

- `small-interface-deep-implementation`: expose one runtime service
- `boundary-discipline`: transport and storage talk to `SessionRuntime`, not loop internals
- `encode-lessons-in-structure`: make the correct ownership unavoidable in module layout

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`, `counsel`

**Changes**

| File                                                                               | Change                                                               | Lines                |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`  | add new public runtime service and contract                          | new                  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts` | demote to internal implementation detail behind `SessionRuntime`     | `~1627-1682`         |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`    | shrink to temporary adapter or redirect entirely to `SessionRuntime` | `~111-127`           |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`      | switch transport handlers to the new runtime service                 | `~80-99`, `~193-275` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`   | read runtime state from `SessionRuntime`                             | `~126-177`           |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: all existing session actions flow through `SessionRuntime`
- preserve all runtime contracts listed in `Semantic Contracts`

## Commit 3: refactor(core): make SessionRuntime the only owner of inbox, queue, checkpoint, and snapshot

**Justification**: the loop state, pending refs, checkpoint payload, and transport snapshot are four versions of the same truth. Collapse them into one runtime-owned model.

**Principles**

- `derive-dont-sync`: one inbox, one queue, one checkpoint state
- `make-impossible-states-unrepresentable`: remove dead runtime/status combinations
- `fix-root-causes`: delete pending side channels instead of reconciling them

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`, `counsel`

**Changes**

| File                                                                                          | Change                                                                                             | Lines                      |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`      | replace current public loop state projection with the internal `SessionRuntime` state model        | `~168-320`                 |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.checkpoint.ts` | shrink checkpoint schema to mailbox plus resumable cursor                                          | `~1-43`                    |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`            | delete `pendingQueueRef` and `pendingQueuesRef`; centralize queue mutation and snapshot derivation | `~1449-1484`, `~1721-1853` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`           | replace duplicate runtime DTOs with one shared session-runtime snapshot shape                      | `~232-244`                 |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop.test.ts`           | tighten queue, interaction, and recovery tests against the new single-owner model                  | `~420-717`, `~1157-1745`   |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: queue, checkpoint restore, and snapshot all agree
- preserve interaction parking/resume/interrupt semantics

## Commit 4: refactor(core): unify provider and external driver execution under one TurnEvent stream

**Justification**: there is only one turn model. Driver kind should not fork the runtime above the driver boundary.

**Principles**

- `small-interface-deep-implementation`: one turn collector
- `boundary-discipline`: drivers emit `TurnEvent`; runtime consumes `TurnEvent`
- `subtract-before-you-add`: delete duplicate collectors and drifted semantics

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`, `counsel`

**Changes**

| File                                                                                | Change                                                               | Lines                                 |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts`             | define the unified runtime-visible turn stream contract              | `~272-320`                            |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.ts`  | replace provider/external split collectors with one `TurnEvent` path | `~405-500`, `~727-1000`, `~2038-2089` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/providers/provider.ts`        | adapt model providers to the unified turn stream contract            | `~1-220`                              |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop.test.ts` | cover identical semantics for model and external driver turns        | `~1157-1745`                          |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: provider-backed and external-driver-backed turns produce the same runtime behavior
- preserve external-tool observability-only semantics

## Commit 5: refactor(core): delete ActorProcess and route all runtime access through SessionRuntime

**Justification**: once `SessionRuntime` owns runtime truth, `ActorProcess` has no principled reason to exist.

**Principles**

- `subtract-before-you-add`: delete dead facades
- `boundary-discipline`: transport and clients depend on runtime services, not actor wrappers
- `encode-lessons-in-structure`: keep one runtime entry point

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`, `counsel`

**Changes**

| File                                                                                   | Change                                                                           | Lines                |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/actor-process.ts`        | delete file or reduce to a private compatibility shim removed in the same commit | `~1-260`             |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`          | remove `ActorProcess` dependency and call `SessionRuntime` directly              | `~80-99`, `~121-275` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/session-queries.ts`       | stop reading runtime state through `ActorProcess`                                | `~144-177`           |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/actor-process.test.ts` | delete or replace with `SessionRuntime` acceptance tests                         | `~1-245`             |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: runtime APIs still behave with `ActorProcess` gone
- preserve owned/attached server-facing runtime behavior

## Wave 1 Exit Criteria

- `Profile` owns cwd-scoped policy
- `SessionRuntime` is the single public session engine
- queue, checkpoint, inbox, and snapshot all come from one state model
- driver kind no longer forks runtime logic above the driver boundary
- `ActorProcess` is deleted

Run `okra counsel --deep` on the full Wave 1 diff before Wave 2.

## Wave 2: Primitive Reduction

Goal: reduce the extension model to `Capability`, `Resource`, and `Projection`.

## Commit 6: refactor(core): replace generic pipeline and subscription hooks with explicit runtime slots

**Justification**: generic keyed middleware is hiding core control flow. Simpler architecture uses explicit, finite seams for prompt shaping, input normalization, permission policy, and runtime reactions.

**Principles**

- `encode-lessons-in-structure`: make extension seams explicit in types, not stringly hook registries
- `progressive-disclosure`: expose only the minimal extension points
- `small-interface-deep-implementation`: fewer primitives, stronger semantics

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`, `counsel`

**Changes**

| File                                                                              | Change                                                                   | Lines      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/pipeline.ts`         | delete public pipeline primitive or reduce to private migration shim     | `~1-64`    |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/subscription.ts`     | delete public subscription primitive or reduce to private migration shim | `~1-62`    |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts`         | add explicit runtime reaction slots where long-lived behavior belongs    | `~180-260` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/projection.ts`       | expand projection role for prompt/context/runtime derivation             | `~1-220`   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts` | own explicit input, prompt, policy, and turn-reaction seams              | new        |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: explicit slots cover existing prompt/input/policy/reaction use cases
- add replacement tests for every deleted pipeline/subscription behavior class

## Commit 7: refactor(core): migrate builtins off Pipeline and Subscription and delete their hosts

**Justification**: the primitive reduction is not real until builtins stop relying on middleware registries.

**Principles**

- `migrate-callers-then-delete-legacy-apis`: move builtin callers, then delete the hosts
- `subtract-before-you-add`: remove middleware engines once explicit seams exist
- `boundary-discipline`: extensions declare what they are, not what registry key they patch

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`, `counsel`

**Changes**

| File                                                                                           | Change                                                                         | Lines                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------ |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/pipeline-host.ts`     | delete host                                                                    | `~1-105`                                   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/subscription-host.ts` | delete host                                                                    | `~1-132`                                   |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`          | remove pipeline/subscription compilation from resolved extension graph         | `~18-21`, `~44-47`, `~273-304`, `~426-483` |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/session-tools/index.ts`            | migrate prompt shaping to explicit projection/runtime slot                     | `~1-80`                                    |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/auto.ts`                           | migrate tool-result and turn-after behavior to explicit resource/runtime seams | `~666-667`                                 |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff.ts`                        | migrate turn-after behavior to explicit resource/runtime seams                 | `~130-130`                                 |
| `/Users/cvr/Developer/personal/gent/packages/core/tests/extensions/`                           | rewrite middleware-host tests around explicit seams                            | `~all relevant`                            |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: no builtin behavior still depends on pipeline/subscription hosts
- ACP codemode prompt rewriting and auto/handoff workflows stay green

## Commit 8: refactor(core): make Capability the only callable substrate and collapse request surfaces

**Justification**: callable behavior should have one internal representation and one public request boundary. Tool/query/mutation/command bridges are migration residue.

**Principles**

- `small-interface-deep-implementation`: one callable substrate
- `subtract-before-you-add`: delete bridge layers and duplicate routing
- `migrate-callers-then-delete-legacy-apis`: move request callers, then remove legacy invoke APIs

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`, `counsel`

**Changes**

| File                                                                                          | Change                                                           | Lines      |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability.ts`                   | seal the internal callable model around one capability node type | `~67-220`  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/capability-host.ts`  | keep one dispatcher and simplify audience handling               | `~43-220`  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`         | delete tool/query/mutation/command lowering                      | `~72-208`  |
| `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`                      | expose only the final public authoring/request surface           | `~196-291` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/make-extension-host-context.ts` | replace `query`/`mutate` with one request invocation surface     | `~119-157` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`           | reduce extension invocation to one request payload shape         | `~346-372` |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`                 | collapse duplicate request handlers into one entry point         | `~475-535` |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools/queries.ts`            | migrate read callers to the final request surface                | `~1-127`   |
| `/Users/cvr/Developer/personal/gent/packages/extensions/src/task-tools/mutations.ts`          | migrate write callers to the final request surface               | `~1-220`   |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: all callable extension flows hit the same capability substrate
- preserve capability audience/intent shadow semantics and task RPC round-trips

## Wave 2 Exit Criteria

- public extension model is `Capability`, `Resource`, `Projection`
- generic pipeline/subscription primitives and hosts are deleted
- one request boundary remains
- capability bridges are deleted

Run `okra counsel --deep` on the full Wave 2 diff before Wave 3.

## Wave 3: Edge Simplification

Goal: keep app-specific client facets at the app edge and delete dead transport adapters.

## Commit 9: refactor(tui): move client facets out of core and redesign TUI extension edges

**Justification**: TUI renderers, widgets, overlays, and commands are app concerns. Core should export ids, refs, runtime events, and projections, not a second client extension system.

**Principles**

- `boundary-discipline`: app facets belong at the app edge
- `redesign-from-first-principles`: do not align the TUI model with core by adding another bridge
- `small-interface-deep-implementation`: core stays small; TUI owns TUI

**Skills**: `architecture`, `code-style`, `react`, `bun`, `test`, `counsel`

**Changes**

| File                                                                              | Change                                                             | Lines           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-client.ts` | delete or move out of core                                         | `~1-229`        |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts`     | create TUI-owned client facet model                                | new             |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/discovery.ts`         | keep discovery thin and TUI-local                                  | `~1-103`        |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/resolve.ts`           | rebuild resolver against TUI-local facets                          | `~1-331`        |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/`            | migrate builtin client extensions to the new TUI-local facet model | `~all relevant` |
| `/Users/cvr/Developer/personal/gent/apps/tui/tests/extensions-resolve.test.ts`    | rewrite around TUI-local facets                                    | `~1-260`        |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: TUI extension precedence and collisions still work with core client facets gone
- preserve all per-slot resolution semantics listed in `Semantic Contracts`

## Commit 10: refactor(tui): split transport, lifecycle, and session-view state into focused surfaces

**Justification**: the current client context is a god object. Simpler TUI architecture uses smaller focused surfaces and derived view hooks.

**Principles**

- `progressive-disclosure`: consumers depend on the smallest surface they need
- `composition-over-flags`: compose focused providers and hooks
- `small-interface-deep-implementation`: thinner public context, deeper internals

**Skills**: `architecture`, `code-style`, `react`, `bun`, `test`, `counsel`

**Changes**

| File                                                                          | Change                                              | Lines                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------- |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`          | split wide context into focused providers and hooks | `~94-164`, `~202-327`, `~433-780` |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts`   | consume focused runtime/session surfaces            | `~256-408`                        |
| `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-child-sessions.ts` | consume minimal runtime/session surface             | `~25-116`                         |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: session switching, reconnect behavior, and extension pulse refreshes still work
- preserve headless completion behavior and stale-response gating

## Commit 11: refactor(server): delete REST and collapse SDK topology to the real transport model

**Justification**: RPC is the real contract. REST and dead topology aliases are adapter residue and should be removed unless they are deliberate product surfaces.

**Principles**

- `subtract-before-you-add`: delete dead adapters
- `boundary-discipline`: one transport contract
- `encode-lessons-in-structure`: split RPC handlers by concern while keeping one real edge

**Skills**: `architecture`, `effect-v4`, `code-style`, `bun`, `test`, `counsel`

**Changes**

| File                                                                           | Change                                                                                | Lines            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ---------------- |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/http-api.ts`      | delete REST contract                                                                  | `~1-65`          |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/server-routes.ts` | assemble only RPC and product-owned support routes                                    | `~76-124`        |
| `/Users/cvr/Developer/personal/gent/packages/core/src/server/rpc-handlers.ts`  | split handler assembly by concern while keeping RPC as the only application transport | `~78-559`        |
| `/Users/cvr/Developer/personal/gent/packages/sdk/src/server.ts`                | remove dead `remote` topology and simplify server shape                               | `~1-9`, `~69-74` |
| `/Users/cvr/Developer/personal/gent/packages/sdk/src/client.ts`                | collapse client constructors onto the real transport model                            | `~249-330`       |

**Verification**

- `bun run gate`
- counsel review against this commit section
- targeted regression: owned and attached server flows still work with REST deleted
- preserve supervisor lifecycle semantics and SDK constructor behavior

## Final Verification

After Commit 11:

1. run `bun run gate`
2. run `okra counsel --deep` on the full branch against this entire plan
3. review for:
   - scope drift
   - principle violations
   - leftover bridges or dead adapters
   - duplicated representations of the same truth
   - missing tests around the new core nouns
   - any semantic contract listed above that no longer has a direct regression lock

## Done Means

- `Server` owns only process-wide services
- `Profile` owns cwd-scoped policy and extension graph
- `SessionRuntime` is the only public session engine
- `Capability`, `Resource`, and `Projection` are the only core extension primitives
- provider and external drivers share one turn execution model
- client facets live at the app edge, not in core
- RPC is the only application transport
