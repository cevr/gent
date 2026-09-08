# Deferred context findings: completion receipt

Date: 2026-09-08.
Base: `dd517c29`.
Work branch: `fix/context-deferred`.
Test checkout: `/Users/cvr/Developer/personal/.rifts/gent/context-deferred`.
Delivery checkout: `/Users/cvr/Developer/personal/gent`.

## Results

1. The summary input estimate includes the focus instructions and the retained
   binding note. Selection uses the same user prompt formatter as generation.
   It reserves output space and respects the full 16,384-token input cap.
   An oversized note causes no summary request. The original projection remains.
2. RPC tests run real cells through real storage and runtime services. A cell
   schedules a directive, then waits in a host tool. The test interrupts it
   through public RPC. The next user turn keeps older context. It creates no
   summary or window marker. Both `context.compact()` and `context.newWindow()`
   have this test.
3. The status line shows the actual summary revision. The event and snapshot
   carry the optional value. A reused summary keeps its revision. A new window
   clears it. The cumulative count remains a separate metric.

The revision label is worth the small change. It identifies the summary that
is currently in the model projection. The count cannot do that. No new service
or parallel state owner was needed.

## Validation

- Budget tests: passed, including four new cases for instructions, bindings,
  both inputs, and no available source space.
- Interruption tests: passed for both directives.
- Mutation check: temporarily removed the first-step directive cleanup.
  Both interruption tests failed. Restored the source before the full gate.
- Revision tests: 15 tests passed across the RPC directive suite and label suite.
- Full `bun run gate`: passed after each of the three code units. The gate
  includes typecheck, lint, format, build, and workspace tests.
- `git diff --check`: passed.
- Local source review: checked prompt construction against its estimate,
  directive cleanup against the RPC test, and revision propagation through
  event storage and snapshot reads. No unresolved finding in this scope.

Test log files:

- `/tmp/gent-context-budget-test.log`
- `/tmp/gent-context-budget-gate.log`
- `/tmp/gent-context-interrupt-test.log`
- `/tmp/gent-context-interrupt-mutation.log`
- `/tmp/gent-context-interrupt-gate.log`
- `/tmp/gent-context-revision-test.log`
- `/tmp/gent-context-revision-gate.log`

These log files are temporary. The RPC cell tests ran on macOS. They are skipped
on other platforms by the existing suite condition. Token counts use Gent's
character-based estimate; they are not exact provider token counts.

The live Luna transcript and keyboard checks from the earlier handoff remain
pending. No paid model request was made in this follow-up. Sideshow was not
available at `http://localhost:8228`.

## Source receipts

The paths below identify the delivery files. The tests ran against these files
in the Rift before local integration.

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/model-compaction.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/model-compaction.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/agent-loop/model-context-directives.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-source.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/event.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.state.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/utils/session-labels.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/session-labels.test.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/model-context-ledger.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/model-context.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/code-cell/cell-context-host.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/rpc-harness.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/test-utils/language-model.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/tests/runtime/cell-worker-fixture.ts`
- `/Users/cvr/Developer/personal/gent/plans/context-and-disclosure.md`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
- `/Users/cvr/Developer/personal/gent/AGENTS.md`
- `/Users/cvr/Developer/personal/gent/packages/core/AGENTS.md`
- `/Users/cvr/Developer/personal/gent/apps/tui/AGENTS.md`
- `/Users/cvr/Developer/personal/gent/package.json`
- `/Users/cvr/Developer/personal/gent/lefthook.yml`
