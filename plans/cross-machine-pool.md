# Two machines, one pool (queue row 56, was row 21)

Date: 2026-10-31. Revised 2026-11-01 against main `92f0a8653`, after rows
53 to 55, and again after review round 1 and the owner's link decision.
Status: steps 1 to 3 built, step 2 checked live on both machines; step 4
waits for evidence.

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
3. **Both link modes** (2026-11-01, verbatim: "Let's do both I and II").
   (i) Each machine reads its peer on its own link. (ii) Each link also
   carries the reader's own facts to the peer on stdin, so one working link
   keeps both servers informed. The workbox already reaches the Mac over
   Tailscale SSH with a key the Mac accepts, and finds `gent` on the
   non-interactive `PATH` (measured 2026-11-01 from the workbox:
   `echo ok; command -v gent` printed `ok` and `/Users/cvr/.local/bin/gent`).
   So (i) needs no access change.

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

**(b) A peer link of own facts.** Each server publishes its own facts: its
admitted runs and its metered fuel, per account. The other server reads
them and counts them. With owner rule 3 (ii), a link also writes the
reader's own facts to the peer, which notes them as if it had read them.
No admission state is written to the other machine: only each server's own
facts, which the receiver holds as a cache.

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
  inside one propagation delay, and a partition, are left unserialized.
  This is best-effort coordination, not a guarantee: the bounds and their
  costs are under "Failure modes".
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
      reading. A diagnostic, not identity ("Account identity" below).

No time from the peer's clock is in the facts. Schema: `PoolFacts`,
packages/core/src/domain/driver.ts.

### The link

- The server serves its facts as a stream (`accounts.pool`, built in step
  1): the current facts, one line at each change, and a heartbeat after
  30 s with no line (guess) that repeats the last facts under the same
  `seq`. Each line is a whole snapshot, so a reader keeps the last one and
  the reader is the same whichever machine starts the link. Each reader
  holds one pending snapshot, the newest: a stalled SSH reader costs one
  value, gets the newest facts when it resumes, and never holds the
  placement lock. The stream ends as the server's shutdown begins, so a
  peer follower never delays a restart. `gent ctl pool --follow` prints
  that stream as bare `PoolFacts` JSON lines and exits 1 when the stream
  ends or the connection drops; `gent ctl pool` prints the first. Measured
  (step 1 tests).
- The user file names the peer as a command (`pool.peer`, an argv array).
  On the Mac: `["ssh", "bite-workbox", "gent", "ctl", "pool", "--follow"]`.
  On the workbox: `["ssh", "cvr@cristians-macbook-pro", "gent", "ctl",
  "pool", "--follow"]`. Both are Tailscale names; the config holds names,
  never addresses. A project file cannot set it, as with `extraUsage` and
  `sabbath` (measured: config.ts counts them in the user file only); the
  command runs code.
- A scoped server fiber, beside the pool sweep, runs the command, decodes
  each stdout line, and notes it on placement (`CredentialPlacement.notePeer`).
  The same fiber writes this server's own `pool` stream to the command's
  stdin, one `PoolFacts` line each (owner rule 3 (ii)). It restarts with
  backoff to 5 minutes (T3's follower rule) and logs each failure
  (`credential-placement.peer.failed`).
- **The input side (step 2).** `gent ctl pool --follow` also reads
  `PoolFacts` lines on its stdin and sends each to the server it attaches
  to (a new RPC, `accounts.notePeer`), which notes them as the peer's
  facts, as its own fiber would. Stdin closed: the forwarding stops and the
  stream keeps printing. A line that does not decode fails the command with
  a `CtlFailed` line, so the sending fiber restarts the link. Step 1 does
  not read stdin.
- **One peer cache, two sources.** A server holds one peer's facts, fed by
  its own link's stdout and by the lines its peer's link sends in. A line
  replaces the cache when its `boot` differs (a restart) or its `seq` is
  higher or equal under the same `boot` (an equal one, a heartbeat or the
  same line from the other source, adds no fuel but releases the pending
  segments; built in step 2); a lower `seq` only refreshes the last-line
  time.
  Freshness is the reader's own clock at the arrival of any line from
  either source. Two machines only: a third is out of scope.
- No `pool.peer`: nothing runs and nothing changes. The single-machine
  path stays as it is today. A server with no `pool.peer` that receives
  lines on `accounts.notePeer` counts them (a link the other machine
  started), so one config on one machine already informs both.

### How placement counts the peer

- **Account identity: the label, by convention.** One account holds the
  same label on both machines; the label is the identity. Anthropic
  sign-ins store no account id (measured: no account uuid in
  anthropic.ts), and a reset time is not an identity: one account named
  differently on two machines would count nothing, two accounts whose
  weekly resets fall within 60 s would merge, and a rollover would refuse
  a true match. The convention holds today: each machine stores 8
  Anthropic credentials, and all 8 labels are on both (measured
  2026-11-01: `gent auth list` on each machine, each `provider/label`
  hashed with sha256 and the hash sets intersected; counts only, no label
  printed). Checked at link time: on the first line of each peer `boot`,
  a peer label that names none of this server's pool accounts, and an own
  pool label the peer does not list, are logged once
  (`credential-placement.peer.label-unmatched`, labels only, both
  directions) and count no peer data. `week` is a diagnostic only: a
  matched label whose peer `week` differs from this server's own `7d`
  reset by more than 60 s (`QUOTA_RESET_TOLERANCE_MS`) logs
  `credential-placement.peer.week-mismatch` once per `boot` and still
  counts. Not built: a `pool.peer.accounts` map of peer label to own
  label. It is the next step only if the labels ever stop matching; the
  convention needs no config (subtract before you add).
- **Load (F1, F5).** `laneLoad` adds the peer's `runs` whose accounts
  overlap the scope. `loneStart` reads the pool load, so one lone start runs across
  both machines, not one per machine.
- **Ranking (F3).** `rankPlacement` adds the peer's `live` sessions to
  each account's live count.
- **Fuel (F2).** On each line, the reader takes the rise of each
  account's `spend` `fuel` per model since the last line and adds it to
  that account's open segments, as `noteFuel` does. A rise of a model's
  `unpriced` drops that model's segments and the account's own, as an
  unpriced own request does.
- **Fuel reconciliation: a close waits for the next peer line.** The
  peer's fuel and the provider's reading of it reach this server by two
  paths, in either order. Moving a late rise into the next segment does
  not preserve `fuelPerPct`: a segment closes at the first 1% move
  (`read`, provider.ts), and a segment with zero fuel is not kept. Say A
  reads B's point before B's line brings its fuel F (quota-before-facts):
  A closes a zero-fuel segment, which is dropped; F lands in the next
  segment; A then spends F for a second point, and the fit keeps 2F for 1
  point, not F per point. Capacity on that account is overstated (2x when
  these are its only kept segments).
  Inferred from `read` and the fit. The rule: on an account the peer
  shares (its last facts list spend or runs on it), a reading that would
  close a segment marks it pending instead. The next peer line to arrive,
  by arrival order on this server and never by a peer clock, adds its
  fuel rise to the pending segment, keeps it, and the segment that reading
  opened starts with no fuel from that line. A pending segment that sees
  no peer line within 60 s (two heartbeats) is dropped: its fuel is
  unknown, never zero. What it costs: the peer's spend between the reading
  and that line's arrival (one propagation delay, plus at most one
  heartbeat when the peer is idle) counts in the closing segment, not the
  next. That is a shift by the lag, not a loss: fuel is conserved, and in
  steady spend the shift is the same at both ends of each segment
  (inferred). A segment's close is held up to 60 s, so `fuelPerPct` reads
  one point later. An account the peer does not share closes at once, as
  today.
- **Band (F7).** `accounts.lanes` reports the peer: its name, its runs per
  provider, and the age of its last line by this server's clock. As built
  (step 3): one `peer` record, not one per provider. Its name is the host
  its last line named (`PoolFacts.host`), its runs the sum on matched
  accounts of every pool, and each link's state (`down`).
- **Overshoot signal.** The server logs
  `credential-placement.pool-overshoot` once per crossing when own plus
  counted peer load exceeds the capacity. Two events can cross: a peer
  line that raises the peer's load, and a reading that lowers the
  capacity (the account-wide room fell faster than counted load
  explains, which a silent peer's spend does). The second needs no peer
  line, so the log also measures a partition. Step 4 depends on this log.

### Failure modes

This is best-effort coordination. The bounds below hold only while both
servers follow the same rules; nothing revokes a run already admitted.

- **One link is down.** Each link carries both directions (owner rule 3),
  so either link alone keeps both servers informed. The counts do not
  change; only the band (step 3) shows the link that failed. Inferred
  from the link design. As built, each server knows its own link from
  its command's stdout and the peer's from `accounts.notePeer` lines;
  it cannot tell the peer's link is down until that link was heard once
  in this server run (step 3).
- **A partition: both links down** (Tailscale down, a machine asleep, or
  its server stopped). Silence does not prove the peer stopped: a
  sleeping Mac resumes its runs when it wakes, and a cut network hides
  runs that go on. The policy, from the owner's goal (spend each week to
  100% before its reset) and row 57 (a usage limit now waits for the
  reset; it no longer kills the run):
  1. **Silent:** no line from either source for 90 s (three heartbeats).
     The reader drops its open and pending segments on the accounts the
     peer shares: their fuel is unknown, never zero. It logs
     `credential-placement.peer.silent` once.
  2. **Hold, the first 30 minutes of silence (guess).** The reader keeps
     the peer's last-known runs and live sessions counted, and caps its
     own load at half the capacity: it admits a start only while its own
     load stays under `min(C - peer runs, C / 2)`. With both servers on
     this rule the pool stays at or under C. Proof sketch: at the cut A
     holds a runs and B holds b, with a + b at most C. A server at or
     under half admits up to half, and a server over half admits nothing;
     the other one admits at most C minus the first one's last-known runs.
     So the total is at most C (inferred). This also closes the case the
     first plan missed: A holds C long runs, B loses its view of A, and
     B, still counting A's C runs, admits nothing (the first plan's
     10-minute expiry let B admit C more, so 2C).
  3. **Release, after 30 minutes.** The reader counts the peer's runs as
     0 and lifts its own cap to C. The release is a bet that a peer silent
     that long has stopped or paused; it is not a proof. The
     `pool-overshoot` log (readings lowering the capacity under counted
     load) shows when the bet was wrong.
  4. **A line arrives:** the counts resume at once. A new `boot` is
     handled as a restart (below).

  What it costs. During a hold, each machine starts at most half the
  pace, though the other machine may be idle: a short cut wastes up to
  half the pool's pace for 30 minutes. After a release with both machines
  busy, the pool can run up to 2x the pace until a link returns. The 90%
  cap on the 5h window and the row 57 wait bound that damage to a pause,
  not a lost run. Holding forever was rejected: a Mac asleep overnight
  would hold the workbox at half the pace all night, and quota a week
  does not spend is lost at its reset, while overshoot only pauses work
  until a reset. A Mac that wakes resumes its runs before its link is
  back (backoff up to 5 minutes), so the pool can pass C by the Mac's
  runs at sleep for that time; the log measures it.

- **The peer restarts.** A new `boot` gives no fuel rise for the gap. The
  reader drops the open and pending segments on the accounts the old boot
  had fuel or runs on, then counts from the new base.
- **Clock skew.** The facts carry no peer time. Freshness is the reader's
  own clock at arrival. The `week` diagnostic compares two provider
  `resetAt` values, both on the provider's clock, and the fuel
  reconciliation uses arrival order. So skew between the machines changes
  nothing. Inferred from the schema.
- **Both admit at the same moment.** Each sees the other's runs one
  propagation delay late: an SSH line over Tailscale, under a second
  (guess). Two starts inside that delay can both take the last room.
  Overshoot needs simultaneous bursts on both machines. The
  `pool-overshoot` log measures how often it happens. Step 4 bounds it
  only if the log shows it.
- **A label on one side only.** That account counts no peer data and is
  logged (`peer.label-unmatched`). It behaves as today: F2's bias on it,
  no peer runs subtracted.
- **A wrong command.** The fiber fails, logs, backs off; the band shows the
  peer as unread. A partition follows if the other machine's link is down
  too.

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
   Review round 1 fix (`fix(lanes): …`): each reader holds one pending
   snapshot, the newest (a stalled reader skips to the newest `seq`); the
   heartbeat comes after 30 s with no line, not on a fixed period; the
   streams end as the server's shutdown begins (`endPool`, run by the SDK
   server before Bun's listener drain), and `--follow` then exits 1 with
   `the server stopped`. Tests: the stall, the idle heartbeat (a change at
   29 s, no repeat at 30 s, one at 59 s), the end at close, and the ctl
   test over the real server, which closes the server and needs the
   follower to end within 5 s.
2. **Done: `feat(lanes): count the peer's runs and fuel in the pool`.** The

   `pool.peer` config (user file only), the reader fiber with both
   directions (stdout read, own facts written to stdin), the stdin side of
   `gent ctl pool --follow` and `accounts.notePeer`, the one peer cache,
   `notePeer`, and load, lone start, ranking and fuel in one commit (F1 and
   F2 must land together). Tests over two placements and one scripted
   account set, the peer fed in memory (the probe's setup):
   - disjoint accounts: A's and B's admitted starts sum to the solo
     capacity (13), not 26. Fails without the peer's runs in `laneLoad`.
   - shared account: each server's `fuelPerPct` is the true rate (2 M), not
     1 M. Fails without the peer's fuel.
   - shared account, both on: the admitted starts sum to the solo capacity
     (6), not 3 or less. Fails with load on and fuel off.
   - newcomer: the sum stays at or under the solo capacity. Fails today
     (15 against 12).
   - quota-before-facts: A reads the point B's fuel F moved before B's line
     brings F; then A spends F for the next point. `fuelPerPct` is F per
     point, not 2F. Fails when the close does not wait for the peer line.
   - facts-before-quota: B's line brings F, then A reads the point. The
     segment keeps F for 1 point, and the next peer line (a heartbeat, no
     rise) releases it with no fuel added. Fails when the pending close
     discards the fuel the segment already held.
   - a pending segment with no peer line for 60 s is dropped.
   - partition: after 90 s of silence the reader holds the peer's
     last-known runs and caps its own load at `min(C - peer runs, C / 2)`;
     the case A holds C, then the cut, admits nothing on B. After 30
     minutes the peer's runs count 0 and the cap lifts. A line ends the
     silence at once. A new `boot` drops the open segments. Each fails with
     its rule removed.
   - identity: a label on one side only counts no peer data and logs
     `peer.label-unmatched`; a matched label whose `week` differs by more
     than 60 s still counts and logs `peer.week-mismatch`.
   - one cache, two sources: the same line from both sources counts its
     fuel rise once; a lower `seq` under the same `boot` only refreshes the
     time.
   - ctl stdin: `gent ctl pool --follow` with `PoolFacts` lines on stdin
     notes them on the real server (the step 1 ctl test's setup); a bad
     line exits 1 with `CtlFailed`.
   - A's facts after it reads B list A's runs alone.
     Docs: lanes.md, credentials.md (placement), cli.md. Live check: the Mac
     with `pool.peer` alone, then both machines; `gent ctl lanes` on each
     shows the other's runs.
     Built as: `PoolConfig` (config.ts), `followPoolPeer` (the link, a
     server fiber beside the pool sweep), `notePeer` and its helpers in
     runtime/provider.ts, `accounts.notePeer` (rpc.ts, server.ts), and the
     stdin side of `gent ctl pool --follow`. Measured with the probe's setup
     (two placements and a solo, one scripted account set, the peer fed in
     memory, steps of 30 s): disjoint accounts admit 13 + 13 = 26 apart
     against the solo's 13, and 12 + 0 linked; the newcomer admits 6 + 8 =
     14 apart against 12 (not 15: the steps moved to 30 s, see below), and
     12 + 0 linked; one shared account reads 2 M fuel per point on the solo,
     A and B, and admits 6 + 0 against the solo's 6. Each test fails with
     its protection removed (32 probes). Where the code differs from the
     design above:
   - Equal `seq` counts as a new line, not a refresh: its rise is 0, and
     it commits the pending segments. The heartbeat repeats the same
     `seq`, and the facts-first case needs it to release a point. A lower
     `seq` under the same `boot` only refreshes the time.
   - A pending list per window, and the rise goes to the newest pending
     segment. A reading that opens a fresh segment, or closes one of
     unknown fuel, on a shared account leaves a placeholder pending (no
     segment), so the next line's rise lands there and not in the point
     after it.
   - Facts first (the peer's line before the reading of the point it
     moved) is the common order on a live link. Then a steady peer's
     rise lands one line late: conserved over a long run, biased at the
     edges. The test feeds a heartbeat after each reading.
   - A new base (the first line, a new `boot`, or the first line after
     silence) gives no rise, and drops the open and pending segments of
     each account the old facts used or the new facts list spend on.
     Before the first line a segment holds this server's fuel alone: the
     link must be up before both spend (the shared-account test brings it
     up first).
   - Overshoot is counted with no Sabbath, over this server's pool, both
     at a peer line and at a reading.
   - The silence needs a timer: a watch armed 90 s after each line serves
     the queue, which turns the peer silent. The hold's end is also a
     wake time of the queue.
   - The half cap applies to the providers the peer's facts list, and to
     the pool's check only (a model's own window keeps the plain check).
     A lone start still goes in the hold when the pool load is 0.
   - The peer's rise adds fuel, not tokens: the facts carry no tokens.
   - A rename carries pending segments to the new label; a new sign-in
     drops them.
   - The link reads `pool.peer` at each run; with none it stops, so a
     `pool.peer` added while the server runs takes a server restart.
   - `gent ctl pool --follow` reads no stdin when stdin is a terminal.
   - The 1-minute steps of the probe let a pending segment expire exactly
     at 60 s, a test artifact: the tests step 30 s.
   - Review fixes (one commit): a run that prints no line for 90 s is
     stopped (an ssh on a dead route waits hours on TCP keepalive, and both
     servers would count each other as 0 after the hold); the documented
     commands add `ServerAliveInterval=15`. A run that noted a line starts
     the wait over only when it lived a minute, so a peer server that
     refuses this one's facts at its first stdin line does not relaunch
     each second. A command that closes its stdout and stays up is stopped
     1 s later. Counts, sessions, unpriced, `seq` and fuel decode only at 0
     or above. Not changed: a duplicate line from the second link can commit
     a pending segment early, the same edge bias as facts first; the link
     and `accounts.notePeer` resolve the same launch cwd (`RuntimeEnvironment`
     is built from `config.cwd`); a child holding stderr does not hold the
     run (the spawner ends stderr at the exit, measured).
   - Left: a silent peer's next line with a lower `seq` of the same
     `boot` replaces the cache (it starts a new base), not a refresh.
   - Live check, 2026-11-01: two scripted-model servers (Mac and workbox,
     scratch homes, a fake `default` key, a seeded ledger) linked by
     `pool.peer` over ssh. `debug threads` and `debug delegate` on either
     side raised `load` to 1 on both sides within 0.2 s, and both fell to 0
     together. No link failure past the one at start (the workbox server
     was not yet up), no silence, no label mismatch, no overshoot
     (measured). `debug machine` holds no lane: its step is a shell
     command.

3. **`feat(tui): show the peer in the lanes band`.** A row after the
   provider rows: `peer <name> <runs> runs · <age>`, or `peer <name>
   unread <age>` when silent, with a mark when one of the two links is
   down; `gent ctl lanes --line` prints the same.
   Tests: `laneRows` in apps/tui/tests (fails without the row), the ctl
   line test. `bun run test:e2e` and the verify-gent live check at normal
   and narrow widths.
   Done (2026-11-01). As built:
   - The name is the peer machine's hostname cut at its first dot, a new
     required `host` in `PoolFacts` (`os.hostname` through `GentPlatform`).
     No config key: the hostname names the machine with no setup, and both
     servers are this build. The memory placement (`CredentialPlacement.Memory`)
     and the test placements name `test-host`.
   - `LaneReport.peer` is optional: `heard` (`host`, `at`), `runs`,
     `silent`, `down` (`own`, `peer`). It is absent with no peer line and
     no link of this server's own. `gent ctl lanes` now prints the whole
     `LaneReport` beside `server`, so the JSON carries it.
   - What a server can know of the links: its own link (`own`) is the
     `pool.peer` command's stdout, down after 90 s with no line, counted
     from the link's start or its last line, so a command that never
     prints reads down too. The peer's link (`peer`) is the lines that come
     through `accounts.notePeer`: down after 90 s with no line, but only
     once one came in this server run. Nothing tells a server that the
     peer set a `pool.peer`, so a link that was never heard reads as no
     link, not as down.
   - Rows: `peer <host> <n> runs · <age>` (`1 run` singular), `peer <host>
     unread <age>` when silent, `peer unread` before the first line. A down
     link marks `peer!` and adds `· own link down`, `· peer link down` or
     `· links down`. Narrower, the row dropped the reason, then the age,
     then the host (the review fixes below changed this order). The glyph is `⇄`, info tone while heard, warning while
     silent or down.
   - The band reads `accounts.lanes` every 30 s, at a turn's end and at a
     reconnect, so a peer run of a few seconds can fall between two reads;
     the age ticks between reads. A real model run lasts minutes (inferred).
   - Live check (verify-gent, 2026-11-01, one Mac, three scratch servers):
     run A, a server B whose `pool.peer` runs A's `gent ctl pool --follow`,
     and a server C whose `pool.peer` prints nothing. A read
     `⇄ peer Cristians-MacBook-Pro 0 runs · 29s`, then `1 run · 0s` while B
     ran `debug threads`; at 26 columns `⇄ peer 1 run`. B stopped by PID: A
     read `⇄ peer! Cristians-MacBook-Pro unread 2m · peer link down` at
     121 s. C read `⇄ peer unread`, then `⇄ peer! unread · own link down`
     at 90 s (measured).
   - Review fixes (one commit, `fix(lanes): …`):
     - The `accounts.notePeer` handler tags its lines with the link
       `peer`. A new rpc test notes one line, moves the test clock 90 s and
       reads `down: ["peer"]`. With the tag `own`, the test fails.
     - The lanes report drops the peer when its facts stop counting (90 s
       of silence and the 30-minute hold) and this server runs no link of
       its own. Before, a peer whose owner removed `pool.peer` stayed on
       the band as `peer! … unread 3h · peer link down` until a restart.
       While this server runs its own link, the report keeps the peer, so
       the band names that link down.
     - The row ranks its facts: a silent peer's held runs, then the link
       down, then the age, then the host. Each width shows the best set of
       facts that fits. The mark and the runs or `unread` always stay.
       Before, a narrow row dropped the link down first.
     - A silent peer's row shows its held runs while they still limit
       admission: `peer! <host> unread 3m · 2 runs held · peer link down`.
     - An empty host name (no name, or one that starts with a dot) gives
       `PoolFacts.host` the name `unnamed`, so the row never prints
       `peer  2 runs`.
     - The ranking puts the age over the host. So the form `peer! <host>
       unread · <link> down` never shows: at each width where it fits,
       `peer! unread <age> · <link> down` also fits. A live row at 17 to
       24 text columns now reads `peer 2 runs · 12s`, not `peer <host> 2
       runs`.
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

1. **How the workbox reads the Mac: decided 2026-11-01, both modes.** The
   owner chose (i) and (ii) together ("Let's do both I and II"): each
   machine reads its peer on its own link, and each link also carries the
   reader's own facts on stdin. Owner rule 3 holds the decision; "The
   link" and "Failure modes" hold the design. No choice is open.
