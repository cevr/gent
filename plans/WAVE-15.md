# Planify: Wave 15 - Post-Wave-14 Recursive Audit Closure

## Context

Wave 14 implemented the independent five-lane audit across simplification,
correctness, actor north star, extension system, and lint suppressions. It
closed the known P1 work around interaction identity, durable pending
singleton state, branch target validation, profile runtime ownership, actor
supervision and durable commits, extension authoring unity, runtime
composition, storage boundaries, turn phase extraction, and test control-flow
linting.

Wave 15 exists because Wave 14's final recursive audit found one remaining P2:
active source and tests still contain migration-history labels in comments
(`C9.3`, `B11.6`, `planify Commit 7`, and similar breadcrumbs). Wave 14 fixed
the concrete examples surfaced by that audit and hands the broader cleanup to
this closure wave.

## Scope

- In: only P0/P1/P2 findings from the final recursive Wave 14 audit.
- In: simplification opportunities that materially reduce LOC or cognitive
  debt while preserving the current Effect stack and feature set.
- In: correctness or actor-model findings that remain after Wave 14.
- In: extension-system findings that improve parity without widening the
  public API back into a generic imperative surface.
- In: lint/suppression findings where suppressions reveal bad architecture.
- Out: speculative feature work, aesthetic refactors, and compatibility shims
  for deleted APIs.

## Constraints

- Stay within Effect, Bun, SQLite, OpenTUI/Solid, and current package topology
  unless a finding proves the current topology is the problem.
- Keep the default authoring surface small; use advanced entrypoints only for
  real advanced extension authors.
- No `try`/`finally`, `async`/`await`, Promise chains, raw Promise-returning
  tests, or hook cleanup patterns in test files.
- No process-shaped source/module names outside `plans/` and dated audit
  receipts.
- Each implementation batch gets one review round only: one Codex subagent and
  one Okra counsel attempt. P0/P1/P2 findings from that round are fixed before
  the next batch.
- Gate after every batch: `bun run typecheck && bun run lint && bun run test`.

## Applicable Skills

`planify`, `repo`, `counsel`, `architecture`, `effect-v4`, `test`,
`code-style`, `bun`, `review`

## Gate Command

```bash
bun run typecheck && bun run lint && bun run test
```

## Research Streams

| Lane              | Codex                         | Okra / Opus                             |
| ----------------- | ----------------------------- | --------------------------------------- |
| Simplification    | Final Wave 14 recursive audit | Final Wave 14 recursive counsel attempt |
| Correctness       | Final Wave 14 recursive audit | Final Wave 14 recursive counsel attempt |
| Actor north star  | Final Wave 14 recursive audit | Final Wave 14 recursive counsel attempt |
| Extension system  | Final Wave 14 recursive audit | Final Wave 14 recursive counsel attempt |
| Lint suppressions | Final Wave 14 recursive audit | Final Wave 14 recursive counsel attempt |

## Principle Grounding

| Principle                                                                | Application                                                                      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `/Users/cvr/.brain/principles/correctness-over-pragmatism.md`            | Remaining P1/P2 correctness issues become structural batches, not local patches. |
| `/Users/cvr/.brain/principles/redesign-from-first-principles.md`         | Any surviving architecture debt should be simplified at the owner boundary.      |
| `/Users/cvr/.brain/principles/subtract-before-you-add.md`                | Prefer deleting duplicate surfaces, adapters, or tests before adding new layers. |
| `/Users/cvr/.brain/principles/make-impossible-states-unrepresentable.md` | Encode surviving invariants as typed states, not comments or conventions.        |
| `/Users/cvr/.brain/principles/prove-it-works.md`                         | Every accepted finding gets focused regression coverage and the full gate.       |

## Synthesis

The final recursive audit is the source of truth for Wave 15. It accepted one
P2 across the simplification and lint-suppression lanes: process-shaped
migration labels remain in active source and test comments. Those labels make
the codebase read like a plan execution transcript instead of a product. Wave
15 is therefore a narrow cleanup wave, not a new architecture wave.

## Batch 1: docs(style): remove process-shaped active comments

**Justification**: Active files should explain behavior, invariants, and
regression classes directly. Historical batch/commit labels belong in plans or
dated audit receipts, not source, tests, or lint-rule comments.

**Changes**:
| File | Change |
| ---- | ------ |
| `apps/**` | Replace migration-history labels in active TUI comments with behavior-grounded explanations. |
| `packages/**` | Replace migration-history labels in active package source/tests with stable invariant or regression wording. |
| `lint/**` | Replace rule-history labels with the current lint-rule rationale. |
| `AGENTS.md` | Keep the process-shaped naming ban explicit so this does not creep back into active code. |

**Verification**:

- `rg -n "planned for batch|planify Commit|\\bC[0-9]+(\\.[0-9]+)?[a-z]?\\b|\\bB[0-9]+(\\.[0-9]+)?[a-z]?\\b|\\bW[0-9]+(?:-[0-9]+[a-z]?)?\\b|same wave|downstream batches|batch12|wave14|planify-migration|codex BLOCK|Option G" apps packages lint --glob '!**/dist/**' --glob '!**/.turbo/**'`
- `git diff --name-only -- apps packages lint | xargs rg -n "^[[:space:]]*(//|/\\*|\\*)[[:space:]]*:|codex BLOCK|Option G|\\bW[0-9]+|\\bC[0-9]+|\\bB[0-9]+|planify|batch12|wave14|downstream batches|planned for batch|planify Commit"`
- `bun run typecheck && bun run lint && bun run test`.
- One review round: one Codex subagent plus one Okra counsel attempt, P0/P1/P2
  only.

## Completion Rule

- Wave 15 is complete when the active-source process-name audit is clean, the
  full gate passes, and the single review round reports no P0/P1/P2 findings.

## Status

- Batch 1 implemented:
  - Removed process-shaped migration labels from active `apps/**`,
    `packages/**`, and `lint/**` source/test comments and behavioral test
    descriptions.
  - Removed the obsolete `batch12-modules` test-file allow-list path from the
    custom lint plugin.
  - Stabilized `runProcess` shell tests by using `/bin/sh` for shell-only
    subprocess assertions.
  - Review round completed:
    - Codex subagent found no P0/P1 behavior regression and one P2 cleanup
      issue: label deletion had left malformed comments/test names. Fixed.
    - Okra counsel attempt produced no final report before termination, but its
      partial event log at
      `/tmp/counsel/personal-gent-860892a9/20260429-162349-codex-to-claude-38cc6d/events.jsonl`
      surfaced the same P2 class plus missed `W#` labels. Fixed.
  - Active-source process-name audit and malformed-comment audit returned no
    matches.
