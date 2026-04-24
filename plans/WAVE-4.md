# Planify: Recursive Hardening Wave 4

## Context

Wave 3 implementation completed through commit `a9d09640` and was gated.
Fresh final verification ran:

- `bun run gate` green at `a9d09640`
- `bun run test:e2e` green at `a9d09640` with 35 pass / 0 fail
- Eight independent audit lanes completed

The recursive audit still found material P2 issues across runtime ownership,
auth fail-closed behavior, extension protocol construction, external-driver
transcript handling, SDK/TUI adapters, and public behavioral coverage. This
plan supersedes Wave 3. The plan is not complete until every batch below is
implemented, gated, reviewed once, and the final recursive audit reports no
P1/P2 findings.

## Scope

- **In**: actor/runtime deletion ownership, MachineEngine termination
  serialization, public extension send/ask validation, missing-session runtime
  rejection, extension protocol constructor spoofing, provider/model auth
  fail-closed behavior, ACP live-user transcript preservation or explicit
  rejection, TUI auth/cwd adapter hardening, SDK registry process safety, and
  public behavioral coverage for the audited gaps.
- **Out**: P3 cleanup, cosmetic refactors, package-policy removal. Package
  policy removal happens only after recursive audit is clean.

## Constraints

- Correctness over pragmatism.
- Breaking changes allowed if migrated in the same wave.
- No feature cuts.
- One implementation commit per batch.
- Run `bun run gate` for every batch.
- Run `bun run test:e2e` for high-blast-radius runtime/server/SDK batches.
- Run exactly one review subagent per implementation commit.
- If a review finds real P1/P2, fix with a follow-up commit and gate again.
- Final batch reruns the same eight audit lanes. If any P1/P2 remains,
  overwrite this file with the next Planify plan and continue.

## Applicable Skills

`architecture`, `effect-v4`, `test`, `code-style`, `bun`, `planify`

## Gate Command

`bun run gate`

---

## Audit Findings

| ID    | Severity | Finding                                                                                                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                            |
| ----- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W4-1  | P2       | Session deletion terminates extension actors but not live `SessionRuntime` / `AgentLoop` actors. Active turns can outlive deleted sessions.  | `packages/core/src/server/session-commands.ts:89`, `packages/core/src/server/session-commands.ts:977`, `packages/core/src/runtime/agent/agent-loop.ts:2083`, `packages/core/src/runtime/agent/agent-loop.ts:2823`, `packages/core/src/runtime/agent/agent-loop.ts:3506`                                                                                                                             |
| W4-2  | P2       | `MachineEngine.terminateAll` bypasses the per-session mailbox and can race pending actor spawn, resurrecting deleted-session actors.         | `packages/core/src/runtime/extensions/resource-host/machine-engine.ts:227`, `packages/core/src/runtime/extensions/resource-host/machine-engine.ts:276`, `packages/core/src/runtime/extensions/resource-host/machine-lifecycle.ts:300`, `packages/core/src/runtime/extensions/resource-host/machine-lifecycle.ts:350`, `packages/core/src/runtime/extensions/resource-host/machine-lifecycle.ts:450` |
| W4-3  | P2       | Public `extension.send` / `extension.ask` trust caller-supplied `branchId`, unlike `extension.request`.                                      | `packages/core/src/server/rpc-handler-groups/extension.ts:38`, `packages/core/src/server/rpc-handler-groups/extension.ts:62`, `packages/core/src/server/rpc-handler-groups/extension.ts:101`, `packages/core/src/runtime/extensions/resource-host/machine-lifecycle.ts:49`                                                                                                                          |
| W4-4  | P2       | `SessionRuntime.dispatch` treats missing or failed session lookup as launch-cwd fallback runtime.                                            | `packages/core/src/runtime/session-runtime-context.ts:135`, `packages/core/src/runtime/session-runtime-context.ts:157`, `packages/core/src/runtime/session-runtime.ts:299`, `packages/core/src/runtime/session-runtime.ts:329`                                                                                                                                                                      |
| W4-5  | P2       | `ExtensionMessage.make(...)` lets payload overwrite `extensionId` / `_tag`, spoofing the protocol envelope.                                  | `packages/core/src/domain/extension-protocol.ts:152`, `packages/core/src/domain/extension-protocol.ts:218`, `packages/core/src/domain/extension-protocol.ts:273`, `packages/core/src/runtime/extensions/resource-host/machine-protocol.ts:124`, `packages/core/src/runtime/extensions/resource-host/machine-protocol.ts:149`                                                                        |
| W4-6  | P2       | Provider and model catalog auth paths still fail open on `AuthStore.get` failures.                                                           | `packages/core/src/providers/provider.ts:40`, `packages/core/src/providers/provider.ts:81`, `packages/core/src/runtime/model-registry.ts:207`, `packages/core/src/runtime/model-registry.ts:226`, `packages/extensions/src/openai/index.ts:129`, `packages/extensions/src/openai/index.ts:147`                                                                                                      |
| W4-7  | P2       | ACP external drivers collapse the live user turn to the first text part, silently dropping images and later parts.                           | `packages/core/src/runtime/agent/agent-loop.ts:1154`, `packages/extensions/src/acp-agents/executor.ts:133`, `packages/extensions/src/acp-agents/executor.ts:205`, `packages/extensions/src/acp-agents/claude-code-executor.ts:405`, `packages/extensions/src/acp-agents/transcript.ts:145`                                                                                                          |
| W4-8  | P2       | Command-palette “New Session” drops `cwd`, breaking project-scoped auth/config and extension requests.                                       | `apps/tui/src/client/context.tsx:639`, `apps/tui/src/components/command-palette.tsx:160`, `apps/tui/src/components/command-palette.tsx:238`, `packages/core/src/server/session-commands.ts:592`                                                                                                                                                                                                     |
| W4-9  | P2       | TUI session auth gate fails open on `auth.listProviders` errors.                                                                             | `apps/tui/src/routes/session-controller.ts:187`, `apps/tui/src/routes/session-controller.ts:197`, `apps/tui/src/routes/session-controller.ts:201`, `apps/tui/src/routes/session-controller.ts:321`                                                                                                                                                                                                  |
| W4-10 | P2       | `auth.listProviders({ sessionId })` falls back to launch cwd when the session is missing or lookup fails.                                    | `packages/core/src/server/rpc-handler-groups/config.ts:100`, `packages/core/src/server/rpc-handler-groups/config.ts:103`, `packages/core/src/runtime/config-service.ts:181`, `packages/core/src/domain/auth-guard.ts:31`                                                                                                                                                                            |
| W4-11 | P2       | SDK registry cleanup can SIGTERM an unrelated process after PID reuse.                                                                       | `packages/sdk/src/server-registry.ts:114`, `packages/sdk/src/server.ts:336`, `packages/sdk/src/server.ts:337`                                                                                                                                                                                                                                                                                       |
| W4-12 | P2       | Profile resource coverage bypasses `SessionProfileCache.Live`; live profile `layerContext` resource-backed capability execution can regress. | `packages/core/src/runtime/session-profile.ts:142`, `packages/core/tests/server/extension-commands-rpc.test.ts:252`, `packages/core/tests/runtime/session-profile.test.ts:36`                                                                                                                                                                                                                       |
| W4-13 | P2       | Recursive delete cleanup lacks public RPC acceptance for descendant stream/runtime cleanup.                                                  | `packages/core/tests/server/session-commands.test.ts:851`, `packages/core/tests/server/session-commands.test.ts:890`, `packages/core/src/server/rpc-handler-groups/session.ts:60`                                                                                                                                                                                                                   |
| W4-14 | P2       | Auth overlay OAuth callback session threading lacks successful behavioral coverage.                                                          | `apps/tui/src/routes/auth.tsx:301`, `apps/tui/src/routes/auth.tsx:349`, `apps/tui/tests/auth-route.test.tsx:240`, `apps/tui/tests/auth-route.test.tsx:328`                                                                                                                                                                                                                                          |

Clean audit lanes:

- Extension API boundary audit: no P1/P2 except W4-3 surfaced by runtime audit.
- Storage model audit: no P1/P2 at `a9d09640`.
- Suppression/boundary discipline audit: no P1/P2 at `a9d09640`.

---

## Commit 1: `fix(extensions): seal protocol message constructors`

**Justification**: Extension protocol constructors are a boundary. The
envelope fields are identity, not payload. Payloads must not overwrite `_tag`
or `extensionId`.

**Principles**:

- `boundary-discipline`: validate untrusted extension payloads at the protocol
  boundary.
- `make-impossible-states-unrepresentable`: constructor output must make spoofed
  envelopes unrepresentable.
- `fix-root-causes`: fix the shared constructor, not individual call sites.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                    | Change                                                                            | Lines    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- | -------- |
| `packages/core/src/domain/extension-protocol.ts`        | reject or stamp-over reserved payload keys for command/request/reply constructors | ~130-280 |
| `packages/core/tests/domain/extension-protocol.test.ts` | add spoofing regressions for command, request, and reply constructors             | ~1-140   |

**Verification**:

- Targeted: `bun test packages/core/tests/domain/extension-protocol.test.ts`
- Full: `bun run gate`

---

## Commit 2: `fix(extensions): validate send and ask session branches`

**Justification**: Public extension transport paths must share one session and
branch validation boundary. `send`, `ask`, and `request` are the same boundary
with different dispatch semantics.

**Principles**:

- `boundary-discipline`: validate public RPC inputs before runtime dispatch.
- `small-interface-deep-implementation`: centralize branch/session validation
  behind the extension handler group.
- `test-through-public-interfaces`: prove through public RPC calls.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                        | Change                                                                          | Lines    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| `packages/core/src/server/rpc-handler-groups/extension.ts`  | reuse a shared session/branch resolver for `send`, `ask`, and `request`         | ~30-170  |
| `packages/core/tests/server/extension-commands-rpc.test.ts` | add public tests for missing session and cross-session branch on `send` / `ask` | ~180-330 |

**Verification**:

- Targeted: `bun test packages/core/tests/server/extension-commands-rpc.test.ts`
- Full: `bun run gate`

---

## Commit 3: `fix(runtime): reject missing sessions before dispatch`

**Justification**: A deleted or unreadable session must not execute pre-turn
runtime work against launch-cwd defaults. Missing session is a command failure,
not a profile fallback.

**Principles**:

- `boundary-discipline`: dispatch is a runtime command boundary; missing durable
  session is invalid input.
- `fix-root-causes`: stop the work before AgentLoop submission.
- `prove-it-works`: use public message/session paths, not only direct state
  inspection.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                          | Change                                                                                              | Lines     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------- |
| `packages/core/src/runtime/session-runtime-context.ts`        | preserve lookup failures instead of collapsing them to `SessionMissing` for dispatch-critical paths | ~125-170  |
| `packages/core/src/runtime/session-runtime.ts`                | reject `SessionMissing` before normalizing/submitting commands                                      | ~290-335  |
| `packages/core/tests/runtime/session-runtime-context.test.ts` | cover missing/failed lookup semantics                                                               | ~300-540  |
| `packages/core/tests/server/session-commands.test.ts`         | add public/direct command regression for missing deleted session dispatch                           | ~990-1100 |

**Verification**:

- Targeted: `bun test packages/core/tests/runtime/session-runtime-context.test.ts packages/core/tests/server/session-commands.test.ts`
- Full: `bun run gate`

---

## Commit 4: `fix(runtime): terminate session loops on delete`

**Justification**: Session deletion owns the session lifecycle. Durable delete
without live loop termination leaves actors running after their session is gone.

**Principles**:

- `serialize-shared-state-mutations`: lifecycle mutation must be owned by the
  runtime that owns the actor state.
- `make-operations-idempotent`: repeated delete/terminate must be harmless.
- `test-through-public-interfaces`: descendant cleanup must be proven through
  public session deletion and streams.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                  | Change                                                                              | Lines                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------- |
| `packages/core/src/runtime/session-runtime.ts`        | add an idempotent terminate/stop API for a session id, wired to AgentLoop ownership | ~40-80, ~290-360       |
| `packages/core/src/runtime/agent/agent-loop.ts`       | expose owned loop shutdown by session id without leaking internals                  | ~2080-2130, ~2820-2860 |
| `packages/core/src/server/session-commands.ts`        | include SessionRuntime termination in recursive delete cleanup                      | ~50-105, ~940-990      |
| `packages/core/tests/server/session-commands.test.ts` | public RPC delete closes descendant streams and stops runtime-owned loops           | ~840-1010              |

**Verification**:

- Targeted: `bun test packages/core/tests/server/session-commands.test.ts`
- Full: `bun run gate`
- High risk: `bun run test:e2e`

---

## Commit 5: `fix(extensions): serialize machine termination`

**Justification**: `terminateAll` mutates the same session actor map as
publish/send/execute. It must go through the same serialized mailbox and must
account for pending spawn slots.

**Principles**:

- `serialize-shared-state-mutations`: terminate and spawn are shared actor-state
  mutations and need structural serialization.
- `fix-root-causes`: remove the race at lifecycle ownership, not by adding
  caller sleeps.
- `prove-it-works`: cover delete-during-spawn behavior.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                                      | Change                                                                    | Lines    |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| `packages/core/src/runtime/extensions/resource-host/machine-engine.ts`    | route `terminateAll` through the per-session mailbox                      | ~220-280 |
| `packages/core/src/runtime/extensions/resource-host/machine-mailbox.ts`   | add termination task priority/shape if needed                             | ~1-180   |
| `packages/core/src/runtime/extensions/resource-host/machine-lifecycle.ts` | make pending spawn cancellation/removal idempotent and non-resurrecting   | ~280-460 |
| `packages/core/tests/extensions/concurrency.test.ts`                      | add terminate-during-spawn and post-terminate no-resurrection regressions | ~1-260   |

**Verification**:

- Targeted: `bun test packages/core/tests/extensions/concurrency.test.ts`
- Full: `bun run gate`
- High risk: `bun run test:e2e`

---

## Commit 6: `fix(auth): fail closed in provider and model auth paths`

**Justification**: Auth read/decode failures are not “missing auth”. Provider
streaming and model catalog filtering must fail closed when the auth store is
unreadable.

**Principles**:

- `boundary-discipline`: preserve storage/auth boundary failures.
- `fix-root-causes`: remove the remaining fail-open catch sites, not downstream
  symptoms.
- `prove-it-works`: cover provider and catalog paths, not only auth RPC.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                                        | Change                                                                                             | Lines    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------- |
| `packages/core/src/providers/provider.ts`                                   | map auth lookup failures to `ProviderError`; allow only true missing credentials to be `undefined` | ~35-120  |
| `packages/core/src/runtime/model-registry.ts`                               | propagate auth lookup/filter failures instead of returning unfiltered catalog                      | ~200-230 |
| `packages/core/tests/providers/provider-resolution.test.ts`                 | add provider fail-closed auth lookup regression                                                    | ~1-220   |
| `packages/core/tests/server/model-registry.test.ts` or existing model tests | add model catalog fail-closed auth regression                                                      | relevant |

**Verification**:

- Targeted: `bun test packages/core/tests/providers/provider-resolution.test.ts packages/core/tests/server/model-registry.test.ts`
- Full: `bun run gate`

---

## Commit 7: `fix(acp): preserve live user message parts`

**Justification**: External drivers receive the same user intent as model
drivers. Dropping images and later text parts silently changes user input.

**Principles**:

- `fix-root-causes`: fix the transcript boundary used by ACP executors.
- `make-impossible-states-unrepresentable`: unsupported live parts should be
  explicit, not silently discarded.
- `test-through-public-interfaces`: prove through external turn execution.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                         | Change                                                                        | Lines    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------- | -------- |
| `packages/extensions/src/acp-agents/transcript.ts`           | render live user messages structurally or explicitly reject unsupported parts | ~70-180  |
| `packages/extensions/src/acp-agents/executor.ts`             | stop extracting only the first text part                                      | ~130-220 |
| `packages/extensions/src/acp-agents/claude-code-executor.ts` | stop extracting only the first text part                                      | ~400-440 |
| `packages/core/tests/extensions/transcript.test.ts`          | add live multi-part/image/text regressions                                    | ~1-220   |
| `packages/core/tests/runtime/external-turn.test.ts`          | add external driver live-user part regression                                 | ~1-220   |

**Verification**:

- Targeted: `bun test packages/core/tests/extensions/transcript.test.ts packages/core/tests/runtime/external-turn.test.ts`
- Full: `bun run gate`

---

## Commit 8: `fix(auth): keep session cwd boundaries in auth flows`

**Justification**: Auth config is project-scoped. Missing sessions and auth
read failures must not fall back to launch cwd, and the TUI must not continue
after auth-gate errors.

**Principles**:

- `boundary-discipline`: stale `sessionId` at public auth RPC is invalid input.
- `fix-root-causes`: fail closed where the wrong cwd would be chosen.
- `test-through-public-interfaces`: cover TUI callback and public auth RPC.

**Skills**: `architecture`, `effect-v4`, `react`, `test`, `code-style`, `bun`

**Changes**:

| File                                                    | Change                                                                                 | Lines    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------- |
| `packages/core/src/server/rpc-handler-groups/config.ts` | reject missing/failed session lookup for session-scoped auth listProviders             | ~90-115  |
| `apps/tui/src/routes/session-controller.ts`             | keep auth gate pending/open/error on listProviders failure instead of fail-open closed | ~180-325 |
| `apps/tui/src/routes/auth.tsx`                          | ensure callback paths retain active session id                                         | ~290-360 |
| `packages/core/tests/server/auth-rpc.test.ts`           | add stale/deleted session id auth listProviders failure coverage                       | ~1-320   |
| `apps/tui/tests/auth-route.test.tsx`                    | add successful callback session threading coverage                                     | ~220-460 |

**Verification**:

- Targeted: `bun test packages/core/tests/server/auth-rpc.test.ts apps/tui/tests/auth-route.test.tsx`
- Full: `bun run gate`

---

## Commit 9: `fix(tui): create palette sessions with cwd`

**Justification**: Every user-created session in the TUI needs workspace cwd
for project-scoped config, auth, and extension requests.

**Principles**:

- `derive-dont-sync`: derive session creation cwd from the active workspace
  instead of leaving it implicit.
- `boundary-discipline`: session creation is the boundary where cwd is recorded.
- `test-through-public-interfaces`: command palette path needs behavioral
  coverage.

**Skills**: `react`, `test`, `code-style`, `bun`

**Changes**:

| File                                          | Change                                                                | Lines    |
| --------------------------------------------- | --------------------------------------------------------------------- | -------- |
| `apps/tui/src/client/context.tsx`             | pass workspace cwd through the `createNewSession` wrapper             | ~620-650 |
| `apps/tui/src/components/command-palette.tsx` | keep command-palette call path using cwd-aware wrapper                | ~150-245 |
| `apps/tui/tests`                              | add or extend command-palette/client-context test for cwd propagation | relevant |

**Verification**:

- Targeted: relevant TUI test file(s)
- Full: `bun run gate`

---

## Commit 10: `fix(sdk): make stale registry cleanup process-safe`

**Justification**: A registry entry’s PID being alive does not prove it is still
the gent worker. Cleanup must not SIGTERM an unrelated reused PID.

**Principles**:

- `boundary-discipline`: registry files are stale external state and require
  identity validation.
- `make-operations-idempotent`: stale cleanup should remove the registry entry
  without destructive side effects unless ownership is proven.
- `prove-it-works`: cover PID-reuse behavior in SDK tests.

**Skills**: `architecture`, `test`, `code-style`, `bun`

**Changes**:

| File                                                                 | Change                                                                                                           | Lines    |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------- |
| `packages/sdk/src/server-registry.ts`                                | expose enough identity/ownership validation to distinguish stale entry from owned worker                         | ~90-140  |
| `packages/sdk/src/server.ts`                                         | only SIGTERM when registry identity proves the PID belongs to the stale gent server; otherwise remove entry only | ~320-345 |
| `packages/sdk/tests/supervisor.test.ts` or `server-registry.test.ts` | add PID-reuse/stale-entry no-SIGTERM regression                                                                  | relevant |

**Verification**:

- Targeted: `bun test packages/sdk/tests/supervisor.test.ts packages/sdk/tests/server-registry.test.ts`
- Full: `bun run gate`
- High risk: `bun run test:e2e`

---

## Commit 11: `test(server): cover live profile resources and descendant deletes`

**Justification**: Previous fixes had too much direct-runtime coverage. Public
RPC acceptance must prove live profile resource provisioning and descendant
cleanup.

**Principles**:

- `test-through-public-interfaces`: verify through RPC/client calls.
- `prove-it-works`: cover the real `SessionProfileCache.Live` path.
- `fix-root-causes`: tests should guard the actual regression surfaces.

**Skills**: `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File                                                        | Change                                                                                                 | Lines     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------- |
| `packages/core/tests/server/extension-commands-rpc.test.ts` | add RPC acceptance using `SessionProfileCache.Live` plus resource-backed `transport-public` capability | ~240-330  |
| `packages/core/tests/server/session-commands.test.ts`       | add public RPC delete parent with child/grandchild event streams closing                               | ~840-1010 |

**Verification**:

- Targeted: `bun test packages/core/tests/server/extension-commands-rpc.test.ts packages/core/tests/server/session-commands.test.ts`
- Full: `bun run gate`

---

## Commit 12: `chore(audit): rerun recursive verification`

**Justification**: The plan only closes when the same audit surface reports no
P1/P2. Audit output becomes the handoff receipt.

**Principles**:

- `prove-it-works`: final status must be backed by fresh gate/e2e/audit output.
- `test-through-public-interfaces`: final audit checks behavior, not intent.
- `encode-lessons-in-structure`: if P1/P2 remains, rewrite this plan instead of
  burying findings in chat.

**Skills**: `planify`, `architecture`, `effect-v4`, `test`, `code-style`, `bun`

**Changes**:

| File      | Change                                                                                         | Lines |
| --------- | ---------------------------------------------------------------------------------------------- | ----- |
| `PLAN.md` | overwrite with final verification receipt if no P1/P2; otherwise overwrite with next Wave plan | all   |

**Verification**:

- `bun run gate`
- `bun run test:e2e`
- Eight independent audit agents:
  1. runtime ownership / actor-model clarity
  2. extension API boundaries
  3. Effect-native AI integration
  4. storage model
  5. domain modeling / constructor discipline
  6. suppression debt / boundary discipline
  7. SDK/TUI adapter debt
  8. test taxonomy / behavioral coverage

If any P1/P2 remains, overwrite `PLAN.md` with the next recursive Planify plan
and continue.
