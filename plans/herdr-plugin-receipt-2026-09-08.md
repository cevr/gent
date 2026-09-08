# Herdr plugin — 2026-09-08

The built-in `@gent/herdr` client extension reports Gent's active UI state to
Herdr. It loads through the normal extension pipeline. It requires no new
package or install command. Disable it through the existing extension settings.

The extension activates only when `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and
`HERDR_PANE_ID` are present. Headless clients have no UI activity accessor and
do not activate it. The shared server and child agents cannot claim the pane.

`ClientActivity` reads current UI state. It does not replay events or keep a
second activity state. Questions, permissions, auth gates, and errors report
blocked. Loading and a lost connection report unknown. Running turns report
working. Ready input reports idle. Each report carries the current session ID.

The reporter keeps one pending state. It preserves socket write order and
monotonic sequence numbers. Each request has a 500 ms limit and one retry.
Exit cancels the active report, drops queued reports, and sends release last.
The main TUI scope waits for client-provider disposal before process exit.

## Validation

- `bun run gate` passed: typecheck, lint, format, build, and all gate tests.
- Real local socket tests cover state changes, session changes, setup lifetime,
  release ordering, missing sockets, silent sockets, and disabled/headless use.
- Herdr 0.9.0 detected the compiled app as `gent` in pane `wZ:pH`.
- Live Luna test observed `idle → working → blocked → working → done`.
- The blocked state matched a real `ask_user` interaction. The test selected
  Continue through Herdr. Luna returned `HERDR-QUESTION-DONE`.
- On exit, the pane returned to its shell. Herdr removed the `gent` identity.
- The first question attempt had invalid model tool input. A later exact-input
  attempt completed. Its cell row still showed a failure mark although the
  nested tool returned the answer. The full feature check confirmed that
  recovery stops the outer cell without source replay. The UI hid the cause.
  The display fix now shows it. See the full feature receipt below.

## Herdr compatibility limit

Herdr 0.9.0 accepts Gent's lifecycle reports. Its supported-agent list does not
include Gent. It ignores Gent's session reference and rejects `agent prompt`,
even after naming the pane. Use `pane send-text`, `pane send-keys`, and
`pane get` for control. Native `agent start`, `agent prompt`, and session resume
need Gent support in Herdr. The plugin does not use another agent's identity.

## Source and test records

- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/builtins/herdr.client.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/herdr/reporter.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-activity.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-services.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/context.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/routes/session-controller.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/main.tsx`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/herdr.test.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/tests/herdr-test-server-boundary.ts`
- `/Users/cvr/Developer/personal/gent/plans/gent-feature-e2e-2026-09-08.md`
- `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent/packages/coding-agent/src/core/extensions/builtin/herdr-agent-state.ts`
- `/Users/cvr/.cache/repo/herdrdev/herdr/src/agent_resume.rs`
- `/tmp/gent-herdr-gate.log`
- `/tmp/gent-herdr-live-20260908/01-idle.json`
- `/tmp/gent-herdr-live-20260908/05-working.json`
- `/tmp/gent-herdr-live-20260908/07-blocked.json`
- `/tmp/gent-herdr-live-20260908/repeat-question.txt`
- `/tmp/gent-herdr-live-20260908/repeat-complete.txt`
- `/tmp/gent-herdr-live-20260908/11-released.json`

The cached Prime Agent checkout is at `a3b3e75` (2026-08-11). Its refresh failed.
The installed Herdr CLI and live server supplied the compatibility checks.
Temporary test records can expire.
