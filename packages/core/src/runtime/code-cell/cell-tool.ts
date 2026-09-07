import { Effect, Schema } from "effect"
import { tool } from "../../domain/capability/tool.js"
import { CellInput } from "../../domain/cell-input.js"
import { ToolResultFailure } from "../../domain/tool-output.js"
import { dispatchCell } from "./cell-dispatch.js"

/** Declaration only. The turn dispatcher still owns identity, permissions, and execution scope. */
export const CellTool = tool({
  id: "cell",
  description: "Run TypeScript in the current branch's persistent Bun cell.",
  params: CellInput,
  output: Schema.Json,
  promptGuidelines: [
    "Values remain available in later cells on this branch while its worker lives.",
    "Call host tools with await tools.call(name, input).",
    "Discover selected tools with await tools.call('tool-catalog', {_tag: 'search', query: ''}). Search returns 20 names; pass nextOffset as offset for the next page.",
    "Get an input schema with await tools.call('tool-catalog', {_tag: 'describe', name: 'tool-name'}). Descriptions do not grant permission to execute.",
    "Set reset: true to discard retained values before running new code. Use this after worker state loss.",
    "A failed cell may have completed effects. Do not replay source to recover unknown outcomes.",
  ],
  execute: Effect.fn("CellTool.execute")(function* () {
    const saved = yield* dispatchCell().pipe(
      Effect.catchTag("CellToolCallSuspended", (suspended) => Effect.fail(suspended.pending)),
    )
    const result = yield* Schema.decodeUnknownEffect(Schema.Json)(saved.result)
    if (saved.isFailure) {
      return yield* new ToolResultFailure({ message: "Cell execution failed", result })
    }
    return result
  }),
})
