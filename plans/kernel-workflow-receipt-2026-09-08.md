# Workflow validation — 2026-09-08

## Changes

- `fdba7a8d`: replace fixed child-agent sequences with outcome prompts. Keep command IDs, approval, source checks, and read-only review behavior.
- `c234f400`: give each workflow request a new follow-up ID. Repeated commands must create distinct messages.

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/workflows.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/workflows.test.ts`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`

## Gate and E2E results

The full gate passed after each code change. The E2E suite passed all 62 tests after each change. Commit checks also passed.

Evidence:

- `/tmp/gent-workflows-simple-gate.log`
- `/tmp/gent-workflows-simple-e2e.log`
- `/tmp/gent-workflows-simple-commit.log`
- `/tmp/gent-workflow-repeat-gate.log`
- `/tmp/gent-workflow-repeat-e2e.log`
- `/tmp/gent-workflow-repeat-commit.log`

## Live Herdr checks

Tests used a live Luna model in pane `wZ:pH`. The root pane retained focus after testing.

The first test setup was invalid. A normal prompt asked the model to run a queued plan before the workflow prompt reached the model. The model changed an old test file. The file was restored. The test was repeated with a new fixture and an initial READY turn.

The new test saved a plan, ended that cell, and opened approval in a separate cell. The user choice was No. A byte comparison confirmed that the source file did not change. A later cell read the saved checkpoint and plan. The checkpoint survived approval recovery.

Evidence:

- `/tmp/gent-workflows-initial-transcript.txt`
- `/tmp/gent-workflows-fresh-approval.txt`
- `/tmp/gent-workflows-fresh-plan.txt`
- `/tmp/gent-workflows-fresh-target.txt`
- `/tmp/gent-workflows-fresh-checkpoint.txt`

## Repeated-command defect

The live test found that a repeated command reused its command ID as the follow-up ID. This could combine queued requests or reuse a completed message. An RPC test reproduced the problem: two requests produced one queued item. The fix adds a fresh platform ID to each invocation.

The RPC test passed after the fix. A new live session read `REPEAT-PLAN-GREEN` with `/plan`. A normal cell then saved `REPEAT-PLAN-SECOND`. A second `/plan` read the new value and returned to idle. This check covered a repeat after the first turn completed.

Evidence:

- `/tmp/gent-workflow-repeat-repro.log`
- `/tmp/gent-workflow-repeat-fixed.log`
- `/tmp/gent-workflow-repeat-first.txt`
- `/tmp/gent-workflow-repeat-second.txt`

Identity owners:

- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.protocol.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.handlers.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/session-runtime.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/server/transport-contract.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/gent-platform-bun.ts`

## Review and limits

An independent Astra review found no remaining blockers in either code change. Its requested live repeat check passed.

Artifact storage remains unchanged. The proposed migration uses kernel bindings for working state and files for saved results. It keeps durable operations and recovery in the host. Each future code change must pass the full gate and a live Herdr TUI check.

Plans:

- `/Users/cvr/Developer/personal/gent/plans/kernel-backed-artifacts-and-simplification.md`
- `/Users/cvr/Developer/personal/gent/plans/kernel-prior-art-2026-09-08.md`

The `/tmp` logs are local test receipts. They are not repository files.
