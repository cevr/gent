# Seam Tests

Fast seam parity:

- `tests/transport-contract.test.ts`
  - shared client contract
- `tests/event-stream-parity.test.ts`
  - durable event log replay semantics
- `tests/live-event-parity.test.ts`
  - live-only event semantics
- `tests/watch-state-parity.test.ts`
  - watched current-value state semantics
- `tests/queue-contract.test.ts`
  - queue-specific contract and restore semantics

Worker and TUI boundary:

- `apps/tui/tests/worker-supervisor.test.ts`
  - hosting and supervision behavior
- `apps/tui/tests/session-feed-boundary.test.tsx`
  - real worker-backed feed projection
- `apps/tui/tests/app-bootstrap-boundary.test.ts`
  - bootstrap decisions against the real worker-backed client

Rule:

- test the seam that owns the contract
- do not rebuild watched-state expectations from raw events in callers
- do not treat direct parity as proof of worker lifecycle behavior
