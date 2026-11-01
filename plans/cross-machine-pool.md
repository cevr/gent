# Two machines, one pool (row 21)

Date: 2026-10-31. Status: design, not built.

The owner works on the Mac and on the workbox (`bite-workbox`, Tailscale)
at the same time. Each runs its own gent server and its own ledger
(`PlacementLedger` in `packages/core/src/runtime/provider.ts`). The goal is
one pool: the six-day pace and the per-account windows hold across both
machines, so 99.9% of each weekly quota is spent and no limit is hit.

## What each server already sees (measured from source)

- Every Anthropic response carries the account-wide unified utilization
  headers (`unifiedQuota`, `packages/extensions/src/anthropic.ts:3102`).
  These count every client of the account: the other machine, Claude Code,
  TeamClaude. So each server's `readings` are already global.
- `burn` (`LaneBurn`) is local: fuel per lane-hour over this server's
  ended lanes. Fuel is read from the window deltas, so the other machine's
  spend in the same window is charged to this server's lanes (inferred).
- Admission is local: a server admits lanes while the pool is under pace.
  It does not know the other server's open lanes.

## The failure today (inferred)

Both servers read the same utilization and both see headroom. Both admit.
Each one's burn per lane-hour rises because it absorbs the other's spend,
so each then admits fewer. The pool converges, but late and in swings: two
admitters on one budget, each with a lagged signal. Near a 5h limit the
lag can overshoot into a 429 before either backs off.

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
  (link revoked, thread gone). It survives a restart.
- **One usage hub** (`apps/server/src/usage/cliproxyApi.ts`,
  `UsageLimitSources.ts`). Usage limits come from a CLIProxyAPI hub's
  management API, one account pool that every machine reads. The pool is a
  server, not a file per machine.

TeamClaude: one account set, synced across installs through
`teamclaude callback`, so a token refresh reaches every install.

## Design

One pool authority, the workbox server: it is always on and holds the
long-running work.

1. **Pool link.** The Mac's server links to the workbox's server with a
   pairing code (T3's model). `gent pool link <url>` on the Mac; the
   workbox prints the code with `gent pool pair`. Address: the Tailscale
   name. The token lives in gent's secret store, never in argv or config.
2. **Grants, not ledgers.** Before a lane opens, the Mac asks the
   authority for a grant (provider, account slot, model). The authority
   runs the same admission it runs for its own lanes, over both machines'
   open lanes. A grant is a lease: the Mac renews it while the lane runs,
   and an unrenewed lease ends after a timeout (a crashed Mac frees its
   lanes).
3. **Readings flow up.** The Mac sends each quota reading and each lane's
   end (fuel, hours) to the authority with its renewals. Burn is then
   measured over all lanes on one window, so no lane absorbs another
   machine's spend.
4. **Offline fallback.** When the authority does not answer, the Mac paces
   alone on its local ledger, at a reduced share (half the pace, guess),
   and shows that on the band. It retries with T3's backoff. When the link
   returns, open local lanes register with the authority.
5. **Accounts.** While TeamClaude runs beside gent (owner, 2026-10-31:
   "side by side until I'm more confident"), each machine's gent sends its
   Anthropic calls through that machine's TeamClaude proxy, and TeamClaude
   stays the one holder of each token family. At the cutover the authority
   holds the credentials. The Mac never holds a refresh token, so one
   holder rotates each token family (lanes.md "Cause"). The Mac's model
   calls still go direct: the grant names the slot, and the authority
   hands a short-lived access token with it. Measured 2026-10-31: the Mac
   and the workbox TeamClaude hold different refresh tokens for the same
   account, so today each install may hold its own family.
6. **Cross-machine threads** (later). A thread may start a child on the
   other machine (`environment` on `delegate.start`), as T3's remote
   delegation: the child is an ordinary thread there, and the parent wakes
   on its completion. Not needed for the pool.

## Open questions

- Share for the offline fallback: half the pace, or the Mac's share of the
  last 24 h? (guess: half)
- Does the access-token handoff in step 5 satisfy the provider's terms for
  one subscription used from two machines? It already happens today with
  Claude Code on both, so inferred yes.

## Order

1. Pool link and pairing (no admission change). Test: two servers in one
   test process, the second linked to the first.
2. Grants and leases, readings flow up. Test: two servers on one scripted
   account; the sum of open lanes holds under the pace.
3. Offline fallback.
4. Credentials on the authority, at the TeamClaude cutover only (the
   owner decides when).
