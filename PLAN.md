# Planify: Current Work

## Active Wave

Continue from `plans/WAVE-28.md`.

Wave 27 closed with a successful implementation gate but did not meet the
recursive audit close criterion: the final independent audit found no P0s, but
it did find remaining P1s in runtime ownership, extension API surface, file
merit, and behavioral guardrails.

## Continuation Rules

- Read `AGENTS.md`, `ARCHITECTURE.md`, and `plans/WAVE-28.md` before editing.
- Preserve the north stars: actor model, Effect ecosystem, and use the
  platform.
- Prefer bigger cohesive files when a split does not encode a real boundary,
  public entrypoint, ownership seam, generated fixture, independently testable
  domain, or high-churn isolation point.
- Run focused tests and then `bun run gate` between logical batches.
- If a batch touches runtime actor semantics, also run `bun run test:e2e`.
- Close Wave 28 only after an independent same-lane audit finds no P0/P1.

## Historical Plans

Older waves remain archived in `plans/`. Do not resume from the old root Wave 7
text; it was superseded by later waves and is now intentionally removed from the
active continuation surface.
