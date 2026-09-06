# Malleability

Gent must support change without a second control plane.

This design applies the context model from [A Programming Paradigm for Spatiotemporal
Composability](https://arxiv.org/abs/2608.25512). The paper defines two properties:

- Temporal composition removes a component and reverses its effects.
- Spatial composition activates a component when its requirements exist.

Effect scopes already provide the temporal base. Context and Layer already provide
the service base. Gent needs a live resource graph between these two parts.

## Current decision

Do not put Effect Machine around `AgentLoop`.

Effect Encore owns the durable actor mailbox and request protocol. A second actor
would duplicate queue, supervision, and recovery work.

Do not put Effect Machine around a boot-only resource load.

A state machine without live desired-state changes has no useful transitions. It
adds code but does not add malleability.

Use Effect Machine for the live resource lifecycle. This is Gent's first deliberate
dogfooding boundary for that package. It owns the inertial lifecycle of one component:

```text
inactive -> loading -> active -> unloading -> inactive
                 \-> failed <-/
```

Effect Encore stays above this layer. It owns durable commands that request graph
changes. Effect Machine owns the local lifecycle after a command changes desired
state.

The [implementation plan](../plans/live-composition.md) tracks delivery. The
[research report](research/2026-09-06-malleability-and-harness-prior-art.md) gives
the source evidence and failure cases. The live host and public repair path now
exist. Approval replay, full gate, and terminal/server E2E pass. The
[completion audit](../plans/live-composition-review.md) records the evidence and limits.

Machine owns local transitions, not a second desired-state store. Its states name
loading, readiness, retirement, cleanup, and failure. Effect scopes own the actual
resources. Encore records desired/applied revisions and stable command IDs. Restart
recreates live resources from those records; it does not restore serialized scopes.

A new desired revision must not interrupt required cleanup. A state-owned Machine
task is interrupted on state exit. Thus the lifecycle must postpone replacement
while cleanup runs, or retain cleanup ownership until the operation settles.
Tests must prove this ordering. Do not add both a machine state and a mutable status
field for the same fact.

## Bottom-up model

Build the model in this order.

1. Give each resource a stable identity.
2. Let each resource declare stable resource requirements.
3. Build a pure desired graph from extension configuration.
4. Reject duplicate identities and cycles. Resolve missing requirements by policy.
5. Compute activation order from the graph.
6. Give each active resource one owned Effect scope.
7. Close dependent scopes before provider scopes.
8. Reconcile graph changes while the server runs.
9. Add Effect Machine for the per-resource lifecycle.

Do not infer identity from array position. Reordering configuration must not restart
an unchanged resource.

Missing requirements use reactive suspension for optional components. Report the
missing provider IDs, including transitive causes. A required application root that
cannot activate rejects the desired graph before mutation. Duplicate IDs and cycles
are invalid even when the affected components are optional. The host must expose
unavailable components without publishing tools that need their absent services.

The live catalog applies the planner's inactive-resource result. The author API
declares resource requirements, not per-capability requirements. Thus one inactive
process resource suspends its full owning extension from the catalog and scheduler
inputs. Desired declarations remain intact. Adding the missing provider can
activate the owner on the next refresh. Removing the provider revokes it again.

Do not infer runtime requirements from TypeScript service types. Type information is
not a stable runtime graph. A resource must declare the runtime identities that it
requires.

## Required invariants

- One resource owns one scope.
- Scope close finalizes registered Effect acquisitions and stops owned resources. It
  does not roll back arbitrary persistent writes or external effects. Those effects
  need explicit inverses or named compensation boundaries.
- A provider becomes active before a dependent starts.
- A dependent stops before a provider stops.
- Failed start closes the partial scope.
- Reconcile uses stable identity, not object identity.
- Reconcile is repeatable for the same desired graph.
- Configuration is the desired state.
- Inspection events are receipts. They are not control inputs.
- External effects without an inverse use a named compensation or withholding
  boundary.

## Implemented resource boundary

The pure planner owns identity, dependency order, and missing-provider policy.
The live graph host owns resource scopes, generations, publication, and admission.
It stops dependent resources before their providers. Replacement is exclusive:
the host closes admission and drains or cancels users before replacement starts.
This produces an unavailable interval. It does not promise an atomic swap of
external ports, locks, or account leases.

The profile cache is the single production owner. Startup and per-cwd requests use
that cache. Encore records desired commands and applied results in SQLite. Startup
recovery reacquires resources before exposing the saved launch owner. A failed
saved owner does not fall back to default authority.

The public `resourceGraph.preview` operation prepares a snapshot from the target's
loaded declarations. It does not publish a catalog or acquire declared resources.
Trusted setup can perform its own effects. Preview is not a sandbox. A healthy
control server on the same database can submit a corrected snapshot for a failed
owner. Submission records intent; callers must wait for applied state.

See [the repair example](extensions.md#repairing-an-unavailable-resource-owner).
Current root checks are recorded in `plans/live-composition.md`. These resource
checks do not imply that tool replay or the complete product gate has passed.

## Ownership

- Gent owns resource identity, configuration, graph policy, and reconciliation.
- Effect owns Context, Layer, Scope, and finalization.
- Effect Encore owns durable actor commands and recovery.
- Effect Machine owns local state transitions and inertial lifecycle.

If Gent needs a generic lifecycle workaround, evaluate Effect Machine first. If Gent
needs a durable actor workaround, evaluate Effect Encore first.

## FX transcript implementation slice

FX is the selected Gent terminal standard. The first bounded transcript slice is now
implemented in the existing OpenTUI client. It keeps one transcript column and one
composer. It does not add a web surface, a second transport, or a new dependency.

The current behavior is:

- User turns use a restrained left rail. Images, multiline text, queued labels, and
  steering labels remain visible and selectable.
- Compact and expanded tool projections use the same call identity. Known renderer
  failures and unknown-renderer failures remain visible.
- One scoped terminal-dimension subscription serves the app. Retained history
  and hidden panels do not each add a resize listener.
- Retry events keep a historical resolved state. Stream start, completion,
  interruption, error, and idle transitions settle the visible retry label.
- Live and buffered message events accept the labeled model-compaction record. A
  native streamed assistant message remains separate from that summary record.

The behavior is covered by focused render and feed tests. The deterministic debug
provider covers stream, retry, tool, and long-history fixtures. The current debug
provider does not publish a pending user interaction request. The TUI harness
tests cover interaction rendering and buffered replay. A separate source-TUI
check uses a local mock server to test a real confirmation request and reply.

This slice does not claim full FX parity. It does not implement FX's native runtime,
MCP lifecycle, or a complete terminal visual-regression suite. A direct PTY retry and
history check passed at 120x40 and 80x24. The built debug binary showed a streamed
response, but its no-delay fixture completed before Escape could prove cancellation.
That earlier host failure is now fixed. A later source-TUI check with an explicit
delayed mock server proved keyboard cancellation during thinking and streaming,
then accepted a new turn. An earlier confirmation reply found a source-mode
binding failure. After the scoped replay repair, real confirmation requests and
replies passed at 120x40 and 80x24 in consecutive turns. This proves same-process
native approval without a profile change. Direct and external replay, changed
bindings, and corrupt saved results still need final checks.

Receipts:

- `/tmp/gent-fx-resource-planner-focused-final.log`
- `/tmp/gent-fx-resource-planner-history-normal.txt`
- `/tmp/gent-fx-resource-planner-history-narrow.txt`
- `/tmp/gent-fx-terminal-harness-tests.log`
- `/tmp/gent-fx-cancel-startup-failure.txt`
- `/tmp/gent-fx-debug-startup.txt`
- `/tmp/gent-fx-debug-bin-startup.txt`
- `/tmp/gent-fx-debug-bin-cancel.txt`
- `/tmp/gent-keyboard-cancel-root-review.md`
- `/tmp/gent-shared-dimensions-current-root.log`
- `/tmp/gent-interaction-normal-pending-root.txt`
- `/tmp/gent-interaction-normal-failed-root.txt`
- `/tmp/gent-approval-terminal-root-review.md`
- `/tmp/gent-approval-normal-completed-root.txt`
- `/tmp/gent-approval-narrow-completed-root.txt`

## Prior-art references

The [research report](research/2026-09-06-malleability-and-harness-prior-art.md)
records source evidence. These projects informed the UI and live graph questions.
Source inspection and hands-on tests are separate forms of evidence.

- [fx](https://github.com/vercel-labs/fx): visual style, transcript and tool
  rendering, interaction states, harness separation, and lifecycle fit.
- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): Cordis as
  a concrete implementation of the same spatiotemporal composability ideas.
- [exo](https://github.com/exoharness/exo): self-modification boundaries and
  recovery behavior.
