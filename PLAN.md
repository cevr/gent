# Planify: Current Work

## Active Wave

Continue from `plans/WAVE-30.md`.

Wave 29 closed its narrow extension-authority lane, but the broader recursive
simplicity audit still found P1s in extension authoring, shipped extension
boundaries, actor operation idempotency, and platform process ownership. Wave 30
turns those findings into the next commit-batched implementation wave.

## Continuation Rules

- Read `AGENTS.md`, `ARCHITECTURE.md`, and `plans/WAVE-30.md` before editing.
- Preserve the north stars: actor model, Effect ecosystem, and use the
  platform.
- Preserve the extension authoring north star: params-only leaves and
  `yield* ExtensionContext`; no ctx parameters, no privileged builtin API, and
  no capability/read/write ceremony when host access can be expressed through
  the provided context facade.
- Prefer bigger cohesive files when a split does not encode a real boundary,
  public entrypoint, ownership seam, generated fixture, independently testable
  domain, or high-churn isolation point.
- Run focused tests and then `bun run gate` between logical batches.
- If a batch touches runtime actor semantics, also run `bun run test:e2e`.
- Close Wave 30 only after the independent recursive audit in the final batch
  finds no P0/P1.

## Historical Plans

Older waves remain archived in `plans/`. Do not resume from the old root Wave 7
text; it was superseded by later waves and is now intentionally removed from the
active continuation surface.
