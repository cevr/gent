# Core Guidelines

## Type Exports

- `MessagePart`, `TextPart`, etc. - Import from here, never redeclare locally
- `ToolDefinition` - `Params` must extend `Schema.Schema.AnyNoContext` (no context for sync decode)

## Schema Patterns

- `Schema.Unknown` for dynamic JSON (`ToolCallPart.input`, `ToolResultPart.output.value`)
- Decode with `Schema.decodeUnknownSync(schema)(value)` before use
- Owned unions use `_tag`, not `kind` / `_kind`
- **Every tagged/discriminated union uses `Schema.TaggedUnion`** (or `Schema.TaggedStruct` + `Schema.toTaggedUnion` for kebab-case wire tags, or `Schema.TaggedErrorClass` for errors). Never hand-roll `{ readonly _tag: "X"; ... } | { readonly _tag: "Y"; ... }` literal unions, even for "internal" driver/state events. Construct via `Union.cases.Variant.make({...})`, never `{ _tag: "X", ... } satisfies Union`. Extract types with `type X = Schema.Schema.Type<typeof X>`.

## Runtime Boundary

- Server-facing code uses `SessionRuntime` only. `AgentLoop` is a runtime-internal implementation detail.
- Server-facing orchestration flows through typed `SessionRuntime` methods: `sendUserMessage`, `recordToolResult`, `steer`, and `respondInteraction`.
- Do not reintroduce a generic runtime command union or public dispatch bridge.

## Extension Boundary

- Author with `tool(...)`, `request(...)`, `defineResource(...)`, `hook.*(...)`, and `AgentDefinition.make(...)`
- Slash command presentation lives on `request({ slash: { ... } })` — there is no separate `action(...)` factory
- Do not reintroduce `query(...)`, `mutation(...)`, `action(...)`, generic `_kind` contribution unions, or flat `Contribution[]`
- Prompt shaping, policy, and turn lifecycle behavior belong to `hook.turnProjection` and explicit runtime slots, not generic middleware APIs

## Provider Boundary

- Provider/model-driver code uses `effect/unstable/ai` types directly (`LanguageModel`, `Prompt`, `Response`, `Tool`)
- Stream normalized `Response.StreamPart` values and derive Gent durable events once at the runtime edge
