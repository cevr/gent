# Banked resets

`/status` shows the resets each account's plan holds to clear a spent window early (Claude's reset grants, Codex's reset credits): one row after the provider's lanes row and its lost logins, `↺ resets anthropic default 3 · next lapses 08:10` (each account's count, then when the soonest grant lapses). A lapsed grant counts none; an account with none, or out of the provider's scope, is not named. A count goes three sweeps (30 minutes) after the read that listed it. `gent ctl lanes` lists each account's `resets`, and `--line` prints the row without its mark. A held reset needs no action, so the band under the status row never shows the row. Gent never spends a reset.

## Sub-features

- `resets-at-rest`: no band and no `resets` text under the status row.
- `resets-in-status`: in `/status`, at the end of the list, the full row under the lanes row; an account with only lapsed grants, or out of the scope (`work`: the run's scope is `default` alone), is not named.
- `resets-narrow`: the pane picks the row's shorter forms for its width: at 44 columns `↺ resets anthropic default 3` (and `≡ lanes anthropic 1/1 free · 5h 120k/%`), at 28 `↺ resets default 3` (and `≡ lanes 1/1 free`).
- `ctl-resets`: `gent ctl lanes` holds `resets` on every account that holds any, `work` too; `--line` prints `resets anthropic default 3 · next lapses <HH:MM>`.

## How to get to it (user POV)

- `/status` (or `Status` in the `ctrl+p` palette), then `down` to the lanes rows at the end of the list.
- `gent ctl lanes` and `gent ctl lanes --line` from a shell, with no session.

## Driving it with verify:drive

- **Preconditions:** a run launched with a ledger that holds resets: the [lanes](lanes.md) ledger recipe, with this key added to its object, then `verify:launch --dir "$RUN" --data "$(dirname "$RUN")/evidence/credential-usage.json"`. The scripted model reads no usage, so the resets come from the ledger.
- **States:** default (no row at rest), open (`/status`: resets held, one account out of the scope, one with only lapsed grants). Loading, empty, focus and error are `n/a`: empty is `/status` without the row, which [lanes](lanes.md) covers.
- **Regression:** `apps/tui/tests/extensions/machines.client.test.tsx` (`banked resets`), `apps/tui/tests/ctl.test.ts` (`lanes needs no session`), `packages/core/tests/runtime/provider.test.ts` (`banked resets`), `packages/core/tests/server/rpc.test.ts` (`banked resets at start`).

The ledger key (`now` and `h` as in the lanes recipe):

```js
resets: [
  {
    provider: "anthropic",
    slot: "default",
    readAt: now - 60000,
    grants: [{ count: 2, expiresAt: now + 3 * h }, { count: 1 }],
  },
  {
    provider: "anthropic",
    slot: "work",
    readAt: now - 60000,
    grants: [{ count: 1 }],
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

1. **At rest.** `expectNot resets`, `cap 79-resets-at-rest`. No band.
2. **In /status.** `send /status`, `keys enter`, `waitFor more ↓`, `settle`, twelve `down`, `waitFor ↺ resets anthropic default 3 · next lapses`, `cap 79a-resets-in-status`. The pane's last line reads `↺ resets anthropic default 3 · next lapses <HH:MM>`, under `≡ lanes anthropic 1/1 free`; `work` and `home` are not named.
3. **Second view.** `sh gent ctl lanes --line` and `sh gent ctl lanes`. The line file holds the row without its mark; the JSON lists `resets` on `default` and `work` only.
4. **Resize.** `resize 44 20`, `cap 79b-resets-narrow`; `resize 28 20`, `cap 79c-resets-narrower`; `resize 120 40`, `cap 79d-resets-wide-again`. Each capture fits its width.

## Gotchas

- Write the ledger just before the launch, and drive within 30 minutes of it: the lapse clock and the lapsed grants are relative to `now`, and a count whose `readAt` is 30 minutes old is gone (the scripted model reads no usage, so nothing refreshes it).
- A ledger change on disk shows only after a server restart.
- The row names the lapse in the local zone, so the clock differs between machines.
