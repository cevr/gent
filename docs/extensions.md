# Extension Authoring Guide

## Overview

Extensions add tools, agents, prompt sections, hooks, and stateful behaviors to gent. `extension()` is the unified authoring API — it works for both simple external extensions (no Effect knowledge) and full-power builtins (Effect interceptors, actors, layers, providers). All gent builtins use this same API.

## Discovery

Extensions are loaded from two directories:

| Scope   | Path                  | Precedence |
| ------- | --------------------- | ---------- |
| User    | `~/.gent/extensions/` | 1 (medium) |
| Project | `.gent/extensions/`   | 2 (high)   |

Within each directory:

- Top-level `*.ts`, `*.js`, `*.mjs` files are loaded
- Subdirectories with `index.ts`/`index.js`/`index.mjs` are loaded
- Files starting with `.` or `_` are skipped
- `*.client.{tsx,ts,js,mjs}` and `client.{tsx,ts,js,mjs}` are TUI-only (not loaded server-side)

**Per-file isolation**: One broken file does not suppress siblings. Each file is loaded independently; failures are logged as warnings and the extension is skipped.

**Scope precedence**: Higher scope wins for same-key contributions. Project overrides User overrides Builtin. Same-scope collisions between different extensions are fatal.

## Disabling Extensions

Create `.gent/disabled-extensions.json`:

```json
["extension-id-to-disable"]
```

Both `~/.gent/disabled-extensions.json` (user-level) and `.gent/disabled-extensions.json` (project-level) are merged.

## extension API

```ts
import { extension } from "@gent/core/extensions/api"

export default extension("my-ext", async (ext, ctx) => {
  // ctx.cwd — project working directory
  // ctx.source — path to this extension file
})
```

The factory runs at **setup time** (not import time), receives setup context, and can be async.

### ext.tool(def)

Register a tool:

```ts
ext.tool({
  name: "greet",
  description: "Say hello",
  parameters: {
    name: { type: "string", description: "Who to greet" },
    count: { type: "number", optional: true },
  },
  execute: async (params, ctx) => `Hello, ${params.name}!`,
})
```

Parameters use simple type declarations (`string`, `number`, `boolean`). The framework builds Schema validation automatically.

### ext.agent(def)

Register a subagent:

```ts
ext.agent({
  name: "helper",
  model: "anthropic/claude-sonnet-4-20250514",
  description: "A helper for specific tasks",
  allowedTools: ["read", "write"],
})
```

### ext.promptSection(section)

Add a static system prompt section:

```ts
ext.promptSection({
  id: "project-rules",
  content: "Always follow the coding standards in STANDARDS.md.",
  priority: 50, // lower = higher priority
})
```

### ext.on(key, handler)

Register hook interceptors. Six hook points available:

| Hook               | Type            | Description                    |
| ------------------ | --------------- | ------------------------------ |
| `prompt.system`    | Transform       | Modify the system prompt       |
| `tool.execute`     | Transform       | Intercept tool execution       |
| `permission.check` | Transform       | Override permission decisions  |
| `context.messages` | Transform       | Filter/modify context messages |
| `tool.result`      | Transform       | Enrich/modify tool results     |
| `turn.after`       | Fire-and-forget | Post-turn side effects         |

**Transform hooks** receive `(input, next)` — call `next(input)` to continue the chain:

```ts
ext.on("prompt.system", async (input, next) => {
  const result = await next(input)
  return result + "\n\nCustom footer."
})
```

**Fire-and-forget hooks** receive `(input)` only:

```ts
ext.on("turn.after", async (input) => {
  console.log(`Turn completed in ${input.durationMs}ms`)
})
```

### ext.onStartup(fn) / ext.onShutdown(fn)

Lifecycle hooks. Multiple calls compose in declaration order:

```ts
ext.onStartup(async () => {
  /* initialize resources */
})
ext.onShutdown(async () => {
  /* cleanup */
})
```

### ext.actor(actor)

Stateful extensions register one actor. Stateless extensions can omit this entirely.

Current helpers like `fromReducer()` / `fromMachine()` still exist during the migration, but the extension surface is `ext.actor(...)`.

```ts
import { extension, fromReducer } from "@gent/core/extensions/api"

const turnCounterActor = fromReducer({
  id: "turn-counter",
  initial: { turns: 0 },
  reduce: (state, event) => {
    if (event._tag === "TurnCompleted") {
      return { state: { turns: state.turns + 1 } }
    }
    return { state }
  },
  derive: (state) => ({
    promptSections: [
      {
        id: "turn-count",
        content: `Turns so far: ${state.turns}`,
        priority: 80,
      },
    ],
    uiModel: state,
  }),
})

extension("turn-counter", (ext) => {
  ext.actor(turnCounterActor)
})
```

Rules:

- one actor per extension
- actor optional for stateless extensions
- actor owns state, snapshot, and turn projection
- helper adapters are transitional; plan removes them in favor of one actor-shaped substrate

### Imperative Side Effects

Queue follow-up turns or inject messages from hook handlers — no actors needed:

```ts
ext.on("turn.after", async (input) => {
  if (shouldContinue(input)) {
    ext.queueFollowUp("Continue working on the task.")
  }
})

ext.on("tool.result", async (input, next) => {
  const result = await next(input)
  ext.interject("I noticed something — let me check.")
  return result
})
```

Available in `turn.after`, `tool.execute`, `tool.result`, `context.messages` handlers. Not available in `prompt.system` or `permission.check` (throws descriptive error).

### File-Backed Storage

Simple key-value storage, namespaced by extension ID:

```ts
// Available at setup time and in handlers
await ext.storage.set("config", { theme: "dark" })
const config = await ext.storage.get("config")
await ext.storage.delete("config")
const keys = await ext.storage.list()
```

Stored at `~/.gent/extensions/<id>/storage/<key>.json`. Keys must be alphanumeric with hyphens/underscores.

### Event Observation

Observe all events (including diagnostic) without actors or state:

```ts
ext.observe((event) => {
  console.log(`[${event._tag}] session=${event.sessionId}`)
})
```

Fire-and-forget: errors caught and logged, return value ignored. Runs after reduction.

## Validation

The framework validates all loaded extensions before creating the registry:

- **Duplicate IDs** in same scope → fatal
- **Same-name tools** from different extensions in same scope → fatal
- **Same-name agents** from different extensions in same scope → fatal
- **Same-id providers** from different extensions in same scope → fatal
- **Same-type interaction handlers** from different extensions in same scope → fatal
- **Same-id prompt sections** from different extensions in same scope → fatal

Cross-scope: higher scope wins silently (project overrides user overrides builtin).

## Full-Power Methods

The same `extension()` builder has additional methods for Effect-aware extensions. These are used by builtins and advanced authors.

### ext.tool(fullToolDef) / ext.agent(agentDefinition)

`tool()` and `agent()` are overloaded — they accept both simple defs (shown above) and full domain objects created via `defineTool()` / `defineAgent()`.

### ext.interceptor(key, run)

Register a raw Effect interceptor (bypassing the Promise-based `on()` wrapper):

```ts
import { extension, defineInterceptor } from "@gent/core/extensions/api"

extension("my-ext", (ext) => {
  ext.interceptor("prompt.system", (input, next) =>
    next({ ...input, basePrompt: input.basePrompt + "\nExtra." }),
  )
})
```

### ext.actor(actor)

Register a stateful actor from `fromReducer()` or `fromMachine()`.

```ts
import { extension, fromReducer } from "@gent/core/extensions/api"

const myActor = fromReducer({
  id: "my-actor",
  initial: { count: 0 },
  reduce: (state, event) => ({ state }),
  derive: (state, ctx) => ({ promptSections: [...] }),
})

extension("my-ext", (ext) => {
  ext.actor(myActor)
})
```

### ext.jobs(...jobs)

Register durable host-owned scheduled jobs.

```ts
extension("memory-jobs", (ext) => {
  ext.jobs({
    id: "reflect",
    schedule: "0 21 * * 1-5",
    target: {
      kind: "headless-agent",
      agent: "memory:reflect",
      prompt: "Reflect on recent sessions.",
    },
  })
})
```

### ext.layer(layer)

Provide Effect service layers. Multiple calls merge:

```ts
ext.layer(MyStorage.Live)
ext.layer(MyCache.Live) // merges with above
```

### ext.provider(provider)

Register an AI model provider:

```ts
ext.provider({
  id: "my-provider",
  name: "My Provider",
  resolveModel: (name, auth) => createModel(name, auth?.key),
})
```

### ext.interactionHandler(handler)

Register interaction handlers (permission, prompt, handoff, ask-user):

```ts
ext.interactionHandler({ type: "permission", layer: MyPermissionHandler.Live })
```

### ext.tagInjection(injection)

Register tag-conditional tool injections:

```ts
ext.tagInjection({ tag: "debug", tools: [DebugTool] })
```

### ext.onStartupEffect(effect) / ext.onShutdownEffect(effect)

Register Effect-based lifecycle hooks (composes with `onStartup()`/`onShutdown()`):

```ts
ext.onStartupEffect(registerCronJobs)
ext.onShutdownEffect(removeCronJobs)
```
