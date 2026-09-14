# Prior-art review — what to remove, what to add (2026-09-13)

## Status (2026-09-14)

| Item                           | Result                                                                                                                                                                                                                   | Commit     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| R1 permission rules            | removed; one-shot approval covers the bash guardrails                                                                                                                                                                    | `d7dbf8e7` |
| R2 webfetch                    | removed; cell guideline says fetch and parse in the cell                                                                                                                                                                 | `1d7124d9` |
| R3 instructions extension      | folded into `agents` turn projection                                                                                                                                                                                     | `1d7124d9` |
| R4 retry policy                | on `ModelDriverContribution.retry`; loop keeps re-run only                                                                                                                                                               | `fc134b9e` |
| R5 search-sessions             | removed; `read-session` and `rename-session` stay; cell guideline names `~/.gent/data.db`                                                                                                                                | `1d7124d9` |
| R6 agents-view server half     | **rejected**: the two-catalog constraint holds (live `Session.listActiveLoops` vs stored `session.list`); a client-only view needs a core RPC or N snapshot reads per tick, which costs more than the 435 LOC it removes | —          |
| R7 step/outcome loop           | `classifyStep` → `StepOutcome`; policy and persistence are exhaustive matches                                                                                                                                            | `41c971aa` |
| A1 tool-result spill           | 8,000-char cap with a `read` locator                                                                                                                                                                                     | `e9808c2e` |
| A2 model-change notice         | durable user-role `model-change` message on model switch only                                                                                                                                                            | `fb9ad41f` |
| A3 typed fan-in                | **rejected** (2026-09-14): `Promise.all` over foreground `delegate` is the fan-in; `background: true` plus completion-as-message covers spawn-without-await; run 34 used six in one cell without it                      | —          |
| A4 step boundary events        | `StreamEnded.outcome` carries the step tag                                                                                                                                                                               | `41c971aa` |
| A5 tool-conditional guidelines | **verified, no change**: `turn-resolve.ts` already passes the post-policy tool list to `buildTurnPromptSections`                                                                                                         | `fb9ad41f` |

Open questions answered: 1 one-shot approval covers the guardrails; 2 one
Rift, gamut as the gate; 3 spill first, compaction measured later; 4 yes,
`ARCHITECTURE.md` Rules are now numbered invariants with receipts and a
known-gaps list.

Baseline: gent main `ce0b8137`. Priors surveyed in the session scratchpad:
opencode `v2` (`052be04466`, Effect 4 rc.112), pi (`71dca87`), exo
(`f90ea0f`), deepseek-harness (`c291e79`), prime-agent (`1fc1adb`).
Priorities: effect-native, actor-model, lean core, fully extensible.

## Where gent stands

| Concept       | gent                                                | opencode v2                                               | pi                                | exo                                 | deepseek                                   | prime                                          |
| ------------- | --------------------------------------------------- | --------------------------------------------------------- | --------------------------------- | ----------------------------------- | ------------------------------------------ | ---------------------------------------------- |
| Core LOC      | 27.6k (`packages/core/src`)                         | 61.9k                                                     | ~2.3k loop + 3.5k session         | ~0.7k loop + Rust substrate         | 4.1k spine, 275 pkgs                       | 2.3k loop + 13.3k session                      |
| Loop proper   | `runtime/agent` 8.2k                                | `runner/llm.ts` 370 + `step.ts` 298                       | 110 lines                         | 70 lines                            | `agent.ts` 619                             | 963                                            |
| Concurrency   | encore actor per (ws, session, branch)              | doorbell coordinator + write-ahead claim                  | lanes = actors with durable inbox | file lock per conversation          | durable inbox projection                   | daemon + worker per tree                       |
| Queued input  | `agent_loop_queues` table                           | `session_inbox` steer/queue, delivery boundaries          | two `PendingMessageQueue`s        | none                                | `agent/inbox/spliced` events               | steer/followUp                                 |
| Storage       | SQLite, event log + projection, 14 migrations       | SQLite/Drizzle, event + projection same tx, 47 migrations | JSONL tree                        | JSON files, UUIDv7                  | JSONL, immutable generations               | JSONL tree                                     |
| Tools in core | 0                                                   | 0 (13 internal plugins)                                   | 8                                 | 5 (`shell` only fs primitive)       | 26 pkgs behind seams                       | 1 (`ipython`)                                  |
| Model tool    | `cell` (full Bun, 3.7k)                             | `execute` (hand-written JS interpreter, 8.9k)             | none                              | none                                | `run_code` (PTC transport)                 | `ipython` (Python kernel)                      |
| Permissions   | rules + approvals + `/permissions`                  | action/resource rules, allow/deny/ask, saved              | none (project trust only)         | none (sandbox rewind)               | `ask`/`never`, `allowed-once`, fail-closed | none (extension examples)                      |
| Compaction    | core `model-context` 831 + ext 1,038                | `compaction.ts` 793 + instruction epochs                  | 865                               | none; tool-result spill at 8k chars | separate plugin 2.9k + spill store         | 851 pure                                       |
| Retries       | core `retry.ts` 124                                 | `runner/retry.ts` 151                                     | per-provider                      | none                                | plugin, policy on adapter                  | one shared policy                              |
| System prompt | 1 core section + per-tool guidelines                | 15-line file + instructions                               | 168 lines, tool-conditional       | developer `Message[]` per turn      | logged as surface node 0                   | trained prefix + schemas                       |
| Subagents     | `delegate` foreground in cell, child = user message | `subagent` tool, depth 1, bg completion = inbox input     | none (on purpose)                 | none                                | named registry, depth-checked              | `rlm.spawn` admission handle, `collect` fan-in |
| Effect        | v4 rc.112 + encore                                  | v4 rc.112, custom LayerNode DAG, no cluster               | no                                | no                                  | Cordis DI                                  | no                                             |

Two things every prior agrees on that gent already does: built-ins are
extensions with no privileged path, and tool guidance lives on the tool, not
in a prompt essay. None of the priors uses actors; pi's lanes and opencode's
coordinator plus write-ahead claim are the closest shapes, and both validate
"one owner per session, durable inbox, resumable from the store".

## Remove (candidates, ordered by confidence)

R1. **Persistent permission rules.** Prior: deepseek keeps only
`ask | never` with `allowed-once` and fails closed; pi, prime, and exo ship
no gate at all. gent carries `PermissionRule`, `permission.listRules` and
`permission.deleteRule` RPCs, `permission/saved` storage, the
`/permissions` route and overlay, and rule evaluation in exec-tools.
Reduce to: one durable approval request per call, answered once, fail-closed
when no answerer. Removes two RPCs, one route, one table, and the rule
schema. Keep `interaction_requests` (it is the durable one-shot request).
Receipts: `packages/core/src/server/rpcs.ts`, `apps/tui/src/routes/permissions*`,
`packages/extensions/src/exec-tools/`.

R2. **`network-tools` webfetch.** Prior: the cell already has `fetch`
(Bun); exo, prime, and opencode keep host-side fetch only for HTML→markdown
(opencode spends 658 LOC on it). Drop `webfetch`, add one line to the cell
guidelines ("fetch and parse in the cell"). Keep `websearch` only while it
holds a provider key. Receipt: `packages/extensions/src/network-tools/` (358).

R3. **`instructions` extension as a separate package.** 94 LOC that read
AGENTS.md/CLAUDE.md into a section. Every prior does this inside prompt
assembly (pi `<project_context>`, opencode ambient discovery). Fold into the
`agents` extension's turn projection. Receipt: `packages/extensions/src/instructions/`.

R4. **Retry policy in core.** Prior: deepseek puts the policy on the
provider adapter and keeps retry orchestration as a mountable plugin; prime
has one shared policy owned outside the loop. Move `retry.ts` policy fields
onto `ModelDriverContribution` (the driver knows its own 429/overload
shapes); the loop keeps only "re-run the step". Receipt:
`packages/core/src/runtime/retry.ts` (124), `runtime/agent/agent-loop.turn-execution.ts`.

R5. **`session-tools` (search-sessions, read-session).** 337 LOC of tools
the cell can do against `~/.gent/data.db` with `bun:sqlite`. Deepseek keeps
five read-only `session_*` tools, pi and prime none. Candidate for the
"subsumed by Bun" list; needs a guideline line and a schema pointer.

R6. **`agents-view` server half.** 435 LOC. Prime keeps the agents view
client-side over the ledger; gent's TUI could read `session.list` +
`session.getSnapshot` directly (both exist). Verify the two-catalog
constraint in `project_agent_view.md` before touching.

R7. **Turn-execution size.** Not a feature removal: `agent-loop.turn-execution.ts`
(1,178) + `agent-runner.ts` (562) + `agent-loop.handlers.ts` (902) is
2.6k for what opencode does in 670 with a `step.attempt → Outcome`
contract (`Completed | Retry | Continue | RecoverFull | Compacted`). Adopt
the step/outcome shape; policy (overflow recovery, continuation prompts,
length-finish) becomes matches on the outcome instead of branches inside
the stream fold.

## Add (candidates, ordered by value per LOC)

A1. **Tool-result spill.** exo writes any tool result over 8,000 chars to
an artifact and inlines a 4,000-char preview; deepseek has a spill store with
an opaque locator. gent has `context.read(id)` in the cell already, so the
add is a size cap on inlined results plus the locator. Reduces context
pressure before compaction ever runs. ~80 LOC in `tool-runner.ts`.

A2. **Model-change notice.** deepseek injects a durable user-role line
`[model changed: turns above were generated by X; the session continues with
Y]` on provider/model change and nothing on effort-only change. gent's
`SessionSettingsUpdated` event is the hook; one hidden-from-UI message.
Keeps attribution honest in the transcript and the cache prefix stable.

A3. **Typed fan-in for children.** prime `rlm.collect(targets, timeout)`
returns result envelopes without growing the parent queue. gent's delegate is
foreground in one cell, which is simpler, but a `collect` over admitted
children lets the orchestrator spawn without awaiting. Only if run 33+ shows
Opus wanting it; today's runs are green without it.

A4. **Step boundary events.** deepseek and opencode log `step/*`; gent logs
`StreamStarted/Ended` and `TurnCompleted`. If R7 lands, the outcome enum
gives the step boundary for free; log it so the TUI's "Worked for 7m32s"
can show per-step cost.

A5. **Tool-conditional guidelines.** pi assembles `Guidelines:` only from
active tools. gent already dedupes per-tool `promptGuidelines`; the missing
half is dropping a guideline when its tool is denied for the turn. Check
`buildTurnPromptSections` uses the post-policy tool list.

## Keep, validated by priors

- Cell in full Bun: opencode paid 8.9k LOC for a sandboxed interpreter;
  prime runs an unsandboxed Python kernel and says so. Decision stands
  (`project_cell_full_bun.md`).
- Child completion as a user message: opencode delivers background
  completion as inbox input, never a tool result. Same shape.
- Event log + projection in one transaction: opencode `Bus.publish` and
  gent `transactWithEvent` are the same commit discipline.
- Session settings on the row, resolved server-side: opencode
  `session_v2.model {id, providerID, variant}`; deepseek `current/assembled`
  split so a switch lands on the next step. gent landed this at `73bd6d94`.
- Zero tools in core, one-tool model surface, tool guidance on the tool.
- Actors: alone among priors, but pi's spec (§0.3 "total state, never a
  journal"; §0.5 per-tool `replay: never|safe`) is the durability contract
  gent's `tool_call_bindings` replay already implements.

## Open questions for the session

1. R1 is the largest single reduction. Does the one-shot approval cover the
   exec-tools guardrails, or do those become a cell guideline?
2. R7 is a rewrite of the hottest file. Do it as one Rift with the gamut as
   the gate, or leave the loop alone this pass?
3. A1 vs compaction: if spill lands, does the compaction extension shrink?
4. pi's `docs/harness.md` is a normative spec with numbered invariants and
   a known-gaps list. Is `ARCHITECTURE.md` the place to adopt that form?
