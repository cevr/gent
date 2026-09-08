# Extension Authoring Guide

## Overview

Extensions add leaf capabilities to gent: tools for the LLM, typed RPCs between
extensions, scoped resources, lifecycle hooks, agents, and LLM drivers.

Single entry point: `defineExtension({ id, setup })`. `setup` is an Effect
that yields `ExtensionHost` and registers values built with small factories:
`host.register(domain, ...values)` for leaves and `host.on(kind, handler)` for
hooks. gent is a library used inside Effect programs — setup, tools, requests,
and hooks return `Effect`, no Promise edges.

## Quick Start

```ts
import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api"
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
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", GreetTool)
  }),
})
```

That's it. Save as `~/.gent/extensions/greet.ts` and restart gent.

For the smallest complete product loop, see
`examples/extensions/session-notes.ts`. It is still one file, but covers the
real shape an author reaches for after the first tool: process-scoped state,
a model-callable tool, a slash-presented request, and a turn projection hook.
Its regression test loads the file through the public package path and executes
the contributed tool and hook under the real resource layer while checking the
slash request through the registry surface.

For capabilities that should appear only after a runtime decision, see
`examples/extensions/dynamic-scratchpad.ts`. It starts with one slash-presented
installer request, then uses `ExtensionContext.Dynamic` to register a
session-scoped tool and slash request. Its RPC acceptance test proves the
dynamic slash command appears, the model sees the dynamic tool, and the dynamic
request reads the same extension-owned state.

## Named Concepts

You need at most 7 concepts to write a complete extension:

| #   | Concept           | What it is                                          |
| --- | ----------------- | --------------------------------------------------- |
| 1   | `defineExtension` | Extension factory — takes `id` + one `setup` Effect |
| 2   | `ExtensionHost`   | Setup-time host: `register`, `on`, cwd/home facts   |
| 3   | `tool`            | LLM-callable tool (params + execute)                |
| 4   | `request`         | Extension-to-extension typed RPC                    |
| 5   | `defineResource`  | Scoped service/lifecycle/schedule declaration       |
| 6   | `defineAgent`     | Spawnable subagent                                  |
| 7   | `PermissionRule`  | Allow/deny rule for tool patterns                   |

Registration domains: `"tool"`, `"request"`, `"resource"`, `"job"`, `"agent"`,
`"modelDriver"`, `"externalDriver"`. Hook kinds: `"systemPrompt"`,
`"turnProjection"`, `"turnAfter"`, `"toolCall"`, `"toolResult"`.

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
| Extension shape | `defineExtension`, `GentExtension`, `ExtensionHost`                          |
| Capabilities    | `tool`, `request`, `ref`                                                     |
| Resources       | `defineResource`, `defineStateResource`, `ResourceId`, `ResourceRevision`    |
| Hooks           | `host.on(kind, handler)` and hook input/output types                         |
| Agents          | `defineAgent`, `AgentName`, `ModelId`, run-spec helpers                      |
| Stable ids      | `ExtensionId`, `ArtifactId`, `ToolCallId`, `ResourceId`, `ResourceRevision`  |
| Policies/errors | `PermissionRule`, capability/provider-auth/agent-run author-facing errors    |
| Host facts      | `ExtensionHost.host` and `ExtensionHost.Process`                             |
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
never reach into runtime Tags. `ctx.State.changed(...)` uses the current
extension identity supplied by the host; do not pass an extension ID. If an
extension needs private state, it
should import its own service Tag from a `defineResource(...)` layer and
yield that service directly. Do not add ctx parameters, private builtin APIs,
capability labels, or read/write metadata when ordinary Effect service access
already expresses the authority.

`ExtensionHost.host` and `ExtensionHost.Process` are the only public host
platform views at setup time. They expose small, serializable facts and narrow
host probes such as OS info, executable path, home directory, command-name
candidates, and loopback port probing.
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
import { defineExtension, ExtensionHost, tool } from "@gent/core/extensions/api"
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
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", EchoTool)
  }),
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
import { defineExtension, ExtensionHost, request } from "@gent/core/extensions/api"
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
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("request", GetStatus, SetStatus)
  }),
})
```

Request handlers receive params only. Host authority comes from
`yield* ExtensionContext`, and extension-owned services are ordinary Effect
services; authors import the smallest service Tag they need rather than
declaring capability labels. The loader binds every registered request to the
enclosing `defineExtension({ id })`, so the extension id is written once. Client-only protocol modules that export refs before server setup can use
`defineRequests(extensionId, { ...requests })` to bind a whole request map with
one id.

## Hooks (turn-time derivation)

Use `host.on("turnProjection", ...)` for prompt shaping and tool-policy
derivation. Hook handlers receive their event input only. Host authority follows
the same authoring model as tools and requests: `yield* ExtensionContext` or the
smallest extension-owned service Tag needed.

```ts
import { defineExtension, ExtensionContext, ExtensionHost } from "@gent/core/extensions/api"
import { Effect } from "effect"

export default defineExtension({
  id: "status-ext",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.on("turnProjection", () =>
      Effect.succeed({
        promptSections: [{ id: "status", content: "ready", priority: 0 }],
        toolPolicy: { include: ["status"] },
      }),
    )
    yield* host.on("turnAfter", () =>
      Effect.gen(function* () {
        const ctx = yield* ExtensionContext
        yield* ctx.Session.queueFollowUp({ sourceId: "status-ext", content: "status updated" })
      }),
    )
  }),
})
```

Lifecycle extension points are typed hook kinds, not keyed middleware bags:
`systemPrompt`, `turnProjection`, `turnAfter`, `toolCall`, and `toolResult`.
Each `host.on` call is typed by the kind's input and output.

## Dynamic Capabilities

Use `ExtensionContext.Dynamic` when an extension needs to register tools or
requests for the current session after setup. Dynamic registration is still
ordinary Effect code: the installing request or hook yields `ExtensionContext`,
registers public `tool(...)` / `request(...)` leaves, and stores any private
state in extension-owned services.

```ts
const install = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const unregisterTool = yield* ctx.Dynamic.registerTool(ScratchpadAppendTool)
  const unregisterRequest = yield* ctx.Dynamic.registerRequest(ShowScratchpad)
})
```

The host supplies the current extension identity, so authors register leaves
instead of threading extension IDs through dynamic calls. The returned effects
unregister the dynamic leaves. Keep them when the
extension owns a lifecycle that should later remove or replace the capability.
For the complete shape, including state and slash presentation, see
`examples/extensions/dynamic-scratchpad.ts`.

## Resource (long-lived state)

A Resource declares a stable `id`, an optional semantic `revision`, its scope
(lifetime), and a service Layer plus optional schedule and lifecycle hooks.
Declare `requires` with stable resource IDs when activation needs other
resources. `required` marks a root policy resource and defaults to `false`.
The revision records resource semantics, including configuration changes, and
defaults to `"1"`. Extension-owned state should live in scoped
services/resources; `defineStateResource(...)` is the low-ceremony state cell
helper for that case. True actor protocols belong at their owning runtime
boundary through Effect Entity/RPC, not in extension registrations.

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
  ExtensionHost,
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
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "resource",
      defineResource({
        id: "my-service-ext/service",
        tag: MyService,
        scope: "process",
        layer: MyService.Live,
      }),
      defineStateResource({
        id: "my-service-ext/counter-state",
        tag: CounterState,
        scope: "process",
        initial: 0,
      }),
    )
  }),
})
```

Setup already runs as an Effect, so a resource that needs host facts reads
them from the same `host` value (`host.cwd`, `host.home`,
`host.host.commandCandidates`) before registering; the resource itself should
still expose the smallest service Tag it needs.

## Agent

```ts
import { defineExtension, defineAgent, ExtensionHost, ModelId } from "@gent/core/extensions/api"
import { Effect } from "effect"

const helper = defineAgent({
  name: "helper",
  description: "Helper for specific tasks",
  model: ModelId.make("anthropic/claude-sonnet-4-6"),
  allowedTools: ["read", "write"],
})

export default defineExtension({
  id: "helper-ext",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("agent", helper)
  }),
})
```

## Validation

The framework validates all loaded extensions before creating the registry:

- **Duplicate IDs** in same scope degrade the conflicting extension
- **Model-callable tools** require a non-empty `description`
- Same-name tools/agents/drivers in same scope degrade

Cross-scope: higher scope wins silently (project overrides user overrides
builtin).

## Repairing an Unavailable Resource Owner

Gent does not create a default profile when a durable resource graph for the
launch directory cannot be reacquired. The graph control plane remains
available from a server started for another healthy directory with the same
SQLite database.

```ts
import { CanonicalCwd, RequestId, ResourceGraphRevision } from "@gent/sdk"

const targetCwd = CanonicalCwd.make("/path/to/failed-project")
const server =
  yield *
  Gent.server({
    cwd: "/tmp/gent-control",
    state: Gent.state.sqlite({ dbPath: "/path/to/gent.db" }),
  })
const { client } = yield * Gent.client(server, { cwd: String(targetCwd) })
const status = yield * client.resourceGraph.get({ cwd: targetCwd })

if (status === null) throw new Error("No durable resource graph exists for the target")

// Preview the target declarations without publishing or acquiring resources.
// The loader supplies the artifact identity. Do not invent source strings or
// revisions from a package name, path, or file digest.
const correctedSnapshot = yield * client.resourceGraph.preview({ cwd: targetCwd })
const receipt =
  yield *
  client.resourceGraph.submit({
    cwd: targetCwd,
    commandId: RequestId.make("repair-2026-09-06"),
    expectedRevision: status.desiredRevision,
    desiredRevision: ResourceGraphRevision.make("profile-repair/1"),
    snapshot: correctedSnapshot,
  })
```

Use the returned `desiredRevision` as `expectedRevision` when submitting a
corrected snapshot. The target `cwd` selects the workspace header. The control
server must use the same database. A failed source identity remains visible as
failed or pending until a valid snapshot is applied. Wait for
`client.resourceGraph.get({ cwd: targetCwd })` to report `state: "applied"`;
submission only records and queues the command.

Preview does not publish a catalog or acquire declared resources. It runs trusted
extension setup to read the declarations. Setup can perform its own effects.
Preview is not a sandbox or a general side-effect-free operation.

## In-tree Examples

| Extension                               | Demonstrates                                 |
| --------------------------------------- | -------------------------------------------- |
| `packages/extensions/src/session-tools` | `tool` + explicit prompt/policy integration  |
| `examples/extensions/session-notes.ts`  | one-file tool + slash request + state + hook |

## Surface Invariants

- Extension callables are `tool(...)` and `request(...)`.
- Extensions register through `host.register(domain, ...values)` and
  `host.on(kind, handler)`; there are no per-kind buckets on
  `defineExtension`.
- Prompt shaping and policy derivation live in `host.on("turnProjection", ...)`.
- Long-lived state lives in `defineResource(...)` or `defineStateResource(...)`.
- Generic middleware APIs are not part of extension authoring.
- The registration domain is the discriminator; extension authors do not build flat `_kind` contribution unions.
- Builtins, user extensions, and project extensions use the same public API.
- Builtins are the starting extension set, not privileged APIs or registry
  shortcuts.
- Handlers take input only; host authority comes from `yield* ExtensionContext`.
- Extension-private authority is an imported service Tag from a resource layer,
  not a read/write or capability declaration.
- Runtime services such as `GentPlatform`, `ToolRunner`, `ExtensionEventSink`,
  storage Tags, event stores, and process helpers are not public extension API.
