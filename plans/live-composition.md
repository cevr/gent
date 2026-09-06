# Live composition

Status: implementation and validation complete for this goal. See
[the completion audit](live-composition-review.md) for current evidence and limits.
The checkpoints below preserve the work history. Their open-item notes describe
the state at that checkpoint, not the final status. The user has authorized
commits and a local main merge. No remote push is part of this handoff.
Research: [malleability and harness prior art](../docs/research/2026-09-06-malleability-and-harness-prior-art.md).

## Outcome

Users can change supported tools, providers, and extension resources while Gent
runs. Conversations and durable pending interactions survive. Unchanged resources
stay running. The terminal follows FX's layout and interaction standard.

## Ownership

| Concern                                          | Owner                                            |
| ------------------------------------------------ | ------------------------------------------------ |
| Desired graph, identity, dependency policy       | Gent pure domain planner                         |
| Local resource lifecycle                         | Effect Machine                                   |
| Acquisitions and registered cleanup              | Effect Layer and Scope                           |
| Durable graph commands and recovery              | Effect Encore at the Gent runtime boundary       |
| Tool binding, admission, and catalog publication | Gent resource host and extension dispatch        |
| Session execution and durable interactions       | Existing SessionRuntime and branch actor         |
| Terminal presentation                            | Existing OpenTUI client, with FX as the standard |

The user explicitly requested Effect Machine dogfooding on 2026-09-06.
Use it for the resource lifecycle, not as a second actor around AgentLoop.
The pure planner does not need a machine. Loading, active use, retirement, and
cleanup do: they have async work, invalid transitions, cancellation, and failure.

Machine should expose the actual lifecycle state. Do not retain a competing mutable
status field beside it. Host-owned handles remain in scoped services, not in durable
state schemas. Encore stores desired/applied revisions; it does not serialize live
Effect scopes. A restart reacquires resources from durable intent.

## Delivery batches

Each batch needs a full gate and focused behavior checks. Preserve the current
dirty migration work.

The user authorized the owned-library release flow on 2026-09-06. Fix reusable
Machine or Encore behavior and developer-experience gaps upstream. Add a Changeset,
commit, push, complete the automatic version PR flow, and verify npm publication.
Then update Gent to the published version and validate again. Do not leave a local
`file:` dependency or a Gent workaround in place of that repair. This authority
does not include unrelated releases or a Gent push.

### 1. Identity and pure graph

- Require explicit stable IDs in author declarations. Do not derive IDs from array
  positions, service tag strings, or object identity.
- Declare revision and runtime requirements. Static resources can use revision `1`.
  Configuration-dependent resources must change revision when their semantics change.
- Reject duplicate IDs and cycles before any host mutation.
- Suspend optional components with unavailable requirements. Reject a plan when a
  required root cannot activate. Report transitive missing requirements.
- Compute dependency-first start order, reverse stop order, and affected dependents.
- Test graph reordering and unchanged revisions as no-ops.

### 2. Scoped lifecycle with Effect Machine

- Give each resource its own acquisition scope and lifecycle actor.
- Keep one immutable resource revision per lifecycle instance. The graph host
  owns replacement; the local actor owns activation and retirement only.
- Connect typed start/stop outcomes to machine states and inspection receipts.
- Preserve sequential transition ownership while load or cleanup is in progress.
- Do not cancel cleanup merely because a newer desired revision arrives.
- Define partial-start cleanup and failed-stop behavior with deterministic tests.
- Remove boot paths that acquire one resource twice or lose the acquired context.

### 3. Live replacement and durable recovery

- Connect desired-state commands to existing Encore ownership.
- Stage replacement registrations before publication.
- Bind tool use to resource generations. Reject stale bindings.
- Stop admission, drain or cancel users, then close retired scopes.
- Define exclusive-resource downtime and timeout policy.
- Keep authorization revocation separate from best-effort replacement fallback.
- Test crashes, repeated commands, compensation failures, and cold interactions.

#### Tool binding boundary

The first host contract treats replacement as exclusive. It closes admission,
drains or cancels admitted work, and stops affected old resources before starting
their replacements. Unchanged resource scopes remain open. This gives a clear
unavailable interval and does not assume that two revisions can share a port,
file lock, or external account lease. Concurrent replacement needs an explicit
author contract and separate tests before the host can support it.

Stage the next catalog and its service context together. A failed stage must
not expose a new callable with an old service context. If old resources were
already stopped, cleanup of the failed stage does not restore them. Report the
remaining unavailable components. Do not call this rollback.

Keep publication revision separate from each resource revision. Tool or provider
catalog semantics can change without a resource restart. The apply input supplies
that publication revision. Do not compare function or object identity to detect a
semantic change. The same publication revision and ordered canonical resource
declarations are a no-op. A declaration-order change can change service precedence
and restage the publication, but does not restart unchanged resource lifecycles.

A failed stop blocks that resource ID and its affected dependents. Keep the
failure receipt. Do not retry an already-closed Scope or acquire a replacement on
the next ordinary apply. An explicit repair must establish that the exclusive
resource can be acquired safely. Scope cleanup alone cannot prove this after a
failed external stop operation. Recovery must preserve this distinction.

`packages/core/src/runtime/agent/turn-source.ts` sends the resolved tool schemas
to the model. `packages/core/src/runtime/agent/tool-runner.ts` later selects an
implementation by tool name from the registry. That is not a sufficient binding
once a live catalog can replace a name. Capture the selected resource generation
with the advertised tool set, then check admission against that generation at use.
The external-driver tool path needs the same check.

`packages/core/src/runtime/agent/turn-tool-execution.ts` also persists calls for
direct invocation and resumed work. Durable pending calls must retain a stable
resource identity and semantic revision. A process-local generation alone cannot
serve as a recovery identity. Recovery must reject an incompatible replacement;
it must not silently execute the current tool with an old call's name.

`packages/core/src/runtime/extensions/extension-capability-context.ts` provides
the captured capability Context at invocation. Live replacement must select that
Context from the admitted binding. Changing a global registry cannot update a
service value that an earlier Layer already captured.

### 4. FX terminal

- Keep one transcript column and a stable composer.
- Use restrained visual hierarchy and consistent inline menus.
- Support compact and expanded tool details with shared identity.
- Keep failure visible and model context separate from display history.
- Capture narrow/normal terminals, streaming, long history, and interactions.

#### Surface scope and checks

FX is the user-selected visual standard. Do not select a new visual identity.
Keep the current keyboard-first terminal, extension slots, themes, and session
controller. Use actual terminal cells and captures as the visual evidence.
Do not replace the client or add a web shell.

The current session route already puts one scrolling transcript above a separate
composer. Preserve that structure. Check its allocation under streaming, growing
drafts, interaction prompts, and narrow terminals before changing it.

| Surface                          | Current owner                                | Required check or change                                                                                   |
| -------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Transcript and input allocation  | `apps/tui/src/routes/session.tsx`            | Keep the composer outside the transcript scroll area; verify 80x24 and 120x40.                             |
| User turn marker                 | `apps/tui/src/components/message-list.tsx`   | Replace the broad filled user panel with the FX rail; preserve images, queued labels, and steering labels. |
| Composer and pending interaction | `apps/tui/src/components/composer.tsx`       | Keep draft state and existing submit keys; show unsupported interaction outcomes.                          |
| Composer metadata                | `apps/tui/src/components/bordered-input.tsx` | Preserve extension label slots; clip secondary labels before input or escape controls.                     |
| Tool presentation                | `apps/tui/src/components/tool-frame.tsx`     | Keep one call identity across compact and expanded output; make failure visible in both.                   |

Before UI changes, add focused render checks beside the existing composer and
widget tests. Then run terminal E2E checks for streaming, cancellation, long
history, and pending interactions. A static capture cannot prove these behaviors.
Do not report model-context compaction as permission to remove visible history.

### 5. Integration and review

- Apply Pi/OpenCode lessons only to demonstrated Gent gaps.
- Investigate the intermittent ACP boundary test without using retry as a fix.
- Run the full gate, relevant RPC/recovery tests, and terminal E2E tests.
- Review the complete implementation independently. Resolve blocking findings.
- Update architecture and behavior docs with exact completion receipts.

## Current evidence

- Native changed-binding RPC checks now pass: 2 tests, 30 assertions.
  Configuration and resource revisions reject the saved call, persist its
  failed result, expose the error, reach Idle, and accept a new turn.
  Receipt: `/tmp/gent-changed-binding-rpc-root.log`. This supersedes the
  older open native changed-binding notes below. Direct/external replay and
  corrupt-result settlement still need final checks.
- The newer result-ownership helpers pass 9 tests and 13 assertions:
  `/tmp/gent-replay-result-ownership-root.log`. They exclude unrelated
  assistant windows and missing anchors. Review found that corrupt completed
  result data returns no result, which can make the executor repeat the tool.
  Typed failure and an integration no-repeat check remain required. Do not
  treat the green helper test as proof of safe corrupt-result handling.
- E2E passes at the same checkpoint: 25 TUI tests plus 36 server/terminal
  tests. Both tasks exit zero. Receipt: `/tmp/gent-scoped-replay-e2e-root.log`.
  This is regression evidence, not proof of the remaining replay failure cases.
- Full gate passes at the scoped-replay checkpoint: typecheck, lint, format,
  build, and tests exit zero. Receipt: `/tmp/gent-scoped-replay-gate-root.log`.
  Focused binding, native interaction, and cold interaction suites pass
  16 tests and 56 assertions: `/tmp/gent-scoped-replay-root.log`. Direct and
  external source-mode replay, changed-binding failure settlement, and exact
  assistant ownership of completed results remain under review. Later edits
  require a fresh gate.
- Real source-TUI approval now passes at 120x40 and 80x24 in one mock-server
  process. Both confirmations complete. The second turn retains the first
  reply. Captures: `/tmp/gent-approval-normal-pending-root.txt`,
  `/tmp/gent-approval-normal-completed-root.txt`,
  `/tmp/gent-approval-narrow-pending-root.txt`, and
  `/tmp/gent-approval-narrow-completed-root.txt`. The owned PTY and server
  closed; no paid calls occurred. This clears the same-process native prompt
  failure, not direct/external replay or changed-binding failure settlement.
- Root strengthened availability regression passes: 1 test, 30 assertions.
  It checks typed request rejection, absence from the staged registry, the
  missing provider in the publication plan, zero initial acquisitions, later
  activation, and resource/scheduler removal after revocation. Receipt:
  `/tmp/gent-availability-exact-root.log`. This clears the weak-assertion
  finding from the earlier availability checkpoint.
- Encore release cleanup is complete. Root verified the clean warm source at
  `6e8fdf92a2ce0636eba0dca30cdf1f761d200bd1` and confirmed that the completed
  `deferred-reply-schema` Rift no longer exists. The agent verified merged
  PRs 60/61, successful CI and release runs, npm 0.29.1, and frozen install.
  Gent's catalog retains `effect-encore` `^0.29.1` and `effect-machine` `0.25.4`.
- The availability stage now filters the full owning extension from catalog
  and scheduler inputs when its process resource is inactive. Desired
  declarations remain intact. Root profile/RPC check: 30 tests, 143 assertions.
  Receipt: `/tmp/gent-availability-stable-root.log`. The new test still needs
  an exact unavailable error and lifecycle counts: a generic failed request
  could also result from the old missing-service defect. This review remains
  open until the stronger checks pass.
- Public repair now passes the root stable checkpoint: 13 tests, 97 assertions
  across the graph RPC and profile cache suites. The real `Gent.server` test
  previews the failed target from a healthy control server, submits the exact
  snapshot, waits for applied state, restarts the original target, invokes its
  resource-backed request, and checks cleanup after scope close. Preview-only
  leaves first-use resolution intact. Invalid preview retains the live
  generation. Receipt: `/tmp/gent-public-repair-stable-root.log`. This
  supersedes the earlier draft cleanup and missing-helper failures below.
- The SDK public export contract now passes: 2 tests, 5 assertions. Receipt:
  `/tmp/gent-sdk-surface-review-root.log`. The graph/profile rerun still fails
  the repair cleanup assertion: 11 pass, 1 fail, 85 assertions. Receipt:
  `/tmp/gent-preview-repair-review-root.log`. The new first-use preview test
  was incomplete at the root check and failed on a missing helper import:
  `/tmp/gent-preview-first-use-root.log`. Await the agent's stable checkpoint
  before the next run; these draft failures are not completion evidence.
- The next full test checkpoint fails the SDK public export contract and the
  new healthy-server repair test's cleanup assertion. The latter checks stop
  and release while its server scope is still open. The extension suite passes
  592 tests and 1385 assertions, without the earlier ACP failure. Receipt:
  `/tmp/gent-integration-live-check-root.log`. Lint flags five null checks in
  the new repair test: `/tmp/gent-lint-live-check-root.log`.
- Public graph preview now exists in the draft. Root found that preview of a
  new cwd registers an empty owner in the live cache. A later normal resolve
  then sees an existing owner without a publication. Preview must not change
  normal launch behavior or revoke an existing publication. A regression and
  fix are in progress with the public repair work.
- Root production review found an availability gap: `live-profile.ts` stages
  all active extension declarations without reading the graph plan's inactive
  resources. The pure planner's suspension tests do not prove capability
  withholding. Production tests and a staged catalog fix are in progress.
- The next full typecheck passes five packages. The TUI fails only on
  `terminal-dimensions.tsx` with `effect(unnecessaryArrowBlock)`. This supersedes
  the earlier typecheck pass for the current draft. Receipt:
  `/tmp/gent-current-type-review-root.log`.
- Root compaction check passes 12 tests and 64 assertions across projection,
  native execution, and RPC failure handling. It covers bounded input/output,
  changed source rejection, valid tool pairing, and retained durable history.
  Receipt: `/tmp/gent-compaction-current-review-root.log`.
- Root graph safety check passes 82 tests and 291 assertions across the pure
  planner, lifecycle, resource host, leases, graph host, and durable command
  suites. Receipt: `/tmp/gent-resource-safety-current-root.log`. These focused
  results do not replace the final full gate or real terminal approval check.
- Root real terminal approval check found a source-mode replay defect. The
  shipped `prompt` confirmation renders at 120 by 40. Enter then reports
  `ToolBindingReplayError` because no durable binding exists. A following turn
  reports `ModelContextProjectionError`. This was one server process, without
  replacement or restart. The mock model had no paid calls. Captures:
  `/tmp/gent-interaction-normal-pending-root.txt`,
  `/tmp/gent-interaction-normal-failed-root.txt`, and
  `/tmp/gent-interaction-narrow-followup-failed-root.txt`. The owned terminal
  session and mock server were stopped. Both defects remain open.
- Real resource cold reacquisition now passes through the production cache and
  SQLite command state. A new runtime exposes a new target resource instance
  and records its lifecycle. Root check: 1 test, 15 assertions. Receipt:
  `/tmp/gent-real-resource-cold-root.log`. Completed repair of a failed owner
  remains separate and unproven.
- Multi-step interaction replay now passes a real runtime test: step 1 finishes,
  step 2 parks, and step 2 resumes before another model call. Root interaction
  suite: 6 tests, 24 assertions. Receipt: `/tmp/gent-multistep-replay-root.log`.
  Completed siblings in a paused batch and direct/external replay still need
  their own checks.
- The next root RPC and interaction check passes 29 tests and 112 assertions.
  Host cancellation now checks the successful `ErrorOccurred` envelope, Idle,
  and a new turn. One completed-sibling test passes. Reverse declaration order
  and the real source-mode approval still need checks. Receipt:
  `/tmp/gent-publication-final-review-root.log`.
- Graph storage and RPC checks pass 15 tests and 81 assertions. Optional
  `undefined` metadata now passes through schema JSON encoding before strict
  canonical encoding. A failed owner accepts a valid internally prepared
  snapshot and reacquires its resource in a new runtime. Public preparation
  and the documented healthy-control-server repair path remain under review.
  Receipt: `/tmp/gent-graph-repair-current-root.log`.
- Root verified two new real-RPC lease checks: user cancellation reaches Idle
  and accepts another turn; interaction parking permits resource release.
  Both pass, with 10 assertions. Receipt:
  `/tmp/gent-lease-lifecycle-current-root.log`. A later version uses host-driven
  cancel retirement, without a user Cancel command. It also passes and proves
  Idle plus next-turn acceptance: `/tmp/gent-host-cancel-current-root.log`.
  The error-event assertion is being strengthened.
- The latest full test command passes after fixing the draft binding-persistence
  typo. The focused cold/binding rerun passes 5 tests and 17 assertions. The
  extensions package passes 592 tests and 1385 assertions. Receipts:
  `/tmp/gent-current-integration-tests-root.log` and
  `/tmp/gent-binding-persistence-recheck-root.log`. Full typecheck and lint also
  pass: `/tmp/gent-integration-typecheck-latest-root.log` and
  `/tmp/gent-live-integration-lint-root.log`. Format check still flags four
  integration files: `/tmp/gent-integration-format-root.log`. The current E2E
  command also passes: 25 TUI tests and 36 server/terminal tests. Receipt:
  `/tmp/gent-current-integration-e2e-root.log`. The full gate and missing
  behavioral checks remain due; later changes require fresh validation.
- Root RPC checks passed: resource graph boundary, 3 tests and 6 assertions;
  extension requests, 20 tests and 69 assertions. These cover canonical owner
  aliases, launch failure isolation, and active-request drain before replacement.
  Receipts: `/tmp/gent-resource-owner-rpc-current-root.log` and
  `/tmp/gent-publication-rpc-current-root.log`.
- Same-process interaction checks passed: 8 tests and 27 assertions. The cold
  interaction and binding suites now pass together: 5 tests and 17 assertions.
  Both restart cases failed in an earlier draft. The exact repair still needs
  review, and source-mode rejection and changed-generation execution tests
  remain required. Receipts: `/tmp/gent-binding-interactions-root.log` and
  `/tmp/gent-replay-cold-current-root.log`. Review:
  `/tmp/gent-tool-binding-replay-root-review.md`.
- Root reproduced the auth-screen resize warning in one App render test. It
  added 11 concurrent subscriptions and removed all 11 during cleanup. The
  shared terminal-size source now has an App regression for one listener,
  reactive resize, and zero listeners after cleanup. Root auth suite passes:
  10 tests, 21 assertions. Receipt:
  `/tmp/gent-shared-dimensions-current-root.log`. Diagnosis and source paths:
  `/tmp/gent-auth-resize-root-review.md`.
- Root verified keyboard cancellation at 80 by 24 and 120 by 40 with the source
  TUI and an explicit delayed mock server. The client accepted a second turn
  after cancellation. No paid model was used. Receipt:
  `/tmp/gent-keyboard-cancel-root-review.md`.
- Root verified the compiled artifact token replacement with an in-memory Bun
  bundle of `packages/extensions/src/artifact-identity.ts`. The output contains
  the supplied build token and no unresolved identity symbol. This does not
  prove full executable startup or cold resource recovery.
- Root loader, activation, and profile checks passed: 27 tests, 129 assertions.
  Receipt: `/tmp/gent-artifact-policy-root-tests.log`. Mutable package metadata
  no longer supplies a loaded artifact identity. Source-mode durable replay
  remains unsupported; this limit is not full live-composition completion.
- Root identified a live/durable applied-revision mismatch when command A
  completes after newer desired command B arrives. The actor/storage repair
  passed 18 tests and 81 assertions, including same-revision recovery.
  Production cache and RPC integration remain open. Receipts:
  `/tmp/gent-admitted-application-root-review.md` and
  `/tmp/gent-admitted-recovery-root-tests.log`.
- Root verified live summary display, separate streamed response identity, and
  retry-history reconstruction: 4 tests, 19 assertions. Receipt:
  `/tmp/gent-summary-feed-root-tests.log`.
- The full test command passed before the current production graph wiring.
  Receipt: `/tmp/gent-integration-current-tests-root.log`. This checkpoint is
  not a pass for later integration edits. The corresponding gate passed
  typecheck and build but failed two profile-cache wrapper guardrails.
  Receipt: `/tmp/gent-integration-current-gate-root.log`.
- Production startup ordering remains under review. Dispatch of saved desired
  state does not prove that live resources are ready. Receipt:
  `/tmp/gent-graph-startup-root-review.md`.
- The current extensions package check passed once, without retries: 592 tests,
  1385 assertions. Receipt: `/tmp/gent-acp-current-package-root.log`. This does
  not establish the cause of the earlier intermittent ACP failure.

- Batch 1 foundation passed the full gate on 2026-09-06.
  Receipt: `/tmp/gent-live-composition-identity-gate-final.log`.
  It includes the author metadata migration and 19 focused planner tests.
  This does not prove live host enforcement; batches 2 and 3 remain open.
- Independent planner checks covered all 512 directed three-node graphs for
  cycle detection and input-order invariance. Receipt:
  `/tmp/gent-resource-graph-exhaustive-review.log`.
- The intermittent ACP failure did not reproduce in isolated, package, or direct
  request checks. No production fix is claimed. Its test helper now includes HTTP
  status and raw response text when the JSON-RPC result is missing. The original
  cause remains unknown. Successful wire capture: `/tmp/acp-debug-body.log`.
- Baseline dirty status: `/tmp/gent-live-composition-baseline-status.txt`.
- Baseline contains 629 changed/untracked paths. Preserve unrelated work.
- A real `resolveProfileRuntime` probe confirmed two resource acquisitions.
  Lifecycle start/stop used instance 1; the returned capability context used
  instance 2. Receipt: `/tmp/gent-resource-instance-probe.log`.
  The owning paths are `packages/core/src/runtime/extensions/activation.ts:392`
  and `packages/core/src/runtime/profile.ts:326`. Batch 2 must acquire once and
  preserve that same context for lifecycle and capability calls.
- Published `effect-machine@0.25.2` accepts `effect >=4.0.0-rc.112 <5`.
  Registry metadata checked on 2026-09-06. Use the published package, not a local
  `file:` dependency, when batch 2 integrates the machine.
- A published Machine probe confirmed a deferred-reply schema defect. An
  `Event.reply` with `Schema.Finite` returned success with `"not-a-number"`
  through `Machine.deferReply` and `self.reply`. Receipt:
  `/tmp/gent-machine-deferred-reply-schema-probe.log`.
  Repaired upstream and released as `effect-machine@0.25.3`.
  Fix PR: https://github.com/cevr/effect-machine/pull/71.
  Automatic version PR: https://github.com/cevr/effect-machine/pull/72.
  Both PRs are merged. Post-merge CI and npm publication passed.
  Gent's catalog and lock now use the published version. Installed-package
  verification rejects the invalid reply with a schema defect:
  `/tmp/gent-machine-published-schema-probe.log`.
  Review: `/tmp/effect-machine-deferred-reply-review.md`.
  Upstream gate: `/tmp/effect-machine-deferred-reply-gate.log` (354 tests).
  The automatic version PR's own check failed before creating jobs; the cause
  is not established. Post-merge CI on `89a15963654317694b5e28e0a3cc7c794edc1f9c`
  passed: https://github.com/cevr/effect-machine/actions/runs/34019840358.
- A second published Machine probe found that actor shutdown can return before
  a background finalizer finishes. Both the first and repeated `actor.stop`
  calls returned success while a cleanup gate remained closed.
  Receipt: `/tmp/gent-machine-concurrent-stop-probe.log`.
  Repair the shared shutdown-completion owner upstream. Do not add a competing
  actor stop barrier in Gent. This issue is not fixed by the reply patch.
  The repair passed independent review and the committed full gate: 363 tests,
  774 assertions. Receipt: `/tmp/effect-machine-stop-completion-committed-gate.log`.
  Commit: `5a5c1f3cb75ac2c52593e1ac3b8ffd2eb1800349`.
  Fix PR: https://github.com/cevr/effect-machine/pull/73.
  Fix PR CI passed. The PR merged as
  `0b9f0e366deb6f301c3beb03c3d6c544d458bd09`.
  Automatic version PR: https://github.com/cevr/effect-machine/pull/74.
  Its CI run required approval. Approval started the unchanged workflow, which
  passed before merge. Version PR merge:
  `33beb71591c4e36da3b86bd07e907a3d69ddab69` (`effect-machine@0.25.4`).
  npm publication passed. Gent's catalog and lock now use published `0.25.4`.
  The installed-package probe proves both stop callers wait for blocked cleanup,
  then succeed with terminal result `Stopped`. Receipt:
  `/tmp/gent-machine-0254-published-shutdown-probe.log`.
  Install receipt: `/tmp/gent-machine-0254-install.log`.
  Gent lifecycle/lease checks passed on the published version: 22 tests,
  81 assertions. Receipt: `/tmp/gent-machine-0254-primitives.log`.
  Post-merge CI passed on the version commit. The clean, completed upstream Rift
  was removed after publication. GitHub retains the source and commit history.
- The context identity regression passed independently. Start, capability use,
  stop, and release all used instance 1. Receipt:
  `/tmp/gent-resource-identity-review-test.log`.
- The resource context fix passed the full Gent gate on 2026-09-06. The assembly
  now returns acquired and declarative services in resolved extension order.
  Receipt: `/tmp/gent-resource-identity-gate.log`.
- Profile declaration loading is separate from resource and scheduler activation.
  Its regression checks zero lifecycle and scheduler actions during declaration
  loading, invalid declaration reporting, and one boot resource instance.
  Full gate: `/tmp/gent-profile-declarations-gate.log`.
  Terminal/process E2E: `/tmp/gent-profile-declarations-e2e.log` (exit 0).
- The generation lease primitive passed independent review and eight focused
  tests (32 assertions). Admission and release use one atomic count. Each use
  owns a fresh scope. Drain and cancellation wait for its finalizers.
  Receipt: `/tmp/gent-resource-leases-review.log`.
  Source: `packages/core/src/runtime/extensions/resource-host/resource-leases.ts`.
  This primitive does not yet bind tools or publish a live resource graph.
- Lifecycle review remains open. Start-hook cleanup must belong to the resource
  scope. Stop and release failures need distinct receipts. Native actor shutdown
  must wait for all cleanup before the host can depend on it.
- The hook-scope repair passed 14 lifecycle tests (49 assertions). Start-hook
  resources release on retirement, before Layer release. Stop-hook resources use
  a fresh scope and release before the stop hook completes. Pure Layer cleanup
  defects report the release phase. Receipt:
  `/tmp/gent-resource-lifecycle-hook-review.log`.
- The primitive checkpoint passed the full Gent gate on 2026-09-06.
  Receipt: `/tmp/gent-resource-primitives-gate.log` (exit 0).
  Native shutdown review and graph-host integration remain open. This gate does
  not prove live replacement, durable recovery, or the FX terminal changes.
- The same checkpoint passed terminal and server-process E2E checks: 36 tests,
  94 assertions, two successful tasks. Receipt:
  `/tmp/gent-resource-primitives-e2e.log` (exit 0).
- Sideshow health check failed on 2026-09-06. Use normal progress messages.

## Live profile integration checkpoint

- The stable local-host checkpoint passed the full gate.
  Receipt: `/tmp/gent-host-stable-checkpoint-gate.log` (exit 0).
  Terminal and server-process E2E also exited 0.
  Receipt: `/tmp/gent-host-ui-checkpoint-e2e.log`.
  Shutdown tests now cover blocked drain, activation, and catalog staging.
  The host agent reports 15 focused tests and 78 assertions, plus ten repeated
  runs. Root reviewed the new scope-close and finalizer assertions.
  The graph host is ready for profile integration. This is not proof of live
  application wiring or durable recovery.
- FX registered-renderer coverage now uses the real ExtensionUIProvider and
  built-in read renderer at 42 columns. The UI agent reports five focused tests
  and 23 assertions, plus 419 TUI tests. Root inspected the retained normal and
  narrow terminal frames. Full workflow terminal checks remain due.
- Root ran the current full test command: `bun run test` exited 0.
  Receipt: `/tmp/gent-live-composition-current-tests.log`.
  The current full gate exited 1. Build and all six typechecks passed; host
  guardrails rejected three unreviewed diagnostic suppressions and one helper.
  Receipt: `/tmp/gent-live-composition-current-gate.log`.
  Agents were still editing. Run the full gate again on the stable checkpoint.
- Root ran the current graph-host tests: 10 passed, 52 assertions.
  Receipt: `/tmp/gent-live-host-root-tests.log`.
  These tests do not yet cover failed compensation followed by retry.
  Review remains open: `/tmp/gent-live-host-root-review.md`.
- Root ran tool-runner and external-driver tests: 28 passed, 91 assertions.
  Receipt: `/tmp/gent-tool-binding-root-review.log`.
  Captured implementations are tested. Durable replay identity and generation
  admission remain separate, incomplete requirements.
- The current launch profile is built once in
  `packages/core/src/server/dependencies.ts` and passed into
  `packages/core/src/runtime/session-profile.ts` as an initial cache entry.
  Replace this owner during integration. Do not add a second host beside it.
- `packages/core/src/runtime/profile.ts` still uses startup activation and
  `buildExtensionLayers`. The live catalog stage must assemble the contexts
  acquired by the graph host. It must not call the resource Layer builders again.
- `packages/core/src/runtime/session-runtime-context.ts` and
  `packages/core/src/server/rpc-handlers.ts` currently expose a bare profile
  context. Carry the publication authority through both paths. Binding only
  turn execution would leave direct RPC tool use outside generation admission.
- Cached profile values must refer to a publication, not an unguarded context.
  Each use must enter that publication's lease. A new resolve must observe the
  new publication after replacement. An old captured value must reject use
  after admission closes.
- Align live-owner keys with durable `(workspaceId, canonicalCwd)` keys.
  `packages/core/src/server/workspace-rpc.ts` validates workspace ID syntax;
  it does not derive that ID from the target session directory. The SDK uses
  `sha256(resolve(clientCwd))` in `packages/sdk/src/transport-headers.ts`.
  Launch ownership can use that rule, but request ownership must use the
  request's CurrentWorkspaceId. Do not capture its default at layer build or
  silently merge different workspace owners in a cwd-only mutable cache.
- Do not persist the process generation ID as sufficient replay identity.
  Persist stable source, owner, schema, and resource revision information.
  Rebuild scopes after restart, then validate the saved binding before use.
- Source identity must describe the loaded code, not just current file bytes.
  `packages/core/src/runtime/extensions/loader.ts` imports an unchanged file
  specifier. A refresh must not attach a new file digest to cached old exports.
  Test the loader's source replacement policy before claiming source hot reload.
  Configuration re-evaluation and code replacement are different operations.
- Refresh must read fresh configuration. `packages/core/src/runtime/config-service.ts`
  caches user config and launch-directory project config. Calling the existing
  `get(launchCwd)` again does not reload changed files. Add a fresh snapshot path
  for explicit refresh. Invalid desired config must fail before graph mutation;
  it must not become an empty config and silently change the active profile.

## Rules that must remain true

### Durable binding implementation order

1. Make dynamic registration cleanup refer to a fresh internal registration
   token. Reusing an author entry object must not let old cleanup remove a new
   registration. Check duplicates and insert in one atomic state operation.
   The repair is present. Root verified the registry and tool-runner tests:
   19 passed, 82 assertions. Receipt:
   `/tmp/gent-dynamic-registry-root-review.log`. Full checkpoint gate remains due.
2. Add JSON-safe tool binding records in the existing SQLite database. Save
   assistant tool calls and their binding records in one transaction. The key
   must include the assistant message ID and tool-call ID.
   The storage primitive is present. Root verified 10 storage tests with 29
   assertions after the independent ownership checks were added. The tests prove
   immutable writes, workspace/session/branch checks, actual call ID/name checks,
   malformed JSON rejection, cascade deletion, and shared outer rollback.
   Receipt: `/tmp/gent-tool-binding-storage-root-review.md`.
   Production assistant persistence and replay do not yet use these rows.
3. Bind replay to saved owner, source, schema, and resource revision identities.
   A process generation is a local admission token, not durable equality.
   Matching declarations after restart must acquire fresh scopes and admit use
   through the new publication. Missing legacy identity must produce a visible
   failure without selecting a replacement by name.
4. Apply the same persistence rule to direct invocation and external-driver
   callbacks. Preserve the actual pending tool-call ID. Do not park an external
   interaction before its assistant tool call and binding are durable.
5. Test cold restart with matching identity, changed owner, changed schema,
   changed resource revision, missing legacy binding, and repeated commands.
   Pending interaction state must settle on rejection. No ghost pending request
   may remain.

The initial durable binding report found no required Encore projection API.
Keep Gent's domain projection in Gent. Use Encore's persisted commands and shared
SQL transaction APIs.

The later real SQL command test found an Encore identity defect. Schema payloads
did not receive the primary key from the operation definition. Two equal sends
created two message rows with null message IDs. The upstream repair is in
`/Users/cvr/Developer/personal/.rifts/effect-encore/deferred-reply-schema`.
The final repair preserves scalar, object, and transformed-class payloads.
Public Client dispatch through SQL storage deduplicates repeated requests.
Root's full upstream gate passed 296 tests and 747 assertions. The fix PR #60
and automatic version PR #61 are merged. Release run 34029069857 passed.
Root verified npm `effect-encore@0.29.1` and its Effect peer range
`>=4.0.0-rc.112 <5`. Gent's catalog, lock file, and installed package now use
0.29.1 with the published integrity. Root verified the original graph-command
regression: 7 tests passed, 21 assertions. Receipt:
`/tmp/gent-encore-0291-command-root.log`. Full downstream validation remains due.
Do not change Gent payloads to field records to bypass this defect.
Receipts: `/tmp/gent-resource-command-repair-root-tests.log` and
`/tmp/effect-encore-schema-payload-root-review.md`.

### Model context follow-up

The audit in `docs/research/2026-09-06-model-context-projection-audit.md` recorded
the former unbounded prompt path. The pure projector and native model wiring
are now present. They keep complete tool groups, reject malformed pairs, use
model context metadata, reserve system/tool/output space, and leave stored
history unchanged. The effective driver ID selects the model metadata.

Root verified the adjacent streaming, interaction, recovery, external-turn,
message-send, and model-context tests: 47 tests passed, 148 assertions.
Receipt: `/tmp/gent-context-adjacent-root-tests.log`.
The RPC failure test proves an error event, an idle turn, retained history,
and a successful next turn. The output reserve reaches the selected driver.

The full test run then found three custom metrics model fixtures without
context limits and one unstable profile admission wait. The repaired files
passed together: 8 tests, 47 assertions.
Receipts: `/tmp/gent-live-composition-integration-tests.log` and
`/tmp/gent-profile-metrics-repair-root.log`.

Suffix selection does not complete semantic compaction. Bounded semantic
compaction, exact provider capability limits, terminal history checks, and a
fresh full gate remain required. The latest gate failed on draft command lint
and the profile key-lock guardrail. The latest terminal/server E2E command
passed, including 36 server/PTY tests with 94 assertions.
Receipts: `/tmp/gent-live-composition-integration-gate.log` and
`/tmp/gent-live-composition-context-e2e.log`.

### Invariants

- Scope close is cleanup, not rollback of arbitrary external effects.
- A failed fallback cannot restore revoked authority.
- A name alone cannot bind a tool across replacement.
- A tool that holds a publication lease must not synchronously wait for that
  publication to drain. Graph change commands must persist and enqueue work,
  then return a command receipt. A later status query reports completion. Test
  refresh submitted from an active tool to prevent self-drain deadlock.
- A new Context cannot change service values already captured by a dependent.
- Inspection reports outcomes. It is not a second control input.
- A green test is evidence only for the behavior it actually exercises.
