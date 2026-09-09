# The resource host: what it costs, what it buys, what to do

Date: 2026-09-09. The one large collapse candidate that survived scrutiny.

## The cost

| Component                                         |       Lines |
| ------------------------------------------------- | ----------: |
| `runtime/extensions/resource-host/`               |       2,864 |
| `runtime/live-profile.ts`                         |         799 |
| `runtime/session-profile.ts`                      |         572 |
| `storage/resource-graph-storage.ts`               |         679 |
| `domain/resource-graph.ts` + `domain/resource.ts` |        ~500 |
| **≈ total**                                       | **≈ 5,400** |

Concepts it introduces: Resource, ResourceScope, ResourceGraph, generation,
lease, publication, retire mode (drain vs cancel), plan, admission,
descriptor, revision, staging, availability.

## What it buys

**Two long-lived resources.** The full non-test inventory:

| Resource                           | Needs to outlive a turn? | Why                                                                                                                             |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `@gent/exec-tools/background-bash` | **Yes**                  | Owns OS processes; `start` reconciles interrupted runs                                                                          |
| `@gent/btw/runs`                   | **Yes**                  | Owns fibers via `Effect.forkIn(effect, scope)`                                                                                  |
| `@gent/skills/service`             | **No**                   | Immutable cache of a disk read; `list` is `Effect.succeed(skills)` and there is deliberately no reload path (`skills.ts:22-23`) |

Plus, as of this session, branch-scoped resources — but those build over
`loopScope` and use only `buildResourceLayer`, not the graph host.

**Zero schedules** are registered anywhere in the repo.

**The RPC surface has no production caller.** `resourceGraph.submit`,
`.get`, and `.preview` (`rpcs.ts:148-158`) are called from
`tests/server/resource-graph-rpc.test.ts` and nowhere else. No shipped app,
extension, or TUI view uses them.

**One real consumer exists, and it bypasses the host entirely.**
`apps/tui/src/ops/local-health.ts:155-175` opens the SQLite file read-only and
queries `resource_graph_state` directly for a health readout. It needs the
_table_, not the host.

## Reading

Roughly 5,400 lines and a dozen concepts implement generational
reconciliation for two resources that only need "start at process start, stop
at process stop", with a durable state table for a health check that reads
SQL directly.

The machinery is well built — the branch-resource work this session used it
without friction. It is simply sized for a problem gent does not have. The
generational graph exists to swap resource sets safely while the process runs
(config reload, extension enable/disable). That capability is real, but it is
exercised by config-change tests, not by any user-facing flow.

## What NOT to do

**Do not delete the host in one change.** It is load-bearing for extension
activation and config reload, and `live-profile.ts` is how the whole extension
set is resolved per cwd. This is not a subtraction, it is a redesign.

**Do not treat exo's per-round rebuild as directly portable.** exo rebuilds
its tool registry every round because it has _no_ long-lived resources. Gent
has two, and one of them owns OS processes. The lesson is the ratio, not the
mechanism.

## Proposed sequence, smallest first

1. **Make `skills` branch-scoped.** It is a cache; branch lifetime is correct
   for it. Removes one process resource, exercises the new branch path, and
   is reversible. _Low risk._
2. **Retire the `resourceGraph.*` RPC surface** — three RPCs, three handlers,
   and `ResourceGraphCommandServiceApi.submit`, its only caller. Keep the
   `resource_graph_state` table, since `local-health` reads it. _Low risk,
   removes a public surface that exists only for its own tests._

   **Scoped precisely after tracing.** The command service itself is **not**
   removable: `dependencies.ts:437` calls
   `commandService.recoverAllAndAwaitReport` at startup to recover resource
   graph applications interrupted by a previous process. `recover`,
   `recoverAll`, `recoverAllAndAwait`, and `recoverAllAndAwaitReport` are all
   live. Only `submit` (`resource-graph-command.ts:115`) is unreachable
   outside tests — its sole caller is `rpc-handlers.ts:441`, itself uncalled.
   `resource-graph-entity.ts` stays too: `live-profile.ts:67` and
   `session-profile.ts:53` both import it.

   So this step is three RPCs, three handlers, four schema types, and one
   service method — worth doing for the surface it removes, not for line
   count.

   **Attempted and reverted.** Removing them typechecked everywhere except
   `tests/server/resource-graph-rpc.test.ts`, which confirmed there is no
   production caller. But reading that test before deleting it changed the
   conclusion: `resourceGraph.submit` is the **only entry point that repairs a
   failed resource graph**. The test "repairs a failed owner and reacquires its
   resource after restart" (`:262`) submits a new desired revision against a
   graph in state `failed` and waits for `applied`.

   There is no other trigger. `applyDesired` has callers at
   `session-profile.ts:441` and `dependencies.ts:317`, but both are owner
   adapters invoked _by_ the resource graph entity (`resource-graph-entity.ts:325`)
   during an apply that something else initiated. Startup recovery
   (`recoverAllAndAwaitReport`) re-drives interrupted applications; it does not
   re-submit a graph that failed validation or apply.

   So "no production caller" was true and misleading. The RPC is the operator
   escape hatch for a wedged resource graph, reachable over the transport. An
   uncalled _recovery_ surface is not the same as a dead one — the absence of
   calls is the success case.

   **Revised.** This step is withdrawn. Revisit only if step 3 removes the
   failure state that makes repair necessary.

3. **Then** measure what remains: with one process resource left
   (`background-bash`) plus `btw/runs`, ask whether generations, leases, and
   retire modes are still earning their place, or whether a plain
   process-lifetime scope with a start hook covers both.

Steps 1-2 are independently valuable and safe. Step 3 is the real question
and should not start until they land.

## Correction to an earlier note

An earlier plan recorded "remove `@gent/core-internal` (109 files)" as a
reduction step. `core-internal` is a `package.json` plus a symlink to
`core/src`, with 230 import sites. Deleting it rewrites imports and weakens
the public/internal boundary without removing code. Dropped from the plan.
