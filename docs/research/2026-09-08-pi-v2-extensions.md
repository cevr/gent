# pi-mono "harness v2" extension system — map and comparison with gent

Date: 2026-09-08. Read-only research. No recommendations in this file.

## 0. Source

- Repository: `https://github.com/badlogic/pi-mono`
- Branch selected: `harness-v2/j4`. `git ls-remote --heads` shows no `v2`, `next`, or `v2-*` branch. `harness-v2/j4` is the only branch with a v2 name. `bigrefactor` and `earendil` exist. They do not carry a v2 name.
- Commit: `f7f933c6e0a127bd2b56336338512092fec0399d` (2026-08-07, "docs(agent): clarify remaining v3 normalization").
- Clone: `priors/pi` (shallow, depth 1). All pi paths below are relative to that clone.
- Package name on this branch: `@earendil-works/pi-coding-agent` 0.84.1 (`packages/coding-agent/package.json:2-3`).

Scope note. The "v2" work on this branch lives in `packages/agent` (the durable `AgentHarness`, design in `packages/agent/docs/harness-v2.md`). The coding-agent extension system in `packages/coding-agent/src/core/extensions/` is the shipped v1 surface. The design doc says coding-agent migration to `AgentHarness` is out of scope (`packages/agent/docs/harness-v2.md:41`). The v2 `hooks.on` and `events.on` registries throw `HarnessNotImplemented` on this commit (`packages/agent/src/harness/agent-harness.ts:219-235, 326-327`). This report maps both: the shipped v1 surface (section 1) and the v2 hook catalog as designed (section 2).

## 1. Shipped extension system (`packages/coding-agent`)

### 1.1 Declaration

- An extension is a TypeScript or JavaScript module. Its default export is a factory `(pi: ExtensionAPI) => void | Promise<void>` (`packages/coding-agent/src/core/extensions/types.ts:1518`).
- Inline extensions are a factory or `{ name, factory, hidden? }` (`types.ts:1520-1531`). The SDK passes them as `extensionFactories` and loads them as `<inline:name>` (`packages/coding-agent/src/core/resource-loader.ts:945-968`).
- There is no manifest object. Identity is the file path. `Extension.path`, `resolvedPath`, and `sourceInfo` are derived from the path (`packages/coding-agent/src/core/extensions/loader.ts:469-488`).
- The `Extension` record holds mutable maps: `handlers`, `tools`, `messageRenderers`, `entryRenderers`, `commands`, `flags`, `shortcuts`, and one optional `markdownTransformer` (`types.ts:1695-1708`).

### 1.2 Discovery and loading

- Locations, in order: `cwd/.pi/extensions/`, `~/.pi/agent/extensions/`, then configured paths (`loader.ts:689-735`; docs at `packages/coding-agent/docs/extensions.md:109-136`).
- Directory rules: direct `*.ts`/`*.js` files; one-level subdirectory with `index.ts`/`index.js`; or subdirectory with `package.json` `pi.extensions` (`loader.ts:597-687`; manifest reader `packages/coding-agent/src/core/pi-manifest.ts:3-16`). Packages from npm or git resolve through `packageManager.resolve()` (`resource-loader.ts:550-556`).
- Loader uses `jiti` with `moduleCache: false`. It injects `VIRTUAL_MODULES` (pi-ai, pi-agent-core, pi-tui, pi-coding-agent, typebox) so an extension imports the host copies (`loader.ts:50-74, 436-461`).
- The factory runs at load time. Registration calls write into the `Extension` maps. Action calls go through a shared `ExtensionRuntime` whose methods throw until `bindCore()` replaces them (`loader.ts:174-247, 249-407`).
- A per-cwd module cache exists and is cleared on cwd change (`loader.ts:146-172`).
- Project-local extensions load only after project trust. A `project_trust` event runs before project resources load (`types.ts:519-541`; `resource-loader.ts:575-620`).
- Load errors are collected per path. One bad file does not stop siblings (`loader.ts:539-577`).
- Reload: `ctx.reload()` rebuilds the runner. Old `pi` and `ctx` objects are invalidated. Calls on a stale object throw a fixed message (`loader.ts:197-215`; `docs/extensions.md:1276`).

### 1.3 Runner and how the agent loop invokes extensions

- `ExtensionRunner` owns the extension list, the shared runtime, UI context, mode, and bound host callbacks (`packages/coding-agent/src/core/extensions/runner.ts:268-312`).
- `bindCore()` copies host actions into the shared runtime and flushes provider registrations queued during load (`runner.ts:314-412`). `bindCommandContext()` adds session control (`runner.ts:414-431`).
- `AgentSession` builds one runner per load and rebinds it (`packages/coding-agent/src/core/agent-session.ts:2587-2598, 2314-2322, 2339-2365`).
- Generic emit: sequential over extensions, sequential over handlers. Errors are caught and reported through `emitError`. Only `session_before_*` events can return `cancel` (`runner.ts:792-833`).
- Pipeline emits with reduction: `emitMessageEnd` (replace message, same role) (`runner.ts:835-875`); `emitToolResult` (patch content/details/isError/usage) (`runner.ts:877-930`); `emitToolCall` (first `block` wins; a throwing handler is NOT caught here, so it fails closed) (`runner.ts:932-953`); `emitContext` (`runner.ts:984`); `emitBeforeProviderRequest` (`runner.ts:1016`); `emitBeforeProviderHeaders` (`runner.ts:1050`); `emitBeforeAgentStart` (append messages, replace system prompt) (`runner.ts:1081-1145`); `emitInput` (`handled` short-circuits, `transform` chains) (`runner.ts:1196-1235`).
- Attachment points in the loop:
  - agent-core `Agent` exposes `transformContext`, `onPayload`, `beforeToolCall`, `afterToolCall` (`packages/agent/src/agent.ts:101-107, 180-190`; `packages/agent/src/types.ts:200, 244-292`).
  - `AgentSession._installAgentToolHooks` sets `beforeToolCall` to `emitToolCall` and `afterToolCall` to `emitToolResult` (`agent-session.ts:470-520`).
  - `sdk.ts` wires `transformHeaders`, `onPayload`, `onResponse`, and `transformContext` to the runner (`packages/coding-agent/src/core/sdk.ts:311-354`).
  - Agent events are forwarded as `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_*`, `tool_execution_*` (`agent-session.ts:726-810`).
  - `input` runs before skill and template expansion (`agent-session.ts:1142-1150`). `before_agent_start` runs after (`agent-session.ts:1233`).
  - Session events (`session_start`, `session_before_compact`, `session_before_tree`, `session_shutdown`, `resources_discover`) are emitted from the session code (`agent-session.ts:1818-1819, 2083-2084, 2258-2267, 2961-2962, 3081`).
- The full event list is in `ExtensionAPI.on` overloads (`types.ts:1203-1244`). Lifecycle diagram: `docs/extensions.md:275-347`.

### 1.4 Event catalog (v1)

Startup and resources: `project_trust`, `resources_discover` (`types.ts:519-557`).
Session: `session_start`, `session_info_changed`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_shutdown`, `session_before_tree`, `session_tree` (`types.ts:562-668`).
Request pipeline: `context`, `before_provider_request`, `before_provider_headers`, `after_provider_response` (`types.ts:670-697`).
Agent and turn: `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end` (`types.ts:699-760`).
Tools: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_call` (typed per builtin tool), `tool_result` (typed per builtin tool) (`types.ts:762-975`).
Model: `model_select`, `thinking_level_select` (`types.ts:794-808`).
User: `user_bash`, `input` (`types.ts:813-850`).

Result shapes: `types.ts:1065-1136`.

### 1.5 Tool contribution

- `pi.registerTool(ToolDefinition)` (`types.ts:1251-1253`). Definition fields: `name`, `label`, `description`, `promptSnippet`, `promptGuidelines`, `parameters` (TypeBox), `constrainedSampling`, `renderShell`, `prepareArguments`, `executionMode`, `execute(toolCallId, params, signal, onUpdate, ctx)`, `renderCall`, `renderResult` (`types.ts:449-500`).
- Extension tools override builtin tools by name. The registry starts from builtins, then sets extension tools by name (`agent-session.ts:2471-2522`; docs `docs/extensions.md:2047-2060`).
- Tool execution wrapper passes `runner.createContext()` as the `ctx` argument (`packages/coding-agent/src/core/extensions/wrapper.ts:17-37`; `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts:5-18`).
- Active tool set is mutable at runtime: `getActiveTools`, `getAllTools`, `setActiveTools` (`types.ts:1336-1342`). The wrapper reports tools added during execution as `addedToolNames` (`wrapper.ts:22-35`).

### 1.6 Commands, shortcuts, flags, and TUI contributions

- `registerCommand(name, { description, getArgumentCompletions, handler(args, ctx) })` (`types.ts:1175-1181, 1260`). Command dispatch happens in `AgentSession` before the `input` event (`agent-session.ts:1280-1300`). Conflicts with builtin commands produce a diagnostic and an alternative invocation name (`packages/coding-agent/src/modes/interactive/interactive-mode.ts:623-637`; `runner.ts:603-658`).
- `registerShortcut(KeyId, { description, handler(ctx) })` (`types.ts:1263-1270`). Applied by interactive mode (`interactive-mode.ts:1981-1995`).
- `registerFlag(name, { type, default })` and `getFlag(name)` (`types.ts:1272-1282`). Values are set from CLI into the shared runtime (`agent-session.ts:2580-2585`).
- TUI surface on `ctx.ui`: `select`, `confirm`, `input`, `notify`, `onTerminalInput`, `setStatus`, `setWorkingMessage`, `setWidget`, `setFooter`, `setHeader`, `setTitle`, `pasteToEditor`, `setEditorText`, `editor`, `addAutocompleteProvider`, `custom` overlays, `setEditorComponent`, themes, `setToolsExpanded` (`types.ts:131-283`). Implementations live in `interactive-mode.ts:2361-2374, 2667-2712`.
- Rendering hooks: `registerMessageRenderer(customType)`, `registerEntryRenderer(customType)`, `registerMarkdownTransformer` (`types.ts:1288-1296`).
- Non-TUI modes get a no-op UI context. `ctx.hasUI` and `ctx.mode` tell the extension (`types.ts:305-313`; `runner.ts:433-444`).

### 1.7 State and persistence

- No extension state store. State lives in closures in the factory.
- Two persistence paths in the session file:
  - `pi.appendEntry(customType, data)` writes a `CustomEntry` that does not enter LLM context (`types.ts:1317`; `packages/coding-agent/src/core/session-manager.ts:104-108, 1122-1133`).
  - `pi.sendMessage({ customType, content, display, details })` writes a `CustomMessageEntry` that does enter LLM context (`types.ts:1302-1306`; `session-manager.ts:136-142, 1160-1190`).
- Reconstruction on `session_start`: the extension scans `ctx.sessionManager.getBranch()` for its `customType` or for its tool results and rebuilds memory state (`docs/extensions.md:1846-1878`).
- Tool results carry `details` for the same purpose (`docs/extensions.md:1848`).
- Extension-to-extension messaging: a process-wide `EventBus` on `pi.events` backed by `node:events` (`packages/coding-agent/src/core/event-bus.ts:1-33`; `types.ts:1435`). Subscriptions are tracked and dropped on invalidate (`loader.ts:216-231, 397-406`).

### 1.8 Provider contribution

- `pi.registerProvider(name, ProviderConfig)` or `registerProvider(Provider)`; `unregisterProvider(name)` (`types.ts:1416-1432`). Config includes `baseUrl`, `apiKey`, `api`, `streamSimple`, `headers`, `models[]`, `oauth` (`types.ts:1443-1488`).
- Registrations made during load are queued and flushed in `bindCore` (`loader.ts:232-246`; `runner.ts:360-412`).

### 1.9 Host context (`ExtensionContext`)

- Fields: `ui`, `mode`, `hasUI`, `cwd`, `sessionManager` (read-only), `modelRegistry`, `model`, `scopedModels`, `thinkingLevel`, `isIdle()`, `isProjectTrusted()`, `signal`, `abort()`, `hasPendingMessages()`, `shutdown()`, `getContextUsage()`, `compact()`, `getSystemPrompt()` (`types.ts:307-347`).
- `ExtensionCommandContext` adds `getSystemPromptOptions`, `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload` (`types.ts:353-387`).
- The context is built fresh per emit (`runner.ts:673-751`).

## 2. v2 hook design (`packages/agent/docs/harness-v2.md`)

This is design on this commit. `hooks.on` throws (`packages/agent/src/harness/agent-harness.ts:326`).

- Model: "Events observe execution and cannot change it. Hooks intercept execution and can change it." (`harness-v2.md:28`).
- Hook names: `before_run`, `before_resume`, `before_run_end`, `transform_context`, `before_request`, `before_payload`, `after_response`, `before_tool`, `after_tool`, `before_compaction`, `before_navigation` (`agent-harness.ts:198-209`; catalog `harness-v2.md:1294-1395`).
- Semantics: sequential, chained transforms; a throwing handler is skipped except `before_tool`, which fails closed (`harness-v2.md:1284-1292`).
- Durability: hook outputs that feed state are persisted in records before execution proceeds (`before_run` → `operation_started`, `before_tool` args → `tool_started`, `after_tool` → tool-result entry) (`harness-v2.md:1291`). A replay table says which hooks re-run on retry and resume (`harness-v2.md:1396-1409`).
- Stable registration ids for `before_run` and `before_resume`; `resumeData` is stored per id so the extension can rebuild process-local state on resume (`harness-v2.md:1287, 1300-1317`).
- Lanes: named positions in the session tree that run in parallel. Extensions get the full lane API. A subagent tool runs on a second lane of the parent session (`harness-v2.md:26`).
- Events are one flat stream, passive, not replayed, post-hook values only (`harness-v2.md:1170-1182`).
- Extension state pattern stays entry-based: `findEntryOnBranch({ type: "custom", customType })` (`harness-v2.md:1511`).

## 3. gent extension surface (for comparison)

Files read:

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/goal/index.ts`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:760-1000`
- Supporting: `packages/core/src/domain/contribution.ts`, `packages/core/src/domain/capability/{tool,request}.ts`, `packages/core/src/domain/extension-services.ts`, `packages/core/src/domain/resource.ts`, `packages/core/src/domain/scheduled-job.ts`, `packages/core/src/domain/dynamic-extension-registry.ts`, `packages/core/src/runtime/extensions/{loader,extension-hooks}.ts`, `packages/core/src/runtime/agent/{turn-resolve,tool-runner,agent-loop.turn-execution}.ts`, `apps/tui/src/extensions/client-facets.ts`.

Shape:

- Declaration: `defineExtension({ id, resources?, scheduledJobs?, tools?, requests?, agents?, hooks?, modelDrivers?, externalDrivers? })`. Each bucket is an array, a sync factory, or an Effect factory (`api.ts:212-244, 335-384`). Result is `GentExtension { manifest, setup: Effect<ExtensionContributions, ExtensionLoadError, R | ExtensionSetupContext> }` (`extension.ts:361-382`).
- Hooks: five kinds — `systemPrompt`, `turnProjection`, `turnAfter`, `toolCall`, `toolResult` (`extension.ts:194-247`). Compiled once per registry into `resolveSystemPrompt`, `resolveTurnProjection`, `transformToolResult`, `preflightToolCall`, `emitTurnAfter` (`runtime/extensions/extension-hooks.ts:24-42, 239+`). Call sites: `turn-resolve.ts:261, 331`; `tool-runner.ts:197, 398`; `agent-loop.turn-execution.ts:650`.
- Tools: `tool({ id, description, params, output, execute, promptSnippet?, promptGuidelines?, readonly?, destructive?, interactive?, permissionRules?, prompt? })` (`capability/tool.ts:135-187`). `execute` receives params only. Host authority comes from `yield* ExtensionContext` (`extension-services.ts:248-267`).
- Requests: `request({ id, input, output, execute, slash?, prompt?, description? })`. Slash commands are requests with a `slash` block (`capability/request.ts:63-96`; `registry.ts:45-58, 148-158, 321-365`).
- Registry: scope-sorted (`builtin < user < project`), last writer wins per id; winners feed model tools, RPC, prompt sections, permission rules, and slash commands (`registry.ts:106-146, 368-449`). Tool policy per turn: agent allow/deny, extension projections, re-apply deny, drop interactive tools when non-interactive (`registry.ts:515-540`).
- Resources: `defineResource({ id, revision?, requires?, required?, scope: "process", layer, start?, stop? })` and `defineStateResource` (`resource.ts:68-193`). Scheduled jobs: `{ id, cron, target: { agent, prompt, cwd? } }` (`scheduled-job.ts:10-18`).
- Host facade: `ExtensionContext` with `Session`, `Agent`, `Interaction`, `Process`, `Files`, `FileLock`, `State`, `Dynamic` (`extension-services.ts:248-267`). `Dynamic.registerTool` / `registerRequest` allow session-scoped runtime registration (`dynamic-extension-registry.ts:6-56`).
- Loading: user dir `~/.gent/extensions`, project dir `.gent/extensions`, project trust gate, per-file isolation, `setup` sealed through `sealRuntimeLoadedEffect` (`runtime/extensions/loader.ts:212-290`). Client files are `*.client.{tsx,ts,js,mjs}` and load in the TUI (`loader.ts:54-55`; `apps/tui/src/extensions/discovery.ts`).
- TUI contributions are a separate bucket carrier: `renderers`, `widgets`, `commands`, `overlays`, `interactionRenderers`, `composerSurface`, `borderLabels`, `autocomplete` (`apps/tui/src/extensions/client-facets.ts:203-212`).
- Example: the goal extension contributes two requests, one tool, and one `turnAfter` hook (`packages/extensions/src/goal/index.ts:330-335`). It queues follow-ups via `ctx.Session.queueFollowUp` (`goal/index.ts:63-72`) and stores state in a `modifyGoal` store plus `ctx.State.changed` (`goal/index.ts:110, 130, 146`).

Doc drift observed: `ARCHITECTURE.md:869` and `:882` name the bucket `reactions` with `turnBefore` and `messageOutput`. Code names the bucket `hooks` with five kinds and has no `turnBefore` or `messageOutput` (`api.ts:241`; `extension.ts:198-218`).

## 4. Comparison

### 4.1 Concepts pi has that gent lacks

| pi concept                                                                                                                                                                 | pi citation                                     | gent status                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `input` event: intercept, transform, or handle user text before expansion                                                                                                  | `types.ts:831-850`; `agent-session.ts:1142`     | No hook before prompt submission.                                                                                                        |
| `before_agent_start`: inject messages and replace system prompt per run                                                                                                    | `types.ts:699-709, 1102-1106`                   | `systemPrompt` hook rewrites the prompt. No message injection at run start.                                                              |
| `context` / `transform_context`: per-request rewrite of the message array sent to the provider                                                                             | `types.ts:670-673`; `sdk.ts:351-354`            | No hook on the outgoing context.                                                                                                         |
| `before_provider_request`, `before_provider_headers`, `after_provider_response`                                                                                            | `types.ts:676-697`; `sdk.ts:311-347`            | No wire-level hooks.                                                                                                                     |
| `message_end` replacement of the assistant message before commit                                                                                                           | `runner.ts:835-875`                             | No assistant-message rewrite hook.                                                                                                       |
| `tool_execution_start/update/end` observation, plus `turn_start/turn_end`, `agent_start/agent_end/agent_settled`                                                           | `types.ts:712-788`                              | Only `turnAfter`. No streaming or per-tool observation hooks for extensions.                                                             |
| Session lifecycle events with cancel: `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_before_tree`, `session_shutdown`, `session_start` | `types.ts:562-668`                              | No session lifecycle hooks. No compaction or tree hooks.                                                                                 |
| `resources_discover`: extension adds skill, prompt, and theme paths                                                                                                        | `types.ts:544-557`                              | No equivalent.                                                                                                                           |
| `model_select`, `thinking_level_select` events; `setModel`, `setThinkingLevel` actions                                                                                     | `types.ts:794-808, 1352-1358`                   | No model-change hook or action on the extension surface.                                                                                 |
| `user_bash` interception of the `!` shell prompt                                                                                                                           | `types.ts:813-826`                              | No equivalent.                                                                                                                           |
| CLI flags per extension (`registerFlag`, `getFlag`)                                                                                                                        | `types.ts:1272-1282`                            | No equivalent.                                                                                                                           |
| Keyboard shortcuts on the server-side API (`registerShortcut`)                                                                                                             | `types.ts:1263-1270`                            | Keybinds are display hints on `slash` or client `commands` (`request.ts:84`; `client-facets.ts:132`).                                    |
| Tool rendering on the tool definition (`renderCall`, `renderResult`)                                                                                                       | `types.ts:489-500`                              | Renderers are a separate client bucket (`client-facets.ts:97-101`).                                                                      |
| Custom message renderers and markdown transformer                                                                                                                          | `types.ts:1288-1296`                            | No markdown transformer. Interaction renderers exist (`client-facets.ts:152-156`).                                                       |
| Provider registration by config object with OAuth (`registerProvider(name, config)`)                                                                                       | `types.ts:1416-1488`                            | Model drivers are a typed bucket with layer + auth (`api.ts:242`). No config-only provider path.                                         |
| Rich `ctx.ui` in the server-side handler: dialogs, widgets, footer, header, editor, overlays, autocomplete, themes                                                         | `types.ts:131-283`                              | Server-side `Interaction` has `approve`, `present`, `confirm`, `review` (`extension-services.ts:132-152`). UI shape is client-side only. |
| Session control from a command: `newSession`, `fork`, `navigateTree`, `switchSession`, `reload`, `waitForIdle`                                                             | `types.ts:353-387`                              | `Session` facade exposes list, get, rename, search, queueFollowUp, listBranches (`extension-services.ts:72-110`). No fork or switch.     |
| Persistence via session entries: `appendEntry` (non-context) and `sendMessage` (context) with `customType`                                                                 | `session-manager.ts:104-142`                    | Follow-ups carry `metadata.customType` (`goal/index.ts:66-71`). No non-context custom entry primitive.                                   |
| Process-wide `EventBus` for extension-to-extension events                                                                                                                  | `event-bus.ts:1-33`                             | Extensions call each other with typed `request` RPC (`api.ts:177-183`). No pub-sub.                                                      |
| Inline factory extensions from the SDK host                                                                                                                                | `types.ts:1518-1531`                            | Builtins pass through `DependenciesConfig.extensions` (`ARCHITECTURE.md:779`). Same effect, different shape.                             |
| Package manifest `pi.extensions` with npm/git package sources                                                                                                              | `pi-manifest.ts:3-16`; `resource-loader.ts:550` | Directory scan only (`loader.ts:212-220`).                                                                                               |
| v2 (designed): durable hook outputs, replay table, stable hook ids with `resumeData`, `before_resume`, `before_run_end` follow-up, lanes                                   | `harness-v2.md:1284-1409`                       | No durable hook records. `turnAfter` follow-up is similar to `before_run_end` but not crash-safe.                                        |

### 4.2 Concepts gent has that pi lacks

| gent concept                                                                                                                                                               | gent citation                                        | pi status                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Declarative typed buckets with a manifest id                                                                                                                               | `api.ts:223-244`                                     | Imperative registration into maps keyed by file path (`loader.ts:469-488`).                |
| Scope precedence `builtin < user < project` with id shadowing across all buckets                                                                                           | `extension.ts:79-80`; `registry.ts:106-146, 271-278` | Load order only; extension tools override builtins by name (`agent-session.ts:2471-2522`). |
| Compiled immutable registry snapshot (`ResolvedExtensions`)                                                                                                                | `registry.ts:62-75, 368-449`                         | Runner reads live maps on each emit (`runner.ts:792-833`).                                 |
| Requests as typed RPC with input/output schemas and a slash presentation block                                                                                             | `capability/request.ts:39-96`                        | Commands take a raw `args: string` (`types.ts:1175-1181`). No extension RPC.               |
| Extension effect membrane that seals failures and defects into typed errors                                                                                                | `registry.ts:216-242`; `extension-hooks.ts:104-121`  | Try/catch with `emitError` (`runner.ts:808-830`).                                          |
| Resources with lifecycle (`start`, `stop`, `requires`, `required`, `revision`) and process scope                                                                           | `resource.ts:68-141`                                 | No lifecycle primitive. Docs say to use `session_shutdown` (`docs/extensions.md:220`).     |
| State resources (`defineStateResource`)                                                                                                                                    | `resource.ts:171-193`                                | Closure state plus entry scan (`docs/extensions.md:1846-1878`).                            |
| Scheduled jobs (cron target = agent + prompt)                                                                                                                              | `scheduled-job.ts:10-18`                             | No equivalent.                                                                             |
| Agents as a contribution (`agents` bucket) with allow/deny tool lists                                                                                                      | `api.ts:240`; `registry.ts:573-606`                  | Not an extension concept.                                                                  |
| External drivers (non-LLM turn executors)                                                                                                                                  | `api.ts:243`; `extension.ts:283-284`                 | Not an extension concept.                                                                  |
| Turn projection: tool policy fragments (`include`, `exclude`, `overrideSet`) and prompt sections per turn                                                                  | `extension.ts:267-281`; `registry.ts:458-540`        | `setActiveTools` is an imperative global change (`types.ts:1342`).                         |
| Tool metadata: `readonly`, `destructive`, `interactive`, `permissionRules`, `prompt` section                                                                               | `capability/tool.ts:144-175`                         | `executionMode`, `promptSnippet`, `promptGuidelines` only (`types.ts:449-477`).            |
| `toolCall` preflight returning a deny with a typed result object                                                                                                           | `extension.ts:181-185`; `tool-runner.ts:398-415`     | `tool_call` returns `block` + `reason` (`types.ts:1071-1080`). Similar.                    |
| Host facade split by authority: `Session`, `Agent`, `Interaction`, `Process`, `Files`, `FileLock`, `State`, `Dynamic`                                                      | `extension-services.ts:248-267`                      | One flat `ExtensionContext` plus `pi` actions (`types.ts:307-347, 1198-1436`).             |
| Session-scoped dynamic registration with tokens                                                                                                                            | `dynamic-extension-registry.ts:6-56`                 | Global `registerTool` after load plus `refreshTools` (`loader.ts:263-270`).                |
| Per-file isolation with `FailedExtension` status surfaced to the UI                                                                                                        | `extension.ts:47-76`; `registry.ts:285-319`          | Errors array per load (`types.ts:1711-1716`). Similar but not typed by phase.              |
| Client contributions as a typed bucket carrier (`renderers`, `widgets`, `commands`, `overlays`, `interactionRenderers`, `composerSurface`, `borderLabels`, `autocomplete`) | `client-facets.ts:203-212`                           | Imperative `ctx.ui.*` setters (`types.ts:131-283`).                                        |
| Effect-native end to end (no Promise edges)                                                                                                                                | `api.ts:13-15`                                       | Promise-based handlers (`types.ts:1193`).                                                  |
| Artifact identity for durable replay (`LoadedArtifactIdentity`)                                                                                                            | `extension.ts:24-36`                                 | No equivalent.                                                                             |

### 4.3 Where gent is more complex for the same capability

| Capability                        | pi                                                                                                             | gent                                                                                                                                                            | Complexity delta                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Register one tool                 | `pi.registerTool({ name, description, parameters, execute })` (`types.ts:1251`)                                | `tool({ id, description, params, output, execute })` then place in `tools: [...]` (`capability/tool.ts:187`; `api.ts:232`)                                      | gent requires an output schema and a bucket placement. Lowering into `AiTool` plus metadata tag (`capability/tool.ts:43-79`). |
| Slash command                     | `pi.registerCommand("name", { handler(args, ctx) })` (`types.ts:1260`)                                         | `request({ id, slash: {...}, input: Schema.String, output: Schema.Void, execute })` then `capabilityToCommand` (`goal/index.ts:215-262`; `registry.ts:321-365`) | gent needs schemas and an RPC identity for a text command.                                                                    |
| Handler error isolation           | try/catch, `emitError` (`runner.ts:808-830`)                                                                   | `sealErasedEffect` / `exitErasedEffect` membrane with `onFailure` and `onDefect` branches (`registry.ts:216-242`; `extension-hooks.ts:104-121, 266-290`)        | gent has two erasure layers (`eraseHookSlot` in `extension.ts:222-225`, then runtime reseal).                                 |
| Access host services in a handler | `ctx` argument (`types.ts:1193`)                                                                               | `yield* ExtensionContext` inside Effect, provided by `provideExtensionServices` at each call site (`extension-services.ts:523`; `registry.ts:263-267`)          | gent needs a host-context service layered per hook and per RPC (`CurrentExtensionHostContext`, `CurrentHookHostContext`).     |
| Post-turn continuation            | `sendUserMessage` from `agent_end` handler or v2 `before_run_end` (`types.ts:1311`; `harness-v2.md:1319-1329`) | `hook.turnAfter` + `ctx.Session.queueFollowUp({ sourceId, content, metadata, wake })` (`goal/index.ts:63-72, 152-190`)                                          | Similar. gent adds `sourceId` and `metadata` fields.                                                                          |
| Load-time facts (cwd)             | `cwd` captured by `createExtensionAPI` (`loader.ts:253`)                                                       | `yield* ExtensionSetupContext` inside an Effect factory (`api.ts:28-38`; `extension-setup-context.ts:20-51`)                                                    | gent uses a Tag and a `RemainingSetupRequirements` type helper (`api.ts:221`).                                                |
| Extension state                   | closure variable + entry scan on `session_start` (`docs/extensions.md:1846-1878`)                              | `defineStateResource` with Tag, layer, and scope, or a store module plus `ctx.State.changed` (`resource.ts:171-193`; `goal/index.ts:110`)                       | gent has more parts; pi has no crash-safe state beyond entries.                                                               |
| Tool visibility                   | `setActiveTools(names)` (`types.ts:1342`)                                                                      | `hook.turnProjection` returning `toolPolicy` fragments, compiled by `compileToolPolicy` (`extension.ts:267-281`; `registry.ts:515-540`)                         | gent is declarative and per-turn. More code paths.                                                                            |
| Tool override by name             | Map set by name (`agent-session.ts:2501-2506`)                                                                 | Scope-sorted winners map plus a second raw-entries list for RPC lookup (`registry.ts:123-196, 380-387`)                                                         | gent maintains two structures for one id space.                                                                               |

### 4.4 Same capability, near-equal complexity

- Tool call preflight: pi `tool_call` → `{ block, reason }` (`types.ts:1071-1080`); gent `toolCall` → `{ _tag: "deny", message, result? }` (`extension.ts:181-185`).
- Tool result transform: pi `tool_result` patch (`runner.ts:877-930`); gent `toolResult` returns a replacement result (`extension.ts:215-218`; `tool-runner.ts:197-214`).
- Project trust gate on project-local extensions: pi `project_trust` event and deferred load (`resource-loader.ts:575-620`); gent `isProjectExtensionDirectoryTrusted` (`runtime/extensions/project-trust.ts:9`; `loader.ts:218`).
- Discovery directories: pi `.pi/extensions` + `~/.pi/agent/extensions` (`loader.ts:710-716`); gent `.gent/extensions` + `~/.gent/extensions` (`loader.ts:213-215`).
- Per-file load isolation: both.

## 5. Counts

- pi v1 events on `ExtensionAPI.on`: 37 (`types.ts:1203-1244`). pi v2 hooks designed: 11 (`agent-harness.ts:198-209`).
- gent hook kinds: 5 (`extension.ts:198-218`). gent server buckets: 8 (`api.ts:225-243`). gent client buckets: 8 (`client-facets.ts:203-212`).
- pi `ExtensionAPI` methods: 25 registration/action methods plus `events` (`types.ts:1198-1436`).
- gent `ExtensionContext` facets: 8 (`extension-services.ts:257-264`).
