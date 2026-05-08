# Planify: Current Work

## Active Wave

Continue from `plans/WAVE-29.md`.

Wave 28 closed several runtime and file-merit items, but the final audit still
found P1 extension-authority leaks. Wave 29 replaces public `read`/`write`
authority metadata with constrained Effect services that extension code imports
and yields.

## Continuation Rules

- Read `AGENTS.md`, `ARCHITECTURE.md`, and `plans/WAVE-29.md` before editing.
- Preserve the north stars: actor model, Effect ecosystem, and use the
  platform.
- Prefer bigger cohesive files when a split does not encode a real boundary,
  public entrypoint, ownership seam, generated fixture, independently testable
  domain, or high-churn isolation point.
- Run focused tests and then `bun run gate` between logical batches.
- If a batch touches runtime actor semantics, also run `bun run test:e2e`.
- Close Wave 29 only after an independent same-lane audit finds no P0/P1.

## Historical Plans

Older waves remain archived in `plans/`. Do not resume from the old root Wave 7
text; it was superseded by later waves and is now intentionally removed from the
active continuation surface.
