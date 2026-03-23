# Test Lanes

Unit:

- `bun run gate`
- pure unit tests only
- no TUI suites
- no transport, worker, bootstrap, or boundary coverage

Integration:

- `bun run test:integration`

Root seam and boundary coverage:

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
- `tests/core-boundary.test.ts`
  - `SessionCommands` / `ActorProcess` / durable inbox seams
- `tests/tui-boundary.test.ts`
  - structural production TUI boundary guard

TUI integration coverage:

- `apps/tui/tests/*`
  - all TUI tests run in the integration lane
- `apps/tui/integration/worker-supervisor.test.ts`
  - hosting and supervision behavior
- `apps/tui/integration/session-feed-boundary.test.tsx`
  - real worker-backed feed projection
- `apps/tui/integration/app-bootstrap-boundary.test.ts`
  - bootstrap decisions against the real worker-backed client

Rule:

- test the seam that owns the contract
- do not rebuild watched-state expectations from raw events in callers
- do not treat direct parity as proof of worker lifecycle behavior
