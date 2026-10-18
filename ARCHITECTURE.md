# Gent Architecture

Minimal agent harness. Effect-first. Small seams. One owner per concern.

This file is the index. Read it whole; then read the area files your change
touches. Each area file is the one home of its material: update it when the
code diverges. A guard (`findSteeringBudgetOverruns`) holds this index to
12 KB and each area file to 40 KB; past that, split the file behind a pointer.

## Core Model

`gent` is organized around six nouns:

- `Server` — process-wide services only: storage, auth stores, platform, transport wiring, connection tracking.
- `Profile` — cwd-scoped extension graph: drivers, hooks, resources, capability leaves.
- `SessionRuntime` — the single public session engine: inbox, queue, checkpoint, watch state, turn orchestration.
- `Tool` / `Request` — independent callable leaves for model tools and typed extension RPC. Requests with a `slash:` block also surface as human slash commands.
- `Resource` — long-lived scoped services and extension-owned state.
- `Hook` — `systemPrompt`, `turnProjection`, `turnAfter`, `loopOpen`, `wakeDue`, `sessionDeleted`, and `toolCall` handlers registered with `host.on` for prompt, policy, turn follow-up, branch repair after a restart, a durable wake record that came due, cleanup after a session delete, and a verdict on each tool call before it runs.

Everything else is adapter code around those nouns.

## Rules

The numbered invariants a change must keep. `docs/architecture/rules.md`
holds each in full with the files that enforce it (its receipts) and the
known gaps; read it before a change that touches a rule. A change that breaks
an invariant updates both lists in the same commit.

1. **Effect-native end to end.** No Promise in an extension surface; no `async`/`await` in tests.
2. **One actor per (workspace, session, branch).** Every session mutation crosses the agent loop entity's mailbox.
3. **Everything is an extension of the loop.** Core registers zero tools; everything arrives through the extension API.
4. **Schema-first transport contract.** Every RPC input and output is a Schema; thin adapters carry it.
5. **Event and projection commit together.** A mutation writes its row and its events in one transaction.
6. **Tool calls replay from durable bindings.** A resumed turn re-delivers a stored result; it never re-runs the tool.
7. **Approvals are one-shot and fail closed.** One durable ask, nothing saved, no answerer means no; the `toolCall` hook's strictest verdict wins.
8. **Each model step is classified once.** Persistence and the continue/stop policy match on one `StepOutcome`.
9. **Retry policy belongs to the driver.** The loop re-runs a step; the driver says what is transient and when (`retryAt`).
10. **Tool results are bounded before the model sees them.** 8,000 characters inline, the rest paged; images by reference and bounded.
11. **A model change is a durable user-role notice the loop writes.** Effort changes ride the cache-keeping markers.
12. **Tool guidance lives on the tool and follows the active tool list.**
13. **The cell runs in full Bun.** No sandbox, no interpreter.
14. **A child's completion arrives as a user message, never a tool result.**
15. **Platform edges stay explicit.** Effect platform services, `runProcess`, `writeFileAtomic`; no facet duplicates them.
16. **RPC is the application transport.** No parallel REST surface.
17. **Context leaves the window as a handoff, never as a loss.** A durable marker names what it replaced; the cost rule `coldHandoffPays` decides cold handoffs.
18. **A leaf requires only the services it is given.** `tool`, `request` and `defineResource` bound their required services by type.

## Area files

Each line names an area file under `docs/architecture/`, what it covers, and
when to read it.

- `rules.md` — the rules above in full, with receipts and known gaps; read when a change touches an invariant or you review one.
- `server.md` — package map, system shape, transport boundary, app services and storage, platform seams, shared server discovery, distribution, observability, key files; read when you change startup wiring, storage, the RPC contract, release or logs.
- `profiles.md` — the runtime profile: extension loading, profile cache and leases, shared Resource builds, last good versions, reload, prompt sections and notices; read when you change extension activation, config reads or the request prefix.
- `runtime.md` — the session runtime and agent loop: residency, durable wakes and deferred recovery, steering, follow-up admission, orphan reconciliation, retry, cancellation, `TurnCompleted`; read when you change the loop, a turn's lifecycle or its receipts.
- `context.md` — model context: compaction, project instructions, the system prompt, tool-result spill, classifier models, virtual models, the effort router; read when you change what a request carries or how a model is chosen.
- `threads.md` — threads and agent runs: rounds, `thread_rounds`, `session.send`, snapshot threads, the agents pane and tray, child depth, machines; read when you change child sessions, the thread tools or machines.
- `agents.md` — `AgentDefinition`, agent config, run specs, tool and path admission, session admission, model and effort precedence; read when you change agents or what a run may do.
- `interactions.md` — the cold interaction pattern, approvals, owned asks, the `toolCall` gate, the interaction tools; read when you change asks, approvals or their replay.
- `cell.md` — the Bun cell: tool policy, kernel, worker, namespace, catalog, host calls and their storage; read when you change the cell or how tools reach the model.
- `mcp.md` — the MCP extension: server entries, plugins, OAuth, the catalog, clients, tool names; read when you change MCP.
- `extension-host.md` — extension shape, dependency direction, the boundary contract, the API inventory, server extension buckets, hooks, Resource scopes, events, extension state, the entry rules and extension authority; read when you change the extension API or author an extension.
- `models.md` — the models.dev catalog, API classes, generic providers, drivers; read when you change model discovery or a provider driver.
- `credentials.md` — credential slots and placement: labels, logins, rotation, `authSpread`; read when you change auth.
- `shipped-extensions.md` — `/btw`, wake alarms and monitors, bash and background jobs, goals, the regex worker, fs-tools, workflow results, bundled skills; read when you change one of them.
- `checkpoints.md` — turn checkpoints: capture, store, refs, reads, revert, retention; read when you change `@gent/checkpoints` or `/revert`.
- `tui.md` — the TUI as a client over the contract: its production shape, boundaries and rules; read with `apps/tui/AGENTS.md`, which points to the TUI topic files, when you change the TUI.
- `testing.md` — test boundaries, philosophy and gotchas, the three tiers, the test layers example, commands, test structure, important files; read when you add or restructure tests.
- `history.md` — owner directions, measurements and pass evidence moved out of the live files; read only when you need why a rule was decided.

## Non-Goals

- No cluster/distribution roadmap in this document.
- No compatibility notes for deleted facades.
- No process-purity dogma. Same-process direct transport is fine.

These files describe the architecture we want to keep, not the migration
history we already paid for.
