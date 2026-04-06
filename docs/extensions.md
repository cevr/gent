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

**Scope precedence**: Higher scope wins for same-key contributions. Project overrides User overrides Builtin. Same-scope contribution collisions degrade the conflicting extension instead of crashing host startup.

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

## Dual-Surface API

The extension builder has two surfaces for hooks and commands:

- **`ext.on(key, handler)`** — Effect-native. Handlers return `Effect`, ctx is `ExtensionHostContext`.
- **`ext.async.on(key, handler)`** — Promise-based. Handlers return `Promise`, ctx is `ExtensionContext`.

Both register the same interceptors. Same capabilities, different ergonomics. Use `ext.async.*` if you don't want Effect; use `ext.*` for full Effect power.

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

### ext.command(name, options)

Register a slash command. Handler receives args and `ExtensionContext` (Promise-based):

```ts
ext.command("deploy", {
  description: "Deploy the current branch",
  handler: async (args, ctx) => {
    const result = await ext.exec("deploy", [args])
    console.log(result.stdout)
    await ctx.turn.queueFollowUp({ content: `Deployed: ${result.stdout}` })
  },
})
```

### ext.exec(command, args?, options?)

Execute a shell command. Returns `Promise<{ stdout, stderr, exitCode }>`:

```ts
const result = await ext.exec("git", ["status"])
if (result.exitCode !== 0) console.error(result.stderr)
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

### ext.on(key, handler) — Effect-native hooks

Register Effect-native interceptor hooks. Seven hook points available:

| Hook               | Type            | Description                      |
| ------------------ | --------------- | -------------------------------- |
| `prompt.system`    | Transform       | Modify the system prompt         |
| `tool.execute`     | Transform       | Intercept tool execution         |
| `permission.check` | Transform       | Override permission decisions    |
| `context.messages` | Transform       | Filter/modify context messages   |
| `tool.result`      | Transform       | Enrich/modify tool results       |
| `turn.after`       | Fire-and-forget | Post-turn side effects           |
| `message.input`    | Transform       | Transform user input before send |

Handlers receive `(input, next, ctx)` where `next` returns `Effect` and `ctx` is `ExtensionHostContext`:

```ts
ext.on("prompt.system", (input, next, ctx) =>
  next(input).pipe(Effect.map((result) => result + "\nCustom footer.")),
)

ext.on("turn.after", (input, next, ctx) =>
  Effect.gen(function* () {
    yield* next(input)
    yield* Effect.logInfo(`Turn completed in ${input.durationMs}ms`)
  }),
)

ext.on("message.input", (input, next, ctx) =>
  Effect.gen(function* () {
    const content = yield* next(input)
    return content.replace(/todo:/gi, "[ACTION ITEM]:")
  }),
)
```

### ext.async.on(key, handler) — Promise-based hooks

Same hooks, Promise ergonomics. Handlers receive `(input, next, ctx)` where `next` returns `Promise` and `ctx` is `ExtensionContext`:

```ts
ext.async.on("prompt.system", async (input, next, ctx) => {
  const result = await next(input)
  return result + "\nCustom footer."
})

ext.async.on("turn.after", async (input, next, ctx) => {
  await next(input)
  console.log(`Turn completed in ${input.durationMs}ms`)
})

ext.async.on("message.input", async (input, next, ctx) => {
  const content = await next(input)
  return content.replace(/todo:/gi, "[ACTION ITEM]:")
})
```

### Imperative Side Effects

Queue follow-up turns or inject messages from `ext.async.on()` handlers — no actors needed:

```ts
ext.async.on("turn.after", async (input, next) => {
  await next(input)
  if (shouldContinue(input)) {
    ext.sendMessage("Continue working on the task.")
  }
})

ext.async.on("tool.result", async (input, next) => {
  const result = await next(input)
  ext.sendUserMessage("I noticed something — let me check.")
  return result
})
```

Available in `turn.after`, `tool.execute`, `tool.result`, `context.messages`, `message.input` handlers. Not available in `prompt.system` or `permission.check` (throws descriptive error).

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

Subscribe to events via the channel-based event bus:

```ts
ext.bus.on("agent:*", (envelope) => {
  console.log(`[${envelope.channel}] payload=${JSON.stringify(envelope.payload)}`)
})
```

## Validation

The framework validates all loaded extensions before creating the registry:

- **Duplicate IDs** in same scope → conflicting extension degrades
- **Same-name tools** from different extensions in same scope → conflicting extension degrades
- **Same-name agents** from different extensions in same scope → conflicting extension degrades
- **Same-id providers** from different extensions in same scope → conflicting extension degrades
- **Same-id prompt sections** from different extensions in same scope → conflicting extension degrades

Cross-scope: higher scope wins silently (project overrides user overrides builtin).

## Full-Power Methods

The same `extension()` builder has additional methods for Effect-aware extensions. These are used by builtins and advanced authors.

### ext.tool(fullToolDef) / ext.agent(agentDefinition)

`tool()` and `agent()` are overloaded — they accept both simple defs (shown above) and full domain objects created via `defineTool()` / `defineAgent()`.

### ext.actor(actor)

Stateful extensions register one actor. Stateless extensions can omit this entirely.

```ts
import { extension } from "@gent/core/extensions/api"
import { Schema } from "effect"
import { Event as MEvent, Machine, State as MState } from "effect-machine"

const TurnState = MState({
  Active: { turns: Schema.Number },
})

const TurnEvent = MEvent({
  Published: { event: Schema.Unknown },
})

const turnCounterActor = {
  machine: Machine.make({
    state: TurnState,
    event: TurnEvent,
    initial: TurnState.Active({ turns: 0 }),
  }).on(TurnState.Active, TurnEvent.Published, ({ state, event }) =>
    event.event._tag === "TurnCompleted" ? TurnState.Active({ turns: state.turns + 1 }) : state,
  ),
  mapEvent: (event) => TurnEvent.Published({ event }),
  snapshot: {
    schema: Schema.Struct({ turns: Schema.Number }),
    project: (state) => ({ turns: state.turns }),
  },
  turn: {
    project: (state) => ({
      promptSections: [
        {
          id: "turn-count",
          content: `Turns so far: ${state.turns}`,
          priority: 80,
        },
      ],
    }),
  },
}

extension("turn-counter", (ext) => {
  ext.actor(turnCounterActor)
})
```

Rules:

- one actor per extension
- actor optional for stateless extensions
- actor owns state, snapshot, and turn projection
- actor transitions stay explicit: pure state changes in handlers, side effects through declared slots

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

### ext.onStartupEffect(effect) / ext.onShutdownEffect(effect)

Register Effect-based lifecycle hooks (composes with `onStartup()`/`onShutdown()`):

```ts
ext.onStartupEffect(registerCronJobs)
ext.onShutdownEffect(removeCronJobs)
```
