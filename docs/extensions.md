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

### ext.state(config)

Stateful extensions via reducer pattern. **One call per extension.**

```ts
ext.state({
  initial: { turns: 0, lastTool: "" },
  reduce: (state, event) => {
    if (event.type === "turn-completed") {
      return { state: { ...state, turns: state.turns + 1 } }
    }
    if (event.type === "tool-call-succeeded") {
      return { state: { ...state, lastTool: event.raw._tag } }
    }
    return { state }
  },
  derive: (state) => ({
    promptSections: [{ id: "turn-count", content: `Turns so far: ${state.turns}`, priority: 80 }],
  }),
})
```

**State is `Readonly<S>`** in the reducer — returning the same reference means "no change" (efficient ref equality check).

**Events** are curated `SimpleEvent` objects with kebab-case `type`:

| type                  | When                     |
| --------------------- | ------------------------ |
| `session-started`     | New session created      |
| `message-received`    | User message received    |
| `stream-started`      | LLM streaming begins     |
| `stream-ended`        | LLM streaming ends       |
| `turn-completed`      | Turn finished            |
| `tool-call-started`   | Tool execution begins    |
| `tool-call-succeeded` | Tool execution succeeded |
| `tool-call-failed`    | Tool execution failed    |
| `agent-switched`      | Active agent changed     |
| `error-occurred`      | Error in the agent loop  |

Internal/diagnostic events are filtered out before reaching your reducer.

**Effects** — trigger side effects from the reducer:

```ts
return {
  state: newState,
  effects: [{ type: "queue-follow-up", content: "Please review the changes." }],
}
```

**Persistence** — opt-in via discriminated config:

```ts
import { Schema } from "effect"

ext.state({
  initial: { count: 0 },
  reduce: (state, event) => {
    /* ... */
  },
  persist: {
    schema: Schema.Struct({ count: Schema.Number }),
  },
})
```

Omit `persist` for memory-only state. Missing `schema` with `persist` is a setup-time error.

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

### ext.actor(result)

Register a stateful actor from `fromReducer()` or `fromMachine()`. Mutually exclusive with `ext.state()`.

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
