import { Effect, Option, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import { getToolMetadata, tool } from "../../domain/capability/tool.js"
import { ToolResultFailure } from "../../domain/tool-output.js"
import { CurrentToolCall } from "../agent/current-tool-call.js"

const CatalogInput = Schema.TaggedUnion({
  search: {
    query: Schema.String.check(Schema.isMaxLength(256)),
    offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
  describe: { name: Schema.String },
})

/** Read the selected capabilities directly. No second schema registry or execution authority. */
export const ToolCatalog = tool({
  id: "tool-catalog",
  description: "Search selected host tools or describe one tool's input schema.",
  readonly: true,
  params: CatalogInput,
  output: Schema.Json,
  execute: Effect.fn("ToolCatalog.execute")(function* (input) {
    const current = yield* Effect.serviceOption(CurrentToolCall)
    if (Option.isNone(current)) {
      return yield* new ToolResultFailure({
        message: "Tool discovery requires a recorded turn call",
        result: { error: "Tool discovery requires a recorded turn call" },
      })
    }
    const bindings = current.value.toolBindings
    if (input._tag === "describe") {
      const selected = Option.fromUndefinedOr(bindings.get(input.name))
      if (Option.isNone(selected)) {
        return yield* new ToolResultFailure({
          message: "Tool is not selected for this turn",
          result: { error: "Tool is not selected for this turn", name: input.name },
        })
      }
      const capability = selected.value.capability
      return yield* Schema.decodeUnknownEffect(Schema.Json)({
        name: input.name,
        description: capability.description,
        guidelines: getToolMetadata(capability).promptGuidelines ?? [],
        parameters: AiTool.getJsonSchema(capability),
      })
    }
    const query = input.query.toLowerCase()
    const names = [...bindings.entries()]
      .filter(
        ([name, entry]) =>
          name.toLowerCase().includes(query) ||
          entry.capability.description.toLowerCase().includes(query),
      )
      .map(([name]) => name)
      .sort()
    const offset = Option.getOrElse(Option.fromUndefinedOr(input.offset), () => 0)
    const page = names.slice(offset, offset + 20)
    return { names: page, total: names.length, nextOffset: offset + page.length }
  }),
})
