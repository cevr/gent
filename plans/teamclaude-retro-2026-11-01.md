# TeamClaude retro (2026-11-01)

The owner asked for a retro on how TeamClaude served the Claude Code
sessions, and for gent to take over what it did and what it lacked. Gent
now signs in to each Claude account itself (`81e6bfbbc` to `ddab7dbe0`);
TeamClaude stays beside it until the owner cuts over
([cross-machine-pool.md](cross-machine-pool.md)).

## Sources

- The owner's own typed messages in the Claude Code transcripts on the Mac
  and the workbox, read on 2026-11-01. Pasted handoffs, agent hand-backs,
  skill text and system notices are left out. 17 messages name TeamClaude
  and 49 name quota, rate limits, pace or burn. This file holds counts and
  paraphrase only: transcripts are published as aggregates.
- TeamClaude 1.1.27 source (`oauth.js`, `claude-resets.js`,
  `account-manager.js`) and the owner's TeamClaude settings, non-secret
  keys only.
- GitHub: the owner filed no TeamClaude issue or pull request (measured).

## How the owner ran TeamClaude

- Every Claude Code session on both machines ran through `teamclaude run`
  (aliases set on 2026-10-13 and 2026-10-15). 7 Max accounts. The Mac and
  the workbox each hold their own token family, by intent.
- Settings: `expiryRouting` on (use the account whose weekly quota expires
  first), `switchThreshold` 1 (use each account to 100%),
  `quotaProbeSeconds` 120 (read every account's quota every 2 minutes,
  without spending any), `autoRedeemResets` off, `distributeSessions` off.

## What hurt

1. **Stalls at a usage limit.** 9 messages from 2026-10-18 to 10-20 say
   only "continue, the limit is up". The session waited for a person.
2. **Agents killed by a 429.** On 2026-10-16 and 10-21 an agent stopped
   mid-round when every account was at quota, and its steps were rerun by
   hand. One handoff names "all 4 accounts at quota".
3. **Two machines, one pool, by hand.** On 2026-10-21, 5 messages carried
   burn rates, 5-hour projections and stop orders between the Mac and the
   workbox for the one account that still had weekly credit.
4. **Pacing questions.** What a token costs in usage percent (10-20); burn
   the weekly quota to 100% by its reset, minding the rolling resets
   (10-21, twice); keep usage over time to read the burn (10-27); Codex
   resets come often, so 100% of a week is hard to judge (10-28).
5. **Ownership.** TeamClaude held the tokens and gent borrowed them
   (10-31, 11-01). The owner wants gent to hold its own sign-ins, one
   token family per machine.
6. **The owner's rule (11-01).** Account order does not matter. Fill each
   weekly quota before it resets, the soonest reset first. The 5-hour
   window is a cap, and some accounts are losing it.

## Gent against each

| Need                          | Gent on 2026-11-01                                                                                                                           | Left                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1. Resume at the reset        | `wake.autoResume` existed, off in the user config. Turned on, both machines, `maxResumes` 3.                                                 | Unattended turns (a delegated child) store no resume: row 57.          |
| 2. Move off a spent account   | Placement moves a refused turn to the next pool account. No Claude pool was set: `authSpread` now names the 7 owned accounts, both machines. | When the whole pool is spent: row 57.                                  |
| 6. Soonest weekly reset first | Placement's rule since 2026-10-21 (`CredentialPlacement`).                                                                                   | An account gent has not sent to has no reading and ranks last: row 53. |
| 3. Two machines, one pool     | Each server keeps its own ledger.                                                                                                            | Row 21, promoted: row 56.                                              |
| 4. Fuel, burn, rolling pace   | Built: fuel per percent, the 7-day ledger, pace toward each reset ([lanes.md](../docs/architecture/lanes.md)).                               | Codex banked resets: row 54.                                           |
| 5. Own sign-ins               | Done: `gent auth login`, the owned store, one family per machine.                                                                            | None.                                                                  |

## What TeamClaude does that gent does not

- **Zero-spend quota read.** `GET /api/oauth/usage` (beta
  `oauth-2025-04-20`) answers the 5-hour and 7-day windows for no quota.
  Row 53.
- **Banked resets.** The same read with `cedar_ember=1` lists the
  claude.ai "Resets" grants; a grant clears the 5-hour and weekly windows.
  TeamClaude can spend one when the pool is dry (`POST
  /api/organizations/<org>/reset_rate_limits`, a call that cannot be
  undone); the owner kept that off. Codex has reset credits too. Row 54.
- **Codex quota read.** `GET chatgpt.com/backend-api/wham/usage`. Row 55.
- **Idle refresh.** Row 23 parked a timed refresh because every gent login
  was shared with Claude Code. An owned sign-in is gent's alone, and row
  53's read every 10 minutes refreshes it on demand (inferred), so row 23
  needs no work of its own for owned accounts.
- Not taken: per-account switch thresholds. Gent counts every account's
  weekly window to 100% and its 5-hour window to 90% (row 17); no owner
  need for more was seen.
