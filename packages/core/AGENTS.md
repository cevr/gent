# Core Guidelines

## Type Exports

- `MessagePart`, `TextPart`, etc. - Import from here, never redeclare locally
- `ToolDefinition` - `Params` must extend `Schema.Schema.AnyNoContext` (no context for sync decode)

## Schema Patterns

- `Schema.Unknown` for dynamic JSON (`ToolCallPart.input`, `ToolResultPart.output.value`)
- Decode with `Schema.decodeUnknownSync(schema)(value)` before use
- Owned unions use `_tag`, not `kind` / `_kind`
- **Every tagged/discriminated union uses `TaggedEnumClass`** (from `domain/schema-tagged-enum-class`), `Schema.TaggedStruct`, or `Schema.TaggedErrorClass`. Never hand-roll `{ readonly _tag: "X"; ... } | { readonly _tag: "Y"; ... }` literal unions, even for "internal" driver/state events. Construct via `Variant.make({...})`, never `{ _tag: "X", ... } satisfies Union`. Extract types with `type X = Schema.Schema.Type<typeof X>`.

## Runtime Boundary

- Server-facing code uses `SessionRuntime` only. `AgentLoop` is a runtime-internal implementation detail.
- Server-facing orchestration flows through `sessionRuntime.dispatch(command)`
- `RuntimeCommand` constructors are the stable write surface: `sendUserMessageCommand`, `recordToolResultCommand`, `invokeToolCommand`, `applySteerCommand`, `respondInteractionCommand`

## Extension Boundary

- Author with `tool(...)`, `request(...)`, `action(...)`, `defineResource(...)`, typed `ProjectionContribution` objects, and `defineAgent(...)`
- Do not reintroduce `query(...)`, `mutation(...)`, generic `_kind` contribution unions, or flat `Contribution[]`
- Prompt shaping, policy, and turn reactions belong to projections/resources and explicit runtime slots, not generic middleware APIs

## Provider Boundary

- Provider/model-driver code uses `effect/unstable/ai` types directly (`LanguageModel`, `Prompt`, `Response`, `Tool`)
- Stream normalized `Response.StreamPart` values and convert once at the runtime edge via `toTurnEventStream`
