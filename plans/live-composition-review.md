# Live composition completion audit

Status: implementation and validation complete for the live-composition goal.
The pending TypeScript 7 / Effect migration remains in the same Rift.
The user authorized commits and a local main merge after validation.
No remote push is part of this handoff.

## Review scope

Root reviewed the goal-owned planner, lifecycle, publication, recovery, tool
replay, model-context, and terminal changes across the recorded checkpoints.
Astra completed the last replay repairs after the user's temporary model change.
Astra also reviewed root's final storage-order repair. No blocking finding remains
in this scope. This does not claim a new line-by-line audit of every unrelated
file in the pre-existing migration.

## Final validation

- Full gate passes: typecheck, lint, guardrails, format, build, and tests.
- Terminal and server E2E pass: 61 tests.
- Storage passes: 100 tests and 326 assertions.
- Focused replay passes: 48 tests and 259 assertions.
- External real-approval and fixed-clock limit checks pass: 2 tests and 24 assertions.
- Direct invocation cleanup passes: 3 tests and 26 assertions.

Receipts:

- /tmp/gent-replay-final-gate-root.log
- /tmp/gent-replay-final-e2e-root.log
- /tmp/gent-storage-order-all-root.log
- /tmp/gent-replay-focused-finish.log
- /tmp/gent-external-boundaries-finish.log
- /tmp/gent-direct-cleanup-finish.log

## Requirement checks

| Goal                        | Evidence and limits                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and planner        | 82 focused tests cover stable identity, deterministic order, duplicates, cycles, and missing requirements. Unchanged resources stay active.                                         |
| Live scopes and publication | Lease, lifecycle, profile, and RPC checks cover generation admission, drain, cancel, ordered cleanup, and next-turn use. Exclusive replacement has an unavailable interval.         |
| Durable recovery            | A healthy control server previews and submits changes to a target. SQL-backed restart recovers desired state and reacquires resources. Replay checks reject changed bindings.       |
| Failure safety              | Tests cover partial-start cleanup, failed stop, failed compensation, revoked admission, and parent shutdown. Cleanup is not rollback of arbitrary external effects.                 |
| FX terminal                 | Real terminal checks cover normal/narrow approval, streaming, cancellation, and retained history. Current E2E passes. Shared dimensions use one listener and remove it at shutdown. |
| Prior-art gaps              | Compaction bounds input/output, verifies source history, keeps tool pairs valid, and retains durable history. Native and external replay reuse completed calls.                     |
| Docs and validation         | Architecture and behavior docs match these boundaries. Final gate and E2E pass. No blocking review finding remains in the goal-owned work.                                          |

Additional behavior receipts:

- /tmp/gent-resource-safety-current-root.log
- /tmp/gent-availability-exact-root.log
- /tmp/gent-publication-final-review-root.log
- /tmp/gent-public-repair-stable-root.log
- /tmp/gent-lifecycle-review-refresh-root.log
- /tmp/gent-compaction-current-review-root.log
- /tmp/gent-changed-binding-rpc-root.log
- /tmp/gent-corrupt-result-settlement-root.log
- /tmp/gent-sibling-results-both-orders-root.log
- /tmp/gent-actor-approval-rejection-current-root.log
- /tmp/gent-approval-terminal-root-review.md
- /tmp/gent-keyboard-cancel-root-review.md
- /tmp/gent-fx-resource-planner-history-normal.txt
- /tmp/gent-fx-resource-planner-history-narrow.txt
- /tmp/gent-shared-dimensions-current-root.log

## Final replay repairs

Each external callback saves its own assistant call, binding, and structured
result. Final text has a separate response step. The second call can wait for
real approval without repeating the first completed call. Call 201 fails before
persistence or execution.

Equal timestamps exposed lexical message-ID ordering at steps 9 and 10. Storage
now persists an insertion-order tie-break. List, session detail, and deletion use
the same order. A forward migration preserves existing row order. Tests cover
upgrade, new writes, and VACUUM. Timestamps are not moved into the future.

Native replay locates results by exact assistant, tool-call ID, and tool name.
It preserves completed sibling results in both declaration orders. Corrupt
results and changed bindings fail visibly with paired failed results. A later
turn can run.

The internal InvokeTool side command cannot wait for an interaction. It returns
a useful error, closes the request, saves a failed result, and clears its local
binding. Redelivery does not run the tool again. Native and external session
turns retain interactive approval support. The existing Schema.Defect wire codec
normalizes inner error classes; tests assert the durable message and result reason.

## Limits

- Same-process source-only replay requires the unchanged callable and generation.
- Cold replay requires trusted matching durable identity. A name alone is insufficient.
- An unfinished tool can repeat effects that preceded its interaction.
- Fresh SQL owner recovery is not proof of every abrupt-process-crash window.
- Trusted extension setup is not sandboxed. Preview does not acquire declared resources.
- The recorded intermittent ACP failure did not recur in isolated, wire, or full tests.
  Its cause remains unknown. No retry was added to hide it.

## Source receipts

- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/ARCHITECTURE.md
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/docs/malleability.md
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/docs/extensions.md
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/docs/research/2026-09-06-malleability-and-harness-prior-art.md
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/plans/live-composition.md
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/storage/schema.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/storage/message-storage.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/storage/relationship-storage.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/storage/sqlite-message-storage.test.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/storage/sqlite-session-storage.test.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/agent-loop.turn-execution.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/turn-source.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/turn-tool-execution.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/agent-loop.handlers.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/src/runtime/agent/turn-persistence.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/agent-loop/external-turn.test.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/agent-loop/interactions.test.ts
- /Users/cvr/Developer/personal/.rifts/gent/deps-malleability/packages/core/tests/runtime/agent-loop/actor-command.test.ts
- /tmp/gent-live-availability-root-review.md
- /tmp/gent-tool-binding-replay-root-review.md
- /tmp/gent-graph-startup-root-review.md

The focused review records list the other implementation files used at each
checkpoint. Older failures in those records are historical unless listed in the
limits above. Remove the clean Rift only after local main contains its commits.
Owned library fixes are published:
effect-machine 0.25.4 and effect-encore 0.29.1. Gent uses registry packages.
