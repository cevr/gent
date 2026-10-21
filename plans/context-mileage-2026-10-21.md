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
2. **Lean start.** A subagent starts with the tools its role names. Every other
   tool and every MCP server is deferred (named, schema on demand). Accept:
   the start context of a worker is under 35k tokens (F4).
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
6. **Compaction window per role, tuned from the burn.** Each role compacts
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

## Order

The cost order is 2 (31% base), 3 (12%), 4 (about 9%), 6 (about 12%), 5 (6%),
and then 1 and 7. 1 is the measure for the rest, so it lands first and stays
small.
