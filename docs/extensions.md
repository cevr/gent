# Extension Authoring Guide

## Overview

Extensions add capabilities to gent: tools for the LLM, typed RPCs between
extensions, UI actions (slash commands / palette), read-only projections,
long-lived resources (with optional state machines, schedules, subscriptions),
agents, and LLM drivers.

Single entry point: `defineExtension({ id, ...buckets })`. Each bucket is a
typed array of values built with small factories. gent is a library used
inside Effect programs — every contribution returns `Effect`, no Promise edges.

## Quick Start

```ts
import { defineExtension, tool } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"

const GreetTool = tool({
  id: "greet",
  description: "Say hello to someone",
  params: Schema.Struct({
    name: Schema.String.annotate({ description: "Who to greet" }),
  }),
  execute: (params) => Effect.succeed(`Hello, ${params.name}!`),
})

export default defineExtension({
  id: "greet-ext",
  tools: [GreetTool],
})
```

That's it. Save as `~/.gent/extensions/greet.ts` and restart gent.

## Named Concepts

You need at most 8 concepts to write a complete extension:

| #   | Concept           | What it is                                       |
| --- | ----------------- | ------------------------------------------------ |
| 1   | `defineExtension` | Extension factory — takes `id` + typed buckets   |
| 2   | `tool`            | LLM-callable tool (params + execute)             |
| 3   | `request`         | Extension-to-extension typed RPC (read or write) |
| 4   | `action`          | Human-triggered UI affordance (slash / palette)  |
| 5   | `defineResource`  | Long-lived state with explicit scope             |
| 6   | `projection`      | Read-only view for prompt sections / tool policy |
| 7   | `defineAgent`     | Spawnable subagent                               |
| 8   | `PermissionRule`  | Allow/deny rule for tool patterns                |

All imports come from one path: `@gent/core/extensions/api`.

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

**Scope precedence**: Higher scope wins for same-key contributions. Project
overrides User overrides Builtin.

## Disabling Extensions

Create `.gent/disabled-extensions.json`:

```json
["extension-id-to-disable"]
```

Both `~/.gent/disabled-extensions.json` (user-level) and
`.gent/disabled-extensions.json` (project-level) are merged.

## Capabilities

Three typed factories replace the old `audiences[] + intent` flag matrix.
The `audience` concept is gone from authoring entirely — the factory choice
determines dispatch routing.

### tool — LLM-callable

```ts
import { defineExtension, tool } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"

const EchoTool = tool({
  id: "echo",
  description: "Echo back the input",
  params: Schema.Struct({ text: Schema.String }),
  execute: (params) => Effect.succeed(params.text),
})

export default defineExtension({
  id: "echo-ext",
  tools: [EchoTool],
})
```

`tool` fields:

- `id` — stable name (the LLM sees this as the tool name)
- `description` — sent to the LLM as the tool description
- `params` — `Schema.Schema` (must be context-free for sync JSON decode)
- `execute(params, ctx)` — returns `Effect`
- Optional: `idempotent`, `interactive`, `permissionRules`, `prompt`,
  `promptSnippet`, `promptGuidelines`, `resources`

### request — extension-to-extension RPC

```ts
import { defineExtension, ExtensionId, request } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"

const StatusExtensionId = ExtensionId.make("status-ext")

const GetStatus = request({
  id: "get-status",
  extensionId: StatusExtensionId,
  intent: "read",
  input: Schema.Struct({ key: Schema.String }),
  output: Schema.String,
  execute: (input) => Effect.succeed(`status for ${input.key}`),
})

const SetStatus = request({
  id: "set-status",
  extensionId: StatusExtensionId,
  intent: "write",
  input: Schema.Struct({ key: Schema.String, value: Schema.String }),
  output: Schema.Void,
  execute: (input) => Effect.succeed(void 0),
})

export default defineExtension({
  id: String(StatusExtensionId),
  rpc: [GetStatus, SetStatus],
})
```

`intent: "read"` capabilities have a **ReadOnly-branded R channel** — the
handler can only yield read-only services (`MachineExecute`,
`TaskStorageReadOnly`, etc.). Write-tagged services fail to compile.

### action — human-triggered UI affordance

```ts
import { defineExtension, action } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"

const DeployAction = action({
  id: "deploy",
  name: "/deploy",
  description: "Deploy the current branch",
  surface: "slash", // "slash" | "palette" | "both"
  input: Schema.Struct({}),
  output: Schema.Void,
  execute: () => Effect.logInfo("deploy requested"),
})

export default defineExtension({
  id: "deploy-ext",
  commands: [DeployAction],
})
```

## Projection (read-only derivation)

Use projections for prompt shaping, policy derivation, and read-only state views.

```ts
import { defineExtension, type ProjectionContribution } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"

const StatusProjection: ProjectionContribution<string> = {
  id: "status",
  query: () => Effect.succeed("ready"),
  prompt: (value) => [{ id: "status", title: "Status", content: value, priority: 0 }],
}

export default defineExtension({
  id: "status-ext",
  projections: [StatusProjection],
})
```

Read-only rule: projections are fenced. Their `R` channel may not yield write-capable services.

## Resource (long-lived state)

A Resource declares its scope (lifetime) and carries an optional service
Layer, state machine, schedule, subscriptions, and lifecycle hooks.

| Scope     | Lifetime                |
| --------- | ----------------------- |
| `process` | Server lifetime         |
| `cwd`     | Per working directory   |
| `session` | Per session (ephemeral) |
| `branch`  | Per branch (ephemeral)  |

```ts
import { defineExtension, defineResource } from "@gent/core/extensions/api"
import { Context, Layer, Effect } from "effect"

class MyService extends Context.Tag("MyService")<
  MyService,
  { readonly getData: () => Effect.Effect<string> }
>() {
  static Live = Layer.succeed(MyService, {
    getData: () => Effect.succeed("data"),
  })
}

export default defineExtension({
  id: "my-service-ext",
  resources: [defineResource({ tag: MyService, scope: "process", layer: MyService.Live })],
})
```

### Resource.machine

Attach an `effect-machine` state machine to a Resource:

```ts
defineResource({
  tag: MyService,
  scope: "process",
  layer: MyService.Live,
  machine: myMachine,
})
```

Use `subscriptions` on a Resource for turn reactions and side effects:

```ts
import { defineExtension, defineResource } from "@gent/core/extensions/api"
import { Effect } from "effect"

export default defineExtension({
  id: "turn-logger",
  resources: [
    defineResource({
      scope: "process",
      subscriptions: [
        {
          pattern: "agent:TurnCompleted",
          handler: (event) => Effect.logInfo(`Observed ${event.channel}`),
        },
      ],
    }),
  ],
})
```

## Agent

```ts
import { defineExtension, defineAgent, ModelId } from "@gent/core/extensions/api"

const helper = defineAgent({
  name: "helper",
  description: "Helper for specific tasks",
  model: ModelId.make("anthropic/claude-sonnet-4-6"),
  allowedTools: ["read", "write"],
})

export default defineExtension({
  id: "helper-ext",
  agents: [helper],
})
```

## Validation

The framework validates all loaded extensions before creating the registry:

- **At most one** Resource with `machine` per extension
- **Duplicate IDs** in same scope degrade the conflicting extension
- **Model-audience tools** require a non-empty `description`
- Same-name tools/agents/drivers in same scope degrade

Cross-scope: higher scope wins silently (project overrides user overrides
builtin).

## In-tree Examples

| Extension                               | Demonstrates                                    |
| --------------------------------------- | ----------------------------------------------- |
| `packages/extensions/src/session-tools` | `tool` + explicit prompt/policy integration     |
| `packages/extensions/src/task-tools`    | `tool` + `request` + `defineResource` + machine |
| `packages/extensions/src/memory`        | `tool` + projection + `defineResource`          |
| `packages/extensions/src/auto.ts`       | `defineResource` with `machine` + projection    |

## Migration Notes

- `query(...)` / `mutation(...)` -> `request(...)`
- `command(...)` -> `action(...)`
- projection constructor folklore -> typed `ProjectionContribution` object literals in `projections: [...]`
- generic middleware APIs are gone from the authoring model
- `_kind` contribution unions are gone; the bucket name is the discriminator

See `docs/migrations/runtime-union-provider.md` for concrete before/after recipes.
