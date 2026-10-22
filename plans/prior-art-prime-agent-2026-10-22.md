# Prime Agent vs gent: multi-agent orchestration, source study

Date: 2026-10-22. Owner request: study Prime Agent's orchestration, source first, against gent ("I don't think it really focuses on budget like we do and routing").

- Prime Agent (PA): `/Users/cvr/.cache/repo/primeintellect-ai/prime-agent`, HEAD `8aac869` (release v0.10.1). PA paths below are relative to `crates/`.
- gent: `/Users/cvr/Developer/personal/gent`, HEAD `650e00328`.
- Labels: **measured** = read in code or counted; **inferred** = follows from code read, not run; **guess** = plausible, not checked.

## Live run (2026-10-22)

Prime Agent 0.10.0 on `openai-codex/gpt-6.1-sol` at medium, in a scratch project with three modules, two runs of three children each. gent on the scripted model (`debug delegate`) through verify-gent at 120x40. (measured)

- Tray: always `◆ N subagents · ◷ N heartbeats · ▸ N shells`, zero counts included. gent: one row per running child with its current call (`◇ Check the greeting files · Running sleep 2; ls …  ← sessions`), nothing at idle.
- Manage view (`←`): sections by the root's status; under the root a collapsible `▾ 6 subagents (3 running) $1.17`, then one row per child with model:effort, cost and age; running glyph pulses `◇◈◆`. gent's Sessions pane (`←`) sections by each session's own status: a running child sits under `Running` while its idle starter sits under `Idle`; nested only when both share a status.
- Transcript: `✉ Agent message · ↓ cart` (received) / `↑ cart` (sent); tool rows `✓ python · <code head> · ↑ 6 ↓ 55 lines · 3ms`; `ctrl+o` cycles Collapsed / Details (reasoning) / Expanded (full tool input and output). gent's completion row is richer: `◆ Check the greeting files · completed · Read 3 files · ran 2 commands · searched 1 pattern · 3s · ↑28k ↓134 $0.03`.
- A child view shows `depth 1` and names its parent by hex id (`↓ 7208729fe295`); gent names the starter.
- Cost: run 2 sent twelve child progress messages; each woke the root for a full turn; the root's shown cost went from $1.54 to $3.41 (Prime Agent's API-price display; the run used the Codex subscription).
- Input: `herdr pane send-text` lost doubled letters (`three` → `thre`) in Prime Agent's composer only.

## Summary

1. The live cost jump (run 2: $1.54 to $3.41) has a code cause in PA. Every child `agent_message` and every settle notice is its own parent turn. `gather_delivery_batch` (pa-daemon/src/worker/queue.rs:320-360) delivers a `custom_message` item alone and stops a batch at one. A steer to a busy parent also stops the running turn at the next boundary (`queued_steering_probe`, pa-daemon/src/agent_engine/config.rs:37-41, turn/model.rs:410-440). Then the steer runs as a new turn. (measured)
2. gent has the same cost shape for thread round ends. Each round end is a `delivery: "queue"` follow-up (packages/extensions/src/threads.ts:1584-1592). Each follow-up keeps its own turn (packages/core/src/runtime/agent-loop.ts:322-334, 449-475). A busy starter does not take a round end into the running turn; it takes it after the turn, as a new turn. (measured) This is the top candidate: coalesce round ends.
3. The "lanes" claim is confirmed. PA keeps one credential per provider (`AuthStorageData`: provider id to credential, pa-core/src/auth/types.rs:128-159). PA reads no quota-window headers (grep for `ratelimit-unified`, `x-codex-primary`: no hits in pa-ai). PA does no pacing and no per-child budget. It has three things: a quota park until the reported reset (pa-daemon/src/provider_park.rs), a same-model failover to other providers (provider_failover.rs), and usage attribution of children to the parent row (rlm_usage.rs). gent's lanes (docs/architecture/lanes.md) are much stronger. (measured)
4. gent is better on durability and control. Rounds are durable rows that reconcile after a crash (threads.ts, child-turns.ts). The interrupt cascades to child rounds. Steering joins the running turn and does not cut it. Typed Schema rows replace PA's `serde_json::Value` summary. PA forgets owed completions when its parent restarts (pa-daemon/src/rlm_children/registry.rs:391-398). (measured, the PA loss is inferred)
5. PA is better on the agents view data. Each forest row draws model:effort, cost and age from the roster summary (pa-tui/src/agents_view_forest/summary.rs:14-31). gent's `AgentRowEntry` has no model, effort or cost (packages/extensions/src/agents-view.ts:629-676). gent gets them only for the selected row through `fetchDetail` (apps/tui/src/extensions/agents.client.tsx:397-440). (measured)

The pass-29 verdicts in PRIOR_ART.md (line 12, line 43) stand. The clone is shallow (100 commits), so `cf285dc` is not in it and I could not diff the history. (measured) The current source still has the same shapes: `rlm.collect` with `timeout_ms=0` is a snapshot, progress notes are 512 chars per 10 s, the rate limit is reported but not enforced (pa-core/src/session_engine/agent_message_ingest.rs:1-4, 53-54), and a child reports by message. (measured) Nothing re-opens A3 or the not-adopted items.

---

## 1. Child lifecycle, durability, orphans

### Prime Agent

- Spawn: `RlmSubagentHost::spawn` (pa-daemon/src/rlm_children/host.rs:22-200). The depth check fails at `rlm_depth >= rlm_max_depth` (host.rs:26-31). The default max depth is 2 (pa-core/src/session_engine/rlm_host.rs:265). The precedence is chat, inherited, global, env, default (rlm_host.rs:356-380). (measured)
- The child id is `sub-<8 hex>` (host.rs:32). A name you give is reserved before the first await, so two parallel spawns cannot take the same name (host.rs:36-51). (measured)
- Model: `resolve_child_model_allowlisted` (host.rs:55-61). Thinking and cwd come from the parent (host.rs:63-65). The parent env is forwarded through `collect_process_launch_env` (host.rs:91), because each child is a separate worker process (host.rs:86-90). (measured)
- The spawn kwargs allow only `name`, `model` and `thinking`. `budget` and `depth` are refused (rlm_host.rs:646, test at 1337-1343). (measured)
- The `ChildRecord` holds about 30 fields of mutable flags (host.rs:94-129). Among them are `settled_status: Option<&str>`, `notice_delivered`, `replied_since_task`, `closed_by_parent`, three `retirement_*` flags and `usage_rearm`. The settle state is a string: `matches!(record.settled_status, Some("done" | "error"))` (rlm_children/lifecycle.rs, `record_child_return`). `should_mark_error` reads three flags (lifecycle.rs). (measured)
- Durability: the spawn ledger is append-only JSONL in each sessions directory (pa-daemon/src/rlm_ledger.rs header). It is the topology authority. A restarted parent seeds its registry from the ledger with every row settled: "nothing is owed" (rlm_children/registry.rs:391-398). So a child that was running at the crash does not deliver its completion to the parent. (measured: the seed; inferred: the lost completion)
- Orphans: when the parent worker dies, its children close (pa-daemon/src/supervisor_parent_death.rs: plain kill, 3 retries, 5 s). `boot_reap.rs` reaps predecessors on the same socket. `revival_gate.rs` relaunches a dead descriptor only with busy evidence that is at most 30 min old (`REVIVAL_BUSY_EVIDENCE_MAX_AGE_MS`), and vetoes GaveUp, SessionArchived, LiveLeaseHeld and StaleBusyEvidence. `stop_cleanup.rs` cancels the scheduled jobs of a stopped tree. (measured)
- Delete: a tombstone and a `Cancelled` terminal notice. A deleted child's spend goes to the parent's `deletedDescendantUsage` (pa-daemon/src/supervisor_roster/passivation.rs). Idle children passivate (the worker exits) and wake from the ledger. (measured)
- A turn abort does not cascade to the children (gent's threads.md:34-36 records this). (measured from gent's doc; I did not find a cascade in PA's lifecycle.rs)

### gent

- `thread.start` creates a session through the `Session` facade and returns at admission (docs/architecture/threads.md:8-13). The id is a SHA-256 over session, branch and tool call, so a replayed call finds its thread (threads.md:92-94). (measured)
- Depth: `DEFAULT_MAX_AGENT_RUN_DEPTH = 3` (packages/core/src/domain/agent.ts:1152). `admitChildSessionDepth` fails closed when ancestry is missing (packages/core/src/runtime/session.ts:180-215). The running cap is 4 threads (threads.ts:1068). Only the user's `~/.gent/config.json` can change it (threads.ts:1063-1067). (measured)
- Durability: the `thread_rounds` table keeps each round (threads.md:120-141). `loopOpen` reconciles each undelivered end: a recorded end is delivered, a turn with a receipt is recorded from history (child-turns.ts), and a round with neither is sent again (threads.md:142-155). Delivery is keyed by `thread-round-end:<round>`, so a second delivery is a no-op (threads.ts:1049, 1570-1592). (measured)
- The starter's interrupt cascades to its `starter` rounds, eight at a time, and leaves a `# Stopped threads` notice (threads.md:14-38). (measured)
- Children run in the same server process as sessions. There is no process per child. (measured: threads.md:5-6)

### Verdict: gent already better

gent has durable rounds that reconcile, an interrupt cascade, and typed state. PA loses owed completions on a parent restart, uses string settle states, and has a process per child, which costs more to start and needs orphan reaping. The pass-29 reaping items are already taken (P29-prime-1, -3). Avoid: PA's flag-bag `ChildRecord` and its "nothing is owed" reseed.

---

## 2. Messaging

### Prime Agent

- `agent_message.send(message, receiver_role, receiver_name)` returns a receipt `delivered` or `queued`, and `all` broadcasts (prompt.txt line 82). `queued` means the receiver was busy at enqueue; `delivered` means it was idle (pa-daemon/src/worker/input.rs:408-416). (measured)
- Lane: follow-up only when the payload has `deliveryMode == "follow_up"`; otherwise steering (input.rs:313-417). The model's `AgentMessageSendInput` has no delivery mode (pa-core/src/session_engine/agent_messaging.rs:79-83), so every model send steers. Heartbeats can pick `steer` or `follow_up` (prompt.txt line 170). (measured)
- Capacity: 20 pending messages per session (`DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION`, agent_messaging.rs:17). The rate-limit constants (capacity 3, refill 1000 ms, agent_messaging.rs:20-22) are only reported, not enforced (agent_message_ingest.rs:1-4, 53-54). (measured)
- No coalescing: `gather_delivery_batch` (worker/queue.rs:320-360) delivers a front item with `custom_message` alone, and a `custom_message` item ends a batch. Default modes: steering `all`, follow-up `one-at-a-time` (pa-daemon/src/worker.rs:314-315). (measured)
- A steer stops the running turn: `queued_steering_probe` stops it at the next boundary, and the steer runs as the next turn (agent_engine/config.rs:37-41; agent_engine/turn/model.rs:410-440). (measured) Each child message to a busy parent therefore ends one parent turn and opens another. Each new turn re-sends the whole context. (inferred) This explains the live run: every child message woke the root for a full turn, and the cost went from $1.54 to $3.41. (inferred from the code plus the live capture)
- Result path: the child sends an explicit `agent_message` to the parent. If it sends none, the settle sends `CompletedWithoutReply` with the last assistant preview (lifecycle.rs `deliver_settle_notice`). A failure sends `rlm_child_failure` (`settle_failed`). Both go through `DaemonCommand::FollowUp` with a one-shot nonce (`deliver_terminal_notice`; anti-spoof in child_status_notices.rs). (measured)

### gent

- Round end: one `Session.send` with `delivery: "queue"`, `wake: true`, and `sourceId: thread-round-end:<round>` (threads.ts:1578-1592). The answer is in the message (header, text, how to read the rest; threads.md:128-138). (measured)
- `session.send` steers an `Interject` with `wake` (threads.md:39-67). Steering joins the running turn at the next safe step boundary, and the same turn continues (packages/core/src/runtime/turn.ts:6395-6440; `joinedTurn` mark; `noteJoined`). An interrupted turn holds steering back for the next turn. (measured)
- Follow-up queue: at most 10 (`FOLLOW_UP_QUEUE_MAX`, agent-loop.ts:320). Each follow-up "stays its own item with its own id, parts, and turn" (agent-loop.ts:322-334). `takeNextQueuedTurn` takes one steering item, else one follow-up (agent-loop.ts:449-475). (measured)
- So: N round ends that land while the starter is busy wait until its turn ends. Then they open N separate turns. (measured from the queue code; inferred for the cost, which is the same shape as PA's)
- A message from a child carries a line saying it is not the round's answer (threads.md:61-63). (measured)

### Verdict: copy the problem's fix, not PA's design; gent already better on steering

- gent already better: steering joins the running turn and does not cut it. PA's stop-and-restart costs a turn each time.
- Avoid: PA's stop-on-steer, its unenforced rate limit, and its untyped delivery-mode string.
- Copy (gent's own fix, PA has none): coalesce round ends. Today both harnesses pay one full turn per child end. See candidate 1.

---

## 3. Budget, usage, routing ("lanes")

### Prime Agent

- Auth: `auth.json` maps provider id to one credential (pa-core/src/auth/types.rs:128-159). `AuthStatus.label` is a display label, not a second account (types.rs:178-184). No multi-account per provider. (measured)
- No quota-window reads: grep for `ratelimit-unified`, `x-codex-primary` and quota `utilization` finds nothing in pa-ai. The only `utilization` hits are context-window displays in pa-tui. (measured)
- Quota park: a quota failure with a reset beyond the quick-retry cap parks the session until the reset plus 30 s grace. One park lasts at most 1 day (clamp 7 d), at most 8 parks per episode. A durable cron wake `quota-resume` restarts it with a resume marker. With no reported reset, there is no park (provider_park.rs:10-120). (measured)
- Failover: the same model id on the other configured providers in catalog order, 3 retries per provider, 8 in total (provider_failover.rs:1-48; candidates in pa-core/src/models/resolver.rs:534-560). (measured)
- Usage: `rlm_usage.rs` adds child usage to the parent's assistant row and restores context tokens (rlm_usage.rs:1-38, `attribute_child_usage`). It is attribution only; there is no per-child budget. (measured)
- Goal budget: `GoalState.token_budget` and `tokens_used` (pa-types/src/goal.rs:38-50). `record_assistant_usage` counts input plus output of the session's own assistant turns (goal_driver.rs:320-370; goals.rs:136). Over budget gives a `BudgetLimited` steer. `--goal-token-budget` needs `--goal` (pa-cli/src/args.rs:420-478). Child tokens are probably not counted (inferred: the goal fold reads own assistant rows).
- Child model: inherited, or picked from an allowlist (`allowedModels`, rlm_child_model.rs). No cost-aware pick. (measured)

### gent

- Lanes (docs/architecture/lanes.md): quota windows per sign-in from Anthropic and Codex headers, OpenCode Go spend limits, fuel per percent, model weights, capacity, `admitLane` gives `Busy` or `Spent` with `retryAt`, a project `authHold`, and a filled-account move with `coldHandoffPays`. (measured from the doc)
- A thread can pin an account (`account`, `RunSpec.credentialSlot`; threads.md:84-89). `Threads.send` fails with `LaneUnavailable` and `retryAt` (threads.md:167-172). (measured)
- Retry: the driver's `retryAt`. A usage-limit reset beyond `maxDelay` fails the step, and the turn reports `limitResetAt` (docs/architecture/runtime.md:165-180). gent does not park a plain session for a later resume. (measured from the doc; I did not find a park in the runtime)
- Goal: the same model as PA. `tokenBudget`, `tokensUsed`, status `budget_limited` (packages/extensions/src/goal.ts:31-47). It counts the session's own input plus output (goal.ts:449). Children not counted. (measured)

### Verdict: gent already better on routing; copy the park only as a lane fallback

- Confirmed: PA has almost no budget-aware routing. It has one account per provider, no quota reads and no pacing. (measured)
- gent already better: lanes.
- Possible copy: PA's durable "park until reset, then resume" for the case where every lane is `Spent`. gent fails the step today. gent already has the wake alarm (`@gent/wake`), so a park is an extension use of `retryAt`, not new core. See candidate 4. (inferred)
- Not applicable: provider failover to the same model id. gent's lanes move between accounts, which covers the same need with quota data.
- Neither has a per-child token budget. PA refuses it as a spawn kwarg (rlm_host.rs:646). Not a candidate without a consumer.

---

## 4. Context per child and cache

### Prime Agent

- A child starts with fresh context. Its kickoff row is "[task from parent]\n\n{prompt}" with id `spawn:<child>` (host.rs:143-178). (measured)
- The static system layers are byte-stable across sessions: a cached prefix of 23,166 of 65,527 chars (core, usage, opinionated). The dynamic tail has the skills inventory (41,827 chars) and the RLM recursion state (31 chars) (prompt.txt lines 3-13). (measured from the capture)
- Ordering: a spawn captures the parent's turn boundary and waits for it before the child's first prompt, "so the parent's continuation request reaches the provider first" (host.rs:182-200, `wait_turn_done`). (measured) The likely gain: the parent's request writes the shared static prefix, and the children then read it, instead of N parallel misses. (inferred)

### gent

- A thread starts with fresh context, or with the starter's current context window through `fork` (`historyBranchId`) (threads.md:75-81). The `worker` agent uses `promptCache: "session"` (threads.md:95-99). (measured)
- `thread.reply` is offered at all times and refuses a call with no open round, because a tool list that changes per round would break the cached prompt (threads.md:160-163). (measured)
- I found no wait for the starter's continuation request before a thread's first request. (inferred from threads.md; I did not trace the turn start)

### Verdict: copy the ordering, as a measured experiment

- gent's fork already reuses the parent prefix, which PA cannot do. gent already better there.
- Copy candidate: hold a new thread's first model request until the starter's continuation request has gone out. This matters most for `fork`, where the child's prefix is the parent's whole history. Measure first: compare `cacheRead` on the first request of 3 parallel forks, with and without the hold. See candidate 3. (guess on the size of the gain)

---

## 5. UI

### Prime Agent

- Footer tray (pa-tui/src/chrome.rs): counts for subagents (direct and nested running, idle, inactive), heartbeats (active, paused) and shells (chrome.rs:128-147). "The subagents, heartbeats, and shells groups always render (an empty one reads its...)" (chrome.rs:175-176). A segment is colored above zero and neutral at zero (chrome.rs:702-703). This is why the tray shows "◆ N subagents · ◷ N heartbeats · ▸ N shells" at zero. (measured)
- Forest (pa-tui/src/agents_view_forest.rs, 144 lines, and agents_view_forest/ 2,520 lines): the model column is the bare model id plus `:level` when thinking is not off (agents_view_forest/summary.rs:14-31). The title falls back through session name, first message, cwd base name and ids (summary.rs:34-56). (measured)
- Row data: `AgentRosterEntry` (pa-types/src/daemon/agent_roster.rs:210-231) has `agent_id`, `queued_child`, `status`, `status_label`, `last_heard_from_at`, `worker_id`, and `summary: Value`. The summary is untyped JSON. Readers pull `model`, `thinkingLevel`, `sessionName`, `firstMessage`, `cwd` and `runtimeKind` by string key. The status label reads about 12 boolean or string keys in order (agent_roster.rs:150-200). (measured)
- Queued strip (pa-tui/src/queued.rs): counts queued internal prompts by origin ("N agent message queued"), and shows the hint "╰─ {browse_key} to browse and edit queued messages" (queued.rs:50-94, 279). (measured)

### gent

- `AgentRowEntry` (packages/extensions/src/agents-view.ts:629-676) is a typed Schema struct: section, status, open questions, name, cwd, times, `runningSince`, live, depth, parent, side thread, thread key, `reportsToStarter`, sessions, `activity`, `runningCall`. It has no model, effort, cost or turn count. (measured)
- Those fields are on `ExtensionAgentDetail` (apps/tui/src/extensions/client-facets.ts:113-132: status, model, effort, turns, `costUsd`, duration, omitted messages, first prompt, last answer). The TUI fetches it only for the selected row (agents.client.tsx:397-440). (measured)
- Sessions pane groups each session by its own status, not nested under the root (observed live; matches `section` per row). (measured live, inferred from the schema)

### Verdict: copy the per-row data, keep gent's typed shape

- Copy: put `model`, `effort` and `costUsd` (and maybe `turns`) on each `AgentRowEntry`, so the list can draw model:effort and cost on every row and sum cost per group, as PA's "▾ 6 subagents (3 running) $1.17" row does. The cost is in the round rows already (threads.md:123-125), and session cost is in the detail read. See candidate 2.
- gent already better: typed rows. PA's `summary: Value` with string keys is the weakness to avoid.
- Avoid: a tray that shows zero counts. gent already draws no tray row at idle (verify-gent captures, 2026-10-22). (measured)
- Not compared: the queued strip. The "1 agent message queued ╰─ Option+↑" capture is Prime Agent's. gent draws queued messages through `QueuedMessage` (apps/tui/src/extensions/host.tsx); no side-by-side capture yet. (measured present; look not compared)

---

## 6. Domain model and code organization

### Prime Agent

- Strength: the exactly-once notice claim. One record flag (`notice_delivered`) collapses the races between the settle watcher, a natural settle during delete, and the delete path (lifecycle.rs `deliver_settle_notice` doc). The notice also needs a nonce minted in the same worker, so a model cannot forge a terminal notice (`deliver_terminal_notice`; child_status_notices.rs). (measured)
- Weakness: stringly typed state. `settled_status: Option<&str>` with `"done" | "error"`, a roster `summary: Value` read by string key, and a `ChildRecord` with about 30 mutable fields guarded by many `Mutex` locks (host.rs:94-129). The state machine is spread across flags, not a tagged enum. (measured)
- Size: the agents view alone is about 3,400 lines in 4 files plus 2,520 in the forest folder (measured, `wc -l`).

### gent

- Strength: one big file per concern with typed Schema unions. The rounds, their delivery and the reconcile are in threads.ts, keyed by deterministic ids, so a replay is a no-op by construction (threads.ts:1049, 1570-1592). (measured)
- Weakness: the follow-up queue is "one item, one turn" by design (agent-loop.ts:322-325). A burst of child ends costs one full turn each, and the queue module has no notion of "these are notices that can share a turn". (measured)

### Verdict

- gent already better on the domain model.
- Do not copy the forge-proof notice. No model tool or client can write a `thread-round-end` custom type today: `session.send` takes only `to` and `message` and writes `session-message` (packages/extensions/src/session-tools.ts:315-320, 715); `clientMetadata` drops a client's `customType` (packages/core/src/domain/message.ts:317-324); every other extension writer passes a fixed constant (machines.ts:2992, 3026; exec-tools.ts:708). (measured, 2026-10-22)

---

## Ranked candidates

1. Done: `1f09269d1` (a round's end steers the starter; a fresh turn reads every waiting steer in its first request) and `87c103b03` (test fix). **Coalesce round ends into one starter turn.** When the starter is running, deliver each round end as steering, so it joins the running turn at the next step boundary (the `joinedTurn` path in turn.ts:6395-6440). When the starter is idle, let one turn take every queued round end that waits. Keep the per-round `sourceId` and the `markDelivered` key, so the exactly-once rule holds. Files: packages/extensions/src/threads.ts (`deliverRoundEnd`, delivery mode), packages/core/src/runtime/agent-loop.ts (`takeNextQueuedTurn`, a batch rule for wake notices), packages/core/src/runtime/turn.ts (joined ids into `turnAfter`), docs/architecture/threads.md, docs/architecture/runtime.md. North star: cheap per task. Evidence: measured queue code; cost gain inferred from PA's live run (each wake about one full-context turn). Check first: the interrupt cascade relies on a round end not waking an interrupted starter (threads.md:14-23); a joined round end must not change that.
2. **DONE (2026-10-22): model, effort and cost on every agents-view row.** Rows carry `turns`, `costUsd`, `durationMs`, `model`, `effort` from one metric-events read (`Session.branchMetrics`); headings and the tray sum cost; the detail read shrank. Whole-workspace read on the owner's store: 18–19 ms SQL + 31–59 ms decode and fold (measured). See threads.md rows. Original note: Add `model`, `effort`, `costUsd` (and `turns`) to `AgentRowEntry`. Sum cost per group in the tray and manage view. Files: packages/extensions/src/agents-view.ts, apps/tui/src/extensions/agents.client.tsx, apps/tui/src/extensions/client-facets.ts (detail may shrink), docs/architecture/threads.md (rows section). North star: one interaction model (one read, not list plus per-row fetch). Evidence: measured schema gap. Cost: the listing reads more per row; measure the tray's read time before and after.
3. **Hold a thread's first request until the starter's continuation request goes out.** Mainly for `fork`. Files: packages/extensions/src/threads.ts (start path), maybe packages/core/src/runtime/turn.ts (a "request sent" signal on the starter branch). North star: cheap per task (cache rate). Evidence: PA does it (host.rs:182-200, measured); the gain is a guess until measured with 3 parallel forks.
4. **Park until reset when every lane is Spent.** Use the step's `retryAt` and the wake alarm to resume the turn after the reset, with caps like PA's (1 day per park, 8 parks). Files: packages/extensions/src/wake.ts or a small part of packages/extensions/src/threads.ts, packages/core/src/runtime/turn.ts (`TurnAfterInput.retryAt` already exists), docs/architecture/lanes.md. North star: lean core with extensions. Evidence: PA provider_park.rs measured; gent's gap measured from runtime.md:165-180. Check first: whether the machines extension already does this for its rounds.
5. ~~Drop zero-count tray segments.~~ Already so: gent draws no tray row while nothing runs (verify-gent captures `01-started` before the child and `04-after-child`, scripted model, 2026-10-22). (measured)
6. **Count children in a goal's tokens.** Fold the thread rounds' usage under a goal session into `tokensUsed`. Neither harness does it. Files: packages/extensions/src/goal.ts, threads.ts (round usage feed `subscribeRoundEnds`). North star: cheap per task (a budget that a delegate cannot bypass). Evidence: goal.ts:449 measured. Low priority: no consumer asks for it yet.

Avoid list: steer that stops the running turn; an unenforced rate limit; a process per child; string settle states and an untyped roster summary; a restart reseed that forgets owed completions; a tray that renders zero counts.
