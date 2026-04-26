# Planify: Wave 12 — 9-Lane Recursive Verification Audit

## Context

After Waves 7, 8, 9, 10, and 11 all ship and gate green, the
substrate has been redesigned end-to-end:

- **W7** hardened the W6 substrate against the W6 closing audit's
  punch list — brand passes, domain back-imports, server hardening,
  test gap closure. Surfaces that survive W10 only.
- **W8** dropped `effect-machine` from the agent-loop. Replaced
  the FSM driver with a plain `Effect.gen` + `Ref<Phase>` + single
  `Fiber<Turn>` per session; collapsed the duplicated state Refs;
  reshaped the checkpoint to a flat `Schema.Struct`. ~800 LOC of
  accidental complexity removed from the most-read file.
- **W9** introduced the actor primitive (`ActorRef<M>`, `Behavior`,
  `ActorContext`, `ServiceKey<M>`, `Receptionist`, `tell`, `ask`)
  as foundation work — no existing migrations.
- **W10** migrated every extension onto the actor primitive,
  collapsed the extension surface to per-bucket inline-handler
  shape (`tools` / `commands` / `keybinds` / `rpc`), deleted the
  `Capability` / `Intent` / `Projection` / `Resource.machine` /
  `MachineEngine` / `runtime.*` slots / `subscriptions` machinery,
  and absorbed any post-deletion stabilization fallout in-wave.
- **W11** replaced loose `resources` + `idempotent` fields on
  `tools` with `needs: [Tag, ...]`-derived concurrency and
  read-safety, with fail-closed lock-registry validation at
  extension load.

The W6 closing audit at HEAD `cad345ba` produced a punch list
preserved at
`~/.claude/projects/-Users-cvr-Developer-personal-gent/memory/project_w7_findings.md`.
**W7 closed the items that target surfaces W10 doesn't delete.**
The remainder of the W6 punch list either dies with W10's deletion
sweep or is restated against the post-W11 shape. This audit
verifies the full chain landed cleanly.

This audit is the verification pass on the fully settled
post-W11 substrate. Its input is real (not in-flight). Its output
is the punch list driving any final cleanup wave.

The plan is not complete until every lane reports, findings are
classified (P1/P2/P3), and either inlined as a follow-up commit
batch (if any P1) or recorded as the closeout receipt (if no P1).

## Scope

- **In**: 9-lane recursive verification at HEAD on the post-W11
  substrate. Lane briefings updated to match the post-W11 surface
  (no `Capability`, no `Intent`, no `Projection`, no
  `Resource.machine`, no `MachineEngine`, no `effect-machine` in
  the agent-loop, no `resources`/`idempotent` fields on tools).
  Classification + receipt.
- **In**: cross-checking the W6 audit's punch list items against
  the post-W11 shape. Items whose target survived (still apply);
  items whose target died (drop); items whose target moved
  (re-state against new shape). Items already closed in W7 are
  recorded as "closed in W7" not re-audited.
- **Out**: implementing any findings. Findings are classified and
  scheduled, not executed in this audit. P1 = follow-up commit
  batch in this wave; P2 = next wave's input; P3 = backlog.

## Constraints

- The audit MUST run nine independent subagents, one per lane, each
  landing cold. No subagent sees another's findings during
  collection — adversarial independence is the value.
- Each subagent receives the universal preamble + lane briefing.
- Findings classification is design-tier work — not delegated.

## Applicable Skills

`architecture`, `effect-v4`, `test`, `code-style`, `bun`, `planify`

## Gate Command

`bun run gate` (verifies HEAD is green before audit launches)

---

## Universal Preamble (used by all nine lanes)

> You are auditing the post-W11 `gent` substrate at HEAD `<SHA>`
> (working dir `/Users/cvr/Developer/personal/gent`). The plan
> sequence is at `PLAN.md` (active wave — currently W12) and
> `plans/WAVE-{7,8,9,10,11}.md` (history). Read the relevant wave
> plans before starting.
>
> The substrate has been redesigned across five waves on top of W6:
>
> - W7: pre-migration hardening — brand passes (`SessionId`,
>   `ToolCallId`, `AgentName`, `ProviderId`, `ActorId`,
>   `InteractionRequestId`, `ExtensionId`); domain back-imports
>   eliminated (`ProviderError`/`StorageError` moved into domain);
>   `ServerIdentity` non-optional in `RpcHandlerDeps`;
>   `SessionMutationsService` parallel surface deleted; `cwdPulseCache`
>   eviction wired; test gap closure (`Effect.timeout` sweeps,
>   missing-coverage tests). All on the W6 substrate before
>   architectural waves begin.
> - W8: agent-loop simplification — `effect-machine` dropped from
>   `agent-loop.ts` + `agent-loop.state.ts`. Single
>   `Ref<AgentLoopState>` + `Fiber<Turn>` per session + flat
>   `Schema.Struct` checkpoint. ~800 LOC removed.
> - W9: actor primitive foundation — `ActorRef<M>`, `Behavior<M>`,
>   `ActorContext<M>`, `ServiceKey<M>`, `Receptionist`, `tell`, `ask`
>   with 5s default ask timeout, `ActorAskTimeout` typed error.
>   Foundation only; no existing extension migrated in W9.
>   `effect-machine`-the-library survives in extension `Behavior`
>   internals where authors choose it (`auto`, `executor/actor`).
> - W10: full migration + extension surface collapse. Buckets:
>   `actors`, `tools`, `commands`, `keybinds`, `rpc`, `agents`,
>   `drivers`. No `Capability` shared parent, no `audiences[]`, no
>   `Intent`, no `Projection`, no `pulseTags`, no `ReadOnlyTag`, no
>   `Resource.machine`, no `MachineEngine`, no `runtime.turnAfter`/
>   `eventReducer`/`eachTick` slots, no `subscriptions` array.
> - W11: `tools` bucket declares `needs: [Tag, ...]`. `LOCK_REGISTRY`
>   maps each Tag to `{ kind: "read"|"write"|"none", locks: string[] }`.
>   Concurrency, read-safety, idempotency all derive from `needs`.
>   Fail-closed validation at extension load.
>
> Read `~/.brain/principles/principles.md` and follow every wikilink.
> Cite the specific principle name + line/file when raising findings.
>
> Output format: punch list of findings with severity (P1 = blocking
> for closeout; P2 = structural deferral candidate for the next
> wave; P3 = non-structural deferral candidate for backlog),
> evidence (file:line), and recommendation. Be adversarial.

## Lane Briefings

### Lane 1 — runtime ownership / actor-model clarity

Does the actor primitive cleanly own state/protocol/lifecycle?
After W9+W10, are there any residual paths where extension code
reaches around the actor boundary (direct `Ref` peer access,
ambient services holding extension state)? Is `ActorEngine`
boundary tight (no leakage into extension code)? Is supervisor
strategy expressive enough for the migrated sites? After W8, is
the agent-loop's plain-Effect driver clean — no leftover FSM-shape
helpers, no projection mirror Refs?

### Lane 2 — extension API boundaries

Is `defineExtension({ actors, tools, commands, keybinds, rpc,
agents, drivers })` the only path? Do any extensions reach for
deleted shapes (compile would fail; this lane verifies semantic
equivalents — e.g., faking `subscriptions` via a hand-rolled
`tell`-everyone helper)? Are `ServiceKey`s typed end-to-end? Are
bucket entries fully self-contained (no shared `Capability`-shaped
helper smuggling audience flags back in)?

### Lane 3 — Effect-native AI integration

Untouched substrate across the program. Confirm no regressions in
`Provider.*` from layer-graph changes across the five waves.
Verify `toTurnEventStream` boundary still single-converts.

### Lane 4 — storage model

Does actor persistence (W9) write through the existing durability
primitives? Did the W11 `LOCK_REGISTRY` introduce a parallel
storage path? Are SQLite migrations clean post-W10 deletions
(unused columns / dead tables flagged for the cleanup tail)? Did
W8's checkpoint reshape preserve durable interaction suspension
end-to-end?

### Lane 5 — domain modeling / constructor discipline

Are `ActorRef`, `ServiceKey`, `ActorAskTimeout`,
`UnknownNeedsTagError`, post-W10 bucket-id brands (`ToolId`,
`CommandId`, `KeybindId`, `RpcId`) schemas clean? Branding
consistent? Did W7's brand pass cover every surface that survived
W10? Any `Schema.String` left where a brand should be?

### Lane 6 — suppression debt / boundary discipline

Any `Effect.die` / `Effect.ignoreCause` / `as any` /
`as unknown as X` cast added across W7-W11? Any `// TODO` / `//
FIXME` left in the migrated code? Are `Effect.timeout` finalizers
still inside-Effect (per CLAUDE.md)?

### Lane 7 — SDK/TUI adapter debt

Did any wave leak through the SDK/TUI boundary in unintended ways?
Are RPC handler groups clean post-W10 (`rpc` bucket should be the
sole RPC contribution surface)?

### Lane 8 — test taxonomy / behavioral coverage

Do new tests follow `Effect.timeout`-inside-Effect rule, behavioral
naming, three-tier taxonomy from CLAUDE.md? Did the migrations
preserve coverage end-to-end? Are there RPC acceptance tests for
the W10 `rpc` bucket? Did W8's regression suite for durable
suspension + queue drain cover the previously FSM-tested
scenarios?

### Lane 9 — substrate consistency (NEW PERMANENT AXIS)

Are the deleted shapes (`effect-machine` from agent-loop;
`Resource.machine`, `MachineEngine`, `runtime.*` slots,
`subscriptions`, ad-hoc `Resource.layer` state holders,
`Capability` parent type, `audiences[]`, `Intent`, `Projection`,
`pulseTags`, `ReadOnlyTag`, `resources`/`idempotent` on tools)
**absent** across the codebase? Does `effect-machine` inside
`Behavior` work where authors chose it? Are Receptionist lookups
typed and optional-dependency-safe (empty array on missing peer)?
Is `LOCK_REGISTRY` complete (every service Tag in
`make-extension-host-context.ts` has an entry; every tool's
`needs` Tag is registered)?

---

## Pre-known input — W6 audit findings re-checked against post-W11

These items were captured at W6 close. W7 closed the
surface-independent half. The remainder needs re-checking against
the post-W11 shape before the audit fires. The audit subagents
should be aware of these so they don't re-discover them as novel
findings:

### Closed in W7 (do not re-audit)

- P1 brand pass on `SessionId`, `ToolCallId`, `AgentName`.
- Generic P2 brand pass (`ProviderId`, `ActorId`,
  `InteractionRequestId`, `ExtensionId`).
- Domain back-imports (`ProviderError`, `StorageError`).
- `DEFAULT_AGENT_NAME` adoption in TUI fallbacks.
- `ServerIdentity` non-optional in `RpcHandlerDeps`.
- `SessionMutationsService` parallel surface deletion.
- `cwdPulseCache` eviction wiring.
- Test gap closure: `Effect.timeout` sweeps; TTL/size-cap tests;
  `Layer.build(AppServicesLive)` smoke; provider cause-preservation;
  concurrent-write storage; FK-migration interrupt; `deleteSession`
  cascade race; `sanitizeFts5Query` units; pure-function tests
  (`resolveAgentDriver`, `getDurableAgentRunSessionId`, event
  helpers, `makeRunSpec`, `copyMessageToBranch`).
- Low/cleanup tail (dead `bypass` column, `getSessionDetail` N+1,
  etc.).

### Resolved by W10 deletion (drop from input)

- **Intent default fix** — the field is gone.
- **`CAPABILITY_REF` privacy test** — symbol gone.
- **`ProjectionId` brand** — projections gone.
- **`CapabilityId` brand** — Capability parent gone.
- **`ReadOnlyTag` privacy** — brand gone.

### Resolved by W11 (drop from input)

- **`resources` field free-form-string concerns** — replaced by
  Tag-based `needs`.
- **`idempotent` hand-set bool concerns** — derived from `needs`.

### New post-W10 surfaces to brand (in scope for the audit)

- `ToolId`, `CommandId`, `KeybindId`, `RpcId` — verify branding
  consistent with W7's brand-pass standard.

---

## Implementation Batches

### Commit 1: `chore(audit): launch nine-lane post-W11 verification`

**Why C1**: gates the closeout. Spawn nine independent subagents
in parallel, each with the universal preamble + lane briefing.
Collect reports.

**Procedure**: nine `Agent` calls (`subagent_type` matching the
lane focus; default `general-purpose` is fine). Run in parallel.
Each subagent's deliverable is a markdown punch list. Collect into
`plans/WAVE-12-FINDINGS.md` (new file, lane-grouped findings).

**Files**: `plans/WAVE-12-FINDINGS.md` (new — receipt only).
No code changes in this commit.

**Verification**: nine reports collected and grouped.

**Cites**: every principle the lanes cite — receipt records the
trail.

### Commit 2: `chore(audit): classify findings + schedule follow-up`

**Why C2**: design-tier work. Read every finding, classify P1 / P2
/ P3, decide which warrant in-wave fixes vs deferral.

**Procedure**:

- P1 (any): inline as C3-Cn batches in this wave. Each P1 fix is
  one commit, gated, reviewed.
- P2: rolled into a new `plans/WAVE-13.md` (next wave) input.
- P3: appended to a backlog file (or memory) for later.

**Files**: `plans/WAVE-12-FINDINGS.md` (annotated with
classifications); `plans/WAVE-13.md` (new — drafted only if P2s
exist); backlog file or memory entry for P3s.

**Verification**: every finding has a classification + disposition.

**Cites**: `subtract-before-you-add`, `progressive-disclosure`.

### Commits 3..N: `fix(...): close P1 finding <id>`

**Why**: any P1 lands in-wave. One commit per P1, gated, reviewed.
If zero P1s, this wave closes after C2.

**Files**: per finding.

**Verification**: per commit `bun run gate`.

**Cites**: per finding's principle citation.

### Final commit: `chore(audit): post-W11 verification closeout`

**Why**: receipt. This file becomes the receipt directly with the
closeout date + outcome summary appended; record P2 deferrals'
destination, mark the wave closed.

**Files**: this file (annotated with closeout date + outcome
summary); `PLAN.md` reset to next active wave (likely W13 or
backlog drain) or marked "no active wave" if everything closed.

**Verification**: `bun run gate` clean at HEAD.

**Cites**: receipt records the trail.

---

This audit is the **last gate before declaring the redesign
complete**. After closeout: gent's substrate is the target shape —
hardened domain (W7) + simplified agent-loop (W8) + actor primitive
(W9) + per-surface buckets (W10) + `needs`-derived concurrency
with fail-closed validation (W11). Future waves are feature work,
not substrate redesign.
