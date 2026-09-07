# Handoff: Bun RLM and harness reduction

Date: 2026-09-07. Mined from the Codex thread `01a06de4-1450-7a61-b63c-9c9df2baccee`
(`~/.codex/sessions/2026/09/04/rollout-2026-09-04T15-27-39-*.jsonl`, 2026-09-04 to
2026-09-07) and its helper threads. The thread goal is `usage_limited` in
`~/.codex/goals_1.sqlite` as of 2026-09-07 11:43 UTC. Claude continues the goal.

## Where the work lives

- Rift: `/Users/cvr/Developer/personal/.rifts/gent/fx-ui`. Branch `main` at
  `a826c364`. 165 uncommitted paths. Nothing from this goal is committed.
- Main checkout `/Users/cvr/Developer/personal/gent` is clean at the same HEAD.
- A second Rift `architecture-depth` holds 14 uncommitted paths from the earlier
  `$improve-codebase-architecture` loop. It is not part of this goal.
- Loom (`~/Developer/personal/loom`) is clean at `1bea365`. No Loom edits exist.

## Timeline

1. 2026-09-04. Codex resumed an earlier Gent session. It set the Codex rule
   "subagents use gpt-5.6-luna at max reasoning; Astra reviews and orchestrates"
   locally and on the workbox. It migrated Gent to TypeScript 7 and added live
   composition. That work is merged to `main` (`9b0a5196`, `e64003ba`, `a826c364`).
2. 2026-09-06. Research pass on malleability and harness prior art. Result:
   `docs/research/2026-09-06-malleability-and-harness-prior-art.md` (committed).
   Goal 1: "Make Gent a minimal, safe, live-composable agent harness with FX as
   its UI/UX standard." Six completion items covered stable resource IDs, live
   reconciliation, durable branch actors, failure tests, FX terminal, and
   Pi/OpenCode lessons. Merged to main on request ("commit and merge to main").
3. 2026-09-06. Goal 2: "UI/UX run to match FX." The user asked for Herdr panes
   instead of pilotty for terminal checks and rejected appearance-only tests.
   Receipts: `docs/fx-ui-acceptance.md` (1,855 lines, uncommitted). All
   `apps/tui` edits in the Rift come from this goal.
4. 2026-09-07 03:08. The user asked what to add and what to cull from the prior
   art. Constraints: aggressively cull code that does not earn its weight; use
   FX beyond its UI; Bun, not IPython, as the RLM kernel; reuse the Loom cell
   design already built as a Pi plugin; Gent's executor is code mode like
   OpenCode's. Research: `docs/research/2026-09-06-bun-rlm-and-loom.md` and
   `docs/research/2026-09-06-gent-trim-candidates.md` (both uncommitted).
5. 2026-09-07. Goal 3 (active): achieve `plans/bun-rlm-and-harness-reduction.md`.
   Receipts in `plans/bun-rlm-progress.md` (newest section first) and
   `plans/bun-rlm-baseline.md`.

## Prior art and what was taken

| Source             | Take                                                                 | Reject                                           |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------ |
| vercel-labs/fx     | UI/UX standard; small kernel interface; bounded output; cancellation | Second agent loop or transport                   |
| earendil-works/pi  | Steering vs follow-up; staged registration; project trust            | Second durable lane engine                       |
| anomalyco/opencode | Typed provider events; replay identity; interrupted tool states      | Volatile approvals; whole-instance reload        |
| deepseek-harness   | Dependency generations; ordered cleanup                              | Cordis beside Effect; cleanup as rollback        |
| exoharness/exo     | Durable desired/applied revisions; repair outside execution          | Self-rebuild daemon                              |
| prime-agent RLM    | Persistent programming surface; host-owned recursive children        | Python kernel; second provider stack             |
| Loom (owned)       | Bun cell evaluation; structured results; bounded process recovery    | Loom daemon; duplicated Job/Workflow/Goal stores |

## Standing user rules for this work

- Preserve code mode. The RLM kernel extends it. No second agent engine, daemon,
  scheduler, or persistence owner.
- Owned libraries (effect-machine, effect-encore, Loom): fix upstream with a
  Changeset and the release flow. Never ship local links.
- Subagents: gpt-5.6-luna at max reasoning for implementation; Astra reviews.
- Cull aggressively, but do not delete ACP, todos, memory, Mermaid, or auto
  goals without the same behavior through a smaller shared path.
- Do not count moved code as savings. Report runtime and test lines separately.
- Herdr panes for terminal checks. No appearance-only tests.

## What is done (evidence in `plans/bun-rlm-progress.md`)

Stage 1. Inactive `SubprocessRunner` removed (244 runtime lines). Baseline
recorded: 86,965 runtime lines at 445 files.

Stage 2. Bun kernel proven in `packages/core/src/runtime/code-cell/`: evaluator
boundary, bounded process protocol, worker loop, generated sandbox, readiness
deadline, replacement and close, shared evaluator with the Loom consumer.

Stage 3. Host bridge: durable outer cell admission, bound tool adapter with
approval signal, durable inner-operation storage, atomic approval storage,
exact inner-operation resume, recovery from the outer cell with a paired
`stateLost` result, branch-owned lazy cells, saved cell routing through the
branch actor, compiled worker artifact owned by core, declared `cell` tool,
recursive children through `AgentRunnerService` with durable admission, depth
and model-attempt limits, cancellation, bounded waiting, and parent-owned
inspection. Worker launch works for source and compiled hosts.

Stage 5 (partial). Project trust: `packages/core/src/runtime/extensions/project-trust.ts`
gates project module import behind `trustedProjects` in user config. Server
and TUI both route through it. Helper thread added the config field.

## Current state at handoff

Updated by Claude on 2026-09-07 (night) at Rift HEAD `dee60987`:

- Inherited work is committed in the Rift. Stage 4 cutover landed: `@gent/cell`
  is a core builtin composed at the server root, the Executor is deleted, and
  source runs use `ProcessLocal` bindings (`267eab59`).
- Stage 4 remainder and Stage 5 landed as `b58496ec`, `000c4003`, `6f89af4e`,
  `c901616d`, `5fb89a76`. The user chose to remove the fixed workflow tools
  (`85d3cb14`).
- The Prime-model and OpenCode v2 contracts from the plan's "Prior-art
  position" landed as eight commits: `4d31eddf` (namespace persists across
  worker restarts), `c30f2314` (child completion as a parent message; `wait`
  removed), `2c531638` (`assistantMessageId` on tool events; bounded model
  content), `06b2dca2` (durable follow-up admission with an explicit wake; fixes
  the warm-branch `queueFollowUp` hang), `5b0dd465` (steering at step
  boundaries), `f7e45168` (orphan projection reconciliation, continuation
  after partial output, retry jitter), `f1a46c39` (catalog as instruction
  section plus kernel-local `tools.search`/`tools.describe`; `tool-catalog`
  deleted), `dee60987` (`StreamSynchronized` marker between replay and live).
  Receipts: top section of `plans/bun-rlm-progress.md`.
- Gates: `bun run gate` exit 0 after every commit. `bun run test:e2e` exit 0
  (36 tests, 8 files) after the marker contract was stated in
  `packages/e2e/tests/event-stream.test.ts`.
- Runtime lines: 88,468 across 454 files (baseline 86,965, +1,503). Tests:
  74,518 across 292 files. The method reproduces the earlier 87,219 receipt.

## Remaining work

- Herdr workflow checks against a live model (plan Stage 5 list). Not run:
  paid, no authority. Only the repo smoke ran.
- Shared evaluator: the `@cvr/bun-cell` extraction in the Loom Rift lags
  Gent's evaluator (snapshot, catalog). Either port those two features into the
  package and release it with the pending Changeset, or drop the extraction.
  Gent keeps its own evaluator until a published version exists.
- Push, merge, or release need authority. Everything is local on the Rift.

## Open decisions for the user

1. **Runtime size (blocks completion).** The plan's completion rule requires a
   net runtime reduction, or a recorded tradeoff and a revised scope decision.
   Runtime is +1,503 lines over the baseline. The additions are the prior-art
   safety and delivery contracts, not moved code. Options: accept the tradeoff
   and close the plan; name deletion targets (candidates in
   `docs/research/2026-09-06-gent-trim-candidates.md`); or drop specific
   contracts.
2. Herdr live-model runs: authorize the paid runs, or accept the mock-provider
   gate and E2E as the evidence.
3. `@cvr/bun-cell`: release with the pending Changeset after porting snapshot
   and catalog, or abandon the extraction.
4. Source-mode durable tool identity is decided: `ProcessLocal` bindings resume
   inside the live generation only; compiled hosts keep durable identities.
