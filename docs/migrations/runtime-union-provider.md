# Runtime, Union, and Provider Migration

Breaking changes were intentional. The compatibility layer is gone. This file is the migration map.

## Runtime

Old mental model:

- `ActorProcess` was the stable session boundary
- handlers pushed bespoke RPC shapes into the runtime
- direct callers reached for loop internals

New mental model:

- `SessionRuntime` is the only public runtime owner
- writes flow through `dispatch(command)`
- reads flow through `getState`, `watchState`, `getQueuedMessages`, `getMetrics`

### Old

```ts
yield *
  actorProcess.sendUserMessage({
    sessionId,
    branchId,
    content,
  })
```

### New

```ts
yield *
  sessionRuntime.dispatch(
    sendUserMessageCommand({
      sessionId,
      branchId,
      content,
    }),
  )
```

Use these command constructors:

- `sendUserMessageCommand(...)`
- `recordToolResultCommand(...)`
- `invokeToolCommand(...)`
- `applySteerCommand(...)`
- `respondInteractionCommand(...)`

If you are writing server code, stop at `SessionRuntime`. `AgentLoop` is internal runtime machinery, not an integration boundary.

## Union Policy

Owned discriminated unions use `_tag`.

Use:

- `TaggedEnumClass(...)` for multi-variant schema unions with per-variant constructors
- `Schema.TaggedStruct(...)` for small command/event/data variants
- `Schema.TaggedErrorClass(...)` for errors

Do not use:

- `_kind` for owned unions
- ad-hoc `"kind"` discriminators when `_tag` is the real model
- hand-rolled wrapper unions when `TaggedEnumClass` can own the shape

### Old

```ts
type Command =
  | { kind: "cancel"; sessionId: SessionId; branchId: BranchId }
  | { kind: "interject"; sessionId: SessionId; branchId: BranchId; message: string }
```

### New

```ts
const Cancel = Schema.TaggedStruct("Cancel", {
  sessionId: SessionId,
  branchId: BranchId,
})

const Interject = Schema.TaggedStruct("Interject", {
  sessionId: SessionId,
  branchId: BranchId,
  message: Schema.String,
})

const Command = Schema.Union([Cancel, Interject])
```

For richer unions:

```ts
export const AgentEvent = TaggedEnumClass("AgentEvent", {
  StreamStarted: {
    sessionId: SessionId,
    branchId: BranchId,
  },
  StreamChunk: {
    sessionId: SessionId,
    branchId: BranchId,
    chunk: Schema.String,
  },
})
```

## Extension Surface

Old callable vocabulary:

- `query(...)`
- `mutation(...)`
- `command(...)`
- audience/intent flag matrices

New callable vocabulary:

- `tool(...)` for model-facing tools
- `request(...)` for typed extension RPC (`intent: "read" | "write"`)
- `action(...)` for human slash/palette affordances

### Old

```ts
const GetStatus = query({
  id: "get-status",
  input: Schema.Struct({ key: Schema.String }),
  output: Schema.String,
  execute: (input) => Effect.succeed(`status:${input.key}`),
})
```

### New

```ts
const GetStatus = request({
  id: "get-status",
  extensionId: ExtensionId.make("status-ext"),
  intent: "read",
  input: Schema.Struct({ key: Schema.String }),
  output: Schema.String,
  execute: (input) => Effect.succeed(`status:${input.key}`),
})
```

Generic middleware APIs are not the extension model anymore. Migrate as follows:

- prompt shaping -> typed `ProjectionContribution` objects and prompt slots
- permission policy -> explicit policy slots / capability policy
- turn reactions -> `defineResource({ subscriptions: [...] })`
- long-lived state / lifecycle -> `defineResource(...)`

Projection authoring is a typed object literal, not a constructor:

```ts
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

## Provider / Model Driver Surface

Provider code should lean on `effect/unstable/ai`, not invent a parallel transcript model.

Use:

- `LanguageModel`
- `Prompt`
- `Response`
- `Tool`

Normalize once:

- driver/model implementation emits `Response.StreamPart`
- runtime converts via `toTurnEventStream(model, stream)`

### Old

- custom provider-local chunk DTOs
- provider-specific transcript assembly spread across runtime call sites

### New

```ts
import * as Response from "effect/unstable/ai/Response"

const stream = Stream.make(
  Response.makePart("text-delta", { id: "t1", delta: "hello" }),
  Response.makePart("finish", {
    reason: "stop",
    usage: new Response.Usage({
      inputTokens: { total: 12, uncached: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 4, text: undefined, reasoning: undefined },
    }),
    response: undefined,
  }),
)

return toTurnEventStream(model, stream)
```

Rule: shared chunk semantics beat provider-local invention. If two providers can share the same `Response.StreamPart` shape, they should.

## Contributor Checklist

- Runtime integration stops at `SessionRuntime`
- Owned unions use `_tag`
- New extension callables use `tool` / `request` / `action`
- New provider code uses `effect/unstable/ai` stream parts
- Deleted surfaces stay deleted
