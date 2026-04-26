# Planify: Wave 10 — Full Migration + Extension Surface Collapse

## Context

Wave 9 introduced the actor primitive (`ActorRef<M>`, `Behavior<M>`,
`ActorContext<M>`, `ServiceKey<M>`, `tell`, `ask`, `Receptionist`,
actor persistence) as foundation work. No existing extension uses it
at W9 close — the new surface coexists with `Resource.machine` /
`runtime.*` slots / `subscriptions` / `Capability` / `Projection`
machinery.

Wave 10 is the **full redesign in one wave**. It does three things
that earlier drafts split across separate migration + collapse waves:

1. Migrates every existing extension onto the actor primitive (all
   7 `Resource.machine` sites + `executor/actor` + every
   `runtime.*`-slot consumer + every `subscriptions` consumer).
2. Collapses the rest of the extension surface to per-bucket
   inline-handler shape (`tools` / `commands` / `keybinds` / `rpc`,
   actor `view: (state) => {...}` instead of `ProjectionContribution`).
3. Deletes every legacy surface in one revertible sweep
   (`Capability` parent + factories + `Intent` + `Projection` +
   `pulseTags` + `ReadOnlyTag` + `audiences[]` +
   `Resource.machine` + `MachineEngine` + `runtime.turnAfter` /
   `eventReducer` / `eachTick` + `subscriptions`).

The cut applies the principles `subtract-before-you-add` (deletion
before construction), `composition-over-flags` (one bucket per
surface, no `audiences[]` matrix), `small-interface-deep-implementation`
(smallest front door per surface), `derive-dont-sync` (presentation
lives with the surface that consumes it), and
`migrate-callers-then-delete-legacy-apis` (every caller migrated
before deletion sweep, sweep is one revertible commit).

**Why one wave instead of two**: there is no shippable intermediate
state between "migrate some sites + add new buckets, leave old
surface alive" and "delete the old surface." The intermediate is
load-bearing only for the test gate. Splitting it into two waves
forces an artificial split where the first wave maintains a
coexistence layer the second wave immediately throws away. Doing it
in one wave (with sub-commits for blast radius) is correct.

A final "post-deletion stabilization" sub-batch absorbs any sharp
edges the deletion sweep surfaces in-wave. If the sweep is clean,
that sub-batch is empty and W10 closes. No separate stabilization
wave needed.

The plan is not complete until every batch below is implemented,
gated, and reviewed once.

## Scope

- **In**: bulk migration of all 7 `Resource.machine` sites
  (handoff, exec-tools notifications, auto, artifacts, memory,
  skills, plus `executor/actor`); `runtime.*` slot consumers
  rewritten as actor mailbox messages; `subscriptions` consumers
  rewritten as Receptionist subscriptions; folding
  `ProjectionContribution` into actor `view: (state) => {...}`;
  per-bucket inline handlers (`tools` / `commands` / `keybinds` /
  `rpc`); deletion sweep of every legacy surface listed below;
  doc rewrite (`docs/extensions.md`); test-helper alignment
  (`e2e-layer.ts` / `in-process-layer.ts` / `extension-harness.ts`);
  post-deletion stabilization sub-batch.
- **Out (deferred to W11)**: `needs: [Tag, ...]`-derived
  concurrency + read-safety. W10's `tools` bucket keeps `resources?`
  and `idempotent?` as-is; W11 replaces them.
- **Out (deferred to W12 audit)**: 9-lane recursive
  verification audit. See `plans/WAVE-12.md`.
- **Out**: cosmetic refactors not tied to migration or surface
  collapse; package-policy reintroduction.

## Constraints

- Correctness over pragmatism. Personal library; no shims, no
  parallel APIs, no deprecation cycles.
- `migrate-callers-then-delete-legacy-apis`: every caller of every
  doomed surface migrated in W10-1 through W10-4. The deletion sweep
  (W10-5) is single-commit and revertible as a unit if any caller
  was missed.
- Each commit compiles and passes `bun run gate`.
- Sub-commits allowed inside any C-batch with blast radius > 20
  files. Each sub-commit must compile and pass gate.
- One review subagent per implementation commit (per-commit Codex
  review for drift detection).
- High-blast-radius commits (W10-1, W10-3, W10-5) also run
  `bun run test:e2e`.
- Apply-tier delegation per CLAUDE.md: design-tier authors the
  first migration of each pattern (one state-holder, one genuine
  machine, one tool, one command, one rpc, one slot consumer);
  apply-tier subagents handle the recipe-execution tail.

## Applicable Skills

`architecture`, `effect-v4`, `test`, `code-style`, `bun`, `planify`

## Gate Command

`bun run gate`

---

## Shape after W10

`defineExtension(...)` accepts these buckets — each bucket has its
own field shape; no shared parent type:

```ts
defineExtension({
  id: "fs-tools",
  // Stateful protocols.
  actors:    [HandoffActor, ExecActor],
  // Surface buckets — each fully self-contained, handler inline.
  tools:     [{ id, input, output, description, prompt?, permissions?, resources?, idempotent?, handler }],
  commands:  [{ id, name, description?, category?, handler }],
  keybinds:  [{ key, description?, handler }],
  rpc:       [{ id, input, output, public?, handler }],
  // Adapters — unchanged.
  agents:    [],  // declarative config, no handler
  drivers:   [],  // model + external transport adapters (kind-narrowed)
})
```

**Seven buckets total.** Surface-named, concrete, no shared parent.
Same featureset as today's seven buckets + four factories +
read-only fence + `audiences[]` + `CapabilityToken` machinery.

## What dies in W10

Verified at HEAD `cad345ba` against the codebase:

- **`Capability` / `CapabilityContribution` / `AnyCapabilityContribution`**
  (`packages/core/src/domain/capability.ts:154-202`) — replaced by
  per-surface bucket types.
- **`CapabilityToken` / `CAPABILITY_REF` symbol / `ref()`**
  (`capability.ts:215-258`) — handler lives inline, no token
  indirection. Cross-extension `request` calls are typed by
  importing the bucket entry directly (or a shared type) — no
  symbol-keyed runtime metadata.
- **`tool(...)` / `request(...)` / `action(...)` factories**
  (`packages/core/src/domain/capability/{tool,request,action}.ts`)
  — ~580 LOC across three files deletes. Authors write
  `tools: [{ ... }]` etc. directly.
- **`audiences: Audience[]`** (`capability.ts:169` + 5 usage sites)
  — surface IS the bucket, no flag.
- **`Intent` type / `intent: "read" | "write"` field on capabilities**
  (`capability.ts:77`, `capability/tool.ts:124`,
  `capability/request.ts:116/124`, `capability-host.ts:85-91/188`,
  `registry.ts:38/111`, `make-extension-host-context.ts:279`,
  `rpc-handler-groups/extension.ts:263`) — does **not** drive
  concurrency (concurrency keys on `resources: ReadonlyArray<string>`
  via `runtime/resource-manager.ts`, fully decoupled from intent).
  Today's consumers are (1) the read-only R-channel fence — dies
  with projection deletion; (2) `CapabilityHost.lookup` authorization
  check — ceremonial dispatch gate that adds nothing the bucket-name
  dispatch doesn't already provide. The future "read-only sub-agent"
  feature will derive read-safety from `needs: [Tag, ...]` in W10;
  no speculative `intent` field is reserved for it.
- **`ProjectionContribution` / `ProjectionRegistry` / `projections`
  bucket** (`packages/core/src/domain/projection.ts:77-133`) —
  folded into actor `view: (state) => { prompt?, toolPolicy? }`.
  Pure function of actor state, no Effect, no service injection,
  no fence needed.
- **`pulseTags` field on `ExtensionContributions`**
  (`contribution.ts:64`) — `derive-dont-sync` violation. Pulse is
  derived from actor `Behavior` swap; no separate event-tag list.
- **`ReadOnlyTag` brand + per-service read-only Tags**
  (`MachineExecute`, `TaskStorageReadOnly`, `MemoryVaultReadOnly`,
  `InteractionPendingReader`, `Skills`, `domain/read-only.ts`) —
  fence existed to compensate for projections pulling from
  arbitrary services. With projections gone, the fence has nothing
  to fence.
- **`ExtensionTurnContext` / `TurnProjection` / `evaluateTurn`
  machinery in agent-loop** — turn-time prompt assembly walks
  `actors[].view(state)` for prompt sections + tool policy. No
  ProjectionRegistry.
- **`CapabilityHost` dispatch by audience** — replaced by direct
  bucket lookup (the bucket name is the dispatch key).
- **`Resource.machine` field, `MachineEngine`, `runtime.turnAfter` /
  `eventReducer` / `eachTick` slots, `subscriptions` array** —
  absorbed into actors and Receptionist subscriptions.

## Why this isn't a regression

Featureset preserved end-to-end:

| Today                                              | After W10                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `tool({ id, intent, params, execute })`            | `tools: [{ id, input, output, handler }]`                                                                |
| `request({ id, intent, input, output })`           | `rpc: [{ id, input, output, public, handler }]`                                                          |
| `action({ id, name, surface, execute })`           | `commands: [{ id, name, handler }]` + `keybinds: [{ key, handler }]`                                     |
| `defineResource({ machine, layer })`               | `actors: [...]`                                                                                          |
| `projection({ query, prompt, policy })`            | `actor.view: (state) => { prompt, toolPolicy }`                                                          |
| `pulseTags: ["TurnCompleted"]`                     | actor Behavior swap derives the pulse                                                                    |
| `runtime.turnAfter` / `eachTick` / `eventReducer`  | actor mailbox messages                                                                                   |
| `subscriptions: [{ event, handler }]`              | Receptionist `subscribe(ServiceKey)` + typed mailbox                                                     |
| `audiences: ["model", "human-slash"]` cross-listed | author writes both `tools: [...]` and `commands: [...]` entries (handler can be a shared local function) |
| `intent: "read" \| "write"`                        | dropped; concurrency unchanged (`resources: [...]` keeps driving it); read-safety derived in W10         |

The "share one handler across surfaces" case becomes: extract a
local function in the extension's own file, reference it from both
bucket entries. This is what every prior-art system does in
practice; it is what authors do in their own code already.

---

## Implementation Batches

Order: migrate every consumer of every doomed surface, then delete
in one revertible sweep, then stabilize. Per
`migrate-callers-then-delete-legacy-apis`. Sub-commits where blast
radius > 20 files. Apply-tier delegation per CLAUDE.md for the
recipe-execution tail.

### Commit 1: `refactor(extensions): migrate all Resource.machine sites + executor/actor to actors`

**Why W10-1 first**: every later commit assumes actors are the only
state-holding shape. Until this lands, the deletion sweep can't
touch `Resource.machine`.

**Sub-commits permitted** (~7 sites + executor + tests):

- **W10-1a**: design-tier migrates `handoff` (simplest, single-state
  store) — establishes the recipe for state-holders.
- **W10-1b**: design-tier migrates `auto` (genuine multi-state
  workflow with `effect-machine` inside `Behavior`) —
  establishes the recipe for genuine machines.
- **W10-1c**: design-tier migrates `executor/actor` (the second
  genuine machine, peer-discovery via Receptionist) — exercises
  cross-extension `find` + `ask`.
- **W10-1d**: apply-tier subagent migrates the remaining 4
  state-holders (exec-tools notifications, artifacts, memory,
  skills) using W10-1a as the recipe.

**Files**: `packages/extensions/src/handoff.ts`,
`packages/extensions/src/auto.ts`,
`packages/extensions/src/auto-checkpoint.ts`,
`packages/extensions/src/executor/actor.ts`,
`packages/extensions/src/exec-tools/*.ts` (notifications),
artifacts store, memory store, skills init, plus their tests.

**Verification**: `bun run gate` + `bun run test:e2e` (final
sub-commit).

**Cites**: `redesign-from-first-principles`,
`migrate-callers-then-delete-legacy-apis`,
`make-impossible-states-unrepresentable`.

### Commit 2: `refactor(extensions): fold ProjectionContribution into actor view`

**Why W10-2**: every `ProjectionContribution` becomes
`actor.view: (state) => {...}` on its owning actor. ~5 sites. The
pure-function-of-state constraint forces any cross-extension reads
to become Receptionist `find` + `ask` from inside the actor's
reducer (which is where they should have been — prompt assembly
should not pull live state from peers).

**Files**: every site declaring `projection({ query, prompt, ... })`,
the consuming `evaluateTurn` walk (still in place — W10-5 deletes).

**Verification**: `bun run gate`.

**Cites**: `derive-dont-sync`,
`small-interface-deep-implementation`.

### Commit 3: `feat(extensions): per-surface buckets with inline handlers`

**Why W10-3**: introduce `tools` / `commands` / `keybinds` / `rpc`
bucket types and migrate ~30 `tool(...)` call sites, ~5
`request(...)` sites, ~3 `action(...)` sites. Each bucket entry is
fully inline.

**Sub-commits permitted** (blast radius ~40 files):

- **W10-3a**: `tools` bucket type + first migration (~3 example
  tools, design-tier) — establishes the recipe.
- **W10-3b**: apply-tier subagent migrates remaining ~27
  `tool(...)` call sites.
- **W10-3c**: `commands` + `keybinds` bucket types + migrate ~3
  `action(...)` sites.
- **W10-3d**: `rpc` bucket type + migrate ~5 `request(...)` sites.

**Verification**: `bun run gate` + `bun run test:e2e`.

**Cites**: `composition-over-flags`,
`small-interface-deep-implementation`,
`progressive-disclosure`.

### Commit 4: `refactor(runtime): lift slot + subscription consumers to actor messages`

**Why W10-4**: `runtime.turnAfter` / `eventReducer` / `eachTick`
consumers become actor mailbox messages. `subscriptions` consumers
become Receptionist subscriptions. After this commit, no extension
reaches for the old slots — W10-5 can delete them safely.

**Files**: every consumer of `runtime.turnAfter` / `eventReducer` /
`eachTick` / `subscriptions`. Tests migrate alongside.

**Verification**: `bun run gate`.

**Cites**: `migrate-callers-then-delete-legacy-apis`,
`subtract-before-you-add`.

### Commit 5: `refactor(domain,runtime): delete legacy surfaces — capability, projection, slots, machine`

**Why W10-5**: every caller migrated in W10-1 through W10-4. Single
commit, designed to be reverted as a unit if anything was missed.

**Deletes**: `Capability` / `CapabilityContribution` /
`CapabilityToken` / `CAPABILITY_REF` / `ref()` / `tool` /
`request` / `action` factories / `audiences: Audience[]` /
`Intent` / `ProjectionContribution` / `pulseTags` / `ReadOnlyTag`

- per-service read-only Tags / `evaluateTurn` / `CapabilityHost`
  audience-dispatch / `Resource.machine` field / `MachineEngine` /
  `runtime.turnAfter` / `eventReducer` / `eachTick` /
  `subscriptions`.

**Updates**: `OVERRIDE_TAG_SETS` (drop deleted Tags),
`make-extension-host-context.ts`, `composer.ts`, `loader.ts`,
`activation.ts`, `e2e-layer.ts` / `in-process-layer.ts` /
`extension-harness.ts`, `docs/extensions.md` (rewritten against
post-W10 surface).

**Verification**: `bun run gate` + `bun run test:e2e`.

**Cites**: `subtract-before-you-add`,
`redesign-from-first-principles`.

### Commit 6: `refactor(extensions): post-deletion stabilization`

**Why W10-6**: any sharp edges the W10-5 sweep surfaces close
in-wave. Common candidates: docs-rewrite gaps, test-helper drift,
inline-handler patterns that crystallize into one or two shared
helpers worth extracting (only if usage proves the case),
extension authoring examples in the README that reference deleted
factories.

**If clean, this commit is empty and skipped — W10 closes after
W10-5.** A skipped W10-6 is the goal: a clean W10-5 sweep means no
caller was missed and no idiom got stranded.

**Files**: per surface fallout discovered.

**Verification**: `bun run gate`.

**Cites**: `subtract-before-you-add`, principle citations per
finding.

---

W10 closes when the legacy surfaces are gone and the gate is green
on the post-deletion HEAD. **`plans/WAVE-11.md`** is the next
wave: `needs: [Tag, ...]`-derived concurrency + read-safety on
the post-W10 `tools` bucket.
