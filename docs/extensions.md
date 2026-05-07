# Extension Authoring Guide

## Overview

Extensions add leaf capabilities to gent: tools for the LLM, typed RPCs between
extensions, UI actions (slash commands / palette), scoped resources, turn
reactions, agents, and LLM drivers.

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
| 5   | `defineResource`  | Scoped service/lifecycle/schedule declaration    |
| 6   | `reactions`       | Turn/message/tool-result hooks                   |
| 7   | `defineAgent`     | Spawnable subagent                               |
| 8   | `PermissionRule`  | Allow/deny rule for tool patterns                |

Third-party extensions import authoring primitives from one path:
`@gent/core/extensions/api`.

Gent-owned builtins may additionally use the private
`packages/extensions/internal/builtin.ts` bridge for runtime services that are
not part of the authoring API. Project and user extensions must not import that
bridge.

## Public vs Builtin-Internal API

`@gent/core/extensions/api` is intentionally small. It is for authoring
extensions, not for reaching into Gent runtime internals.

Public authoring surface:

| Area            | Public exports                                                                  |
| --------------- | ------------------------------------------------------------------------------- |
| Extension shape | `defineExtension`, `GentExtension`, `ExtensionSetupContext`                     |
| Capabilities    | `tool`, `request`, `ref`, `action`                                              |
| Resources       | `defineResource`, `resource`, resource scope/schedule types, `ReadOnly` helpers |
| Reactions       | Reaction input/output types needed to implement `reactions`                     |
| Agents          | `defineAgent`, `AgentName`, `ModelId`, run-spec helpers                         |
| Stable ids      | `ExtensionId`, `TaskId`, `ArtifactId`, `ToolCallId`                             |
| Policies/errors | `PermissionRule`, capability/provider-auth/agent-run author-facing errors       |
| Serialization   | Message/output projection helpers safe to expose across extension boundaries    |

Builtin-internal surface:

| Area             | Internal examples                                                                   |
| ---------------- | ----------------------------------------------------------------------------------- |
| Host plumbing    | `ExtensionHostContext`, tool-execute input, projection internals                    |
| Runtime services | `ToolRunner`, `GentPlatform`, agent loop/session runtime internals                  |
| Storage/events   | task/session mutation services, event publisher/store, interaction pending reader   |
| Drivers/auth     | driver registry internals and provider auth persistence machinery                   |
| Raw domain       | raw events, task internals, message internals not in the serialized author contract |
| Test helpers     | raw tool metadata, `getToolEffect`, fixture builders                                |

Builtin extensions import privileged services from
`packages/extensions/internal/builtin.ts`. That bridge is a private implementation
detail and is not exported from `@gent/extensions`.

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

Three typed factories own dispatch routing. RPCs declare
`intent: "read" | "write"` for read-only fencing and host dispatch.

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
- Optional: `intent`, `needs`, `interactive`, `permissionRules`, `prompt`,
  `promptSnippet`, `promptGuidelines`

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
  requests: [GetStatus, SetStatus],
})
```

`intent: "read"` RPCs have a **ReadOnly-branded R channel** — the handler can
only yield read-only services (`TaskStorageReadOnly`, `MemoryVaultReadOnly`,
etc.). Write-tagged services fail to compile.

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
  actions: [DeployAction],
})
```

## Reactions (turn-time derivation)

Use `reactions.turnProjection` for prompt shaping and tool-policy derivation.
Handlers should depend on read-only service Tags when they only inspect state.

```ts
import { defineExtension } from "@gent/core/extensions/api"
import { Effect } from "effect"

export default defineExtension({
  id: "status-ext",
  reactions: {
    turnProjection: () =>
      Effect.succeed({
        promptSections: [{ id: "status", content: "ready", priority: 0 }],
        toolPolicy: { include: ["status"] },
      }),
  },
})
```

## Resource (long-lived state)

A Resource declares its scope (lifetime) and carries a service Layer plus
optional schedule and lifecycle hooks. Extension-owned state should live in
scoped services/resources; true actor protocols belong at their owning runtime
boundary through Effect Entity/RPC, not in extension authoring buckets.

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

- **Duplicate IDs** in same scope degrade the conflicting extension
- **Model-callable tools** require a non-empty `description`
- Same-name tools/agents/drivers in same scope degrade

Cross-scope: higher scope wins silently (project overrides user overrides
builtin).

## In-tree Examples

| Extension                               | Demonstrates                                 |
| --------------------------------------- | -------------------------------------------- |
| `packages/extensions/src/session-tools` | `tool` + explicit prompt/policy integration  |
| `packages/extensions/src/task-tools`    | `tool` + `request` + scoped storage resource |
| `packages/extensions/src/memory`        | `tool` + reaction + `defineResource`         |
| `packages/extensions/src/auto/index.ts` | `reactions:` + scoped workflow services      |

## Surface Invariants

- Extension callables are `tool(...)`, `request(...)`, and `action(...)`.
- Extension buckets are `tools`, `requests`, and `actions`; older `rpc` and
  `commands` bucket names are not part of the authoring surface.
- Prompt shaping and policy derivation live in `reactions.turnProjection`.
- Long-lived state lives in `defineResource(...)`.
- Generic middleware APIs are not part of extension authoring.
- Bucket names are the discriminator; extension authors do not build flat `_kind` contribution unions.
