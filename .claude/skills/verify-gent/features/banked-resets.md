# Banked resets

The lanes band shows the resets each account's plan holds to clear a spent window early (Claude's reset grants, Codex's reset credits): one row after the provider's lanes row and its lost logins, `↺ resets anthropic default 2, work 1 · next lapses 08:10` (each account's count, then when the soonest grant lapses). A lapsed grant counts none, and an account with none is not named. `gent ctl lanes` lists each account's `resets`, and `--line` prints the row without its mark. Gent never spends a reset.

## Sub-features

- `resets-at-rest`: a ledger whose accounts hold resets shows the full row under the lanes row; an account with only lapsed grants is not named.
- `resets-narrow`: at 50 columns the row drops the lapse (`↺ resets anthropic default 2, work 1`), at 34 the provider (`↺ resets default 2, work 1`).
- `ctl-resets`: `gent ctl lanes` holds `resets` on the accounts that hold any; `--line` prints `resets anthropic default 2, work 1 · next lapses <HH:MM>`.

## How to get to it (user POV)

- It shows by itself in the lanes band under the status row; there is no key or command.
- `gent ctl lanes` and `gent ctl lanes --line` from a shell, with no session.

## Driving it with verify:drive

- **Preconditions:** a run launched with a ledger that holds resets: the [lanes](lanes.md) ledger recipe, with this key added to its object, then `verify:launch --dir "$RUN" --data "$(dirname "$RUN")/evidence/credential-usage.json"`. The scripted model reads no usage, so the resets come from the ledger.
- **States:** default (resets held, one account with only lapsed grants). Loading, empty, focus, open and error are `n/a`: empty is the band without the row, which [lanes](lanes.md) covers.
- **Regression:** `apps/tui/tests/extensions/machines.client.test.tsx` (`banked resets`), `apps/tui/tests/ctl.test.ts` (`lanes needs no session`), `packages/core/tests/runtime/provider.test.ts` (`banked resets`), `packages/core/tests/server/rpc.test.ts` (`banked resets at start`).

The ledger key (`now` and `h` as in the lanes recipe):

```js
resets: [
  {
    provider: "anthropic",
    slot: "default",
    readAt: now - 60000,
    grants: [{ count: 2, expiresAt: now + 3 * h }],
  },
  {
    provider: "anthropic",
    slot: "work",
    readAt: now - 60000,
    grants: [{ count: 1 }, { count: 1, expiresAt: now - 60000 }],
  },
  {
    provider: "anthropic",
    slot: "home",
    readAt: now - 60000,
    grants: [{ count: 1, expiresAt: now - 1000 }],
  },
]
```

Script `drives/lanes-resets.json` (the run with that ledger, 120x40):

1. **At rest.** `waitFor resets anthropic default 2, work 1 · next lapses`, `cap 79-resets-at-rest`. Row 7 reads `↺ resets anthropic default 2, work 1 · next lapses <HH:MM>`; `home` is not named.
2. **Second view.** `sh gent ctl lanes --line` and `sh gent ctl lanes`. The line file holds the row without its mark; the JSON lists `resets` on `default` and `work` only.
3. **Resize.** `resize 50 20`, `cap 79b-resets-narrow` (`↺ resets anthropic default 2, work 1`); `resize 34 20`, `cap 79c-resets-narrower` (`↺ resets default 2, work 1`); `resize 120 40`, `cap 79d-resets-wide-again`.

## Gotchas

- Write the ledger just before the launch: the lapse clock and the lapsed grants are relative to `now`.
- A ledger change on disk shows only after a server restart.
- The row names the lapse in the local zone, so the clock differs between machines.
