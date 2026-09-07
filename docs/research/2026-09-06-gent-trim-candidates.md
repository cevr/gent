# Gent trim candidates

Date: 2026-09-06. Scope: source research only.

Source root: `/Users/cvr/Developer/personal/.rifts/gent/fx-ui`.
HEAD: `a826c36417d7c209d85ef325911365a608ff43e4`.
This checkout has existing edits. HEAD does not identify the full source state.
No runtime file was changed. No gate or runtime test was run for this report.
The checks used source reads, caller searches, and source line counts.

## Main finding

Remove the unused subprocess dispatch option first. Replace the Executor extension
after the Bun kernel has a working host interface. Then replace fixed workflow
tools with recipes over the same agent and tool operations.

Do not count ACP, todo, memory, or auto mode as unused features. Source code cannot
show which features the user needs. These systems have real callers or registered
product surfaces. Their size shows a maintenance cost, not permission to remove them.

The research skill set the source and receipt requirements for this report. The
Effect skill set the test for a useful module: the module must own policy or
resource work. A service name alone does not justify a separate module.

## Ranked changes

| Rank | Proposed change                                                               | Evidence                                                                           | Condition                                                                   |
| ---- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1    | Remove `SubprocessRunner` and its unused selection option                     | No production caller sets `subprocessBinaryPath` in the checked repository         | Keep normal durable and ephemeral child runs                                |
| 2    | Replace the old Executor sidecar with one Bun cell host                       | Nine source files exist to connect, start, inspect, and call the remote runtime    | Prove cell execution, cancellation, output limits, and host calls first     |
| 3    | Replace plan, review, audit, counsel, and research orchestration with recipes | These tools repeat agent dispatch, model selection, synthesis, and result handling | Keep useful prompts, review decisions, artifacts, and explicit model choice |
| 4    | Move parallel and chain composition out of the delegate tool                  | One 388-line tool owns five execution paths and a large optional result schema     | Keep one useful agent-run operation and a real background task owner        |
| 5    | Use one cell engine for the ACP code tool and native code tool                | ACP currently has a separate `new Function` implementation                         | Keep ACP transport and external driver behavior if still required           |
| 6    | Reduce optional product surfaces through profile defaults                     | Many extensions are registered by default                                          | Do not describe a disabled feature as deleted code                          |

## Source size is not net savings

Counts include blank lines and comments. They count current source files only.
They exclude tests, generated files, lock files, and dependencies unless stated.
The counts do not estimate replacement code. Do not add them to claim a net reduction.

| Area                                   | Files | Raw lines | Meaning                                                  |
| -------------------------------------- | ----: | --------: | -------------------------------------------------------- |
| Old Executor extension                 |     9 |     1,898 | Replacement target; some behaviors need a new owner      |
| Old Executor tests                     |     3 |     1,163 | Separate validation cost; preserve useful assertions     |
| Fixed workflow tools and shared helper |     9 |     1,673 | Recipes and host calls will retain part of this behavior |
| Delegate tool                          |     1 |       388 | Includes single, parallel, chain, and background paths   |
| ACP and Claude external adapters       |    14 |     3,247 | Full footprint; not a deletion estimate                  |
| Todo server source                     |     6 |     1,472 | Excludes UI; has a caller in background delegation       |
| Memory extension                       |     4 |     1,073 | Registered product feature; no usage claim               |
| Auto extension                         |     4 |     1,125 | Registered product feature; no usage claim               |
| Theme JSON files                       |     7 |     1,198 | Static data, not equivalent runtime complexity           |

`SubprocessRunner` occupies lines 253–459 of its 459-line file: 207 raw lines.
Removal also affects imports and configuration fields. This is not a measured diff.

Count receipts and exact source sets:

- Executor: all nine `.ts` files under `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/`: `actor.ts`, `controller.ts`, `domain.ts`, `index.ts`, `mcp-bridge.ts`, `platform-adapter.ts`, `protocol.ts`, `sidecar.ts`, `tools.ts`.
- Executor tests: `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/tests/executor/executor.test.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/tests/executor/executor-rpc.test.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/extensions/executor-integration.test.ts`.
- Workflows: `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/plan.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/plan-tool.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/workflow-helpers.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/audit/audit-tool.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/audit/index.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/review/review-tool.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/counsel/counsel-tool.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/research/index.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/research/research-tool.ts`.
- Delegate: `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/delegate/delegate-tool.ts`.
- ACP: all 14 `.ts` files under `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/acp-agents/`: `claude-code-executor.ts`, `claude-sdk-boundary.ts`, `claude-sdk.ts`, `config.ts`, `executor-boundary.ts`, `executor.ts`, `index.ts`, `mcp-codemode-boundary.ts`, `mcp-codemode.ts`, `protocol.ts`, `response-finish.ts`, `schema.ts`, `session-manager.ts`, `transcript.ts`.
- Todo: `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/todo-service.ts`, `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/todo-storage.ts`, and all four `.ts` files under `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/todo/`: `domain.ts`, `index.ts`, `requests.ts`, `tools.ts`.
- Memory: all four `.ts` files under `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/memory/`: `index.ts`, `projection.ts`, `tools.ts`, `vault.ts`.
- Auto: all four `.ts` files under `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/auto/`: `controller.ts`, `index.ts`, `journal.ts`, `protocol.ts`.
- Themes: all seven `.json` files under `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/theme/themes/`: `catppuccin.json`, `dracula.json`, `fx.json`, `gruvbox.json`, `nord.json`, `opencode.json`, `tokyonight.json`.

## 1. Remove the unused subprocess selection

The source search found the option declaration, its copy into runner configuration,
the branch that selects the runner, and the runner implementation. It found no
assignment from an app, SDK, test, or configuration loader. Thus this branch is
not selected by a shipped caller in the checked source. This does not prove that
an external consumer never imports the internal construction function.

The subprocess path still uses the in-process ephemeral implementation. Its durable
path launches `gent --headless --session ...`, then reads results from storage.
The normal in-process runner already owns durable execution. Remove the inactive
selection and subprocess body. Keep shared metadata, child persistence, depth
limits, and run-spec serialization that other entry points still use.

Receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.ts:54`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.ts:253`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/agent-runner.config.ts:3`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/dependencies.ts:100`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/server/dependencies.ts:366`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/execution-overrides.test.ts:4`

## 2. Replace Executor at its extension boundary

Keep the existing code-mode capability. Replace its execution machinery with the
persistent Bun kernel. Code mode and RLM are not competing agent engines here.

`ExecutorExtension` registers one process resource, two tools, three requests, and
a turn projection. The controller opens the sidecar. The projection hides
`execute` and `resume` until the connection is ready. The tools forward code or an
interaction reply through MCP. The sidecar owns runtime discovery, port scans,
process startup, settings, registry files, health checks, and shutdown.

Replace this complete adapter after the Bun host works. Do not retain its endpoint
states and port registry around a local kernel. A local cell operation needs its
own small state contract: cell identity, running or complete state, result handle,
cancellation, and explicit reset. Its persistent process must have one owner.

The current extension Resource API exposes only process scope. A session or branch
kernel therefore needs an explicit owner keyed by workspace, session, and branch.
Do not claim that a new `scope: "session"` descriptor already works. A process
resource can own that map until the runtime has a proper narrower lifetime.

Removing Executor does not remove the MCP dependency. ACP still imports its server
and transport. The search found no dedicated TUI Executor renderer or widget.
Executor requests reach the client through the generic request surface. Test and
lint-inventory references still need cleanup.

Receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/index.ts:23`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/controller.ts:32`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/actor.ts:90`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/tools.ts:72`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/sidecar.ts:140`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/executor/protocol.ts:18`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/acp-agents/mcp-codemode.ts:13`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/package.json:26`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/tooling/src/suppression-inventory.ts:380`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/tooling/tests/platform-duplication-guards.test.ts:303`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md:444`

## 3. Replace workflow machinery after common operations exist

The fixed workflows have useful behavior. Plan runs two model plans, cross reviews,
revisions, and synthesis. Review runs review and critique passes. Audit detects
concerns, runs paired checks, and synthesizes findings. Research fetches repositories,
runs readers, and synthesizes results. Counsel selects another model. Several flows
also request a decision, execute a result, or save an artifact.

Move those policies into editable recipes. Keep one agent-run host operation,
bounded parallel work, explicit model selection, tool restrictions, artifact writes,
and review operations. The existing `ctx.Agent.run` is a useful start. It already
accepts an agent, prompt, cwd, and run specification.

Do not build another generic workflow interpreter to replace these tools. Bun code
can express loops and composition. Keep system behavior such as task lifetime,
interruption, storage, and permissions in the host.

`workflow-helpers.ts` is only 46 lines. Its `requireText` helper centralizes a real
error conversion. Deleting that helper first yields little value. `runCommand`
returns empty text on command failure. Recipe conversion should preserve failure
information where it affects conclusions.

Receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/plan-tool.ts:148`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/review/review-tool.ts:261`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/audit/audit-tool.ts:241`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/research/research-tool.ts:132`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/counsel/counsel-tool.ts:86`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/workflow-helpers.ts:15`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/extension-services.ts:111`

## 4. Keep task behavior while reducing delegate branches

`delegate` has foreground single, parallel, and chain paths. It also has background
single and parallel paths. Background work creates todos, forces durable child
sessions, and writes the child session ID into todo metadata. Todo is therefore
not an independent deletion. The task list also has tools and RPC requests.

Move composition into cells. Keep a task owner that survives the foreground tool
scope. Do not replace background dispatch with an unowned Promise. Keep completion,
failure, cancellation, and child navigation visible. Then remove the duplicate
parallel and chain parameters from the model tool surface.

Receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/delegate/delegate-tool.ts:42`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/delegate/delegate-tool.ts:187`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/delegate/delegate-tool.ts:260`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/todo/index.ts:51`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/todo/requests.ts:19`

## Bun RLM integration and protected rules

The public extension context has Agent, Process, Files, Interaction, Session, State,
FileLock, and Dynamic facets. It does not expose a general tool-call facet. A cell
bridge must therefore add a deliberate host operation. It must not import private
runtime services from a shipped extension.

The internal integration point is `ToolRunner.runBound`. A turn captures an exact
tool entry. The execution path supplies the current host context and applies the
permission check. A cell callback must use an admitted, bound tool entry from that
turn. A later lookup by name can call a different implementation after reload.

Protect these rules:

1. Give every nested operation a stable identity and its own event receipt.
2. Keep workspace, session, branch, agent, and parent-cell identity in the host.
3. Apply tool policy and permission checks to nested calls.
4. Keep the active publication lease while a call uses its resource generation.
5. Save approval state and completed results before the turn parks.
6. Do not rerun earlier cell side effects when a later host call resumes.
7. Stop or explicitly detach pending work when the owning scope closes.
8. Bound cell time, output, stored values, recursion, and child concurrency.
9. Keep large results in handles. Send selected text into model context.
10. Treat Bun globals and module imports as host authority. A worker process alone is not a sandbox.

Cold replay is the main design risk. Gent currently parks a turn through
`InteractionPendingError` and later checks the saved tool binding. An arbitrary
JavaScript continuation is not a durable checkpoint. The kernel needs a stated
contract for live continuation, process loss, and replay. Do not hide this gap
behind the old `resume` tool name.

ACP has a second code implementation. Its MCP handler builds `new Function` for
each request and calls a Gent tool proxy. Share the new cell engine with that
adapter if ACP remains. Keep its external-driver protocol separate from the
native language model turn engine.

Receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/domain/extension-services.ts:237`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-runner.ts:73`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/tool-runner.ts:394`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts:44`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/src/runtime/agent/turn-tool-execution.ts:144`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/tests/runtime/agent-loop/tool-binding-replay.test.ts:185`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/acp-agents/mcp-codemode.ts:155`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/acp-agents/index.ts:253`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/ARCHITECTURE.md:124`

## Safe sequence

1. Remove the inactive subprocess runner. Run the full gate.
2. Prove the reusable Bun kernel with an injected host. Keep this step independent of UI changes.
3. Add the Gent host bridge. Test permissions, resource replacement, cancellation, cold approval, and process loss through RPC.
4. Make cells the default code path. Remove the old Executor adapter and its obsolete tests in the same unit.
5. Move workflow composition into recipes. Reduce default tools only after their useful operations remain available.

Run the full gate between units. Run focused RPC acceptance tests for lifecycle
changes. Run terminal and server-process checks before the final handoff. A large
change should use three to five reviewable commits, as the workspace rules require.

## Limits and open decisions

- This report does not inspect private usage data, installed profile choices, or saved tasks.
- The 3,247 ACP lines include protocol and authentication behavior. They cannot all become cell code.
- The 1,673 workflow lines include prompts and schemas. Their removal does not imply equal net savings.
- A process-scoped Resource does not provide a branch-scoped kernel by itself.
- Persistent cells need explicit fork, reset, crash, and idle cleanup behavior.
- The TUI currently imports both MessageList and NativeTranscript. This report does not establish that either is unused. Both files have pending user edits.
- The prior-art report remains the source for FX, Pi, OpenCode, DeepSeek Harness, and Exo comparisons. This pass verifies Gent deletion boundaries only. It does not revalidate those external snapshots.

Additional receipts:

- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/extensions/src/index.ts:127`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/routes/session.tsx:10`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/src/theme/default-themes.ts:2`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/docs/research/2026-09-06-malleability-and-harness-prior-art.md:1`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/AGENTS.md:1`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/packages/core/AGENTS.md:1`
- `/Users/cvr/Developer/personal/.rifts/gent/fx-ui/apps/tui/AGENTS.md:1`
- `/Users/cvr/Developer/personal/dotfiles/principles/never-block-on-the-human.md:1`
- `/Users/cvr/Developer/personal/dotfiles/principles/redesign-from-first-principles.md:1`
- `/Users/cvr/Developer/personal/dotfiles/skills/research/SKILL.md:1`
- `/Users/cvr/Developer/personal/dotfiles/skills/effect/SKILL.md:1`
- `/Users/cvr/Developer/personal/dotfiles/skills/effect/references/PROGRAM_DESIGN.md:1`
- `/Users/cvr/Developer/personal/dotfiles/skills/effect/references/SERVICES_LAYERS.md:1`
