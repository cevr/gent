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

Register a slash command. Handler receives args and `ExtensionHostContext`:

```ts
ext.command("deploy", {
  description: "Deploy the current branch",
  handler: async (args, ctx) => {
    const result = await ext.exec("deploy", [args])
    console.log(result.stdout)
    // Steer the agent via ctx.turn
    await Effect.runPromise(ctx.turn.queueFollowUp({ content: `Deployed: ${result.stdout}` }))
  },
})
```

### ext.exec(command, args?, options?)

Execute a shell command. Returns `Promise<{ stdout, stderr, exitCode }>`:

```ts
const result = await ext.exec("git", ["status"])
if (result.exitCode !== 0) console.error(result.stderr)
```

### ext.sendMessage(content, metadata?)

Queue a follow-up message after the current turn completes. Only usable from `ext.on()` handlers:

```ts
ext.on("turn.after", (input) => {
  ext.sendMessage("Follow-up analysis complete")
})
```

### ext.sendUserMessage(content)

Inject a user message mid-turn. Only usable from `ext.on()` handlers.

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
- **Same-type interaction handlers** from different extensions in same scope → conflicting extension degrades
- **Same-id prompt sections** from different extensions in same scope → conflicting extension degrades

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

Register one actor-shaped definition.

```ts
import { extension } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"
import { Event as MEvent, Machine, Slot, State as MState } from "effect-machine"
import { ExtensionMessage } from "@gent/core/domain/extension-protocol"

const CounterProtocol = {
  Increment: ExtensionMessage("my-ext", "Increment", {}),
}

const CounterState = MState({
  Active: { count: Schema.Number },
})

const CounterSlots = Slot.define({
  writeAudit: Slot.fn({ count: Schema.Number }),
})

const CounterEvent = MEvent({
  Increment: {},
})

const myActor = {
  machine: Machine.make({
    state: CounterState,
    event: CounterEvent,
    slots: CounterSlots,
    initial: CounterState.Active({ count: 0 }),
  }).on(CounterState.Active, CounterEvent.Increment, ({ state, slots }) =>
    slots
      .writeAudit({ count: state.count + 1 })
      .pipe(Effect.as(CounterState.Active({ count: state.count + 1 }))),
  ),
  slots: () =>
    Effect.succeed({
      writeAudit: () => Effect.void,
    }),
  mapCommand: (message) =>
    message.extensionId === "my-ext" && message._tag === "Increment"
      ? CounterEvent.Increment({})
      : undefined,
  snapshot: {
    schema: Schema.Struct({ count: Schema.Number }),
    project: (state) => ({ count: state.count }),
  },
}

extension("my-ext", (ext) => {
  ext.actor({ ...myActor, protocols: CounterProtocol })
})
```

`mapCommand()` and `mapRequest()` only run for messages declared through `actor.protocols`. Without a protocol definition, gent rejects the message before actor dispatch.

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

### ext.onStartupEffect(effect) / ext.onShutdownEffect(effect)

Register Effect-based lifecycle hooks (composes with `onStartup()`/`onShutdown()`):

```ts
ext.onStartupEffect(registerCronJobs)
ext.onShutdownEffect(removeCronJobs)
```
