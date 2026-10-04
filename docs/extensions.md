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

That's it. Save as `~/.gent/extensions/greet.ts`. The next turn loads it; an
edited, added or removed extension file reaches the next turn the same way, with
no restart. An extension is built with the modules it imports by a relative
path, so an edit to one of them reaches the next turn too, and a save of the
same bytes changes nothing. Its top level runs once per version; setup runs
again on each new profile. An edit that breaks an extension that ran (it does
not build or import, its setup fails, it fails validation, or a process
Resource fails to build) keeps the last good version running, and health
reports the extension degraded with why the new version failed. Deleting the
file or disabling the id removes the extension; nothing is kept after that.

For the smallest complete product loop, see
`examples/extensions/session-notes.ts`. It is still one file, but covers the
real shape an author reaches for after the first tool: process-scoped state,
a model-callable tool, a slash-presented request, and a turn projection hook.
Its regression test (`examples/tests/session-notes.test.ts`) loads the file and
runs its tool, slash request and hooks over the RPC path, under the real
resource layer.

## Named Concepts

You need at most 6 concepts to write a complete extension:

| #   | Concept           | What it is                                          |
| --- | ----------------- | --------------------------------------------------- |
| 1   | `defineExtension` | Extension factory — takes `id` + one `setup` Effect |
| 2   | `ExtensionHost`   | Setup-time host: `register`, `on`, cwd/home facts   |
| 3   | `tool`            | LLM-callable tool (params + execute)                |
| 4   | `request`         | Extension-to-extension typed RPC                    |
| 5   | `defineResource`  | Scoped service layer with a stable id               |
| 6   | `AgentDefinition` | Agent profile registered under `"agent"`            |

Registration domains: `"tool"`, `"request"`, `"resource"`, `"agent"`,
`"modelDriver"`, `"apiClass"`, `"modelRouter"`. Hook kinds: `"systemPrompt"`,
`"turnProjection"`, `"turnAfter"`, `"loopOpen"`, `"sessionDeleted"`.

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
interaction, file lock, classifier, extension, and state-pulse accessors
(`Session`, `Interaction`, `FileLock`, `Models`, `Extensions`, `State`)
plus stable invocation facts such as `sessionId`, `branchId`, `cwd`, and
`home`. `Extensions.status` lists every extension of the session's profile
as an `ExtensionStatus` (`Active` with its version, `Failed` with the
phase that stopped it, or `Disabled`), and each config file that did not
load. An `Active` status with `reloadFailed` is a last good version still
running: a newer version of its file failed at that phase. It reads the extension files as they are now, so an extension an agent
just wrote shows there. `Extensions.reload(id)` runs every setup of the
profile again and returns the new statuses; an unchanged extension keeps its
process and branch Resources, a run that is going on keeps its profile, and
an id the profile does not name fails. Any extension gets this facet. The
shipped `@gent/extension-admin` extension gives it to the agent as the
read-only `extensions.status` tool (`packages/extensions/src/extension-admin.ts`). `Models.decide({ definition, input, model?, timeoutMs? })` asks a
classifier model (System One: Jev, Clef) every `effect/ai/Decision` of the
definition in one call and returns the answers, the model, the usage and the
cost; `Models.available` and `Models.classifiers` say which classifiers have
a credential. The `FileLock` / `Models` / `State` facets wrap the
host-internal `FileLockService`, `DecisionModelResolver` and `EventStore` so authors
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

A request that declares `answersDuringTurn: true` can `"steer"` into its own
branch while a turn runs: the steer joins that turn at its next step (a turn
parked on a blocking ask takes it before its first resumed model request), and
on an idle branch `wake: true` starts one. The `questions.answer` request of
`@gent/interaction-tools` delivers the user's answers to `ask_user_async`
questions this way.

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

Outside a loop there is nothing to hold, and the verb does nothing. A
`"queue"` send that asks to wake the loop holds it too, until the turn it
wakes has run, so the fire's hold can end right after its send.

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

List the extension ids under the `disabledExtensions` key of `.gent/config.json`:

```json
{ "disabledExtensions": ["extension-id-to-disable"] }
```

The user list (`~/.gent/config.json`) and the project list
(`.gent/config.json` in the working directory) are merged. A project list counts
only when the project is a scope of its own, not when gent runs from home.

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
  `promptSnippet`, `promptGuidelines`, `summary` (the one-line result summary
  a client shows for a call)

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
a process resource, and the `"queue"` and `"steer"` sends of
`ctx.Session.send`, which the loop's queue owner serializes on its own. Any
request a client sends while the agent works needs it.

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

`promptSections` is standing content: keep it byte-identical from step to
step. A section that changes makes the next step write the agent block and the
whole conversation again at the cache-write price. Content that changes during
a session goes in `notices`, which ride after the conversation and are never
cached (`examples/extensions/session-notes.ts` shows its notes this way).

```ts
import { defineExtension, ExtensionHost } from "@gent/core/extensions/api"
import { DateTime, Effect } from "effect"

export default defineExtension({
  id: "status-ext",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const today = DateTime.formatIsoDateUtc(yield* DateTime.now)
        return {
          // Standing: the same bytes at every step
          promptSections: [{ id: "status", content: "Keep status lines short.", priority: 0 }],
          // Changing: rides after the conversation
          notices: [{ id: "status-date", content: `Today: ${today}`, keys: [] }],
        }
      }),
    )
    // Records the turn and starts nothing
    yield* host.on("turnAfter", ({ durationMs, interrupted }) =>
      Effect.logDebug("status-ext: turn ended").pipe(
        Effect.annotateLogs({ durationMs, interrupted }),
      ),
    )
  }),
})
```

A `turnAfter` hook that sends a `"queue"` message starts another model turn,
at full price, and that turn's end runs the hook again. A fixed `sourceId`
makes the follow-up once per session. Send from `turnAfter` only when the
model must answer.

Lifecycle extension points are typed hook kinds, not keyed middleware bags:
`systemPrompt`, `turnProjection`, `turnAfter`, `loopOpen` (a branch's loop was
built in this process, or the extension's branch Resources were built again
after an edit or a disable and enable: re-arm timers, report lost work; a hook
still running when those Resources retire is interrupted before they release), and `sessionDeleted`
(remove what the extension keeps for a deleted session outside the database).
Each `host.on` call is typed by the kind's input and output.

## Resource (long-lived state)

A Resource is `defineResource({ id, scope, layer })`: a stable `id`, its scope
(lifetime), and a service Layer. Startup and shutdown work lives in the layer
itself (`Layer.effect`, with `Effect.addFinalizer` or `acquireRelease`).
Resources build in extension resolution order, so a resource may depend on services from extensions that
resolve before its own. Extension-owned state is a resource whose
service is a `Ref` (or any Effect data cell) behind the extension's own Tag.
True actor protocols belong at their owning runtime
boundary through Effect Entity/RPC, not in extension registrations.

| Scope     | Lifetime              |
| --------- | --------------------- |
| `process` | Server lifetime       |
| `branch`  | One agent-loop branch |

`cwd` and `session` are absent until those lifetimes have real host owners. A
`branch` resource starts without an `ExtensionContext`; work that needs the
session facade waits for the `loopOpen` hook.

```ts
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api"
import { Context, Layer, Effect, Ref } from "effect"

class MyService extends Context.Service<MyService, { readonly getData: Effect.Effect<string> }>()(
  "my-service-ext/MyService",
) {
  static Live = Layer.succeed(MyService, MyService.of({ getData: Effect.succeed("data") }))
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

## Model router

A `modelRouter` serves virtual models: ids `<router id>/<name>` that pick one
of their choices at the start of each turn. Each choice names a model, an
effort, or both, and a `reason`. Core calls `route` once per turn, before its
first request, records the pick (`ModelRouted`) and runs every step on it. A
route that fails, takes over 10 s or picks a choice the turn cannot run falls
back to the default choice (`fallback`, an index). `route` may ask classifiers
through `ExtensionContext.Models`; `input.current` says whether the branch's
prompt cache is warm and how many history tokens a switch writes again. The
shipped `@gent/router` builds its routers from the `routers` config key.

A router may also carry `effort`, the effort router that `/effort auto` asks:
a virtual model whose choices each set an `effort` and name no model. It is
not listed and not selectable. On a session on auto, core calls `route` with
it once per user turn, after any model route, offering only the levels the
turn's model accepts; it never asks for a child. On a warm cache it offers
only the level the cache was written at and the levels whose change the
model's driver carries inside the conversation: a driver says so with
`carriesEffort(modelName, hints, catalog)` on its `ModelDriverContribution`,
true where a change from the levels in `hints.reasoningHistory` to
`hints.reasoning` rides as a marker or an update and the request keeps the
bytes the previous request wrote: the same top-level effort and the same
changes before the reply. A driver without it carries no change, so its models change level
only on a cold cache. The first registered router with an `effort` serves
it. When the session runs on one of the same router's virtual models, the
model route's input carries the effort choices too (`input.effort`, each
choice with a model that takes it, or none); answer `effort: { choice,
reason }` beside the model choice to pick both in one classifier call, or
leave it out and core asks the effort router on its own. The shipped router
serves the `routers.effort` config entry, else built-in low, medium, high
and xhigh choices, and answers both in one call.

```ts
import {
  defineExtension,
  ExtensionHost,
  type Message,
  ModelId,
  type ModelRouterContribution,
} from "@gent/core/extensions/api"
import { Effect } from "effect"

const textLength = (message: Message) =>
  message.parts.reduce((sum, part) => {
    if (part.type !== "text") return sum
    return sum + part.text.length
  }, 0)

const byLength: ModelRouterContribution = {
  id: "by-length",
  name: "By length",
  models: [
    {
      name: "auto",
      label: "By length",
      fallback: 0,
      choices: [
        { model: ModelId.make("anthropic/claude-haiku-4-5"), reason: "short requests" },
        { model: ModelId.make("anthropic/claude-sonnet-5"), effort: "high", reason: "long ones" },
      ],
    },
  ],
  route: (input) =>
    Effect.sync(() => {
      const chars = input.messages.reduce((sum, message) => sum + textLength(message), 0)
      return { choice: Number(chars > 2_000), reason: `${chars} characters` }
    }),
}

export default defineExtension({
  id: "by-length-router",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("modelRouter", byLength)
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

| Extension                              | Demonstrates                                  |
| -------------------------------------- | --------------------------------------------- |
| `packages/extensions/src/agents.ts`    | `agent` + turn projection prompt sections     |
| `packages/extensions/src/mcp.ts`       | tools read at setup + a lazy process resource |
| `packages/extensions/src/router.ts`    | `modelRouter` from config + a classifier      |
| `examples/extensions/session-notes.ts` | one-file tool + slash request + state + hook  |
| `examples/extensions/prompt-rules.ts`  | `systemPrompt` hook                           |

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
  `"ActivationFailed"` or `"ModelCatalogFailed"` issues. An
  `"ActivationFailed"` issue with `runningVersion` is a failed reload: the new
  version failed and that last good version still runs. An extension the
  disabled list names is `"Disabled"`, in the optional `disabledExtensions`
  list of the snapshot. Match on the tag
  through the exported schema rather than a string literal where possible.
