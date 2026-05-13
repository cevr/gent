# Extension Authoring Guide

## Overview

Extensions add leaf capabilities to gent: tools for the LLM, typed RPCs between
extensions, scoped resources, turn reactions, agents, and LLM drivers.

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
  output: Schema.String,
  execute: (params) => Effect.succeed(`Hello, ${params.name}!`),
})

export default defineExtension({
  id: "greet-ext",
  tools: [GreetTool],
})
```

That's it. Save as `~/.gent/extensions/greet.ts` and restart gent.

## Named Concepts

You need at most 7 concepts to write a complete extension:

| #   | Concept           | What it is                                     |
| --- | ----------------- | ---------------------------------------------- |
| 1   | `defineExtension` | Extension factory — takes `id` + typed buckets |
| 2   | `tool`            | LLM-callable tool (params + execute)           |
| 3   | `request`         | Extension-to-extension typed RPC               |
| 4   | `defineResource`  | Scoped service/lifecycle/schedule declaration  |
| 5   | `reactions`       | Turn/message/tool-result hooks                 |
| 6   | `defineAgent`     | Spawnable subagent                             |
| 7   | `PermissionRule`  | Allow/deny rule for tool patterns              |

Extensions import authoring primitives from one path:
`@gent/core/extensions/api`.

"Builtin" only means "shipped with Gent". Shipped, project, and user
extensions follow the same import contract; there is no private or privileged
extension API.

## Public API

`@gent/core/extensions/api` is the extension API. Anything an extension needs
must either live here as a stable authoring primitive or be redesigned so the
host owns it.

Public authoring surface:

| Area            | Public exports                                                               |
| --------------- | ---------------------------------------------------------------------------- |
| Extension shape | `defineExtension`, `GentExtension`, `ExtensionSetupContext`                  |
| Capabilities    | `tool`, `request`, `ref`                                                     |
| Resources       | `defineResource`, `defineStateResource`, resource scope/schedule types       |
| Reactions       | Reaction input/output types needed to implement `reactions`                  |
| Agents          | `defineAgent`, `AgentName`, `ModelId`, run-spec helpers                      |
| Stable ids      | `ExtensionId`, `ArtifactId`, `ToolCallId`                                    |
| Policies/errors | `PermissionRule`, capability/provider-auth/agent-run author-facing errors    |
| Host facts      | `ExtensionSetupContext.host`                                                 |
| Serialization   | Message/output projection helpers safe to expose across extension boundaries |

There is no builtin-internal surface. Shipped extensions are useful defaults,
not a second trust tier.

## Authority Model

Extension handlers receive product input only. They do not receive a `ctx`
parameter, and they do not declare read/write grants to ask for host power. If a
handler needs host authority, it yields the public facade:

```ts
import { ExtensionContext } from "@gent/core/extensions/api"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const messages = yield* ctx.Session.listMessages()
  return messages.length
})
```

`ExtensionContext` is the host-owned facade. It exposes session, agent,
interaction, process, file index, file lock, and state-pulse accessors
(`Session`, `Agent`, `Interaction`, `Process`, `Files`, `FileLock`, `State`)
plus stable invocation facts such as `sessionId`, `branchId`, `cwd`, and
`home`. The `Files` / `FileLock` / `State` facets wrap the host-internal
`FileIndex`, `FileLockService`, and `ExtensionStatePublisher` so authors
never reach into runtime Tags. If an extension needs private state, it
should import its own service Tag from a `defineResource(...)` layer and
yield that service directly. Do not add ctx parameters, private builtin APIs,
capability labels, or read/write metadata when ordinary Effect service access
already expresses the authority.

`ExtensionSetupContext.host` is the only public host platform view. It exposes
small, serializable facts and narrow host probes such as OS info, executable
path, home directory, command-name candidates, and loopback port probing.
Extensions do not yield `GentPlatform`, import `runProcess`, or reach into
`@gent/core/runtime/*`; process authority is available only through
`yield* ExtensionContext` and its `Process` facade. When extensions need more
host authority, the design answer is a new public authoring primitive or a
host-owned runtime feature.

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

Three typed factories own dispatch routing. RPC access is ordinary Effect code:
authors yield `ExtensionContext` or extension-owned service Tags for the
authority they need.

### tool — LLM-callable

```ts
import { defineExtension, tool } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"

const EchoTool = tool({
  id: "echo",
  description: "Echo back the input",
  params: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
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
- `output` — `Schema.Schema` validated by Effect AI before the tool result is
  returned to the model
- `execute(params)` — returns `Effect`; host access comes from
  `yield* ExtensionContext`
- Optional: `readonly`, `destructive`, `interactive`, `permissionRules`,
  `prompt`, `promptSnippet`, `promptGuidelines`

`readonly` and `destructive` are provider hints lowered to Effect AI's
`AiTool.Readonly` / `AiTool.Destructive` annotations. They are not authority
grants. Host authority still comes from `ExtensionContext` or an
extension-owned service.

### request — extension-to-extension RPC

```ts
import { defineExtension, request } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"

const GetStatus = request({
  id: "get-status",
  input: Schema.Struct({ key: Schema.String }),
  output: Schema.String,
  execute: (input) => Effect.succeed(`status for ${input.key}`),
})

const SetStatus = request({
  id: "set-status",
  input: Schema.Struct({ key: Schema.String, value: Schema.String }),
  output: Schema.Void,
  execute: (input) => Effect.succeed(void 0),
})

export default defineExtension({
  id: "status-ext",
  requests: [GetStatus, SetStatus],
})
```

Request handlers receive params only. Host authority comes from
`yield* ExtensionContext`, and extension-owned services are ordinary Effect
services; authors import the smallest service Tag they need rather than
declaring capability labels. `request(...)` refs derive their `extensionId`
from the enclosing `defineExtension({ id })`, so the extension id is written
once. Client-only protocol modules that export refs before server setup can use
`defineRequests(extensionId, { ...requests })` to bind a whole request map with
one id.

## Reactions (turn-time derivation)

Use `reactions.turnProjection` for prompt shaping and tool-policy derivation.
Reaction handlers receive their event input only. Host authority follows the
same authoring model as tools and requests: `yield* ExtensionContext`
or the smallest extension-owned service Tag needed.

```ts
import { defineExtension, ExtensionContext } from "@gent/core/extensions/api"
import { Effect } from "effect"

export default defineExtension({
  id: "status-ext",
  reactions: {
    turnProjection: () =>
      Effect.succeed({
        promptSections: [{ id: "status", content: "ready", priority: 0 }],
        toolPolicy: { include: ["status"] },
      }),
    turnAfter: {
      failureMode: "isolate",
      handler: () =>
        Effect.gen(function* () {
          const ctx = yield* ExtensionContext
          yield* ctx.Session.queueFollowUp({ sourceId: "status-ext", content: "status updated" })
        }),
    },
  },
})
```

## Resource (long-lived state)

A Resource declares its scope (lifetime) and carries a service Layer plus
optional schedule and lifecycle hooks. Extension-owned state should live in
scoped services/resources; `defineStateResource(...)` is the low-ceremony state
cell helper for that case. True actor protocols belong at their owning runtime
boundary through Effect Entity/RPC, not in extension authoring buckets.

| Scope     | Lifetime        |
| --------- | --------------- |
| `process` | Server lifetime |

`process` is the only public Resource scope today. `cwd`, `session`, and
`branch` are intentionally absent until those lifetimes have real host owners.
A `start` failure degrades only the owning extension, removes its dependent
contributions from active registries, and appears in extension health surfaces
including `gent doctor`.

```ts
import {
  defineExtension,
  defineResource,
  defineStateResource,
  type ExtensionState,
} from "@gent/core/extensions/api"
import { Context, Layer, Effect } from "effect"

class MyService extends Context.Service<
  MyService,
  { readonly getData: () => Effect.Effect<string> }
>()("my-service-ext/MyService") {
  static Live = Layer.succeed(MyService, {
    getData: () => Effect.succeed("data"),
  })
}

class CounterState extends Context.Service<CounterState, ExtensionState<number>>()(
  "my-service-ext/CounterState",
) {}

export default defineExtension({
  id: "my-service-ext",
  resources: [
    defineResource({ tag: MyService, scope: "process", layer: MyService.Live }),
    defineStateResource({ tag: CounterState, scope: "process", initial: 0 }),
  ],
})
```

Use `resources: () => Effect.gen(...)` only when setup needs public host facts.
Inside that factory, `yield* ExtensionSetupContext` exposes facts such as
`ctx.cwd` and `ctx.host.commandCandidates`; the resource itself should still
expose the smallest service Tag it needs.

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
| `packages/extensions/src/todo`          | `tool` + `request` + scoped storage resource |
| `packages/extensions/src/memory`        | `tool` + reaction + `defineResource`         |
| `packages/extensions/src/auto/index.ts` | `reactions:` + scoped workflow services      |

## Surface Invariants

- Extension callables are `tool(...)` and `request(...)`.
- Extension buckets are `tools` and `requests`; older `rpc`, `commands`, and
  unpublished `actions` bucket names are not part of the authoring surface.
- Prompt shaping and policy derivation live in `reactions.turnProjection`.
- Long-lived state lives in `defineResource(...)` or `defineStateResource(...)`.
- Generic middleware APIs are not part of extension authoring.
- Bucket names are the discriminator; extension authors do not build flat `_kind` contribution unions.
- Builtins, user extensions, and project extensions use the same public API.
- Builtins are the starting extension set, not privileged APIs or registry
  shortcuts.
- Handlers take input only; host authority comes from `yield* ExtensionContext`.
- Extension-private authority is an imported service Tag from a resource layer,
  not a read/write or capability declaration.
- Runtime services such as `GentPlatform`, `ToolRunner`, `ExtensionEventSink`,
  storage Tags, event stores, and process helpers are not public extension API.
