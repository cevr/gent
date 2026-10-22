# Context mileage: where agent tokens go, and what gent should do with it

Status: findings, 2026-10-21. Builds on `plans/context-and-disclosure.md` (S2's
`context.status()` and `context.read`, bounded results).

## Measurement

`bun ~/.claude/skills/orchestrate/scripts/budget.ts --burn` (dotfiles
`e82f834`) read 7 days of Claude Code transcripts on both hosts, the MacBook
and the workbox: 1,870 transcripts, 218k API calls, 6.48 GW. W is weighted
tokens at the Anthropic price ratios: input 1, cache write 1.25 (5 m) or 2
(1 h), cache read 0.1, output 5.

The scan charges each call's cost to what its context held. An item pays its
write once, then a share of every later call's read, until a compaction drops
it: its **rent**. A reply takes its exact output tokens. A tool result or an
attachment takes its share of the measured growth, at most one token for each
two chars. Growth that no item can hold stays unattributed (3.6%). `budget/burn.test.ts`
pins the arithmetic.

## Findings (measured)

| #   | Finding                                                                     | Value                                                                                    |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| F1  | Context (read, write, re-write), not output, is the cost                    | 84% of W; output 16%                                                                     |
| F2  | Mean context per call                                                       | 195k tokens, with the auto-compact window at 350k                                        |
| F3  | The base prompt (system, tools, first prompt) held through every call       | 31% of W                                                                                 |
| F4  | Start context: a full-toolset subagent against a lean one (9 tools, no MCP) | 89k against 32k tokens                                                                   |
| F5  | Bash results held in context                                                | 23% of W; Read 4%                                                                        |
| F6  | Tool results over 8k chars                                                  | 12% of W                                                                                 |
| F7  | Replies held in context                                                     | 17% of W; thinking is 54% of output tokens, and it stays (`clear_thinking`, `keep: all`) |
| F8  | Cache misses (re-written context)                                           | 6.6% of W; 88% of the tokens in 5-minute-TTL calls; median gap 9 to 10 minutes           |
| F9  | Subagents against roots                                                     | 91% against 9% of W                                                                      |

A replay of each segment's growth under a smaller window (inferred, a model
that leaves out the quality lost to more compactions): a 250k window cuts
context W by 10%, 200k by 14%, 160k by 13%, and 120k adds 5%.

## What gent takes

Each item is a requirement with its acceptance measure. Mileage is W per
finished unit. The baseline is the table above.

1. **Rent meter.** The projection keeps each item's tokens and the calls it
   has survived. `context.status()` returns the top renters (id, kind, tokens,
   W so far) next to `percent`, and the TUI's context line shows the largest.
   Accept: on a replayed transcript, gent's per-item attribution matches
   `burn.ts` within 5%.
   Merged at 350c4edb4 with its live-check fixes c0a8fd6b1 and c210f13fc and
   its review fix 7171290b0 (2026-10-22). On 4 real transcripts 292 of 297
   tool items match `burn.ts` within 5%; the 5 misses are results over
   `maximumModelToolResultChars`, which gent charges at the bounded size the
   model sees. Known limits: a forked branch starts its meter fresh; kept
   turns after a handoff are lumped into the marker; uncached input counts at
   weight 1; compaction summary calls are not counted; an omission that cuts
   into a handoff's kept turns only rescales.
2. **Lean start.** A subagent starts with the tools its role names. Every other
   tool and every MCP server is deferred (named, schema on demand). Accept:
   the start context of a worker is under 35k tokens (F4).
   Met before this plan, by the cell (2026-10-22, measured): a thread declares
   only `cell`, and its host tools and MCP servers reach it as one catalog of
   at most 8,000 characters, with schemas on demand through `tools(id)`. Real
   first calls in the owner's data.db (2026-09-15 to 09-23): children 7.4k
   (GPT-5.6 Luna) to 12.6k (Sonnet 5) input tokens, roots 7.5k to 17.5k. In
   the gent repo with the owner's skills directory a thread's first request is
   29,382 characters. A guard in `delegated-threads.test.ts` keeps a thread
   with 200 more host tools on `cell` alone and under 24,000 characters
   (16,156 measured); with the catalog cap lifted it reads 44,806 and fails.
   The rest is the user's: skills and project files are not capped.
3. **Bounded results by default.** A tool result over 8k chars is stored
   whole. The model gets a head and tail preview plus its `context.read` id.
   Accept: results over 8k chars hold under 3% of W (F6). The re-reads that
   `context.read` adds are counted against the saving.
4. **Thinking leaves the context.** Thinking from replies older than the last
   turn is dropped at the next cache breakpoint, so the drop costs one
   re-write, not one per call. Accept: replies hold under 10% of W (F7), and
   the miss share does not rise (F8).
5. **TTL by expected idle.** A call before a known long wait (a gate, a
   `wait` on a process, a scheduled wake past 5 minutes) writes with the 1 h
   TTL. Other calls write with the 5 m TTL. The Anthropic extension
   (`packages/extensions/src/anthropic.ts`, the `ttl` marker) takes the choice
   from the turn. Accept: misses under 2% of W (F8).
6. **Compaction window per role, tuned from the burn.** (Merged at
   `e26b1525c`, 2026-10-21; see `docs/architecture/context.md`. Re-reads by
   `context.read` are not seen.)
   Each role compacts
   at its own window. The window comes from a daily replay of the week's
   transcripts at 100k to 350k, with each transcript's own compactions undone.
   A compaction costs its summary call, the cache restart, and the files read
   again after it. Re-reads are about 20k tokens per compaction (measured), and
   without them the replay picks too small a window. The user's window is the
   ceiling: the tuner only lowers it, needs 20 agents of a role, and takes the
   largest window within 1% of the cheapest. A root compacts between turns,
   never in the middle of a step. Every compaction is told to keep the paths of
   the plan, log and state files, the current step, and the user's
   instructions, so the agent reads them again rather than losing them.
   Reference: dotfiles `budget.ts --tune` and the status mod's `compact.ts`
   (c8a469f), with these results at a 200k ceiling (measured, 2026-10-21):

   | Host    | Role               | Agents | Window | Saving vs 200k | Re-read per compaction |
   | ------- | ------------------ | ------ | ------ | -------------- | ---------------------- |
   | Mac     | orchestrate-worker | 50     | 140k   | 9.0%           | 23k                    |
   | Mac     | general-purpose    | 1128   | 200k   | 0%             | 21k                    |
   | Mac     | root               | 27     | 200k   | 0%             | 18k                    |
   | workbox | orchestrate-worker |        | 140k   | 7.2%           |                        |
   | workbox | general-purpose    |        | 200k   | 0%             |                        |

   Gent runs the same replay through its projection, and the burn cycle
   (the placement and permit work) reads the tuned window per role. Accept:
   mean context per worker call under 130k (F2), the re-read share after a
   compaction does not rise, and the gate failures per unit do not rise.

7. **Short agents over long ones.** A unit that outgrows one window goes to a
   fresh agent with a handoff, not a compaction. Accept: compactions per
   worker under 1.

## Budget learnings (dotfiles budget.ts, 2026-10-21)

Relayed from the budget session. These are about quota pace, not context, but
they set what one W costs, so they live here.

| #   | Learning                                                                                                                                                                                                                                                                                     | Value                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| B1  | Rolling weekly pace (f1ed65b). The old pace spread only the quota in hand over each account's week. pace = max(floor, rolling); rolling = quota in hand plus the share of each new week that opens in the next 7 days, spread over the day hours. The weekly and 5h ceilings still cap it.   | With 6 of 7 accounts spent: 0.8%/h before, 3.6%/h after (pool can sustain about 4.2%/h); agent cap 2 to 4 (measured live) |
| B2  | 5h room (9e58e61). An account whose spent week resets within 5h counts again from its reset, with a fresh 5h window.                                                                                                                                                                         |                                                                                                                           |
| B3  | Held agents per project (95b6aa7). `projectAgents` in `~/.config/orchestrate/budget.json`: a listed project runs up to N agents whatever the pace, and no more. Other projects leave room for held slots that are not in use.                                                                | 1 each for the blade, hymn / selah, gent and performance, on both hosts                                                   |
| B4  | Cost of W. About 0.1% of one account week per 1M W over 7 days: 6,504M W used about 7 account weeks, so one account week is about 930M W. Short windows read 0.15 to 0.85%/MW, because the quota shows in whole percent. W ignores the model. Raw tokens are about 7x W, mostly cache reads. | 930M W per account week (measured over 7 days)                                                                            |

Gent before requirement 8 (`packages/core/src/runtime/provider.ts:4703`, read 2026-10-21):
an account's `sustainable` is its quota in hand over the time to its reset. A
rejected window counts 0 until `resetAt` passes, so a pool of spent accounts
that reset this week paces like the old budget.ts (B1). A reset counts only
once it has passed (B2).

8. **Pace against rolling resets. Merged at 82f8453d1 (2026-10-21).** A window's sustainable rate adds the
   share of each new week that opens inside the horizon, not only the quota
   in hand. A spent week that resets within 5h counts from its reset, with a
   fresh 5h window. The weekly and 5h ceilings still cap it. Accept: on the
   B1 readings (6 of 7 accounts spent, resets spread over the week), gent's
   free lanes match budget.ts's pace within one lane.
   Implementation uses plain hours and gent's 100% quota target, with no new
   owner setting. The seven-account fixture gives 1 lane before and 8 after
   (29.324787415 M fuel/h rolling, at 3.4 M fuel per lane-hour).
   Proof boundary: `CredentialPlacement.lanes` and admission exercise the
   pool formula and ceilings; `place` checks the existing ranking and
   hysteresis. These tests do not exercise provider HTTP header parsing.
   Per-account under-pace ranking stays unchanged; pool admission forecasts
   future refills while rejected accounts stay ineligible now.
9. **Held slots per project. Merged at a4e8542a6 with its review fix 6163ad09f (2026-10-22).** A project (a repository root) can hold N
   lanes whatever the pace, and no more. Other work leaves room for held
   lanes that are not in use. The setting reads beside the account order.
   Accept: with gent held at 1 and the pool at free 0, a gent thread is
   admitted and a second is refused with `LaneUnavailable`.
   The hold is `providers.<owner>.authHold` in the user file, by repository
   path; a project is its origin url, else its root (docs/architecture/lanes.md).
   Past its hold a project competes in the pool. Not done: `accounts.lanes`
   does not show holds, a project file's `authHold` is ignored without a
   warning, and git's url rewrites are not applied.
10. **Cost per model.** Fuel per percent is fitted for each model, not only
    for each window, so an Opus unit and a Haiku unit cost what each burns.
    Whole-percent readings over short windows are too coarse to fit alone
    (B4): the fit spans at least a day. Accept: the fitted cost of one account
    week is within 10% of B4's 930M W for the model mix B4 measured.
    Merged at 58ef2b391 with its review fix ada56ce9b (2026-10-22). The
    weights are fitted from the account windows' kept segments, each read
    at its edges' rounding; the windows are judged at the weights, and the
    two alternate until both settle. Each account window reports each
    model's fuel per point (`LaneWindow.models`). Open: admission and
    placement still count runs unweighted.
11. **Every provider that reports usage joins the pool.** (ChatGPT plan
    merged at 415a2b09c (2026-10-22): the Codex client reads the
    `x-codex-primary-*` and `x-codex-secondary-*` headers on each answer,
    and a test shows both providers' lanes, with a spent ChatGPT window
    refusing only openai. Per-model readings merged at 0ae779bd8 with its
    review fix 33cce355c (2026-10-22): a reading may name a model, its
    window holds, fits and admits that model's runs alone, and admission
    counts the account's load and the model's load apart. OpenCode Go
    merged at 1490c2119 with its review fix ee9521391 (2026-10-22): gent
    meters each account's own priced spend per model per hour against the
    plan's 5-hour, weekly and monthly dollar limits, rejects a window at its
    limit (extra usage never counts), bills a request at its long-context or
    DeepSeek peak price, and keeps each meter's sign-in across a restart.
    Open: a turn that fills its window mid-turn still finishes on extra
    usage.) The seam is already
    normal: a driver reports `QuotaReading` (`window`, `utilization` as a
    fraction, `resetAt`, `rejected`; `packages/core/src/domain/driver.ts:618`),
    and lanes fit fuel per percent for each window. Only the Anthropic
    extension reports today. Each other provider gets an adapter in its own
    extension that turns its own usage words into readings: the OpenAI
    extension for the ChatGPT plan (Codex), the OpenCode extension for
    OpenCode Go. A provider that reports by headers is read on each response;
    one that reports only by an endpoint is read on the wake clock. Whole
    percent, request counts and token counts all become a fraction of the
    window, so the pace and the lanes stay one calculation. Accept: with one
    Anthropic and one ChatGPT account, the pool's free lanes add both, and a
    spent ChatGPT window refuses only ChatGPT models.

    **OpenCode Go facts** (owner link, [Go usage limits](https://opencode.ai/v2/docs/console/go/#usage-limits),
    read 2026-10-21):
    - Limits are monthly dollar amounts **per model**, by plan (Go $10/month,
      Go Plus $40/month). Each model has three windows: 5 hours at 20% of its
      monthly amount, weekly at 50%, monthly at 100%. Examples: GLM-5.3 $15 on
      Go and $120 on Go Plus; DeepSeek V4.1 Flash $80 and $160. Some models
      are free and unlimited for a limited time.
    - Spend is priced from the page's per-model token prices (input, output,
      cached read, and cache write on some models). Go and Go Plus share the
      prices. Some models price by context size (for example GPT 6 Luna above
      272K tokens) or by time of day (DeepSeek peak and off-peak).
    - **Console API** ([API](https://opencode.ai/v2/docs/console/api/),
      [Budgets](https://opencode.ai/v2/docs/console/api/budgets/), read
      2026-10-21). The one usage endpoint is
      `GET https://opencode.ai/console/api/v1/budgets/members`. It takes a
      service-account key as a bearer token, with Budgets › Read. Each member
      row has `spent_micro_cents` for the current UTC calendar month,
      `limit_micro_cents` (null means unlimited), `exceeded` and `resets_at`.
      100,000,000 microcents are one dollar. It has no per-model rows and no
      5-hour or weekly window. A key permission named Usage › Read exists, but
      no usage endpoint is documented. `/console/api/v1/usage` answers 404
      without auth, while the budgets path answers 401 (measured, curl). The
      docs do not say whether `spent` counts Go plan usage, extra usage or
      both. **Probe before design:** one read with the owner's key, compared
      with the console's usage page. If `spent` counts only extra usage, a
      rise while gent sends Go requests means a Go window is spent, from any
      client, and the adapter marks it `rejected` at once. That closes the
      gap left by the outside spend. If `spent` counts both, it bounds the
      monthly window only.
    - **No usage is reported per request.** The page names no response header and no
      usage endpoint, only the console page. So the OpenCode adapter cannot
      read a reading. It derives one from gent's own priced spend per
      (account, model) over each window, divided by that window's dollar
      limit. It sees no spend outside gent, so its utilization is a lower
      bound.
    - The page does not say whether the windows roll or reset at a fixed
      time. The adapter sums spend over the trailing 5 hours, 7 days and 31
      days. That sum is never below the spend since a fixed reset inside the
      same length, so it is safe for both kinds.
    - At the limit, Go blocks requests, or bills the pay-as-you-go balance if
      Extra usage is on. **Extra usage is on for the owner's account, and it
      is never quota** (owner, 2026-10-21). So no limit error arrives: Go
      bills quietly. The adapter itself marks a window `rejected` when gent's
      own spend reaches that window's dollar limit, and placement sends no
      request for that model on that account until the trailing sum drops
      below the limit. Extra-usage spend never counts toward a lane. Accept:
      with a model's 5-hour spend at its limit, a thread start for that
      model on that account is refused with `LaneUnavailable`, and no request
      for it leaves gent.
    - **The limit error, from opencode's source** (`anomalyco/opencode`
      `1b1ad48`, 2026-10-21). opencode has no usage plugin and reads no
      usage endpoint. It learns of a Go limit only from the refusal: HTTP
      429 from `opencode.ai/inference/go/…`, body
      `{"type":"error","error":{"type":"GoUsageLimitError","message":"Subscription quota exceeded."}}`,
      with `retry-after` in seconds (`packages/core/test/session-error.test.ts`,
      `packages/ai/test/provider-error.test.ts`). It classifies that as
      quota, not throttling, and does not retry it. Zen's free tier answers
      `FreeUsageLimitError` the same way. So the adapter also reads a
      `GoUsageLimitError` 429 as `rejected` for that (account, model), with
      `resetAt` = now + `retry-after`. With Extra usage on, this error
      should not arrive until the balance runs out (inferred), so gent's own
      sum stays the first stop; the error covers spend outside gent.
    - **Seam change:** `QuotaReading` is per account today. Go's limits are
      per model, so the reading gains an optional `model`, and a lane for
      that account counts only requests for that model.

12. **Model tier per role.** (Merged at aa6eac4f4 (2026-10-22), in three
    commits, each with its review fix: the lane probe and the `tiers`
    config (8e57018a3, 129421c9b); tier role rounds (9370052e9, 90e4a7e97);
    quality per model and state in `machine.status`, `MachinesRpc.Quality`
    and a round thread's details in the sessions pane (ba7725417,
    aa6eac4f4). Open: a send-time `LaneUnavailable` after a passing probe
    waits on the picked model; stats are keyed by machine name; a
    subscription-only tier ranks by list order; quality shows from 100
    columns only.) Intelligence is hard to measure, so gent does
    not score it. The owner names two ordered model lists beside the account
    order: `strongest` and `efficient`. Plan and review states take the first
    `strongest` model with a free lane. Implement and verify states take the
    `efficient` model with the least fuel per finished unit (from 10) that
    has a free lane. When no model in the tier has a free lane, the state
    queues for one; it does not drop to the other tier. A state's own model
    setting still wins. Quality (review verdicts, verify pass rate, gate
    failures, rounds to accept) is recorded per model and state and shown in
    the `/agents` view and `machine.status`, as a signal for the owner's
    lists, not as a pick input. Accept: with the first `strongest` model
    spent, a plan state takes the second one; with every `strongest` model
    spent, it waits and no `efficient` model runs it; an implement state
    takes the cheaper of two `efficient` models by measured fuel per unit.

## Order

The cost order is 2 (31% base), 3 (12%), 4 (about 9%), 6 (about 12%), 5 (6%),
and then 1 and 7. 1 is the measure for the rest, so it lands first and stays
small. 8 to 10 are placement work: they go with stage 4 of
[kernel-orchestration.md](kernel-orchestration.md), 8 first, because it
frees the most lanes. 11 follows 8, because it adds lanes the pace can then use. 12 needs 10 for its efficient pick, so it lands last.
