# Extension Authoring Guide

## Overview

Extensions add leaf capabilities to gent: tools for the LLM, typed RPCs between
extensions, scoped resources, runtime hooks, agents, and LLM drivers.

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

## Named Concepts

You need at most 7 concepts to write a complete extension:

| #   | Concept           | What it is                                          |
| --- | ----------------- | --------------------------------------------------- |
| 1   | `defineExtension` | Extension factory — takes `id` + one `setup` Effect |
| 2   | `ExtensionHost`   | Setup-time host: `register`, `on`, cwd/home facts   |
| 3   | `tool`            | LLM-callable tool (params + execute)                |
| 4   | `request`         | Extension-to-extension typed RPC                    |
| 5   | `defineResource`  | Scoped service layer with a stable id               |
| 6   | `AgentDefinition` | Agent profile registered under `"agent"`            |

Registration domains: `"tool"`, `"request"`, `"resource"`, `"agent"`,
`"modelDriver"`. Hook kinds: `"systemPrompt"`,
`"turnProjection"`, `"turnAfter"`.

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
| Resources       | `defineResource`                                                             |
| Hooks           | `host.on(kind, handler)` and hook input/output types                         |
| Agents          | `AgentDefinition`, `AgentName`, `ModelId`, run-spec helpers                  |
| Stable ids      | `ExtensionId`, `ToolCallId`                                                  |
| Errors          | capability/provider-auth/agent-run author-facing errors                      |
| Host facts      | `ExtensionHost.host`                                                         |
| Processes       | `runProcess`, `ProcessError` over the Effect `ChildProcessSpawner`           |
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
  const detail = yield* ctx.Session.getDetail(ctx.sessionId)
  return detail.branches.length
})
```

`ExtensionContext` is the host-owned facade. It exposes session,
interaction, file lock, and state-pulse accessors
(`Session`, `Interaction`, `FileLock`, `State`)
plus stable invocation facts such as `sessionId`, `branchId`, `cwd`, and
`home`. The `FileLock` / `State` facets wrap the host-internal
`FileLockService` and `EventStore` so authors
never reach into runtime Tags. No facet duplicates an Effect platform
service: files, paths, processes, and ids come from `FileSystem`, `Path`,
`ChildProcessSpawner`, and `Crypto`, and a relative path resolves against
`ctx.cwd` with `path.resolve(ctx.cwd, p)`. `ctx.State.changed()` uses the current
extension identity, session, and branch supplied by the host. If an
extension needs private state, it
should import its own service Tag from a `defineResource(...)` layer and
yield that service directly. Do not add ctx parameters, private builtin APIs,
capability labels, or read/write metadata when ordinary Effect service access
already expresses the authority.

`ctx.Session.send` is the one verb that puts a user message into a branch.
Its `delivery` picks how the message lands, and each mode takes only its own
fields:

| `delivery` | Lands                                   | Own fields                                                             |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `"turn"`   | starts a turn on another branch         | `completion`, `commandId`                                              |
| `"queue"`  | waits behind the running turn           | `sourceId` (idempotency and `dequeueFollowUp` key), `metadata`, `wake` |
| `"steer"`  | joins the running turn at its next step | `requestId`, `metadata`, `wake`                                        |

A message carries no agent, run spec or interactive flag. Those belong to the
target session: `ctx.Session.create` sets them once in its `admission`.

`"queue"` and `"steer"` target the current branch when no `sessionId` and
`branchId` are named. A `"turn"` names its target, and the current branch
refuses it: a turn that waits on its own loop never returns, so it takes
`"queue"`.

Two verbs stop work, and both target the current branch when no `sessionId`
and `branchId` are named. A `requestId` makes a repeat of the same stop a
no-op.

- `ctx.Session.stop({ sessionId?, branchId?, requestId? })` stops the branch's
  running turn, whichever message opened it, and answers nothing.
- `ctx.Session.stopMessage({ sessionId?, branchId?, messageId, requestId? })`
  stops only what one message opens: its running turn, its turn that has not
  started yet, or its `"steer"` that no step has read (the steer is taken
  back). It waits for the branch's loop and answers `true` when the stop
  reached the message. It answers `false` when the loop no longer holds the
  message (its turn ended, or a step joined it into another turn), and when
  an earlier stop already stops the turn it opened. A steer taken back
  answers `true`, unless an earlier stop from the same branch already stops
  the turn the steer waited to join: that stop answered `true`, so the
  calling branch hears of it once. A stop that reaches a running turn takes
  the calling branch's own waiting `"steer"` messages back with it, so they
  never run as the next turn, and a later stop of one answers `false`.

A branch's loop that nothing holds is passivated after about a minute idle,
and the branch scope closes with it: a fiber forked into a branch resource
stops. Work that must outlive an idle stretch, such as a pending timer, holds
the loop with `ctx.Session.holdResident`, a scoped verb. The hold lasts until
its scope closes, so a timer that holds for its whole life releases the loop
when it fires or is cancelled:

```ts
import { ExtensionContext } from "@gent/core/extensions/api"
import { Effect } from "effect"

export const timer = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const fire = Effect.log("timer fired")
  yield* ctx.Session.holdResident.pipe(
    Effect.andThen(Effect.sleep("5 minutes")),
    Effect.andThen(fire),
    Effect.scoped,
  )
})
```

Outside a loop there is nothing to hold, and the verb does nothing.

`ExtensionHost.host` is the only public host platform view at setup time. It
exposes small, serializable facts such as OS info, executable path, and home
directory.
Extensions do not yield `GentPlatform` or reach into `@gent/core/runtime/*`.
A command runs through `runProcess` from `@gent/core/extensions/api`, which
needs the Effect `ChildProcessSpawner` in the requirement union. When extensions need more
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
- Optional: `readonly`, `destructive`, `interactive`, `dispatches`,
  `promptSnippet`, `promptGuidelines`

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
  execute: () => Effect.void,
})

export default defineExtension({
  id: "status-ext",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("request", GetStatus, SetStatus)
  }),
})
```

A request waits for the session's running turn: the turn holds the loop's
mutation permit until it ends, and a request is a side mutation until it says
otherwise. A request that does not change this branch's loop state (its queue,
follow-ups or messages) declares `answersDuringTurn: true` and answers mid-turn.
Reads qualify, and so do writes outside the loop, such as another session or
a process resource. Any request a client sends while the agent works needs it.

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
        yield* ctx.Session.send({
          delivery: "queue",
          sourceId: "status-ext",
          content: "status updated",
        })
      }),
    )
  }),
})
```

Lifecycle extension points are typed hook kinds, not keyed middleware bags:
`systemPrompt`, `turnProjection`, and `turnAfter`.
Each `host.on` call is typed by the kind's input and output.

## Resource (long-lived state)

A Resource declares a stable `id`, its scope (lifetime), and a service Layer
plus optional `start` and `stop` effects. Resources build in extension
resolution order, so a resource may depend on services from extensions that
resolve before its own. Extension-owned state is a resource whose
service is a `Ref` (or any Effect data cell) behind the extension's own Tag.
True actor protocols belong at their owning runtime
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
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api"
import { Context, Layer, Effect, Ref } from "effect"

class MyService extends Context.Service<MyService, { readonly getData: Effect.Effect<string> }>()(
  "my-service-ext/MyService",
) {
  static Live = Layer.succeed(MyService, {
    getData: Effect.succeed("data"),
  })
}

class CounterState extends Context.Service<CounterState, Ref.Ref<number>>()(
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
        scope: "process",
        layer: MyService.Live,
      }),
      defineResource({
        id: "my-service-ext/counter-state",
        scope: "process",
        layer: Layer.effect(CounterState, Ref.make(0)),
      }),
    )
  }),
})
```

Setup already runs as an Effect, so a resource that needs host facts reads
them from the same `host` value (`host.cwd`, `host.home`,
`host.host.osInfo`, `host.host.homeDirectory`) before registering; the resource itself should
still expose the smallest service Tag it needs.

## Agent

```ts
import {
  AgentDefinition,
  AgentName,
  defineExtension,
  ExtensionHost,
  ModelId,
} from "@gent/core/extensions/api"
import { Effect } from "effect"

const helper = AgentDefinition.make({
  name: AgentName.make("helper"),
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

## In-tree Examples

| Extension                              | Demonstrates                                 |
| -------------------------------------- | -------------------------------------------- |
| `packages/extensions/src/agents.ts`    | `tool` + turn projection prompt sections     |
| `examples/extensions/session-notes.ts` | one-file tool + slash request + state + hook |

## Surface Invariants

- Extension callables are `tool(...)` and `request(...)`.
- Extensions register through `host.register(domain, ...values)` and
  `host.on(kind, handler)`; there are no per-kind buckets on
  `defineExtension`.
- Prompt shaping and policy derivation live in `host.on("turnProjection", ...)`.
- Long-lived state lives in `defineResource(...)`, typically a `Ref` behind the extension's Tag.
- Generic middleware APIs are not part of extension authoring.
- The registration domain is the discriminator; extension authors do not build flat `_kind` contribution unions.
- Builtins, user extensions, and project extensions use the same public API.
- Builtins are the starting extension set, not privileged APIs or registry
  shortcuts.
- Handlers take input only; host authority comes from `yield* ExtensionContext`.
- Extension-private authority is an imported service Tag from a resource layer,
  not a read/write or capability declaration.
- Runtime services such as `GentPlatform`, `ToolRunner`,
  storage Tags, event stores, and process helpers are not public extension API.
- Tagged-union variant tags are PascalCase. Extension health reports
  `"Healthy"` or `"Degraded"`, and a degraded extension carries
  `"ActivationFailed"` issues. An extension written against the earlier
  lowercase spellings (`"healthy"`, `"activation-failed"`) must be updated; match on the tag through
  the exported schema rather than a string literal where possible.
