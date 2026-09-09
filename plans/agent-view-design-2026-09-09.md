# Agent view — design

Date: 2026-09-09. Goal: a screen that lists agents (running, idle, past),
like Claude Code's and Prime Agent's.

**Constraint, from the user: it ships as an extension.** Per the three rules —
effect-native, actor-model, everything is an extension of the loop — the agent
view is not core code and not app code. It is an extension that contributes a
client overlay plus the server capability that feeds it.

## What Prime does (surveyed, receipts)

Prime's `packages/coding-agent/src/modes/agents-view/` is 4,046 lines across
three files. Worth taking, and worth not taking:

**Take:**

- The **pure state layer**. `agents-view-state.ts` (991 lines) imports only
  `node:path` — no terminal, no I/O. Reconciliation, identity algebra, row-tree
  building, scope frames, and search are all pure functions over plain data,
  tested with no mocks (`test/agents-view-state.test.ts`, ~68 cases).
- **Three sections**: Running / Idle / Inactive, with nested rows rendering
  inside their top-level agent's section regardless of their own status
  (`agents-view-mode.ts:2770-2784`).
- **Subagent disclosure**: a synthetic summary row (`"2 subagents running"`)
  that expands to children, grouped by the spawn cell that launched them
  (`agents-view-state.ts:697-701`, `:803-817`).
- **Heartbeat propagation up the tree**: a busy descendant forces every
  ancestor into Running, cycle-guarded (`agents-view-state.ts:729-746`).
- **Orphan re-rooting**: a child whose parent has not loaded yet is promoted to
  top level rather than hidden (`agents-view-state.ts:672-679`).

**Do not take:**

- `agents-view-mode.ts` is a single 2,124-line class with ~50 mutable fields
  mixing TUI, daemon client, timers, and every render method. Its tests reach
  through encapsulation with `Reflect.get(AgentsViewMode.prototype, method)`
  (`test/agents-view-mode.test.ts:78-82`) because the logic cannot be
  constructed without a terminal. That is the anti-pattern, not the pattern.
- Four implicit modes (search / reply / rename / delete-confirm) encoded as
  independent nullable fields plus two timers, disambiguated by an 11-branch
  if-chain. A discriminated union removes most of that volume.
- Manual ANSI cell padding and a sentinel-marker hack to re-open the selection
  background after embedded resets (`agents-view-mode.ts:112-115`, `:2580-2604`).

Prime polls three catalogs (live 1s, heartbeats 15s, saved-on-disk streamed)
over a daemon socket and merges them client-side, with generation counters to
drop stale responses. Gent does not need the disk catalog — its sessions are in
SQLite behind the same server.

## What gent already has (surveyed, receipts)

Far more than expected. The row data almost entirely exists:

| Need                                                 | Where                                                                  | Status                                   |
| ---------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- |
| Live loop enumeration                                | `AgentLoopActor.State.listEntityIds`, used at `session-runtime.ts:165` | Exists, **not on the service interface** |
| Entity id ⇄ `(workspace, session, branch)`           | `agent-loop.entity-id.ts:28-33`                                        | Exists, reversible                       |
| Status / agent name / queue                          | `SessionRuntimeStateSchema`, `agent-loop.state.ts:361-374`             | Exists                                   |
| Model, cost, tokens, turns, duration                 | `SessionRuntimeMetrics`, `agent-loop.state.ts:390-409`                 | Exists                                   |
| Context pressure                                     | `ModelContextMetrics`, `agent-loop.state.ts:378-388`                   | Exists                                   |
| cwd, name, parent links                              | `Session`, `domain/message.ts:147-158`                                 | Exists                                   |
| Durable child registry (workspace-wide)              | `session-operation-storage.ts:332-368`                                 | Exists                                   |
| Live per-loop stream                                 | `session.watchRuntime`, `rpcs/session.ts:77-82`                        | Exists, **one stream per loop**          |
| Overlay chrome, scrolling, fuzzy filter, tree guides | `components/session-tree.tsx`                                          | ~90% reusable                            |
| Client extension overlays + commands + keybindings   | `extensions/client-facets.ts`, `btw.client.tsx`                        | Exists                                   |

Delegation is **live**, not removed: `delegate`, `agent-child`, and
`agent-children` tools (`packages/extensions/src/delegate/`), depth cap 3
(`domain/agent.ts:208-210`). The earlier memory note that delegation was
"collapsed" meant `agent-start` was merged into `delegate` on 2026-09-07 — the
capability kept working.

## Gaps

1. **No enumeration on `SessionRuntimeService`.** `listEntityIds` is used
   inside `session-runtime.ts` but is not exposed (`:221-255`). This is the one
   core seam that must open.
2. **No fan-out status stream.** `watchRuntime` is per-`(session, branch)`. N
   rows means N subscriptions, or one new stream.
3. **No server-side elapsed per loop.** Only client-side
   (`session-controller-state.ts:17`).
4. **Resolved: `listEntityIds` is live-only, and under-reports by design.**
   Traced through `effect-encore`: `listEntityIds` -> `listStateEntityIds`
   (`dist/actor.js:263`) -> `ActorStateRegistry.list` (`dist/actor-state.js:61`).
   That registry is an in-memory `Ref<Map>` (`dist/actor-state.js:14`), and
   `registerState` installs `Effect.addFinalizer(() => registry.deregister(...))`
   (`dist/actor-state.js:53`). An entity deregisters when its scope closes.

   So the enumeration returns **only currently-materialized actors**. An idle,
   evicted, or never-started branch is absent — and it is empty after a restart.
   It answers "which loops are running now", never "which agents exist".

   **Consequence for the design.** Rows cannot come from the actor registry
   alone. Like Prime, gent needs two catalogs merged:
   - **live** — `listEntityIds`, giving Running/Idle and live metrics;
   - **durable** — `SessionStorage.listSessions` plus
     `SessionOperationStorage.listAgentStarts` (`session-operation-storage.ts:332-368`,
     workspace-wide with `Option.none()`), giving Inactive rows and surviving
     restarts.

   A live row and a durable row for the same `(sessionId, branchId)` are the
   same agent and must reconcile to one row, with live data winning. This is
   exactly Prime's `reconcileUnifiedSessions` shape
   (`agents-view-state.ts:180-229`) and the reason that function exists.

## Shape

An extension, `@gent/agents-view`, with two halves:

- **Server half** — a `request` capability returning agent rows, joining
  `listActiveLoops` against `SessionStorage.listSessions` and per-loop
  state/metrics. Plus a `resource` holding the projection.
- **Client half** — a `defineClientExtension` contributing an
  `overlayContribution` and a `clientCommandContribution` (`/agents`), reusing
  `ChromePanel` and the `session-tree` chrome, with `useScopedKeyboard`.

The row unit is **`(sessionId, branchId)`**, not session: one session with
three branches has three loops. This matches `watchRuntime`'s key.

The pure part — reconciliation, row-tree building, section grouping, search —
goes in its own module with no TUI imports, following Prime's state layer and
testable without a terminal. That is the part of Prime worth copying exactly.

## Order

1. Open the enumeration seam: `listActiveLoops` on `SessionRuntimeService`,
   named for what it returns — _active_ loops, not all agents.
2. Pure projection module + tests (no TUI).
3. Extension server half: the row capability.
4. Extension client half: overlay, command, keybinding.
5. Subagent nesting + disclosure, reusing the live `delegate` parent links.

Steps 1-2 carry the risk; 3-5 are assembly over surfaces that already exist.

The reconciliation in step 2 is now the load-bearing piece, not step 1: the
live enumeration is a few lines, while merging two catalogs into stable row
identity is where the correctness lives.

## Step 3 outcome (landed `12db9e70`)

Server half shipped: `@gent/agents-view` contributes one `request` capability,
`list-agents`, returning reconciled rows. Registered in `BuiltinExtensions`.

Two deviations from the shape above, both forced by what the code allows:

- **No `resource` holding the projection.** The capability is a pure read over
  two catalogs; a resource would add a lifecycle with no state to own. Dropped
  rather than built empty.
- **No per-loop state/metrics in the row.** The shape called for joining
  per-loop state, but enumerating N loops must not fan out into N state reads
  on every keystroke. Rows carry identity and liveness; step 4's client
  subscribes per row for detail. `LiveAgentRow` already has the
  `Option`-shaped fields, so nothing has to change to fill them in later.

The enumeration seam is narrower than expected. `listActiveLoops` cannot be
supplied from the loop behavior — the behavior is built by the AgentLoop actor,
so requiring that actor's state client is a cycle — and `effect-encore` does
not export its `ActorStateRegistry` from the package barrel. It resolves via
the ambient `Effect.serviceOption` override path instead, which adds no
requirement. Receipts in the commit message.

Gate green. RPC acceptance test verified by disabling the wiring: all three
cases fail without it.
