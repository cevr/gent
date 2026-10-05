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
reports the extension degraded with why the new version failed. A last good
version whose tool, request, agent or driver id collides with another
extension's does not run: the extension is failed, and the other one runs.
Deleting the file or disabling the id removes the extension; nothing is kept
after that.

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
`"turnProjection"`, `"turnAfter"`, `"loopOpen"`, `"sessionDeleted"`,
`"toolCall"`.

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
an id the profile does not name fails, as does one a config turns off (it is
never set up). Any extension gets this facet. The
shipped `@gent/extension-admin` extension (`packages/extensions/src/extension-admin.ts`)
gives the agent `extensions.status`, `extensions.reload`, and four verbs that
change what the next turn loads: `extensions.enable` and `extensions.disable`
edit `disabledExtensions` in the user or project `config.json` (every other key
stays; a file that is not JSON or that gent would not read as a config is
refused, not replaced), `extensions.add` copies a file or directory into a
scope's extensions directory (an existing name is refused), and
`extensions.remove` moves one into a new directory of its own under
`extension-trash` in the data directory, so no remove replaces another. Each
of the four asks the user once
through `Interaction.approve`, naming the scope, the path and who it reaches;
a headless run declines. The `project` scope needs a project the user trusts,
and `user` is the default only when the session runs from home. A verb's
optional `resume` queues one message on its own branch (`Session.send`,
`delivery: "queue"`), so the agent goes on in the same task on the new
profile. Three requests serve the `/extensions` pane, the user's own hand, so
they never ask: `extensions.pane.status` reads the session's statuses with the
profile resolved again, `extensions.pane.set-enabled` turns an extension off in
the narrowest config that holds the session (the trusted project's, else the
user's) and on in every config that names it, and `extensions.pane.reload`
reloads one. A change pulses the extension's state, so every client reads its
health again. The pane (`apps/tui/src/extensions/extension-admin.client.tsx`)
draws a row per extension with its scope, its state (`on`, `reload failed`,
`failed`, `off`) and, after a failed reload, the version that still runs; a
narrow row drops the version, then the scope, and keeps the id and the state.
It opens on the first row that is not `on`. `space` turns the row off or on,
`r` sets it up again, `enter` shows a failure's whole text, and `esc` goes
back or closes. After each change the TUI loads its client extensions again. The bundled `extensions` skill carries the guide and a template. `Models.decide({ definition, input, model?, timeoutMs? })` asks a
classifier model (System One: Jev, Clef) every `effect/ai/Decision` of the
definition in one call and returns the answers, the model, the usage and the
cost; `Models.available` and `Models.classifiers` say which classifiers have
a credential. The `FileLock` / `Models` / `State` facets wrap the
host-internal `FileLockService`, `DecisionModelResolver` and `EventStore` so authors
never reach into runtime Tags. No facet duplicates an Effect platform
service: files, paths, processes, ids, and HTTP come from `FileSystem`, `Path`,
`ChildProcessSpawner`, `Crypto`, and `HttpClient`, and a relative path resolves against
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

| `delivery` | Lands                                   | Own fields                                                                         |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| `"turn"`   | starts a turn on another branch         | `completion`, `commandId`                                                          |
| `"queue"`  | waits behind the running turn           | `sourceId` (idempotency and `dequeueFollowUp` key), `metadata`, `wake`, `ifLatest` |
| `"steer"`  | joins the running turn at its next step | `requestId`, `metadata`, `wake`                                                    |

A `"queue"` with `ifLatest: <messageId>` is conditional: it starts its turn at
once or it is not admitted. The loop admits it only while the branch is idle,
nothing waits in its queue (a parked steer, a follow-up), and `ifLatest` is
still the newest message a person or an extension sent to the branch. The
test and the admission are one step under the queue's permit, so a message a
user sends after the extension decided still wins. `@gent/wake` sends its
auto-resume this way. A line that is not admitted changes nothing. An admitted
line is a promise: it is stored before `send` returns, so the extension can
forget its own record, and a restart before its turn starts runs it once,
with no new test of `ifLatest`.

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

An extension file resolves `@gent/core/extensions/api`,
`@gent/core/extensions/branch-tools`, `effect`, and each `effect/*` module a
shipped extension imports (`effect/ai`, `effect/http`, `effect/process`,
`effect/sql` and the others `extensionEntryModules` in
`packages/core/src/runtime/extension-host.ts` lists). Core binds them to the
modules gent runs, so a Tag or Schema class the file imports is the one core
uses, in tests as in the binary. The gent server also binds the `@effect/*`
packages the shipped extensions import (the provider SDKs and
`@effect/platform-bun`). Any other package import resolves from the file's
own directory.

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
- `resources` — the `defineResource` values whose services the body yields.
  Write the array inline (`resources: [Counter]`) or type it as a tuple: an
  array type such as `ReadonlyArray<typeof Counter>` can be empty, so it
  grants no services.
  The same extension must register each one, or the extension fails to load
  with `tools[i] (id): names resource "…", which this extension does not register`.
- Optional: `readonly`, `destructive`, `interactive`, `dispatches`,
  `promptSnippet`, `promptGuidelines`, `summary` (the one-line result summary
  a client shows for a call), `recover` (settles a call of this tool that a
  crash left with no result: the loop calls it when the turn resumes, with the
  services the body gets, and it answers `Settled`, `Suspended` or
  `NotRecovered` from `ToolCallRecoveryOutcome` in
  `@gent/core/extensions/branch-tools`; a tool without it is reported to the
  model as interrupted)

A tool whose work outlives a fiber interrupt (a worker process, or a body that
runs uninterruptibly so it can report a cancel) reads `CurrentTurnStop` from
`@gent/core/extensions/branch-tools`: `stopped` completes when the turn is
interrupted or its loop closes, `isStopped` reads that now, and `closing` says
which. The cell races its run against `stopped`: a cancel ends the run and
reports it, a close ends it and records nothing, so a restart finds the call
as a crash leaves it.

The body may yield only the services every root gives a tool: `ExtensionContext`,
the platform services (`FileSystem`, `Path`, `ChildProcessSpawner`, `Crypto`,
`HttpClient`, and the `GentPlatform` that helpers such as `saveToolImage` read),
the core services the branch-tools entry exports (`BranchToolHostServices`:
`EventStore`, `MessageStorage`, `InteractionStorage`, `ToolRunner`), and the
services of its `resources`. A body that requires any other service does not
compile. The bound is on the services
the body requires (its `R`), not on the runtime context:
`Effect.serviceOption` still reads a service the root holds. A tool that
keeps state names the
resource that holds it:

```ts
import { defineExtension, defineResource, ExtensionHost, tool } from "@gent/core/extensions/api"
import { Context, Effect, Layer, Ref, Schema } from "effect"

class Tally extends Context.Service<Tally, Ref.Ref<number>>()("tally-ext/Tally") {}

const TallyResource = defineResource({
  id: "tally-ext/tally",
  scope: "process",
  layer: Layer.effect(Tally, Ref.make(0)),
})

const CountTool = tool({
  id: "count",
  description: "Count the calls of this tool in this process",
  params: Schema.Struct({}),
  output: Schema.Finite,
  resources: [TallyResource],
  execute: () => Effect.flatMap(Tally, (tally) => Ref.updateAndGet(tally, (n) => n + 1)),
})

export default defineExtension({
  id: "tally-ext",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("resource", TallyResource)
    yield* host.register("tool", CountTool)
  }),
})
```

A tool test runs the body with `runToolWithCtx` from `@gent/core/test-utils`.
It gives the body a stub `ExtensionContext` and the platform services
production gives it; a service the test provides replaces the harness one. The
test provides the services of the tool's resources itself.

`readonly` and `destructive` are provider hints lowered to Effect AI's
`AiTool.Readonly` / `AiTool.Destructive` annotations. They are not authority
grants. Host authority still comes from `ExtensionContext` or an
extension-owned service.

A tool that fails reaches the model as a failed tool result that holds only
its error's message text (`{ "error": "Tool 'verse' failed: NotFound: …" }`);
the error's other fields do not reach the model. A tool whose failure the
model should read field by field fails with
`ToolResultFailure({ message, result })` from `@gent/core/extensions/api`:
its JSON `result` is the failed tool result the model reads, and `message`
names the failure in logs.

```ts
import { tool, ToolResultFailure } from "@gent/core/extensions/api"
import { Effect, Option, Schema } from "effect"

const verses = new Map([["John 3:16", "For God so loved the world…"]])

export const VerseTool = tool({
  id: "verse",
  description: "Read one verse by its reference",
  params: Schema.Struct({ reference: Schema.String }),
  output: Schema.String,
  execute: ({ reference }) =>
    Effect.fromOption(Option.fromUndefinedOr(verses.get(reference))).pipe(
      Effect.mapError(
        () =>
          new ToolResultFailure({
            message: `no verse ${reference}`,
            result: { error: "NotFound", reference, known: [...verses.keys()] },
          }),
      ),
    ),
})
```

#### Tool images

A tool hands the model an image by reference. `saveToolImage` stores the
bytes once in the content-addressed blob store,
`<data dir>/blobs/<sha256>.<ext>`, and returns a `ToolImage` (`sha256`,
`mediaType`, `width`, `height`, `bytes`, `source`, and `originalWidth` and
`originalHeight` when the store scaled it). Put it anywhere in the
tool's output; the output schema holds it as `ToolImage`.

```ts
import { saveToolImage, tool, ToolImage } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"

export const ScreenshotTool = tool({
  id: "screenshot",
  description: "Show the model the picture at a path",
  params: Schema.Struct({ path: Schema.String }),
  output: Schema.Struct({ image: ToolImage }),
  execute: ({ path }) =>
    Effect.gen(function* () {
      // A relative path resolves against the session cwd; it is the image's
      // `source` unless the input names one.
      return { image: yield* saveToolImage({ path }) }
    }),
})
```

`saveToolImage` takes `{ bytes }` or `{ path }`, and an optional `source`
label. It takes PNG, JPEG, GIF and WebP. An upright image within 3.75 MiB and
2,000 pixels a side is stored byte for byte. A larger image is scaled to fit
with its aspect ratio kept (Lanczos3) and keeps its format; a GIF becomes a
PNG. An image still past 3.75 MiB is encoded as JPEG at quality 80, 60, 40 and
20, then at three quarters of the side, until it fits. A colour profile that
an encode carries at more than a quarter of the byte limit is left out of that
encode (the image then reads as sRGB); an ordinary one stays. A PNG deflates
its profile, a JPEG or a WebP carries it whole, so the size is measured in each
encode. The blob and its `sha256` are the
scaled bytes, and `originalWidth` and `originalHeight` record the size before
the scale, so a tool can map its coordinates back. Every size is of the
upright image: a JPEG its EXIF orientation turns or mirrors is stored turned,
and its original size is the turned size. Only bytes no codec decodes fail,
with `ToolImageError`, so an image the model API would refuse never enters a
session. The stored tool result stays ordinary JSON. Each request reads the
bytes back and sends the image right after the tool result, under the line
`Image from <tool> <source> <width>x<height>:`; a scaled image's line adds
`scaled from <W>x<H> (multiply coordinates by <f> to map to the original)`,
or `multiply x by <fx> and y by <fy>` when the two factors differ at three
decimals. A model
the catalog says reads no images gets a line that names the image instead. A
request sends at most the newest 20 images (5 on Chat Completions); past that
it leaves out the oldest five at a time, each as a line that names it, and
the session keeps every image. A blob stays while any stored message holds
it, however old the session; a server start removes a blob no stored message
references once nobody used it for a day. `toolImageFile(image)` gives the
path of an image's file, for code that reads the bytes (an MCP result names
it beside each image, so a cell reads it).

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
declaring capability labels. A handler yields the same services a tool body
does, with the same declaration: `resources` names the `defineResource`
values whose services it yields. A handler that requires any other service
does not compile (the same type bound), and the loader checks the
declaration as it checks a tool's, reporting `requests[i] (id): …`. The loader binds every registered request to the
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
model must answer. A turn that a usage limit failed carries `retryAt`
(`Option`, epoch milliseconds): the time the model's driver says the limit
resets, so a hook can wait for it instead of sending into the same limit.

Lifecycle extension points are typed hook kinds, not keyed middleware bags:
`systemPrompt`, `turnProjection`, `turnAfter`, `loopOpen` (a branch's loop was
built in this process, or the extension's branch Resources were built again
after an edit or a disable and enable: re-arm timers, report lost work; a hook
still running when those Resources retire is interrupted before they release), `sessionDeleted`
(remove what the extension keeps for a deleted session outside the database),
and `toolCall` (a verdict on each tool call before it runs, below).
Each `host.on` call is typed by the kind's input and output.

### The `toolCall` hook

A `toolCall` hook gives each tool call a verdict before the call runs:
`ToolCallVerdict.cases.Allow`, `Ask({ reason })` or `Deny({ reason })`. It
runs for each call the model makes and for each call the cell's code makes
(that input names the cell call in `parentToolCallId`). The input also
carries `sessionId`, `branchId`, the turn's opening `messageId`, `toolCallId`,
`agentName`, `toolName`, `readonly` and the call's `input`: the input the tool
runs with, decoded by its parameters, so a field the tool drops is not there.
A call whose input does not decode fails as before, and no hook judges it.

- Every extension's hook runs, at once; the strictest verdict wins: deny,
  then ask, then allow. A hook that fails answers `Ask`.
- `Ask` shows one approval dialog with the reason. A turn with no user (a
  headless run without `--approve-all`) declines it.
- A denied or declined call does not run. The model reads a failed tool
  result that names the reason, and the turn goes on.
- A call is judged once. The verdict is stored before the call asks or runs,
  and an approved `Ask` is stored as passed before the call goes on; a store
  that fails fails the call, which does not run. A call that waits for its
  answer across a restart keeps its verdict and is not judged again: a
  passed `Ask` is not asked again, and one not yet answered asks the same
  question.
- With no `toolCall` hook nothing runs before a call, and the requests keep
  their bytes. A hook that asks a model adds that cost to every call it
  judges, so keep it off unless the owner asks for it.

```ts
import { Effect } from "effect"
import { defineExtension, ExtensionHost, ToolCallVerdict } from "@gent/core/extensions/api"

export const ShellAsksExtension = defineExtension({
  id: "shell-asks",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.on("toolCall", ({ toolName, readonly }) => {
      if (readonly || toolName !== "bash")
        return Effect.succeed(ToolCallVerdict.cases.Allow.make({}))
      return Effect.succeed(ToolCallVerdict.cases.Ask.make({ reason: "every shell command asks" }))
    })
  }),
})
```

### `@gent/guard`

The shipped `@gent/guard` is a `toolCall` hook. It is off: it registers no
hook until `~/.gent/config.json` (or a trusted project's
`.gent/config.json`) holds a `guard` entry with a `policy` or `rules`.

```json
{
  "guard": {
    "policy": "Allow reading and building. Ask before installing packages or pushing. Deny deleting files outside the project.",
    "rules": [
      { "tool": "bash", "match": "git status", "effect": "allow" },
      { "tool": "bash", "match": "git push *", "effect": "ask" },
      { "tool": "bash", "match": "rm -rf *", "effect": "deny" }
    ],
    "model": "typesafe/jev-latest"
  }
}
```

It judges a call in this order, and the first answer wins:

1. `rules`. `tool` is a glob over the tool id, and `match` a glob over each
   of the call's subjects: a string input, or each of the fields `command`,
   `code`, `path`, `url` and `query` the input holds as a string. `*` is any
   run of characters, `?` one, and a trailing ` *` is optional (`git push *`
   also matches `git push`). The last rule that matches a subject decides
   that subject, and the strictest answer wins: a deny or an ask on any
   subject decides the call, and an allow decides only when every subject is
   allowed. A subject no rule matches leaves the call to the next step.
2. A `readonly` tool runs.
3. With a `policy`, a classifier (`ExtensionContext.Models.decide`) reads the
   policy and the call and answers allow, ask or deny. `model` names one of
   the catalog's classifiers; absent, the cheapest classifier with a
   credential. The instructions and the policy are the same bytes for every
   call, and the whole call is the input: a call longer than the classifier
   reads (8,000 characters) asks, with its size as the reason, and is never
   judged on a part. A failure, no answer in 8 s, or an answer the
   classifier is not sure of asks. With no policy, the call runs.

A `guard` entry that does not decode asks about each call that is not
read-only. Both files' entries apply: the policies join, the project's
rules come after the user's, and the project's `model` wins. The guard reads
its config when a session profile is built, and an edit to a config file
builds a new profile for the next turn, so a change applies from the next
turn on. Set `disabledExtensions: ["@gent/guard"]` to turn it off.

The guard is not a sandbox. The classifier reads a call's input as text: a
cell's code is judged as written, and each tool call the code makes is judged
again when it runs, but what the code does in its own Bun runtime is not
seen. A rule matches text, not what a command does.

## Resource (long-lived state)

A Resource is `defineResource({ id, scope, layer })`: a stable `id`, its scope
(lifetime), and a service Layer. Startup and shutdown work lives in the layer
itself (`Layer.effect`, with `Effect.addFinalizer` or `acquireRelease`).
Every build gets the host's services: the platform services a tool gets, and
the session database (`SqlClient` from `effect/sql`, and `InteractionStorage`
from `@gent/core/extensions/branch-tools`). So an extension can own tables in
the session database, with foreign keys to core tables and their delete
cascades, and write an interaction request and its own row in one
transaction. A process Resource that owns tables creates and migrates them in
its layer, under a migration table of its own: the cell runs `effect/sql`'s
`Migrator` over `cell_migrations` with `CREATE TABLE IF NOT EXISTS`
migrations. A `branch` Resource also gets its `BranchAddress` (session id,
branch id, cwd, home) and the services of the `process` Resources of its own
extension that it names in `resources`. A layer that reads any other service
does not compile. Process Resources build in extension resolution order, so a
process Resource may also read, as optional (`Effect.serviceOption`), a
service an extension before its own built. A branch Resource reads only what
it names, so an edit to another extension keeps it and its state.
Extension-owned state is a resource whose
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
import { BranchAddress, defineResource } from "@gent/core/extensions/api"
import { Context, Effect, Layer } from "effect"

class Jobs extends Context.Service<Jobs, { readonly root: string }>()("jobs-ext/Jobs") {}
class BranchJobs extends Context.Service<BranchJobs, { readonly dir: string }>()(
  "jobs-ext/BranchJobs",
) {}

export const JobsResource = defineResource({
  id: "jobs-ext/jobs",
  scope: "process",
  layer: Layer.succeed(Jobs, Jobs.of({ root: "/tmp/jobs" })),
})

// Built once per branch, over the branch and the process Resource it names.
export const BranchJobsResource = defineResource({
  id: "jobs-ext/branch-jobs",
  scope: "branch",
  resources: [JobsResource],
  layer: Layer.effect(
    BranchJobs,
    Effect.gen(function* () {
      const { root } = yield* Jobs
      const { branchId } = yield* BranchAddress
      return BranchJobs.of({ dir: `${root}/${branchId}` })
    }),
  ),
})
```

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

### Context compaction

When a window hands off (it overflows, the model asks, or a turn starts on a
large window whose prompt cache went cold), the loop asks a
`ModelContextCompactor` for the summary the handoff marker carries. An
extension installs one as a `process` Resource; the Tag, `CompactionRequest`,
`CompactionSummary` and `ModelCompactionError` come from
`@gent/core/extensions/branch-tools`. The installed compactors form one
chain: project, then user, then builtin. The first summary wins. A compactor
that fails with `ModelCompactionError` passes the window to the next one, and
the loop truncates the window, with a visible notice, only when no compactor
is left. `compact` runs with the `ExtensionContext` a tool call of the same
extension on the compacted branch gets: `ctx.cwd` is the session's cwd, not
the cwd setup saw, and `ctx.State.changed()` reports under the extension's id.

```ts
import {
  defineExtension,
  defineResource,
  ExtensionContext,
  ExtensionHost,
} from "@gent/core/extensions/api"
import {
  CompactionSummary,
  ModelCompactionError,
  ModelContextCompactor,
} from "@gent/core/extensions/branch-tools"
import { Effect, Layer } from "effect"

const ReviewCompactor = Layer.succeed(
  ModelContextCompactor,
  ModelContextCompactor.of({
    compact: (request) =>
      Effect.gen(function* () {
        // Serve one agent; another agent's window goes to the next compactor.
        if (request.agentName !== "review") {
          return yield* new ModelCompactionError({ modelId: request.modelId, reason: "NotReview" })
        }
        const ctx = yield* ExtensionContext
        return CompactionSummary.make({
          notice: `${request.history.length} earlier messages of the review of ${ctx.cwd} left the window.`,
          modelId: request.modelId,
        })
      }),
  }),
)

export default defineExtension({
  id: "review-compactor",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "resource",
      defineResource({
        id: "review-compactor/compactor",
        scope: "process",
        layer: ReviewCompactor,
      }),
    )
  }),
})
```

## Agents

An agent is one schema, `AgentDefinition`, written two ways: an extension
registers one in TypeScript, and the `agents` key of a config file writes one
in JSON. Both take the same fields; a config entry leaves out `name`, since its
key is the name.

```ts
import {
  AgentDefinition,
  AgentName,
  defineExtension,
  ExtensionHost,
  ModelId,
} from "@gent/core/extensions/api"
import { Effect } from "effect"

const painter = AgentDefinition.make({
  name: AgentName.make("painter"),
  description: "Paints one scene: reads its cues, edits the scene file, looks",
  model: ModelId.make("anthropic/claude-sonnet-4-6"),
  tools: ["film.*", "!film.check", "read", "edit", "write"],
  paths: [
    { path: "apps/animations/src/films", access: "write" },
    { path: ".claude/skills/film", access: "read" },
  ],
})

export default defineExtension({
  id: "painter-ext",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("agent", painter)
  }),
})
```

The same agent in `.gent/config.json` (project) or `~/.gent/config.json`
(user), with no extension at all:

```json
{
  "agents": {
    "painter": {
      "description": "Paints one scene: reads its cues, edits the scene file, looks",
      "model": "anthropic/claude-sonnet-4-6",
      "tools": ["film.*", "!film.check", "read", "edit", "write"],
      "paths": ["apps/animations/src/films", { "path": ".claude/skills/film", "access": "read" }]
    },
    "delegate": { "model": "anthropic/claude-sonnet-4-6" }
  }
}
```

A config entry with a new name creates an agent; one with the name of a
registered agent replaces only the fields it names (`delegate` above keeps
its tools and changes its model). `systemPromptAddendum` is the one field
that adds: the entry's text comes after the agent's. Each field resolves
project config, then user config, then the extension; a run's own overrides
(the `overrides` of a `delegate.start` call) win over all three. A session
runs as an agent by name: `main` by default, `gent -H --agent painter "..."`
for a headless run, and `delegate` for every child. Each turn reads the config
files as they are then, so an edit reaches the next turn.

### Tool patterns

`tools` is an ordered list of patterns over tool ids:

- A pattern matches the whole id. `*` matches any run of characters, dots
  included: `film.*` matches `film.look`, `mcp.github.*` matches every tool
  of the `github` MCP server, and `*` alone matches every tool. Every other
  character matches itself.
- `!` at the start takes the tools it matches back out.
- The last pattern that matches a tool decides. A tool that no pattern
  matches is left out.
- No `tools`: the agent holds every tool. `[]`: it holds none.

`["*", "!bash"]` is every tool but `bash`; `["film.*", "!film.check"]` is the
film tools but `film.check`. The patterns decide only which tools a turn
holds: a held tool still asks for approval where it asks. They are
authoritative: no extension adds a tool they leave out. The cell is the model
surface only for an agent that holds `cell`; the painter above calls its
tools directly. An extension that selects or describes its own tool in a
`turnProjection` hook asks `agent.admitsTool(id)` first, the one predicate
over the patterns.

A config entry or a stored run written before `tools` still loads, with its
old meaning: a `deniedTools` list alone takes those ids from the tools the
agent already holds; an `allowedTools` list alone replaces them and keeps the
inherited denials; both become the allowed ids and then the denied ones with
`!`. `modelId` becomes `model`. A `tools` list always replaces. When gent
writes a stored run or a `driver.list` reply, it also writes the old keys for
an older gent: `modelId`, and the old lists when they can say what the
patterns say, else `allowedTools: []`, so an older gent gives the agent no
tool rather than every tool. `paths` has no old form. A config file is yours:
a write by gent (a driver change, an extension toggle) leaves each agent
entry as you wrote it.

A `delegate.start` call takes the new keys only (`model`, `tools`, `paths`,
...). A call with `modelId`, `allowedTools` or `deniedTools` fails, and the
failure names the key to use; it never runs the child without the
restriction it asked for.

A config entry with a key the schema does not name fails to load, and the
error names the agent and the key: a misspelled `toolz` would otherwise give
an agent every tool. While a user or project config file for the session's
directory does not load, its turns do not run: each one ends with an error
that names the file and the reason, and the turn after the fix runs.
TypeScript source has no old reading either: `AgentDefinition.make`,
`new AgentDefinition`, `makeEffect` and `makeOption` refuse a key the schema
does not name, so an extension that still passes `allowedTools` fails to load
and the failure names the key.

### Paths

`paths` confines the shipped file tools to files and folders, relative to the session
cwd. An entry is `{ "path": ..., "access": "read" | "write" }`; a bare string
is a `write` entry. `read` and `grep` accept any entry; `write` and `edit`
accept only a `write` entry. A call outside every entry it accepts fails with
a `PathScopeError` that names the entries, and the model reads it. Links and
`..` resolve before the check, so a link under an entry that points out of it
is outside. `grep` checks its search root and does not follow a link under
it. No `paths`: the file tools reach every path.

`paths` is not a sandbox. `bash`, the cell and every other tool reach the file
system without the check, so leave them out of the `tools` of an agent you
confine.
A tool of your own reads the session's agent with
`ctx.Session.getAgent()` (`ExtensionContext`) and checks the same way.

## Model router

A `modelRouter` serves virtual models: ids `<router id>/<name>` that pick one
of their choices at the start of each turn. Each choice names a model, an
effort, or both, and a `reason`. Core calls `route` once per turn, before its
first request, records the pick (`ModelRouted`) and runs every step on it. A
route that fails, takes over 10 s or picks a choice the turn cannot run falls
back to the default choice (`fallback`, an index). `route` runs with the
`ExtensionContext` a tool of the same extension gets, so its
`ctx.State.changed()` names the extension. It may ask classifiers
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
- **A tool's or request's `resources`** must be registered by the same extension
- Same-name tools/agents/drivers in same scope degrade

Cross-scope: higher scope wins silently (project overrides user overrides
builtin).

## In-tree Examples

| Extension                              | Demonstrates                                  |
| -------------------------------------- | --------------------------------------------- |
| `packages/extensions/src/agents.ts`    | `agent` + turn projection prompt sections     |
| `packages/extensions/src/mcp.ts`       | tools read at setup + a lazy process resource |
| `packages/extensions/src/router.ts`    | `modelRouter` from config + a classifier      |
| `packages/extensions/src/guard.ts`     | `toolCall` hook from config + a classifier    |
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
- Extension-private authority is an imported service Tag from a resource layer
  that the tool or request names in `resources`, not a read/write or capability
  declaration.
- Runtime services such as `GentPlatform`, `ToolRunner`, storage Tags and event
  stores are not on `@gent/core/extensions/api`. The branch-tools entry exports
  the core services a branch tool reads, and any extension that imports it may
  yield them.
- Tagged-union variant tags are PascalCase. Extension health reports
  `"Healthy"` or `"Degraded"`, and a degraded extension carries
  `"ActivationFailed"` or `"ModelCatalogFailed"` issues. An
  `"ActivationFailed"` issue with `runningVersion` is a failed reload: the new
  version failed and that last good version still runs. An extension the
  disabled list names is `"Disabled"`, in the optional `disabledExtensions`
  list of the snapshot. Match on the tag
  through the exported schema rather than a string literal where possible.
