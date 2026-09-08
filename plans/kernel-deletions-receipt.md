# Kernel deletions: validation record

Status: work in progress. The full goal has five deletion areas.

## Handoff

Removed the second model call that rewrote handoff text above 2,000 characters. The existing approval and new-session creation remain.

The RPC acceptance test now checks the full supplied text through real runtime services. The full gate passed. Live Herdr checks used Luna in pane `wZ:pH` with more than 2,000 characters of supplied context.

The first live check found stale activity after session creation. The snapshot could include the completed event while runtime finalization still reported Running. Historical replay then skipped that lifecycle event. The existing runtime stream only updated queues. It now also updates activity for the current session and branch. Idle updates preserve error status. A client test covers current-branch recovery and rejection of stale branch updates.

The repeated live check opened approval, accepted Yes, created the new session, returned `HANDOFF-IDLE-GREEN`, and showed no Generating line. The source test covers the decline result too.

Evidence:

- `/tmp/gent-handoff-deletion-tests.log`: focused RPC and tool tests, 3 passed.
- `/tmp/gent-handoff-deletion-gate.log`: full gate after summary removal, passed.
- `/tmp/gent-handoff-deletion-approval.txt`: first live approval.
- `/tmp/gent-handoff-deletion-new-session.txt`: stale activity reproduction.
- `/tmp/gent/logs/046a399a-20260908224004-client.log`: snapshot cursor and session transition.
- `/tmp/gent/logs/046a399a-20260908224004-server.log`: both turns completed.
- `/tmp/gent-handoff-runtime-gate.log`: full gate after activity fix, passed.
- `/tmp/gent-handoff-runtime-approval.txt`: repeated live approval.
- `/tmp/gent-handoff-runtime-new-session.txt`: new-session reply and settled activity.

Source files:

- `/Users/cvr/Developer/personal/gent/packages/extensions/src/handoff-tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/tests/handoff/handoff-rpc.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/client/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/hooks/use-session-feed.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/client-session-state.test.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/use-session-feed.test.tsx`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`

## Remaining work

1. Consolidate bundled principles into skills.
2. Replace the repository extension and es-git with documented CLI execution.
3. Replace artifact state and UI with saved files and kernel working values.
4. Remove model-facing skill search/load wrappers. Preserve discovery, scope, and TUI insertion.

Run the full gate and live Herdr checks for each logical commit. Complete review and the final goal audit before integration.
