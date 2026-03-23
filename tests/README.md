# Seam Testing

Use the lightest test that still crosses the seam you are changing.

Default homes:

- `tests/transport-contract.test.ts`
  - shared client contract behavior
  - create/list/send/session snapshot/query parity
- `tests/event-stream-parity.test.ts`
  - `subscribeEvents` replay/live/`after` cursor semantics
- `tests/queue-contract.test.ts`
  - queued follow-up visibility
  - steer-before-follow-up ordering
  - queue drain/restore semantics
- `apps/tui/tests/session-feed-boundary.test.tsx`
  - `useSessionFeed` / `ClientProvider` projection from a real backend transport
  - thinking, queue widget, assistant output, error projection
- `apps/tui/tests/worker-supervisor.test.ts`
  - worker startup, restart, crash/reconnect, debug-mode transport seam
- `apps/tui/tests/client-context.test.ts`
  - mock-only reducer/listener logic
  - not a transport test

Rules:

- if a bug crosses transport or worker boundaries, add a seam test first
- do not use mocked callbacks to claim RPC stream coverage
- do not add new client-behavior tests before checking whether the shared seam suites already own that behavior
- if a TUI state bug depends on backend timing or live events, it belongs in a real transport-backed test
