# Branch resources: design note

Date: 2026-09-09. Author: Claude, from source read at `4c123fa3`.

This note records what the source actually supports before any code changes.
Every claim below has a file and line receipt.

**Status: implemented.** Verified 2026-09-09. `buildResourceLayer(..., "branch")`
runs in `agent-loop.behavior.ts:339` against the branch scope, and
`@gent/skills` declares `scope: "branch"` (`packages/extensions/src/skills/index.ts:28`)
with its service read by the turn projection. The trap this note warned about —
widening `ResourceScope` while every caller still pins `"process"` — did not
happen: there is a real branch-scoped consumer. No open work remains here.

## The finding that shrinks this unit

The plan treats "add branch resource ownership under the existing actor scope"
as host work. Most of it is not. Three mechanisms already exist.

### 1. The resource host already takes its lifetime from context

`makeResourceGraphHost` requires `Scope.Scope` and reads it once:

- `resource-graph-host.ts:353` — signature requires `Scope.Scope | GentPlatform`.
- `resource-graph-host.ts:355` — `const parentScope = yield* Scope.Scope`.
- `resource-graph-host.ts:1032` — the only other use:
  `Scope.addFinalizer(parentScope, shutdown.pipe(Effect.orDie))`.

Every resource and publication scope is created detached with
`Scope.make("sequential")` (`:549`, `:801`), tracked in `ownedScopes` (`:364`),
and closed in reverse by `shutdown` (`:1004`).

So the host's lifetime is exactly the lifetime of whatever scope is provided.
Provide a branch scope and the host tears down when the branch closes. The host
needs no change for this.

### 2. The actor already owns a real branch scope

`agent-loop.handlers.ts:511-540` forks a child of the actor scope per rebuild
with `Scope.fork(actorScope)`, closes it if construction or handle publication
fails, and transfers ownership on success. That is the branch lifetime. It
landed in `77505180` as the prerequisite for this unit.

### 3. The declaration path is parameterised, but every caller pins "process"

`collectResourceEntries(extensions, scope)` filters on `resource.scope === scope`
(`resource-layer.ts:32-40`). `buildResourceLayer` and
`buildResourceServiceLayer` take a `ResourceScope` parameter defaulting to
`"process"` (`:54`, `:97`).

Do not read this as "already generic". Every caller pins the literal:
`profile.ts:293`, `profile.ts:295`, `live-profile.ts:550`,
`e2e-layer.ts:90`, `e2e-layer.ts:107`. The availability reporter also pins it
(`live-profile.ts:385`).

**This is the trap in this unit.** Widening `ResourceScope` is a _widening_, so
almost nothing fails to compile. A `scope: "branch"` resource would type-check,
then be silently dropped by `live-profile.ts:550` before it ever reached a host,
and never be reported unavailable by `live-profile.ts:385`. The type system
gives no signal. A branch feed must land in the same change as the literal.

## What must actually change

1. `domain/resource.ts:38` — `ResourceScope` becomes `"process" | "branch"`, and
   `ScopeOf` (`:44`) gains a `BranchScope` arm alongside `ServerScope`. Without
   the `ScopeOf` arm, `ScopeOf<"branch">` is `never` and the brand gate silently
   disappears — the widening would remove type safety rather than add a lifetime.
2. `agent-loop.behavior.ts:322-331` — replace the direct
   `Layer.build(CellExecution.Branch ⊕ ModelContextLedger.Branch)` with a branch
   resource host constructed over `loopScope`. Both `Scope.Scope` (`:218`) and
   `GentPlatform` (`:241`) are already in the behavior's R channel, so no new
   requirement enters the signature.
3. A branch `baseContext` built from stable host services only. See the hazard.
4. A branch-scoped feed replacing the pinned `"process"` at `live-profile.ts:550`,
   and the availability filter at `live-profile.ts:385`. Without this the
   feature is inert — see the trap above.

`AnyResourceContribution` (`domain/resource.ts:102`) widens automatically, so
every host that iterates it starts receiving branch resources with no type-level
signal. Audit those iterations as part of the change.

`defineStateResource` stays process-only — it pins the literal `scope: "process"`
(`domain/resource.ts:182`) on purpose. `schedule-engine.ts:12` states only
process resources contribute cron schedules; a branch scope must not start
feeding that reconciler.

## The hazard, confirmed

The plan warns that the host captures `baseContext` once and that a branch
resource must not retain a process-publication service after that publication
retires. The source confirms the mechanism exactly.

`baseContext` is captured at construction (`:359-362`) and then merged into
**every** resource context (`:521`) and **every** publication context (`:535`).
It is never refreshed.

So if a branch host's `baseContext` included services owned by the process
host's _current_ publication, those services would remain reachable from every
later branch resource even after that publication retired — a stale-service
leak that no generation check would catch, because the leak bypasses the
generation entirely.

Rule: a branch host's `baseContext` carries only services whose lifetime is at
least the branch's own — storage, platform, config. Never a value read out of
`ResourceGraphPublication.value`.

## Teardown semantics, confirmed

- `shutdown` is `Effect.uninterruptible` and holds the reconciliation semaphore
  (`:1024-1030`, `:1022`).
- It is idempotent on two guards: `shutdownComplete` (`:978`, set `:1016`) and
  the shared semaphore, which also serialises it against `apply` (`:969`).
- In-flight staging races `shutdownRequested` and is interrupted (`:419`,
  `:618`, `:818`).

A branch scope closing mid-stage is therefore defined behavior, not a race.

### Branch close interrupts in-flight work — it does not drain it

This is the one place the host may need a real change, and it is easy to miss.

`shutdown` closes the live generation with the literal retire mode `"cancel"`
(`:981`). `closeGeneration` branches on that: `"cancel"` runs
`leases.cancel` immediately (`:484-486`); only the `else` branch drains
(`:487-493`). The `awaitDrained` effect passed as the drain argument is never
evaluated on the shutdown path.

`leases.cancel` fires the `cancelled` deferred, and `run` races admitted work
against it, so the work is **interrupted**. Every production retire path uses
`"drain"` (`live-profile.ts:763`), but shutdown never does, and shutdown is what
a scope close triggers.

Consequence: closing a branch mid-turn interrupts any work admitted through that
branch host's publication. If branch teardown must let in-flight turn work
finish, either quiesce the branch before closing its scope, or add a graceful
mode to `shutdown`. The latter is the only change `makeResourceGraphHost` itself
would need.

Decide this before implementing. The cell kernel already treats cancellation as
a first-class outcome — `cell-execution.ts` returns "Cell cancelled. Its effects
may have occurred; its source was not replayed." — so interrupt-on-close may be
acceptable. Do not assume it silently.

## A prior multi-scope design left tombstones — read them before designing

An earlier design had three runtime brand _constructors_: `brandServerScope`,
`brandCwdScope`, `brandEphemeralScope`, in a module
`packages/core/src/runtime/scope-brands.ts`. That module no longer exists, and
the constructors have zero uses in any `src/` tree.

Three fences still guard that vanished design:

- `lint/no-direct-env.ts:840` — oxlint rule `gent/brand-constructor-callers`,
  pinning each constructor to one composition root.
- `lint/no-direct-env.ts:869` — sibling rule `gent/no-scope-brand-cast`, fencing
  `as ServerProfile | CwdProfile | EphemeralProfile`.
- `packages/tooling/src/platform-duplication-guards.ts:73-76` — a tombstone
  pattern: "Legacy runtime composer scope brands are deleted; compose layers at
  the owner."

Both lint rules are enabled in `.oxlintrc.json:27,29` and exercised by
`packages/tooling/tests/fixtures.test.ts:121-130` against fixtures in
`packages/tooling/fixtures/`. They pass, but they guard symbols that no longer
exist. The tombstone covers the three _types_; it does not cover the three
_constructors_, so the lint rules are not redundant with it.

The rules are implemented and live — they are oxlint JS-plugin rules in
`lint/no-direct-env.ts`, not TypeScript modules under `packages/tooling/src`.
Searching only `packages/tooling/src` makes them look unimplemented; they are
not. The fixture at `packages/tooling/fixtures/brand-constructor-callers.invalid.ts`
imports the vanished `scope-brands.js`, but it is `@ts-nocheck`'d and exists to
be linted, not compiled, so it is doing its job.

Two consequences for this unit:

1. Today's brands are `declare const` phantom types with no runtime payload
   (`domain/resource.ts:33-35`). A new `BranchScope` must follow that shape.
   Do not resurrect runtime brand constructors — they were deliberately removed.
2. Do not name a new scope `cwd` or `ephemeral`. Those names carry tombstones
   and would trip the guards.

Leave these fences alone in this unit. Deciding whether a fence around a
non-existent symbol still earns its keep is a separate cleanup with its own
gate.

## Correction: the `live-profile.ts:550` literal is a filter, not a bug

Earlier notes framed `collectResourceEntries(..., "process")` at
`live-profile.ts:550` as a hardcoded value to replace with a widened list. That
is wrong, and widening it in place would be a real defect.

Receipts. The list flows `loadDesired` -> `desired.resources` ->
`host.apply({ resources })` at `live-profile.ts:611` and `:764`. The host turns
that argument into its lease graph: `resourceMap(input.resources)` at
`resource-graph-host.ts:665`, `nextDeclarationOrder` at `:681`,
`resourcesInDeclarationOrder` at `:683`, and `planResourceGraph(input.resources)`
at `:863`. Everything in the list is started under the **process** scope.

So a `scope: "branch"` entry added to that list would not merely be carried
along — it would be **started at process lifetime**, which is exactly the
lifetime `"branch"` exists to deny. The `"process"` argument is the correct
filter for that call site and stays.

What is actually needed is a **second** collection at branch lifetime, feeding a
**second** host instance whose parent scope is the loop's `loopScope`. The
assembly layer already supports this without modification:
`collectResourceEntries`, `buildResourceLayer`, and `buildResourceServiceLayer`
all take `scope` as a parameter (`resource-layer.ts:32`, `:53`, `:95`), each
defaulting to `"process"` only for back-compat.

The `:385` availability filter (`resource.scope === "process"`) is likewise
correct as written: it suspends an extension whose _process_ resource is
inactive. A branch resource has no bearing on process-level staging.

**Revised unit of work.** Add a branch collection + branch host over
`loopScope`; do not touch `:550` or `:385`.

## Decision: interrupt on branch close, matching Prime

Checked against the pinned Prime Agent checkout at `a3b3e75` (2026-08-11),
`~/.cache/repo/primeintellect-ai/prime-agent/packages/coding-agent`.

Prime's `KernelManager.dispose()` (`src/core/kernel/index.ts:1500-1516`) runs
in this order:

1. `flushSnapshotForDispose()` — persist kernel state, capped at 5s
   (`:1485-1489`, `SNAPSHOT_DISPOSE_TIMEOUT_MS` at `:39-40`).
2. Wait up to 5s for in-flight **host requests** to settle
   (`HOST_REQUEST_DISPOSE_TIMEOUT_MS` at `:32`).
3. `cleanupResources()` in a `finally` — `rejectActiveExecution(new
Error("Kernel has been shut down"))` at `:1295`, then SIGTERM.

So Prime drains host callbacks but **interrupts the running cell
unconditionally**. Its own code marks the gap at `:1507`:

> `// TODO: plumb AbortSignal through AgentSession.prompt so disposal can`
> `// cancel long-running child loops.`

Its cancellation UX is interrupt-first as well: Ctrl+C interrupts, waits 1s
(`KERNEL_ABORT_GRACE_MS`, `:41`), then force-settles the tool call and moves on,
leaving the cell possibly still running. The hard kill is offered to the user
rather than applied automatically (`src/core/tools/ipython.ts:566-608`).

**Decision.** Take interrupt-on-close. It matches Prime, matches gent's existing
`shutdown` (`resource-graph-host.ts:981`), and matches what the cell already
tells the user: "Cell cancelled. Its effects may have occurred; its source was
not replayed." No change to `makeResourceGraphHost`.

Gent is arguably ahead here: Prime orphans an in-flight child's provider request
silently, while gent's cancellation is explicit in the transcript.

**The one behavior to verify, not assume.** Prime flushes its snapshot before
teardown. Gent snapshots on successful cell completion instead, so a branch
closing mid-cell should still retain _previously_ snapshotted bindings via the
recovery path. That is a claim about existing behavior under a new teardown
owner — test it, do not trust it.

## Acceptance for this unit

From the parent plan, restated concretely:

1. A bare loop completes a turn with no branch resources declared.
2. An extension declares `scope: "branch"` and its service is constructed per
   branch, isolated between branches.
3. Closing a branch closes its resources; a failed branch build releases
   partials.
4. The shipped cell kernel keeps working: reset, interrupt, cancel, recovery,
   and binding retention across turns.
5. Process resources are unaffected — `btw`, `exec-tools`, and `skills` still
   start once.

## Verification plan

- Extend `packages/core/tests/runtime/agent-loop/cell-lifetime.test.ts`
  (already covers branch isolation and worker closure) rather than adding a new
  file.
- Extend `packages/core/tests/extensions/resource-lifecycle.test.ts` for the
  branch scope.
- Prove any new regression test fails when the protection is removed.
- Full gate plus live Herdr per commit.

## Source receipts

- `packages/core/src/domain/resource.ts:9-17,26-45,182`
- `packages/core/src/runtime/extensions/resource-host/resource-graph-host.ts:353,355,359,364,515-541,549,801,1004,1016,1022-1032`
- `packages/core/src/runtime/extensions/resource-host/resource-layer.ts:32-40,54,97`
- `packages/core/src/runtime/extensions/resource-host/schedule-engine.ts:12`
- `packages/core/src/runtime/profile.ts:290-296`
- `packages/core/src/runtime/live-profile.ts:796-799`
- `packages/core/src/runtime/agent/agent-loop.behavior.ts:208-243,322-331`
- `packages/core/src/runtime/agent/agent-loop.handlers.ts:160,511-540`
- `packages/core/src/runtime/code-cell/cell-execution.ts:66-82`
