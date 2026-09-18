# Architecture loop, third run: one file per concern (2026-09-18 →)

Goal, verbatim from the session: reduce files as much as possible; one big
file per concern (`session.ts`, `agent-loop.ts`), not `agent-x.ts` fragments;
keep the loop simple and scannable; effect-native, actor model, lean core,
fully extensible; compare against opencode-v2, pi, codex, prime-agent, exo and
deepseek-harness. The second run (`architecture-loop-2026-09-17.md`) closed
with no structural candidate left; this run changes the file layout, not the
structure, then asks what else core can shed.

Work happens on the rift `one-file-per-concern`; the folds ran in parallel on
`fold-extensions`, `fold-tui`, `fold-small` and were merged here.

## Method

The fold tool (session scratchpad `fold.ts`, not committed) appends sources
to a target in topological order under `// ── <concern> ───` banners, merges
imports, drops sibling imports and self re-exports, rewrites deterministic
keys (`@gent/<pkg>/src/<path>/<Name>` must follow the file path), rewrites
importers across `packages/ apps/ examples/ testbeds/`, repoints backticked
paths in the steering files, and trashes the sources. The dead-export guard
then forces `export` off names only folded siblings used. Each fold was one
commit through the hook gate, then a live gamut run (`bun run gamut up
<preset>`, `wait`, `status`) that had to reproduce the baseline: one parent,
one child, `12 pass, 3 fail`.

Two tool lessons: TypeScript 7.0.2 hangs (no error) on `export { A }` naming
a local declaration, so the tool drops self re-exports; and a rift `gent`
binary shares `~/.gent/server.lock` with every other run unless the lock
lives beside the database (fixed `269ea881`).

## Source folds

| Package    | Files before → after | Commits                                         |
| ---------- | -------------------- | ----------------------------------------------- |
| core       | 146 → 34             | `bcc6f4db` … `745bd0c6`, `197ce431`, `853a067c` |
| extensions | 97 → 26              | on `fold-extensions`, merged `269ea881`         |
| tui        | 144 → 30             | `fc924c69` … `ba4011a8`                         |
| sdk        | 12 → 6               | `04ff6fa1`, `9082aecf`                          |
| tooling    | 21 → 4               | `c1489627`                                      |
| e2e        | 4 → 3                | `bb7544fe`                                      |
| server     | 1 → 1                |                                                 |

Total 425 → 104 source files (`git ls-tree` on `main` and this branch). Loop after the fold: `runtime/agent-loop.ts` 2,440,
`runtime/turn.ts` 3,105, `runtime/tools.ts` 1,349, `runtime/child-agents.ts`
832, `domain/agent-loop.ts` 541 (8,267 lines, from 8,392).

Gate after the merge: 2,486 tests green (core 923, tui 695, extensions 551,
tooling 259, sdk 58); `bun run test:e2e` 18/18. The independent review of
the core fold found no P1/P2; the value-import graph is acyclic (the base
had two cycles).

## Fixes found by the folds

| #   | Finding                                                                                                  | Status                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| F1  | Two gamut runs shared one state file and one server lock; the second killed the first                    | done `a7cd691b`, `269ea881`; regression test proven red                                      |
| F2  | Worker-entry lint suppressions covered the whole file                                                    | done `d7a8263c`: scoped to the process entry                                                 |
| F3  | A detached suppression block survived in the language-model test layers                                  | done `58663025`                                                                              |
| F4  | The child-session depth guard exempted all of `runtime/session.ts` and any file that named the admission | done `ad8ffcf6`: per-declaration check; probe reports `server.ts:591`, `child-agents.ts:399` |
| F5  | ARCHITECTURE.md listed `toolCall`/`toolResult` hooks that do not exist                                   | done, this ledger's commit                                                                   |

## Rejected

| Candidate                                                       | Why                                                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Re-export `InteractionToolsExtension` from the extensions entry | No consumer; the dead-export guard would fail                                         |
| Restore five pre-fold TUI service keys for external extensions  | `deterministicKeys` follows the path; `~/.gent/extensions` is empty; personal library |

## Lean core (survey, session scratchpad `lean-core-survey.md`)

Wakes, alarms and monitors are already extension-only: core holds one
boolean `wake?: boolean` (opencode `resume`, pi `triggerTurn`), the kernel
injection seam. Nothing to shed there. Ranked candidates, each its own
commit with counsel and a gamut run:

1. models.dev fetch + disk cache (`runtime/provider.ts`, ~200 lines) → a
   catalog extension through `ModelDriverContribution.listModels`.
2. Five facade verbs on `ExtensionSessionService`: `create`, `send` with a
   session id, `steer`, `events`, `receipt`; RPC-acceptance test per verb.
3. Child runner + completion delivery (`runtime/child-agents.ts` and the
   child parts of agent/storage/event/facet, ~1,435 lines) → `@gent/delegate`.
   Persisted formats stay: operation `agent.start`, message ids
   `agent-start:<req>` and `child:<req>:complete`, the `AgentRun*` events.
4. Model-attempt budget → a generic `RunSpec` override, with 3.
5. `present` → interaction-tools (~20 lines), optional.

Keep in core: governance, dedup, pubsub, interaction cold park, the auth
store, the compaction seam, the extension host.

| #   | Move                                                                             | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | models.dev fetch + cache → driver-owned catalogs                                 | done `62149d11`, guard `1e661e7b` (core must not name a catalog host; proven red on the old `provider.ts`), review fixup `7d364f26` (empty load not memoized, memo test concurrent, both proven red). `provider.ts` 1,033 → 853; `packages/extensions/src/models-dev.ts` 249. `/model` now lists 104 resolvable models, not 7,843 models.dev entries. Gamut `opus-sonnet` baseline + `/model` pane checked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| L2  | Five addressed facade verbs + child runner → `@gent/delegate` (survey items 2–4) | done `087b12ba`, review fixup `529d22a5`. Owner reopened the rejection (dogfood the extension system). The addressed verbs became uniform facade methods, not a per-extension grant, so `AGENTS.md` holds: every extension gets `Session.{create,send,steer,delete,events}`. No `startup` hook needed — the delegate reconciles its registry lazily on the parent's next turn and on every `agent-children` read, not at process start. Completion is the delegate's own `turnAfter` hook. Core shed `runtime/child-agents.ts` (842 lines), `AgentRunnerService`, `ChildCompletionDelivery`, the `agent.start` storage, and the `AgentRun*` events; the `Agent` facet collapsed to `listAgents`. TUI child view reads `DelegateRpc.Children` + repaints on `ExtensionStateChanged`. Net −2,325 lines. Delegate imports only `@gent/core/extensions/api` (counsel-confirmed, no core-internal privilege). Seam guard now credits a facet only through a member-access `ctx.X.` read, so the context-copy plumbing cannot mask a dead facet (the fixup). Gamut `opus-sonnet`: 6 children spawned, red app 23/0 green, TUI rendered `6 children` inline. Follow-up 2026-09-18: children run as a `delegate` agent the extension registers, paired in `.gent/config.json` `agents.delegate` (`24cfda50`); the tool became pi's handle `delegate.start/wait/send/cancel/list` with one completion writer (a live wait claims the row under a per-process nonce; the hook delivers unclaimed receipts) and an interrupted wait cascades to the child (`19961192`); the `Agent` facet and `requireCurrentAgent` are gone, and the seam guard lost its public-helper credit (`8b3c1087`). Owner then rejected the blocking verb ("i prefer the background ones that wake rather than blocking"; prime-agent's `rlm()` returns at admission and never waits): `delegate.wait` removed from the model surface, four verbs remain, the private start+wait stays inside `runChild` for `/btw`/`read_session`, and a parent's interrupted turn now stops its unheard children through the same `turnAfter` hook (rows settled first, so no wake follows). Gamut `opus-sonnet` at `c0437865`: six children as sonnet under an opus orchestrator with no per-call override, red app 19/0 green. |
| L3  | `present` → interaction-tools (~20 lines)                                        | not done: below the noise floor of a commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Test folds

Mirror the source layout, one test file per concern. Four agents ran in
parallel rifts from the rule sheet (session scratchpad `test-fold-rules.md`);
each map is committed as `plans/test-fold-<package>.md`. Every fold kept its
test count; a junit name diff on the TUI fold caught a 17-test loss before
commit (fold tool gap: a target that is not also a source loses its body).

| Package    | Test files before → after | Tests | Merge              |
| ---------- | ------------------------- | ----- | ------------------ |
| core       | 128 → 32 (+4 helpers)     | 923   | `04b651b1`         |
| extensions | 83 → 23 (+5 helpers)      | 551   | `04242aa9`         |
| tui        | 88 → 26 (+5 helpers)      | 695   | `507c29d7`         |
| tooling    | 17 → 2                    | 261   | with sdk           |
| sdk        | 8 → 4                     | 58    | `fold-tests-small` |

Found on the way: two `tsconfig.locks.json` includes named tests deleted
long ago; a guard now fails on a lock include that names no tracked file
(`d8183ba8`). Gamut after the merge (`opus-sonnet`): one parent on opus,
one child on sonnet, `12 pass, 3 fail`.

Fold tool gaps the agents hit (all repaired by hand, all worth a fix before
the tool runs again): an `import` inside a template literal is hoisted; a
declaration that shadows an import is not a reported collision; `"x"` and
`"x.js"` are two specifiers; runtime path strings (`new URL(...)`,
`import.meta.dir`) are not repointed; `packages/tooling/tests/` mentions are
not repointed; a `@effect-diagnostics-next-line` comment is separated from
its import.

## Closed 2026-09-18

Every package is folded to one file per concern (104 source, 85 test files),
the loop is five files, models.dev left core, and the last lean-core candidate
(L2, the child runner) landed as the `@gent/delegate` extension on the reopen —
the addressed verbs became uniform facade methods, so the extension-authority
rule held rather than blocking the move. Merged to main at `211f4563` + this
ledger commit. Nothing structural is left in the sweeps.
