# opencode v2 plugin system — map and comparison with gent

Date: 2026-09-08. Read-only research. No recommendations in this document.

## 1. Source

- Repository: https://github.com/sst/opencode
- Branch: `v2` (exists as a remote head; sibling heads `v2-*` are feature branches off it; `dev` is the v1 line).
- Clone: `priors/opencode` (shallow, `--depth 1 --branch v2`).
- Commit: `cab8e39ad5191364084dcb0496b0b971cd497ce8` (2026-09-08 05:07:37 +0000, "fix(app): use HTTP-safe attachment and mutation IDs (#47887)").
- opencode paths below are relative to the clone root. gent paths are absolute.

## 2. opencode v2 plugin system

### 2.1 Plugin definition

Three authoring surfaces exist. All export a default object with an `id` and one setup function.

1. Effect plugin. `Plugin.define({ id, effect: (ctx) => Effect<void, never, Scope> })`.
   `packages/plugin/src/effect/plugin.ts:54-61`. The `Context` interface lists every host domain: `packages/plugin/src/effect/plugin.ts:25-52`.
2. Promise plugin. `Plugin.define({ id, setup: async (ctx) => cleanup? })`. The Promise API is a wrapper over the Effect API. `packages/plugin/src/README.md` (Promise guide), `packages/plugin/src/promise/adapter.ts:1-60` (adapter), `packages/plugin/src/promise/plugin.ts` (63 lines).
3. TUI plugin. `Plugin.define({ id, setup: (ctx) => cleanup? })` with a Solid/OpenTUI context. `packages/plugin/src/tui/plugin.ts:7-14`.

Package exports: `.` = Promise, `./effect` = Effect, `./host` = entrypoint resolver, `./tui` = TUI. `packages/plugin/package.json:12-18`.

The plugin package re-exports public schema types (`Agent`, `Command`, `Mcp`, `Model`, `Provider`, `Skill`, `Tool`, `Vcs`, ...) so plugins do not import `@opencode/core`. `packages/plugin/src/effect/index.ts:1-19`. The design goal "internal and external plugins use the same public plugin API" is stated in `packages/plugin/src/effect/PLAN.md:7-16`.

Setup does not return hooks. Setup registers hooks and transforms imperatively on the `ctx` domains. `packages/plugin/src/effect/PLAN.md:41-45`, `packages/plugin/src/effect/README.md`.

### 2.2 Two registration primitives: transform and hook

- `transform(callback: (editor) => void)` registers a synchronous, replayable edit of one domain's state. It returns a `Registration` with `dispose`. It is scope-owned. `packages/plugin/src/effect/registration.ts:27`, `packages/core/src/state.ts:22-24`.
- `hook(name, callback: (event) => Effect<void, Failure>)` registers a runtime interceptor. Same `Registration` type. `packages/plugin/src/effect/registration.ts:12-17`.
- `ModelHooks` add an optional `{ providerID }` filter for events that carry a `model`. `packages/plugin/src/effect/registration.ts:7-10, 19-25`.
- `reload()` belongs to a domain, not a registration. It invalidates the domain and reruns every active transform. `packages/plugin/src/effect/README.md` ("Reloading A Domain"), `packages/core/src/state.ts:26-27, 244`.

Transform semantics (`packages/core/src/state.ts`):

- `State.create({ initial, editor, notify })` holds one domain. `state.ts:156-246`.
- `get()` rebuilds synchronously from `initial()` and replays every transform in registration order only when dirty. Earlier values are never mutated. `state.ts:168-190`.
- A transform that throws disables its whole group (its plugin). The rebuild restarts from a fresh candidate. `state.ts:174-185`, `state.ts:63-75`.
- `State.batch(effect)` coalesces notifications until the effect completes. `state.ts:86-89, 96-111`.
- `State.shutdown(effect)` closes states permanently. `state.ts:91-94`.
- Registration is uninterruptible, attaches a finalizer to the caller's `Scope`, and notifies on add and on dispose. `state.ts:218-243`.
- Reads of another domain inside a transform observe that domain's latest committed state (PLAN). `packages/plugin/src/effect/PLAN.md:88-95`.

Hook semantics (`packages/core/src/plugin/hooks.ts`):

- Five hook domains: `aisdk`, `session`, `permission`, `shell`, `tool`. `hooks.ts:13-19`.
- Only `tool.execute.before` has a typed failure channel (`Tool.Error`). All other hooks have `never`. `hooks.ts:21-30`, `packages/plugin/src/effect/tool.ts:48-52`.
- `register` stores a callback keyed by `domain.name` and removes it on scope close. `hooks.ts:69-86`.
- `trigger` runs callbacks sequentially in registration order and returns the (mutated) event. Later hooks see earlier mutations. `hooks.ts:88-99`.
- `has(domain, name, providerID?)` lets the core skip work when no hook is registered. `hooks.ts:101-106`; used at `packages/core/src/session/model-request.ts:365-366`.

### 2.3 Host context (the `ctx` object)

`PluginHost.make` builds one `Plugin.Context` from core services. `packages/core/src/plugin/host.ts:47-533`. Domains and what each exposes:

| Domain                  | Transform editor                                                                | Runtime hooks                                                                  | Read/act API                                                                                              | Source                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `agent`                 | `list/get/default/update/remove` on `Agent.Info`                                | —                                                                              | `get`, `list`, `reload`                                                                                   | `packages/plugin/src/effect/agent.ts:6-17`, `host.ts:132-168`                             |
| `aisdk`                 | —                                                                               | `sdk` (create provider SDK), `language` (create LanguageModelV3)               | —                                                                                                         | `packages/plugin/src/effect/aisdk.ts:5-22`, `host.ts:169-198`                             |
| `catalog`               | `provider.{list,get,update,remove}`, `model.{get,update,remove,default}`        | —                                                                              | `provider.list/get`, `model.list/default`, `reload`                                                       | `packages/plugin/src/effect/catalog.ts:12-33`, `host.ts:199-242`                          |
| `command`               | `add({ name, description, execute })`                                           | —                                                                              | `list`, `reload`                                                                                          | `packages/plugin/src/effect/command.ts:14-27`, `host.ts:243-247`                          |
| `event`                 | —                                                                               | —                                                                              | `subscribe()` stream of server events and `rpc.*` events                                                  | `packages/plugin/src/effect/event.ts:3`, `host.ts:248-258`                                |
| `experimental.terminal` | —                                                                               | —                                                                              | `read` persistent PTY                                                                                     | `host.ts:259-263`                                                                         |
| `generate`              | —                                                                               | —                                                                              | `text`                                                                                                    | `host.ts:264-266`                                                                         |
| `integration`           | `list/get/update/remove`, `method.{list,update,remove}` (oauth/command/key/env) | —                                                                              | `connect.key`, `oauth.*`, `command.*`, `connection.{active,resolve}`, `reload`                            | `packages/plugin/src/effect/integration.ts:77-96`, `host.ts:267-353`                      |
| `mcp`                   | `list/get/set/update/remove` server configs                                     | —                                                                              | `list`, `reload`                                                                                          | `packages/plugin/src/effect/mcp.ts:6-17`, `host.ts:354-383`                               |
| `permission`            | —                                                                               | `evaluate` (mutate `effect`, `message`)                                        | `list`, `get`, `reply`                                                                                    | `packages/plugin/src/effect/permission.ts:7-24`, `host.ts:384-407`                        |
| `plugin`                | —                                                                               | —                                                                              | `list` inventory                                                                                          | `host.ts:408-410`                                                                         |
| `reference`             | `add/remove/list/get` local or git sources                                      | —                                                                              | `list`, `reload`                                                                                          | `packages/plugin/src/effect/reference.ts:6-16`, `host.ts:411-423`                         |
| `rpc`                   | —                                                                               | —                                                                              | `register(definition, handlers)` + client                                                                 | `packages/plugin/src/effect/rpc.ts:7-29`, `host.ts:131`, `packages/core/src/rpc.ts:67-90` |
| `session`               | —                                                                               | `prompt`, `context`, `model.request`, `http.request`, `http.response`, `retry` | `create/get/switchAgent/switchModel/prompt/generate/command/synthetic/interrupt/rename/move/wait/context` | `packages/plugin/src/effect/session.ts:13-102`, `host.ts:504-530`                         |
| `shell`                 | —                                                                               | `create.before` (mutate command/cwd/env/timeout)                               | —                                                                                                         | `packages/plugin/src/effect/shell.ts:3-17`, `host.ts:439-441`                             |
| `skill`                 | `list/get/add/update/remove`                                                    | —                                                                              | `list`, `reload`                                                                                          | `packages/plugin/src/effect/skill.ts:6-17`, `host.ts:424-437`                             |
| `storage`               | —                                                                               | —                                                                              | `get/set/remove/scan` JSON KV, namespaced by plugin id                                                    | `packages/plugin/src/effect/storage.ts:4-9`, `host.ts:561-588`                            |
| `tool`                  | `list/get/namespace/add/update/remove`                                          | `execute.before`, `execute.after`                                              | `reload`                                                                                                  | `packages/plugin/src/effect/tool.ts:8-58`, `host.ts:442-446`                              |
| `vcs`                   | `add(definition)`, `default.{get,set}`                                          | —                                                                              | `get/base/branches/status/diff`, `reload`                                                                 | `packages/plugin/src/effect/vcs.ts:26-47`, `host.ts:447-455`                              |
| `websearch`             | `add(definition)`, `default.{get,set}`                                          | —                                                                              | `providers`, `query`, `reload`                                                                            | `packages/plugin/src/effect/websearch.ts:6-23`, `host.ts:456-484`                         |
| `worktree`              | `add(definition)`                                                               | —                                                                              | `list/create/refresh/remove`, `reload`                                                                    | `packages/plugin/src/effect/worktree.ts:6-21`, `host.ts:485-503`                          |

Other context fields: `app` metadata, `location` (directory, workspaceID, project), `options` (per-plugin config from `opencode.json`). `packages/plugin/src/effect/plugin.ts:26-28`, `packages/core/src/plugin/module.ts:131`.

Every domain's read API must extend the generated `@opencode/client/effect/api` interface. Plugins add only extra functions. `packages/plugin/AGENTS.md:3-6`.

### 2.4 Plugin sources and loading

Sources, in activation order (`packages/core/src/plugin/supervisor.ts:138-152`):

1. Internal `pre` plugins: browser, MCP config, well-known, git VCS, agent, plan, command, skill, hg VCS, models.dev, every provider plugin, every websearch plugin, patch tool, optimize plugins, each builtin tool (edit, glob, grep, question, read, shell, skill, subagent, webfetch, websearch, write), warming. `packages/core/src/plugin/internal.ts:195-225`.
2. SDK plugins registered by an embedder at runtime. `packages/core/src/plugin/sdk.ts:21-42`.
3. Instance plugins bound at instance birth. `packages/core/src/plugin/instance.ts:19-45`.
4. Configured/discovered package or local plugins. `supervisor.ts:91-95`.
5. Internal `post` plugins: config-driven plugins (instruction, reference, agent, command, compaction, formatter, image, location-watcher, shell, snapshot, tool-output, skill, provider, websearch, worktree), variant, policy. `internal.ts:227-245`.

Internal plugins are the same `Plugin` shape as external ones; the loader pre-provides core services into their `effect`. `internal.ts:247-261`. Example: the builtin `read` tool is a plugin that calls `ctx.tool.transform((editor) => editor.add({...}))`. `packages/core/src/tool/plugin/read.ts:29-47`. Example: default agents are a plugin that calls `ctx.agent.transform`. `packages/core/src/plugin/agent.ts:83-156`.

Config declaration: `plugins: (string | { package, options })[]` in the config document. `packages/schema/src/config.ts:99-100`, `packages/schema/src/config/plugin.ts:6-14`. A string starting with `-` is a remove directive; `*` and `prefix.*` wildcards match plugin ids. `packages/core/src/config/plugin/source.ts:113-120`, `supervisor.ts:26-56`. Directives run in order, so config can disable builtins by id. `supervisor.ts:38-45`.

Auto-discovery: every `plugin/` or `plugins/` directory under a config root contributes `.ts`/`.js` files and directories. `packages/core/src/plugin/source-directory.ts:7-33`, `source.ts:127-133`. Explicit config applies last so it can remove discovered packages. `source.ts:158`.

Entrypoint resolution: a package exposes up to three entrypoints — `server` (or root), `tui`, `rpc` — resolved as subpaths. `packages/plugin/src/host.ts:11-44`. Package loading uses npm install (`npm.add`) or resolve-only when `install === false`; local files use a source cache keyed on content digests with filesystem watches. `packages/core/src/plugin/module.ts:80-133`, `packages/plugin/src/source.ts:8-59`. A module must default-export `{ id, effect }` or `{ id, setup }`. `module.ts:60-73, 107-116`. `opencode plugin add <pkg>` installs and writes config. `packages/cli/src/commands/handlers/plugin/add.ts:14-40`.

### 2.5 Activation, ordering, failure, hot reload

`Plugin.Service` (`packages/core/src/plugin.ts`):

- Each plugin gets its own child `Scope`. All registrations attach to it. `plugin.ts:47-48, 64-80`.
- A plugin `Generation` carries `revision`. `activate` diffs the ordered list; only the changed suffix is torn down (in reverse) and reloaded. `plugin.ts:100-175`.
- Setup failure logs a warning, records `state: failed`, and tries to restore the previous activation as fallback. `plugin.ts:81-87, 154-169`.
- A transform that throws later disables the plugin: `State.group` reports the failure, the registry logs, refreshes, and closes the plugin scope in a background worker. `plugin.ts:50-63, 182-236`.
- `awaitActivation` blocks callers (for example prompt handling) until activation settles. `plugin.ts:250-256`, `packages/core/src/session/prompt.ts:38`.
- Inventory (`Plugin.Info` with `source`, `features {server,tui,rpc}`, `state`) is published on `plugin.updated`. `plugin.ts:285-293`, `packages/schema/src/plugin.ts:24-49`.

`PluginSupervisor` (`packages/core/src/plugin/supervisor.ts`) reactivates on: config change, local module change, a 24-hour timer, `config.updated` / `sdk.plugin.updated` bus events, and package update checks. Triggers are debounced 100 ms after the first run. `supervisor.ts:196-237`. It also checks npm for outdated packages and marks `outdated`/`updating` on the inventory. `supervisor.ts:181-194, 213-224`.

Duplicate ids: first occurrence in boot order wins, later ones are reported as failed plugins. `supervisor.ts:96-111`.

### 2.6 Tools

- `Tool.Info` = `{ name, description, input, output?, execute(input, context) => Effect<Result, Tool.Error>, options? }`. Schemas accept Effect `Schema`, Standard Schema, or raw JSON Schema. `packages/schema/src/tool.ts:44, 92-102`.
- `options`: `namespace`, `permission` (action name used by the permission ruleset), `codemode` (default true: tool is exposed through the code-mode `execute` tool; `false` = direct tool call), `pinned`. `packages/schema/src/tool.ts:22-42`.
- `Tool.Context` gives `sessionID`, `agent`, `messageID`, `id`, `progress`. `packages/schema/src/tool.ts:14-20`.
- The tool editor rejects invalid names into an `errors` list which is logged on notify; `update` cannot rename or move namespace. `packages/core/src/tool.ts:164-215`.
- `snapshot(permissions)` filters wholly-denied tools by ruleset, splits direct vs codemode tools, and builds one code-mode tool plus a catalog. `packages/core/src/tool.ts:220-248`.
- Execution: `execute.before` may rewrite `tool` name and `input` or fail with `Tool.Error`; `execute.after` may rewrite `result` or `error`. `packages/core/src/tool.ts:102-155`, `packages/plugin/src/effect/tool.ts:20-46`.

### 2.7 Config, permissions, state

- Config: plugins receive `ctx.options` from the `plugins` entry. `module.ts:131`. Config-driven behavior is itself implemented as `post` plugins that observe `config.updated` and call `reload()` on a domain. `packages/core/src/config/plugin/entry-observer.ts:7-25`, example `packages/core/src/config/plugin/policy.ts:10-27`.
- Permissions: rules are `{ action, resource, effect: allow|deny|ask }` on each agent (`Agent.Info.permissions`). `packages/schema/src/permission.ts:55-66`, `packages/schema/src/agent.ts:23-55`. Evaluation merges agent rules and saved rules, then runs the `permission.evaluate` hook, which may change `effect` and `message`. `packages/core/src/permission.ts:168-184`. `ask` produces a pending request published as `permission.asked`; replies are `once|always|reject`. `permission.ts:199-212`, `packages/schema/src/permission.ts:41-53`.
- State: (a) domain state via transforms (section 2.2); (b) durable per-plugin JSON KV `ctx.storage` namespaced `plugin:<hex(id)>:`. `host.ts:561-588`; (c) TUI `ctx.storage.store` (disk, live-synced across TUIs) and `ctx.storage.memory` (survives hot reload). `packages/plugin/src/tui/context.ts:31-53`.
- Events: `ctx.event.subscribe()` returns the bus stream filtered to server events and `rpc.*` events. `host.ts:248-258`.
- RPC: `ctx.rpc.register(definition, handlers)` publishes plugin-owned methods and events to clients; a client is also available. `packages/plugin/src/effect/rpc.ts:11-29`, `packages/core/src/rpc.ts:16-20, 67-90`.

### 2.8 TUI (client) plugins

- TUI plugins load from the `tui` entrypoint of the same package (server marks `features.tui`). `packages/tui/src/plugin/context.tsx:94-101, 606-611`. Builtin TUI features are themselves `Plugin.define` modules under `packages/tui/src/feature-plugins/`, e.g. `packages/tui/src/feature-plugins/sidebar/footer.tsx:42-52`.
- Context surface: `client` (generated SDK), `data` (reactive caches for sessions, messages, permissions, forms, projects, shells, location collections, plus `on(type, handler)`), `attention.notify`, `theme`, `markdown.registerCodeBlockRenderer`, `keymap` (layers, commands, palette, slash, modes), `storage`, `ui` (dialog, toast, router pages, session panel, tabs, slot claims). `packages/plugin/src/tui/context.ts:63-140, 320-322, 381-457, 459-499, 501-517`.
- Slot tree: fixed paths `app`, `home.footer`, `prompt.footer[.status|.file]`, `session.composer.top`, `session.panel`, `sidebar.content`, `sidebar.footer`. A claim is `prepend|append|before|after|replace` on one path; `replace` takes over the subtree. `packages/plugin/src/tui/context.ts:180-261`.
- Lifecycle: `setup` may return a cleanup; the host disposes cleanups in reverse on deactivate, and hot-reloads local entrypoints on file change. `packages/tui/src/plugin/context.tsx:120-165, 574-583, 606-629`.

### 2.9 How the agent loop invokes plugins

Trigger sites (all via `PluginHooks.trigger`):

- `session.prompt` before a prompt is materialized; may rewrite text/files/agents/skills/delivery. `packages/core/src/session/prompt.ts:38-52`.
- `session.context` immediately before provider dispatch; may edit `system`, `messages`, `tools` (rename, edit description/schema, delete), `generation`, `providerOptions`. `packages/core/src/session/model-request.ts:299-330`.
- `session.model.request` (baseURL, headers), `session.http.request`, `session.http.response`, `session.retry`. `model-request.ts:224, 249, 261, 392`.
- `aisdk.sdk` and `aisdk.language` when a provider SDK / language model is constructed. `host.ts:169-198`.
- `tool.execute.before` / `tool.execute.after` around every tool call, including code-mode calls. `packages/core/src/tool.ts:102-155, 234-238, 257`.
- `permission.evaluate` on every permission check. `packages/core/src/permission.ts:174-182`.
- `shell.create.before` before a shell spawns. `packages/core/src/shell.ts:268`.

Domain state is read by the loop through `get()`-style reads (for example `tools.snapshot`), so transforms take effect on the next read after a rebuild. `packages/core/src/tool.ts:220-248`, `state.ts:168-190`.

## 3. gent extension surface (for comparison)

- Authoring: `defineExtension({ id, resources?, scheduledJobs?, tools?, requests?, agents?, hooks?, modelDrivers?, externalDrivers? })`. Each bucket is a literal array, `() => array`, or `() => Effect<array, ExtensionLoadError, R>`. `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:212-244, 335-384`. Bucket carrier: `/Users/cvr/Developer/personal/gent/packages/core/src/domain/contribution.ts:43-63`.
- Setup facts come from `yield* ExtensionSetupContext` (`cwd`, `source`, `home`, `host`, `Process`). `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-setup-context.ts:21-28, 48-51`.
- Runtime authority comes from `yield* ExtensionContext` with facets `Session`, `Agent`, `Interaction`, `Process`, `Files`, `FileLock`, `State`, `Dynamic`. `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts:248-265`.
- Hooks: `systemPrompt`, `turnProjection`, `turnAfter`, `toolCall` (preflight, may deny), `toolResult` (rewrite). `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:194-247`. Failures are logged and isolated. `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-hooks.ts:104-121`. Call sites: `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-resolve.ts:261, 331`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts:197, 398`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts:650`.
- Tools: `tool({ id, description, params, output, execute, promptSnippet?, promptGuidelines?, permissionRules?, interactive?, readonly? })` lowers to a branded Effect AI tool with metadata. `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts:28-76`.
- Requests: `request({ id, input, output, execute, slash?, prompt?, description? })`; slash commands are requests with a `slash` block. `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts:63-88`.
- Registry: extensions sort by scope (`builtin < user < project`), later scope wins per id for tools, requests, agents, drivers, prompt sections, and permission rules; compiled once into an immutable `ResolvedExtensions`. `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts:62-75, 106-146, 271-278, 368-449`. Tool policy per turn: agent allow/deny, extension projections, deny re-applied, interactive filter. `registry.ts:515-540`.
- Discovery: `~/.gent/extensions` and `.gent/extensions` files; project extensions require `trustedProjects` in user config. `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/loader.ts:212-267`, `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/project-trust.ts:9-22`. Disable list: `disabledExtensions` in user and project `config.json`. `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/disabled.ts:25-37`.
- Dynamic registration: `ctx.Dynamic.registerTool/registerRequest` with `process` or `session` scope; returns an unregister effect. `/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts:6-59`, `extension-services.ts:237-246`.
- Resources: `defineResource({ id, revision, requires, required, scope: "process", layer, start?, stop? })`. Only `process` scope exists. `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts:38, 68-94`.
- Scheduled jobs: cron entries that run a headless agent. `/Users/cvr/Developer/personal/gent/packages/core/src/domain/scheduled-job.ts:10-20`.
- Drivers: `ModelDriverContribution` (resolveModel, listModels, auth) and `ExternalDriverContribution` (executor, toolSurface, invalidate). `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts:157-193, 270-288`.
- Permissions: `PermissionRule { tool, pattern?: regex, action: allow|deny }` evaluated against JSON-encoded args. `/Users/cvr/Developer/personal/gent/packages/core/src/domain/permission.ts:24-60`.
- TUI: `.client.{ts,tsx}` modules export an Effect setup that yields `ClientTransport`, `ClientShell`, `ClientWorkspace`, `ClientComposer`, `ClientLifecycle`; buckets are `renderers`, `widgets`, `commands`, `overlays`, `interactionRenderers`, `composerSurface`, `borderLabels`, `autocomplete`. `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts:1-24, 204-213`. Widget slots are `below-messages | above-input | below-input`. `client-facets.ts:43`.
- Example: goal extension contributes two requests (one slash), one tool, and one `turnAfter` hook, and uses `ctx.Session.queueFollowUp`, `ctx.State.changed`, `ctx.Interaction.present`. `/Users/cvr/Developer/personal/gent/packages/extensions/src/goal/index.ts:62-72, 215-262, 299-335`.
- Doc drift: `ARCHITECTURE.md` names the hook bucket `reactions` and lists `turnBefore` and `messageOutput`; the code bucket is `hooks` with five kinds and no `turnBefore`/`messageOutput`. `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md:854, 860` vs `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts:241`, `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts:198-219`.

## 4. Comparison

### 4.1 Concepts opencode has that gent lacks

1. Replayable domain transforms with rebuild-on-read and per-domain `reload()`. Any plugin can edit any other plugin's contribution (update a builtin tool's description, remove a builtin agent, add a permission rule to an agent). gent compiles a static snapshot once; later scope shadows by id only. `packages/core/src/state.ts:156-246` vs `registry.ts:368-449`.
2. Imperative registration owned by an Effect `Scope`, with `Registration.dispose`. gent uses declarative buckets; dynamic tools/requests exist only through `ctx.Dynamic`. `packages/plugin/src/effect/registration.ts` vs `extension-services.ts:237-246`.
3. Hot reload and reactivation: config watch, local-file watch, npm update checks, 24-hour timer, prefix-diff of generations with fallback to the previous activation on failure. gent has no watch or reload path. `supervisor.ts:196-237`, `plugin.ts:100-175`; gent grep found no watch/reload in `runtime/extensions` or `apps/tui/src/extensions`.
4. npm package plugins with `install`/`resolve`, version and outdated tracking, `opencode plugin add`. gent loads only local files under two directories. `module.ts:80-133`, `loader.ts:212-267`.
5. Session-level hooks around the model call: `prompt`, `context` (edit messages, system, tool definitions, generation options), `model.request`, `http.request`, `http.response`, `retry`, and `aisdk.sdk`/`aisdk.language`. gent's `systemPrompt` hook returns only a string and gent has no hooks on messages, HTTP, retry, or provider construction. `packages/plugin/src/effect/session.ts:13-83`, `aisdk.ts:5-22` vs `extension.ts:198-219`.
6. `tool.execute.before` may rename the tool and rewrite the input; `execute.after` may rewrite errors. gent's `toolCall` may only deny; `toolResult` rewrites successes only. `packages/plugin/src/effect/tool.ts:20-46` vs `extension.ts:172-185, 216-218`.
7. Permission `evaluate` hook that can override `allow|deny|ask` per call and add a message; `ask` with `once|always|reject` replies and saved rules. gent permission rules are static `allow|deny` regex rules with no `ask` state and no hook. `packages/core/src/permission.ts:168-184` vs `permission.ts:24-60`.
8. Editable domains for catalog (providers/models), MCP servers, skills, references, integrations (OAuth/key/env/command methods), VCS backends, worktree strategies, websearch providers, and slash commands as first-class `command` entries. gent has drivers (provider) and requests-with-slash but no MCP, skill, reference, integration, VCS, worktree, or websearch buckets.
9. Per-plugin durable KV storage (`ctx.storage`) and TUI `store`/`memory` storage. gent has `ctx.State.changed` (notification only) and extension-owned services; no host KV. `host.ts:561-588`, `tui/context.ts:31-53` vs `extension-services.ts:230-235`.
10. Plugin-published RPC definitions and events (`ctx.rpc.register`) that clients call by definition. gent requests are callable by clients, but extensions do not declare event types. `packages/core/src/rpc.ts:67-90`.
11. Event bus subscription from a plugin (`ctx.event.subscribe`). gent extensions have no event stream facet. `host.ts:248-258`.
12. Promise (async/await) authoring surface with the same capabilities. gent is Effect-only by design. `packages/plugin/src/README.md`.
13. TUI: fixed slot tree with `prepend/append/before/after/replace`, router pages, session panel, tabs, dialogs, toasts, keymap layers with modes, markdown code-block renderers, attention notifications. gent TUI has three widget slots, overlays, palette commands, interaction renderers, one composer surface, border labels, autocomplete. `tui/context.ts:191-261, 459-499` vs `client-facets.ts:43, 204-213`.
14. Same authoring shape for builtins: every builtin tool, agent set, provider, and VCS backend is a `Plugin` in `internal.ts`. gent builtins are `defineExtension` too, but core services such as the read tool's file access are not plugin-visible. `internal.ts:195-245`.
15. Plugin inventory event (`plugin.updated`) and per-plugin `features {server,tui,rpc}`; TUI plugin list UI. `packages/schema/src/plugin.ts:24-49`, `packages/tui/src/feature-plugins/system/plugins.tsx`.

### 4.2 Concepts gent has that opencode lacks

1. Typed contribution buckets validated at setup with per-bucket error messages and package-shape validation; extension setup failure excludes the extension before activation. `api.ts:252-313, 345-351`. opencode validates only the module default export shape and lets transforms fail at read time. `module.ts:60-73, 107-116`, `state.ts:174-185`.
2. Scope precedence (`builtin < user < project`) with id-level shadowing across every bucket, plus prompt sections and permission rules taken from winners only. `registry.ts:106-146, 405-426`. opencode has boot-order only, and duplicate ids fail.
3. Project trust gate: project extensions load only when the user config lists the project as trusted. `project-trust.ts:9-22`. opencode auto-discovers `plugin/` directories under any config root without a trust check. `source.ts:127-133`.
4. Turn projection: an extension can add prompt sections and a tool policy fragment (`include`, `exclude`, `overrideSet`) per turn, with agent deny lists re-applied after projections. `registry.ts:453-540`. opencode expresses this through `session.context` mutation and agent permission rules.
5. Resources as a first-class contribution with graph metadata (`id`, `revision`, `requires`, `required`), `start`/`stop`, and a resource host that rejects publication on failed start. `resource.ts:68-94`, `ARCHITECTURE.md:865-872`. opencode uses plain Effect scopes and services inside `effect`.
6. Scheduled jobs (cron → headless agent). `scheduled-job.ts:10-20`.
7. External drivers (non-model turn executors) with `toolSurface` and `invalidate`, and model drivers as split buckets. `driver.ts:175-193, 270-288`. opencode has provider plugins via `aisdk` hooks and catalog transforms; no external executor primitive in the plugin API.
8. Tool metadata in the authoring shape: `promptSnippet`, `promptGuidelines`, `permissionRules`, `interactive`, `readonly`. `capability/tool.ts:28-40`. opencode tool options are `namespace`, `permission`, `codemode`, `pinned`. `packages/schema/src/tool.ts:22-42`.
9. Request capabilities with typed `ref(...)` for extension-to-extension calls and slash presentation on the same leaf. `capability/request.ts:44-60, 90-98`.
10. `ExtensionContext` facets for `Interaction` (`approve`, `present`, `confirm`, `review`), `Files`, `FileLock`, and child-agent `Agent.start/run/inspect/cancel`. `extension-services.ts:257-265, 293-326`. opencode exposes `session.*` and `permission.reply` but no interaction or file-lock facade.
11. Extension-hook error membrane: author `E`/`R` are erased and resealed at the runtime boundary, and every hook failure is isolated to a log line. `extension.ts:222-225`, `extension-hooks.ts:104-121`. opencode hooks have `never` failure types and rely on defects.
12. A per-run ephemeral runtime for child agents that reuses the resolved registry. `ARCHITECTURE.md:907-919`.

### 4.3 Where gent is more complex for the same capability

1. Registering a tool. opencode: `ctx.tool.transform((e) => e.add({ name, description, input, output, execute }))` inside one `effect`. gent: `tool({...})` lowers to a branded Effect AI tool with a `Context.Reference` metadata annotation, brand symbols, phantom type fields, and `getToolMetadata` accessors; the registry then re-reads metadata. `packages/core/src/tool/plugin/read.ts:38-47` vs `capability/tool.ts:25-120`.
2. Registering a slash command. opencode: `ctx.command.transform((e) => e.add({ name, description, execute }))`. gent: `request({ id, input, output, execute, slash })` plus `bindRequestCapabilityExtension`, `REQUEST_REF` symbols, `capabilityToCommand`, and `compileSlashCommands`. `packages/plugin/src/effect/command.ts:14-27` vs `capability/request.ts:32-60, 96-120`, `registry.ts:148-158, 321-365`.
3. Hook plumbing. opencode: one `PluginHooks` service with `register`/`trigger`/`has` (112 lines) and typed event maps per domain. gent: `hook.*` factories, `ExtensionHookSlot` union, `compileExtensionHooks`, `CurrentHookHostContext`, `CurrentProjectionHookContext`, `provideExtensionServices`, `provideExtensionCapabilityContext`, and `sealErasedEffect`/`exitErasedEffect` membranes. `packages/core/src/plugin/hooks.ts` vs `extension.ts:194-247`, `extension-hooks.ts:1-170`.
4. Host authority. opencode passes one `ctx` object; a plugin reads services it needs directly (builtins) or through domain APIs. gent forbids ctx parameters and requires `yield* ExtensionContext` plus a facet wrapper per service (`mapError` per method). `host.ts:127-531` vs `extension-services.ts:271-327`.
5. Loading. opencode's `internal.ts` is a flat list of plugin objects in boot order (`pre`/`post`). gent has `loader.ts`, `activation.ts`, `disabled.ts`, `project-trust.ts`, `host-platform.ts`, `extension-capability-context.ts`, `extension-hook-context.ts`, `extension-effect-membrane.ts`, and `resource-host/` for the equivalent boot path. `internal.ts:195-261` vs directory listing of `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/`.
6. Setup input. opencode: one function with the context. gent: eight optional bucket fields, each accepting three shapes (array, sync factory, Effect factory), with `resolveField` sealing errors per field. `packages/plugin/src/effect/plugin.ts:54-61` vs `api.ts:212-244, 252-313`.
7. TUI extension. opencode: `Plugin.define({ id, setup(ctx) { ctx.ui.slot({...}) } })`. gent: an Effect `setup` that yields five client services from a `ManagedRuntime` and returns typed buckets resolved by a separate resolver with per-bucket conflict rules. `packages/tui/src/feature-plugins/sidebar/footer.tsx:42-52` vs `client-facets.ts:1-24, 71-80`.

## 5. Receipts

opencode (relative to `priors/opencode`):

- `packages/plugin/package.json`
- `packages/plugin/AGENTS.md`
- `packages/plugin/src/README.md`
- `packages/plugin/src/effect/README.md`
- `packages/plugin/src/effect/PLAN.md`
- `packages/plugin/src/effect/{index,plugin,registration,tool,session,event,permission,agent,catalog,command,skill,mcp,integration,aisdk,rpc,storage,shell,vcs,websearch,worktree,reference}.ts`
- `packages/plugin/src/promise/adapter.ts`
- `packages/plugin/src/tui/{plugin,solid,context}.ts`
- `packages/plugin/src/host.ts`
- `packages/plugin/src/source.ts`
- `packages/core/src/plugin.ts`
- `packages/core/src/plugin/{host,hooks,module,internal,supervisor,sdk,instance,agent,source-directory}.ts`
- `packages/core/src/state.ts`
- `packages/core/src/tool.ts`
- `packages/core/src/tool/plugin/read.ts`
- `packages/core/src/permission.ts`
- `packages/core/src/rpc.ts`
- `packages/core/src/session/prompt.ts`
- `packages/core/src/session/model-request.ts`
- `packages/core/src/config/plugin/{source,policy,entry-observer}.ts`
- `packages/core/src/codemode/catalog.ts`
- `packages/schema/src/{plugin,tool,permission,agent,config}.ts`
- `packages/schema/src/config/plugin.ts`
- `packages/tui/src/plugin/context.tsx`
- `packages/tui/src/feature-plugins/sidebar/footer.tsx`
- `packages/plugin-browser/src/index.ts`
- `packages/cli/src/commands/handlers/plugin/add.ts`

gent (absolute):

- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/extensions/api.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/extension-hooks.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/loader.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/activation.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/disabled.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/extensions/project-trust.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/contribution.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-services.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/extension-setup-context.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/dynamic-extension-registry.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/tool.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/capability/request.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/resource.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/scheduled-job.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/driver.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/domain/permission.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/turn-resolve.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/tool-runner.ts`
- `/Users/cvr/Developer/personal/gent/packages/core/src/runtime/agent/agent-loop.turn-execution.ts`
- `/Users/cvr/Developer/personal/gent/packages/extensions/src/goal/index.ts`
- `/Users/cvr/Developer/personal/gent/apps/tui/src/extensions/client-facets.ts`
- `/Users/cvr/Developer/personal/gent/ARCHITECTURE.md`
