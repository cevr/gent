# Wave 36 — File cohesion + closing P2 pass after W35

## Purpose

Wave 35 closed its 28-commit spine at HEAD `f95f18dd` and absorbed P0s +
most P1s from its closing 9-lane audit as a tail (C29-C40, HEAD
`0799efa9`). Wave 36 picks up the remaining items from
`plans/WAVE-35-final-audit-receipt.md` that were not yet folded, plus the
P2 pass, plus a fresh 9-lane closing audit.

This split exists because:

- W35's spine was a counsel-revised set of composable-method demotions +
  `Capability.Tool` removal. Tailing 14+ file-cohesion / schema /
  test-taxonomy fixes onto that scope blurs what "W35 closed" means.
- Closing-audit P0/P1 findings deserve their own wave when they outnumber
  the prior wave's spine, so each wave's plan reflects what actually
  shipped, not what carried over.

Durable rule (added with this wave): **whenever a closing audit produces
P0 or P1 findings, open the next wave for them.** Do not tail-extend.
P2s may either ride along in the same wave or split into a P2-only
wave, depending on volume and independence.

## Spine

### C1 — File cohesion: collapse `server/rpcs/{runtime,auth,extension}.ts` into `server/rpcs.ts`

- Maps `L6-P1-1` / `L6-P1-2` / `L6-P1-3` from W35 final audit.
- Three sub-files (21 + 42 + 57 lines) had a single consumer each
  (`rpcs.ts`). Inline their class bodies and required imports
  (`Schema`, `Rpc/RpcGroup`, `SessionId`, `Model`, `PermissionRule`,
  `GentRpcError`, transport-contract schemas) into `rpcs.ts`; delete
  the three sub-files. `rpcs/session.ts` stays at the audit's
  direction (it's ~3.7k, separate concern).

### C2 — File cohesion: collapse `server/ws-tracing.ts` into `server/server-routes.ts`

- Maps `L6-P1-4`.
- 75 lines, single consumer (`server-routes.ts`). WS-tracing
  middleware lives where it's wired.

### C3 — P2 pass: `mcp-bridge.ts` Promise pagination → Effect.iterate / Stream.paginateEffect

- Maps `L1-P2-1`.
- `packages/extensions/src/executor/mcp-bridge.ts:251` recurses inside
  `Effect.tryPromise`. Replace with an Effect-native paginator.

### C4 — P2 pass: schema `ALTER TABLE` idempotency guards

- Maps `L3-P2-1`.
- Migrations `003_session_workspace` and `005_interaction_decision`
  (`ADD COLUMN`) lack the project's standard `Effect.ignoreCause`
  guard. Wrap both.

### C5 — P2 pass: RPC acceptance coverage for delegate + memory tools

- Maps `L5-P2-1`.
- Add at least one `createRpcHarness` acceptance test in
  `packages/extensions/tests/delegate/` and
  `packages/extensions/tests/memory/`. Existing `runToolWithCtx`
  tests bypass the per-request scope boundary.

### C6 — P2 pass: replace `Effect.sleep` concurrency proxies in `resource-manager.test.ts`

- Maps `L5-P2-2`.
- Lines 90 + 113 use timed sleeps to verify mutual exclusion.
  Replace with `Deferred`-based gates (pattern already in use at
  lines 18-32).

### C7 — Closing 9-lane audit

- Same nine-lane shape as W35's final audit
  (`plans/WAVE-35-final-audit-receipt.md`):
  1. Effect simplification (`Effect.fn` / pipe chains / Promise leaks)
  2. Actor model + wide-event boundaries
  3. Schema / storage integrity (branding, validation boundaries)
  4. Public API ceremony (extensions surface, dual-name exports)
  5. Test taxonomy (sleep-as-gate, harness usage, mock placement)
  6. File cohesion (collapsable sub-files, single-consumer modules)
  7. Ctx-as-param leaks (`FileIndex`/`FileLockService`/etc.)
  8. Yield-don't-thread (service threading vs. inside-Effect yield)
  9. Composable-method demotions (identity wrappers, pass-throughs)
- Method: 9 independent Agent/Explore lanes against fresh HEAD; no
  cross-pollination. Consolidate into
  `plans/WAVE-36-audit-receipt.md`.
- Disposition rule: **if the closing audit produces P0 or P1
  findings, open Wave 37 for them. Do not tail-extend W36.** P2s
  may roll in or split per volume.

## Scope discipline

Per the carry-over `plans/WAVE-35.md:258-266` directive — _"Scope is
not a constraint. 100 commits is fine as long as the end state is
structurally superior."_ — W36 ships all named items above to
completion, then runs the closing audit to verify. The audit's job is
to find what implementation missed; this wave's job is to close it.

If during execution an item turns out to need independent investigation
(new upstream API, unclear repro), it gets written into W37 as a
named, concrete follow-up — not deferred informally.

## Counsel cadence

Same as W35: after every commit, run `okra counsel` against the
HEAD diff with the plan path quoted. One revision round per commit
max. If codex is rate-limited, fall back to an independent Opus
`general-purpose` Agent review (memory:
`feedback_counsel_fallback_opus.md`).

## Memory state at W36 open

- Effect `4.0.0-beta.47` (`effect-machine` + `effect-wide-event`
  rebuilt against it).
- Pre-commit gate via lefthook: lint+fmt → typecheck → build →
  test. All green at HEAD `0799efa9`.
- `plans/WAVE-35-final-audit-receipt.md` is the source of truth for
  C1-C2 items.
