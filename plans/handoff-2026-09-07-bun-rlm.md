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

Updated by Claude on 2026-09-07 (late night) at Rift HEAD `d3128b47`:

- Everything above through `9f8e3d0a` stands. After the receipts commit
  `b48572dd`, the user chose the minimal scope ("memory, auto, todo, acp"):
  `d26c5bba` (todo), `bcce24f4` (auto loop), `9791ca64` (memory), `d77f1894`
  (ACP agents and its three dependencies), `ddc138b4` (docs).
- The Herdr live-model checks ran with Claude Opus 4.6 (user authorized the
  paid runs). They found three defects, fixed as `e710ac3f` (allow lists
  dropped the cell surface), `308b5b47` (deadline counted host waits;
  suspension did not mark recovery), and `d3128b47` (confirmed handoff created
  no session). Receipts: top section of `plans/bun-rlm-progress.md`.
- Gates: `bun run gate` exit 0 at each of the last three commits.
  `bun run test:e2e` exit 0 at `d3128b47`.
- Runtime lines: 79,961 across 418 files (baseline 86,965, -7,004). Tests:
  69,689 across 267 files. The plan's LOC rule is met.
- The user authorized "Push and merge to main". The push and merge state is
  recorded in the progress log's final section.

## Remaining work

- OpenAI OAuth token in `~/.gent/auth` is expired (401 on refresh);
  OpenAI-backed agents (`explore`, `reviewer` default model) fail until it is
  refreshed. Environment, not product.
- The TUI dropped text typed within about a second of a branch switch, twice.
  Not reproduced in a test.
- Shared evaluator: the `@cvr/bun-cell` extraction in the Loom Rift lags
  Gent's evaluator (snapshot, catalog). Either port those two features into the
  package and release it with the pending Changeset, or drop the extraction.
  Gent keeps its own evaluator until a published version exists.

## Open decisions for the user

1. `@cvr/bun-cell`: release with the pending Changeset after porting snapshot
   and catalog, or abandon the extraction.
2. Source-mode durable tool identity is decided: `ProcessLocal` bindings resume
   inside the live generation only; compiled hosts keep durable identities.
