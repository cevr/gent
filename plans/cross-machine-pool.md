# Two machines, one pool (queue row 56, was row 21)

Date: 2026-10-31. Revised 2026-11-01 against main `92f0a8653`, after rows
53 to 55. Status: design, not built.

The owner works on the Mac and on the workbox (`bite-workbox`, Tailscale)
at the same time. Each machine runs its own gent server, with its own
`CredentialPlacement` (`packages/core/src/runtime/provider.ts`) and its own
ledger. The goal is one pool: the weekly pace and the 5h cap hold across
both machines. The owner's routing rule (2026-11-01): use the account whose
weekly quota resets soonest; spend each week to 100% before its reset; the
5h window is only a 90% cap.

Labels: **measured** (read in source, or run), **inferred** (follows from
source, not run), **guess**.

## The evidence

On 2026-10-21 the owner carried burn rates, 5-hour projections and stop
orders between the Mac and the workbox by hand, in 5 messages, to share the
one account that still had weekly credit
([teamclaude-retro-2026-11-01.md](teamclaude-retro-2026-11-01.md), "What
hurt" 3). Measured (the owner's transcripts, counted in the retro).

## Owner rules that bound the design

1. **Each environment holds its own refresh tokens** (2026-11-01, verbatim:
   "it's intentional for Team Claude and the Mac and the Workbox to hold
   different refresh tokens. Each environment should hold its own refresh
   tokens."). So no machine holds or hands out another machine's
   credentials. The old step 5 (the authority holds the credentials and
   hands out access tokens) is gone.
2. **Routing** (2026-11-01): soonest weekly reset first, each week to 100%,
   the 5h window a 90% cap. `rankPlacement` and `FIVE_HOUR_SHARE` already
   follow it (measured: provider.ts, credentials.md "Credential
   placement").

## What each server sees now (measured from source)

- **Account-wide utilization, fresh.** The Anthropic driver reports the
  `anthropic-ratelimit-unified-{5h,7d}-*` headers on every answer
  (`unifiedQuota`, `reportProviderQuota`, anthropic.ts). The pool sweep
  (`sweepPoolQuotas`, `POOL_QUOTA_SWEEP_INTERVAL` 10 minutes) reads every
  pool account with no spend. Utilization is account-wide, so it includes
  the other machine, TeamClaude and Claude Code (inferred: the provider
  reports one figure per account).
- **Lane burn is local and correct.** `noteFuel` adds a step's priced fuel
  to its own running lane; `burnLane` divides that by the lane's hours. The
  other machine's spend never enters it. Measured. The first version of
  this plan said lane burn absorbs the other machine's spend; that was
  wrong.
- **Fuel per percent is local and biased.** A segment runs from one reading
  to the first that moved 1% (`QUOTA_STEP`) and keeps this server's fuel
  alone. The other machine's spend adds points with no fuel. Measured.
- **Load is local.** `laneLoad` counts this server's admitted runs and
  grants. Placement's `live` counts this server's cache-warm sessions.
  Measured.

## Part 1: what a second machine still breaks

A scratch probe ran two `makeCredentialPlacement` instances (servers A and
B) and a third one (solo) that did all the spend itself, on one scripted
account set. Each step cost $10 (2 M fuel). In the shared and disjoint
cases a step moved the 5h window 1 point (true rate 2 M fuel per point);
in the newcomer case it moved 0.5 point. Each server read the account
after its own steps, as answer headers do (bun test, 2026-11-01, today's
code). The probe file is
`/private/tmp/claude-501/-Users-cvr-Developer-personal-gent/cabc8a65-8d57-48f2-b52e-16d1056d82d5/scratchpad/probe/two-servers.test.ts`;
step 2 turns it into kept tests. Numbers below are from that probe:
measured.

### F1. Each server paces the whole pool for itself alone (real)

Capacity comes from the account-wide remaining quota. Load counts only
this server's runs. So each server admits up to the whole pool's pace.

- **Disjoint accounts.** A spends on account `a`, B on `b`; each reads
  the other account by the sweep. Solo capacity 13; A 13; B 13. Together
  they admit 26: twice the pace. Measured.
- **One shared account.** Solo 6; A 3; B 3; together 6. The bias of F2
  makes each server admit about its own share. Measured. This is an
  accident, not a design: it holds only on accounts both machines spend
  on, and only in steady state.
- **A newcomer.** B runs alone for 30 steps, then A and B share the
  account. After 2 shared pairs, A has no capacity figure (no kept segment
  of its own), and an unknown capacity admits every start. After 6 pairs:
  solo 13, A 7, B 11, together 18 (38% over). After 20 pairs: solo 12, A 6,
  B 9, together 15 (25% over). The incumbent's rate lags by the segments'
  24-active-hour half-life. Measured.

Scenario: the workbox runs 6 threads on the soonest-reset account; the
owner starts a machine on the Mac with 6 workers. The Mac's estimate has
no history, so it admits all 6. The pool runs 12 against a pace of about
6, and the 5h window of that account passes 90%. A running turn keeps its
account until the provider refuses it (lanes.md), so the 10% margin is the
only buffer before a 429. Inferred from the probe and lanes.md.

### F2. Fuel per percent counts the other machine's spend as free (real)

On a shared account, `fuelPerPct` fell to half: A 1.03 M, B 1.00 M,
solo 2.00 M. `outsideShare` read 0 on both. Measured. The outside rule
(`QUOTA_OUTSIDE_POINTS`, 3 points) can never drop such a segment: a segment
closes at the first 1% move, so it moves 1 to 2 points, and its excess
over its own fuel is under 3 points. Inferred from `fitWindow` and `read`.
The same bias already comes from TeamClaude and Claude Code spend today
(inferred); it goes away for gent's machines only.

**F1 and F2 must be fixed together.** Today's F2 bias is what keeps the
shared-account case near the right total. Subtract the peer's load without
adding the peer's fuel, and each server halves its capacity and then also
subtracts the peer's runs: in the shared probe A would see 3 minus B's 3,
so 0 free. Add the peer's fuel without its load, and the shared case
becomes 6 plus 6. Inferred from the probe's numbers.

### F3. Both machines pick the same soonest-reset account (real, part of F1)

`rankPlacement` ranks accounts below their own sustainable live load first,
by weekly reset. `live` counts this server's sessions alone, so each server
fills the soonest-reset account up to its full sustainable figure. This is
the per-account form of F1. Inferred from `rankPlacement` and the `live`
map. It is the right account for both (owner rule 2); the defect is the
count, not the choice.

### F4. A 10-minute sweep misses the other machine's burst (minor)

On an account this server spends on, readings arrive with every answer, in
seconds. Measured (`unifiedQuota` on every answer). The 10-minute age
applies only to an account this server does not spend on. At pace, a 5h
window moves about 10/300 of its room in 10 minutes, about 3 points; at
twice the pace, about 6. That fits in the 10-point margin under the 90%
cap. Inferred. Once F1 counts the peer's runs, this age no longer drives
admission. No work planned.

### F5. Each machine takes a lone start (real, small)

`loneStart` admits a start whatever the pace when no admitted run holds a
lane on the scope. Each server checks its own runs, so each machine gets
one. Measured (`loneStart` reads `laneLoad`). Overshoot: one run per
machine.

### F6. The fair queue is per machine (real, small)

`serve` orders waiters by the lanes their session holds on this server.
Nothing orders a Mac waiter against a workbox waiter. Measured. With F1
fixed, each machine queues against the pool's remaining room, so the
effect is order, not overshoot. Inferred. No work planned.

### F7. Neither band shows the pool (real)

The band and `gent ctl lanes --line` show this server's load against the
pool's capacity. The owner cannot see the other machine's runs from
either. Measured (`laneRows`, `accounts.lanes`). This is the hand
coordination of 2026-10-21.

## Part 2: the design

### Options weighed

**(a) No link: infer foreign burn from utilization.** Today's code already
does this by accident (F2), and the probe shows the result: 2x on disjoint
accounts, 25% to 38% over with a newcomer. A deliberate version must split
one 1%-quantized series into this server's rate and the other's spend:
two unknowns from one signal, solvable only when the other machine's spend
varies on its own (inferred). Utilization also shows past spend only. It
cannot show the other machine's admitted runs, which are the future load
admission needs. Rejected.

**(b) A read-only peer link.** Each server publishes its own facts: its
admitted runs and its metered fuel, per account. The other server reads
them and counts them. Nothing is written to the other machine.

**(c) One authority with grants and leases, no credentials.** Exact: one
admitter, no race. Cost: a write API on the authority, a lease protocol
with renewals, a round trip per Mac admission, pairing, and an offline
fallback. When the authority does not answer, the Mac paces alone at a
guessed share: that is (b) with no peer data. Rejected.

### Choice: (b), each server reads the other

Why, by the principles in `~/Developer/personal/dotfiles/principles/`:

- **Separate before serializing shared state.** The two servers do not
  need one mutable admission state. Each publishes independent facts (its
  own runs, its own fuel), and each merges them at read. Only a race
  inside one propagation delay is left unserialized, and its bound is
  below.
- **Derive, don't sync.** A server never copies the peer's facts into its
  ledger. It holds the peer's latest facts as a cache with a lifetime, and
  derives load, fuel per percent and ranking from own state plus that
  cache. A server never republishes what it read, so no fact echoes back.
- **Use the platform.** The link is the owner's existing SSH over
  Tailscale and `gent ctl`, which attaches to a running server and never
  starts one (`connectCtl`, apps/tui/src/ctl.ts: measured). The gent RPC
  listens on 127.0.0.1 only (`LISTEN_HOST`, packages/sdk/src/server.ts:
  measured), so no new network listener and no pairing flow are needed.
- **Subtract before you add.** (c)'s grants, leases, pairing and authority
  role are not built. The old steps 5 and 6 leave this plan.

### The facts (`PoolFacts`)

One schema, own data only. It has no field for a peer's data, so a server
cannot republish what it read.

- `boot`: a random id per server start.
- `seq`: a number that rises on each change.
- per provider:
  - `runs`: the admitted runs and reserving grants, as `lanesHeld`
    counts them (the owner's own turns left out), grouped by their sorted
    account labels and model, each with its `count` (the reader computes
    each run's share at its own weights, `runShare`). Built in step 1: the
    code holds a run on a scope of labels, not on one account
    (`running.scope`, `reserved.scope`), so a run is published with its
    scope, and a reader counts it on a scope it overlaps, as `lanesHeld`
    counts own runs (`scope.some`).
  - per account label:
    - `live`: the cache-warm sessions on the account, per model;
    - `spend`: per model, the cumulative priced `fuel` and the count of
      `unpriced` steps since `boot`, never reset inside a boot. Built in
      step 1: unpriced is per model too, because an unpriced own step drops
      only that model's segments and the account's own (`noteFuel`). A
      report of a sign-in its label replaced since counts nothing, as for
      own segments; the counts stay on the label they were counted on and
      are not saved.
    - `week`: the `resetAt` of the account's latest account-wide `7d`
      reading.

No time from the peer's clock is in the facts. Schema: `PoolFacts`,
packages/core/src/domain/driver.ts.

### The link

- The server serves its facts as a stream (`accounts.pool`, built in step
  1): the current facts, one line at each change, and a heartbeat after
  30 s with no change (guess) that repeats the last facts under the same
  `seq`. Each line is a whole snapshot, so a reader keeps the last one and
  the reader is the same whichever machine starts the link. `gent ctl
  pool --follow` prints that stream as bare `PoolFacts` JSON lines and
  exits 1 when the connection drops; `gent ctl pool` prints the first.
- The user file names the peer as a command (`pool.peer`, an argv array),
  for example `["ssh", "bite-workbox", "gent", "ctl", "pool", "--follow"]`
  on the Mac. A project file cannot set it, as with `extraUsage` and
  `sabbath` (measured: config.ts counts them in the user file only); the
  command runs code.
- A scoped server fiber, beside the pool sweep, runs the command, decodes
  each line, and notes it on placement (`CredentialPlacement.notePeer`).
  It restarts with backoff to 5 minutes (T3's follower rule) and logs each
  failure (`credential-placement.peer.failed`).
- No `pool.peer`: nothing runs and nothing changes. The single-machine
  path stays as it is today.

### How placement counts the peer

- **Account identity.** Labels name accounts on each machine. A peer
  account counts only when its label matches and its `week` is within
  60 s (`QUOTA_RESET_TOLERANCE_MS`) of this server's own `7d` reset for
  that label. A mismatch ignores that account and logs
  `credential-placement.peer.account-mismatch`. Anthropic sign-ins store
  no account id (measured: no account uuid in anthropic.ts), so the reset
  time is the check. The Mac's pool labels are 7 (measured, its user
  file); that the workbox uses the same labels is a guess, and the check
  catches it.
- **Load (F1, F5).** `laneLoad` adds the peer's `runs` whose accounts
  overlap the scope. `loneStart` reads the pool load, so one lone start runs across
  both machines, not one per machine.
- **Ranking (F3).** `rankPlacement` adds the peer's `live` sessions to
  each account's live count.
- **Fuel (F2).** On each line, the reader takes the rise of each
  account's `spend` `fuel` per model since the last line and adds it to
  that account's open segments, as `noteFuel` does. A rise of a model's
  `unpriced` drops that model's segments and the account's own, as an
  unpriced own request does. Fuel is conserved: a rise
  that belongs to a segment that just closed lands in the next one, so the
  sums behind `fuelPerPct` stay right (inferred).
- **Band (F7).** `accounts.lanes` reports the peer: its name, its runs per
  provider, and the age of its last line by this server's clock.
- **Overshoot signal.** When a peer line makes own plus peer load exceed
  the capacity, the server logs `credential-placement.pool-overshoot`
  once per crossing. Step 4 depends on this log.

### Failure modes

- **The peer is offline** (asleep, or its server stopped). A stopped gent
  server runs no lanes, so its load is truly 0. After 10 minutes with no
  line (guess: one sweep interval), the reader counts the peer's load as 0. Until then it holds the last load, so a short network cut does not
  admit twice. While the peer is silent, the reader drops its open
  segments on the accounts the peer last had runs on: their fuel is
  unknown, never zero.
- **The peer restarts.** A new `boot` gives no fuel rise for the gap. The
  reader drops the open segments on the accounts the old boot had fuel or
  runs on, then counts from the new base.
- **Clock skew.** The facts carry no peer time. Freshness is the reader's
  own clock at receipt. Identity compares two provider `resetAt` values,
  both on the provider's clock. So skew between the machines changes
  nothing. Inferred from the schema.
- **One reader is down.** Say A reads B, and B cannot read A. A subtracts
  B's runs; B admits as today. B's admissions are at most the capacity C;
  A's are at most C minus B's runs. Together at most C. B's fuel per
  percent stays biased low by A's spend, so B admits less, not more.
  Inferred. Both readers down is today's behavior (F1 to F5). The band
  shows a silent peer, so the owner sees it.
- **Both admit at the same moment.** Each sees the other's runs one
  propagation delay late: an SSH line over Tailscale, under a second
  (guess). Two starts inside that delay can both take the last room.
  Overshoot needs simultaneous bursts on both machines. The
  `pool-overshoot` log measures how often it happens. Step 4 bounds it
  only if the log shows it.
- **A label mismatch.** That account counts no peer data. The account
  behaves as today: F2's bias on it, no peer runs subtracted.
- **A wrong command.** The fiber fails, logs, backs off; the band shows the
  peer as unread.

## Part 3: steps

Each commit passes `bun run gate` on its own. Each names the test that
fails without its protection; prove it by disabling the protection and
running the test (feedback: validate the regression test).

1. **Done: `feat(lanes): publish this server's own pool facts`.** The
   `PoolFacts` schema, the placement method that builds it from own state,
   the streaming RPC, and `gent ctl pool --follow`. No admission change.
   Tests (core/tests/runtime/provider.test.ts, apps/tui/tests/ctl.test.ts):
   an admitted run is in the facts and leaves them at its release; a
   priced step raises `fuel` by its fuel; an unpriced step raises
   `unpriced`; the stream sends a line on admit and on release. Each fails
   when its update is removed. Docs: lanes.md.
   Built as: the RPC `accounts.pool` (also tested in
   core/tests/server/rpc.test.ts), one-shot `gent ctl pool` beside
   `--follow`, and the facts' shape above (runs per scope and model, spend
   per model).
2. **`feat(lanes): count the peer's runs and fuel in the pool`.** The
   `pool.peer` config (user file only), the reader fiber, `notePeer`, and
   load, lone start, ranking and fuel in one commit (F1 and F2 must land
   together). Tests over two placements and one scripted account set, the
   peer fed in memory (the probe's setup):
   - disjoint accounts: A's and B's admitted starts sum to the solo
     capacity (13), not 26. Fails without the peer's runs in `laneLoad`.
   - shared account: each server's `fuelPerPct` is the true rate (2 M), not
     1 M. Fails without the peer's fuel.
   - shared account, both on: the admitted starts sum to the solo capacity
     (6), not 3 or less. Fails with load on and fuel off.
   - newcomer: the sum stays at or under the solo capacity. Fails today
     (15 against 12).
   - a peer silent for 10 minutes counts 0 runs, and its accounts' open
     segments are dropped; a new `boot` drops them too.
   - a label whose `week` differs by more than 60 s counts no peer data.
   - A's facts after it reads B list A's runs alone.
     Docs: lanes.md, credentials.md (placement). Live check: both machines
     with `pool.peer`, `gent ctl lanes` on each shows the other's runs.
3. **`feat(tui): show the peer in the lanes band`.** A row after the
   provider rows: `peer <name> <runs> runs · <age>`, or `peer <name>
   unread <age>` when silent; `gent ctl lanes --line` prints the same.
   Tests: `laneRows` in apps/tui/tests (fails without the row), the ctl
   line test. `bun run test:e2e` and the verify-gent live check at normal
   and narrow widths.
4. **Later, only on evidence: bound the race.** Build it only if
   `credential-placement.pool-overshoot` appears in either server's logs.
   Each server's facts name the peer `seq` they last read (`seen`); a
   server holds a new start in the queue while the peer has not seen its
   previous admission, and stops waiting when the peer's `seen` has not
   moved for 10 minutes. Overshoot then is at most one start per machine.

## Not in this plan

- Credentials on another machine (owner rule 1).
- Cross-machine threads (a child on the other machine, T3's remote
  delegation). The pool does not need them.
- Spend from TeamClaude and Claude Code stays outside spend (F2's bias for
  that spend stays as today) until the owner cuts over.

## Prior art

T3 Code (`pingdotgg/t3code` at `cbb0417df`, 2026-11-01):

- **Environments.** Each machine runs a full T3 server. A client lists many
  environments. The desktop reaches a remote one through an SSH tunnel
  (`packages/ssh/src/tunnel.ts`: launch or reuse the remote server, forward
  a local port) or `tailscale serve` (`packages/tailscale/`).
- **Peer links** (`apps/server/src/peer/PeerLinks.ts`). A server links to
  another with a one-time pairing code, through the same MCP OAuth flow an
  outside agent uses. The token goes to the server secret store; a table
  keeps the addresses, the access and the last outcome. Plain http is
  accepted only on loopback or a Tailscale address.
- **Remote delegation** (`RemoteDelegation.ts`). `delegate_task` with an
  `environmentId` starts an ordinary thread on the peer. The parent records
  the task like a local one, and a follower completes it when the remote
  thread ends, so the parent wakes as for a local child. The follower waits
  in 50 s chunks (an edge drops idle requests at about 100 s), retries
  with exponential backoff to 5 min, and stops only on final refusals
  (link revoked, thread gone). It survives a restart. This plan takes its
  backoff rule.
- **One usage hub** (`apps/server/src/usage/cliproxyApi.ts`,
  `UsageLimitSources.ts`). Usage limits come from a CLIProxyAPI hub's
  management API, one account pool that every machine reads. The pool is a
  server, not a file per machine. Gent needs no hub for this: the
  provider's own usage read is account-wide (rows 53 and 55).

TeamClaude: one account set, synced across installs through
`teamclaude callback`, so a token refresh reaches every install. It shares
no load between installs: the 2026-10-21 hand coordination ran beside it.
Measured (the retro).

## Owner choices

1. **How the workbox reads the Mac.** (i) The owner lets the workbox SSH
   to the Mac over Tailscale: one `authorized_keys` line on the Mac. The
   Mac's sshd listens (measured, 2026-11-01, a local port check); whether
   the workbox has a key the Mac accepts is not known. (ii) One link the
   Mac starts carries both directions: the workbox's `gent ctl pool` also
   reads the Mac's facts from its stdin and notes them on the workbox
   server. No new access, but a dropped link blinds both servers at once.
   Recommendation: (i). Two independent readers keep the pool bounded when
   one fails (Failure modes, "One reader is down").
