# Lanes band

Under the status row, a band shows how many runs the accounts can carry now and what runs on their own. Its first row is the free lanes per provider (`≡ lanes anthropic 1/1 free · 5h 120k/% ±13% · out 0%`: free over capacity, the binding window's fuel per percent, its band and the spend outside gent). Each active machine run of this session's thread follows it (`▸ soak check r1 3s`: machine, state, round, age; `◷ … · wait 13:47` while its round waits for its account; `?` while it asks). The band hides while gent read no quota window and no run is active. `gent ctl lanes` prints the same lanes as JSON, and `--line` prints the band's row.

## Sub-features

- `band-measured`: a run whose ledger holds a reading and a fitted rate shows `≡ lanes anthropic 1/1 free · 5h 120k/% ±13% · out 0%` at rest.
- `band-hidden`: a run with no reading shows no band at rest.
- `band-unknown`: with no reading, an active run shows `≡ lanes unknown` above its row.
- `band-run`: `debug machine` starts the `soak` machine; `▸ soak check r1 <age>` shows until its 45 s command ends, then goes.
- `band-narrow`: at 60 columns the full row fits; at 44 it drops the share and the band and keeps `1/1 free`.
- `ctl-lanes`: `gent ctl lanes` prints `Lanes` with one provider record per line; `--line` prints the band's row text.

## How to get to it (user POV)

- It shows by itself under the status row; there is no key or command.
- `gent ctl lanes` and `gent ctl lanes --line` from a shell, with no session.

## Driving it with verify:drive

- **Preconditions:** `band-measured` needs a run launched with a ledger: write `credential-usage.json` with current times (the recipe below), then `verify:launch --dir "$RUN" --data <dir>/credential-usage.json`. `band-hidden` and `band-unknown` use the baseline run. The scripted model reports no quota window, so a measured row needs the ledger.
- **States:** default (measured, hidden), loading (the run's command runs), empty (no reading: hidden, then `lanes unknown`). Focus, open and error are `n/a`.
- **Regression:** `apps/tui/tests/extensions/machines.client.test.tsx`, `apps/tui/tests/ctl.test.ts` (`lanes needs no session`), `packages/extensions/tests/machines.test.ts` (`through the RPC harness`), `packages/e2e/tests/verify.test.ts`.

Ledger recipe, run in an empty directory outside the checkout:

```sh
bun -e '
const now = Date.now(), h = 3_600_000
const seg = (endedAt) => ({ provider: "anthropic", slot: "default", window: "5h", endedAt, fuel: 240000, deltaPct: 2, tokens: { input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 0 } })
await Bun.write("credential-usage.json", JSON.stringify({ buckets: [], readings: [{ provider: "anthropic", slot: "default", window: "5h", utilization: 0.4, resetAt: now + 2 * h, readAt: now - 60000, rejected: false }], segments: [seg(now - 600000), seg(now - 120000)] }))'
```

Script `drives/lanes.json` (the run with the ledger, 120x40):

1. **At rest.** `waitFor lanes anthropic 1/1 free`, `cap 71-lanes-at-rest`. Row 5 reads `≡ lanes anthropic 1/1 free · 5h 120k/% ±13% · out 0%`.
2. **Second view.** `sh gent ctl lanes --line` and `sh gent ctl lanes`. The line file holds the same row; the JSON holds `capacity: 1`, `fuelPerPct: 120000`.
3. **A run.** `send debug machine`, `keys enter`, `waitFor soak check r1`, `cap 72-band-with-run`. `▸ soak check r1 0s` under the lanes row.
4. **Its record.** `sh gent ctl request --extension @gent/machines --id run-list`. One run, `machine: "soak"`, `status: "running"`.
5. **Resize.** `resize 60 20`, `cap 73-band-narrow`; `resize 44 20`, `cap 73b-band-narrower` (`≡ lanes anthropic 1/1 free · 5h 120k/%`); `resize 120 40`, `cap 74-band-wide-again`.
6. **The end.** `waitFor` a screen without `soak check r1` (about 45 s), `cap 75-run-ended`. The `machine-end` row lands and the lanes row stays.

Script `drives/lanes-unknown.json` (the baseline run, 100x30):

1. **Hidden.** `cap 76-no-band`: nothing under the status row. `sh gent ctl lanes --line` prints `lanes unknown`.
2. **A run.** `send debug machine`, `keys enter`, `waitFor soak check r1`, `cap 77-unknown-with-run`: `≡ lanes unknown`, then `▸ soak check r1 0s`.
3. **Narrow.** `resize 60 20`, `cap 78-unknown-narrow`.

## Gotchas

- The ledger's readings must be recent: the server drops a reading older than 7 days, and the row says `unknown`. Write the ledger just before the launch.
- The band reads on a turn's end, a reconnect and every 30 s. A ledger change on disk shows only after a server restart.
- A run belongs to the session that started it: a new `["gent"]` session shows the lanes but not another session's runs.
- `gent ctl lanes` takes no `--cwd` or `--session`: the accounts are the server's.
