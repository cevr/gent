# Efficiency sweep

gent is an agent harness, so every pass also sweeps what the harness sends to the model. The **objective** is lower price-weighted token cost per completed task. The **constraint** is no measurable drop in task quality. Adapted from Cursor's harness notes (2026-09); their figures below show magnitude, not targets. One round of prompt trimming, tool offloading, cache layout, sparse line numbers and subagent tuning cut their total cost about 7%.

## Measure per task, by billing type

- A **task** is a turn tree: the parent turn plus every delegate child it started. Cost is per task, never per request, because every step resends the prefix; a change that shrinks a request but adds steps can cost more.
- Weight tokens by **billing type**: output, uncached input, cache write, cache read. Prices come from the model catalog the providers read; cite the source file.
- gent already stores per-step usage with `cacheReadTokens` and `cacheWriteTokens` (`packages/core/src/domain/event.ts`, `domain/message.ts`). A gap in that record (a provider that leaves a field empty, a child whose usage never reaches the parent's total) is the first finding, before any saving.
- **Real usage decides.** The baseline comes from the owner's stored sessions: copy the real database into the scratchpad with `/bin/cp` and read the copy. The live database stays untouched. The `--debug` model reports fake usage, so it proves wiring only, never cost. A paid run is a trust gate: propose it, with its expected cost, in the report.
- Render a few real requests (the provider's request body, after gent's cache marking) and count tokens per section. Read the rendered bytes, not the templates: duplication, volatile values in the prefix and misordered blocks show up only there.
- The capture preload renders them: [`fetch-capture.ts`](fetch-capture.ts), in this skill directory; the tooling typecheck and oxlint read it. Pick a scratch directory `<probe>` and run `bun --config=apps/tui/bunfig.toml --preload .claude/skills/architecture-loop/fetch-capture.ts apps/tui/src/main.tsx -H "<prompt>"` with `CAP_DIR=<probe>/cap`, `HOME=<probe>/home`, `GENT_AUTH_DIRECTORY=<probe>/auth`, `GENT_DATA_DIR=<probe>/data`, fake `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, and no `--debug` (`safety.md` allows this run). The scratch `HOME` and auth directory keep the owner's login (Claude Code credentials, stored OAuth) out of the rendered request; the preload refuses to start when any of the three is outside `<probe>`. The preload saves each provider request body to `CAP_DIR`, answers Anthropic with the scripted SSE steps in `$CAP_DIR/script.json` and OpenAI with a 400, forwards the `models.dev` catalog read, and answers every other host 503.

Baseline table for the ledger: cost share by source × billing type (system prompt, tool schemas, skill and extension descriptions, user messages, file reads, search results, shell output, history, compaction summaries, children), static tokens per request, cache hit rate, steps per task, and per tool the share of tasks that call it and its error rate.

Rank each candidate by share of spend × fraction removable ÷ quality risk.

## Layers

1. **System prompt and injected context.** Label every line: keep (facts the model cannot infer: the product, the environment, quirks seen in transcripts), rewrite (commands and emphasis into plain definitions; a reminder into a constraint; a vague quantity into a range), delete (default behavior of a capable model, guards against habits not seen in this model, repeats of a tool description), move (anything per-session or per-request goes after the cache boundary). Cursor cut two thirds of its prompt this way and the result held across model families.
2. **Tool schemas.** Schemas ride on every request. Keep the high-frequency set static (read, search, edit, shell) plus tools the model calls even when absent. Offload the rest behind a name and a one-line pointer, discoverable on demand; related tools load together. Cursor cut tool-description tokens 60%. The split is a flagged change, chosen by measurement.
3. **Cache layout.** Order: tool schemas → system instructions → breakpoint → setup (skills, agents, rules, environment) → breakpoint → conversation. The prefix stays byte-identical across steps: deterministic tool order and serialization, timestamps and ids after the boundary, earlier messages rewritten only by compaction. Anthropic marking lives in `packages/extensions/src/anthropic.ts`; check it against the provider's four-breakpoint and minimum-length rules. A model switch mid-session discards the cache.
4. **Tool results.** Large output goes to storage with its size and a head and tail; the model pages the rest (`exec-tools.ts` already does this for shell; check every other tool that can return a lot). Look for overhead repeated per line or item: a line number on every read line (Cursor numbered every 10th line and cut cache-read tokens 1.6% with no citation loss; see `fs-tools.ts`), repeated absolute paths, verbose JSON keys, ANSI codes, progress bars. Classify tool errors (bad arguments, environment, provider, timeout, user abort); an unknown error is a harness bug.
5. **Long runs.** Compaction (`compaction.ts`): a short summarization prompt, a compact summary that carries plan state and remaining work, and full history the model can search (`context.history`). Children (`delegate.ts`): short handoffs (done, findings, concerns, deviations); a child runs a different model only when the user or config says so. Reasoning continuity: when a provider returns reasoning items, encrypted ones included, they go back on later steps (Cursor measured a 30% benchmark loss when they were dropped); check `openai.ts` and `anthropic.ts`.
6. **Per-model fit.** Each model gets the edit format it was trained on, tool names that match their shell equivalents, and wording without caps or emphasis for literal models. Every instruction added for a model cites the transcript behavior it fixes.

## Change directly, flag, or propose

- **Change directly**, one revertible commit each: usage and cache telemetry, deterministic serialization and tool order, volatile content moved out of the cached prefix, explicit cache breakpoints, large output spilled to storage, reasoning items passed back, fixes for recurring tool errors.
- **Change behind a config flag**: system prompt edits, tool offloading, output format changes, compaction changes, child prompting. The report names the measurement that decides the flag.
- **Propose to the owner**: which models run, routing, reasoning-effort defaults, how work splits across agents. The owner decides these; a sweep does not.

## Traps

- A prompt that asks the model to save tokens or do less. Cursor's model became reluctant to take on ambitious work and quit, citing waste. Change what the harness sends, not how hard the model tries.
- Truncated tool output: spill it instead.
- Dropped reasoning items.
- Volatile content in the cached prefix, or a tool order that changes between steps.
- Offloading a tool the model needs on the first step.
- A terser output format than the model was trained on: fewer output tokens can mean less thinking.
- Raw token counts instead of cost, per request instead of per task, evals instead of real usage.

## Report

The sweep's report adds, beyond the usual candidate table: the baseline table, each candidate's estimated saving with how it was estimated (tokens measured on rendered requests × share of tasks), its quality risk, its validation (a before/after on stored sessions, or the paid run it needs), and its rollback. A candidate with no measurement is a question, not a finding.
