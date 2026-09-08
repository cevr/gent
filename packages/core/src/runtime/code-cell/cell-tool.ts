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
    "Top-level variables stay bound in later cells on this branch. The host saves them after each cell and restores them after a worker restart; a result then carries restored (names) and omitted (functions, class instances, cycles, oversized values).",
    "Call host tools with await tools.call(name, input). Run independent calls concurrently with Promise.all; chain dependent calls with sequential awaits.",
    "The cell is a Bun runtime in the working directory: Bun (Bun.file, Bun.$, Bun.spawn), fetch, process (cwd, env), node builtins through await import('node:fs/promises') or require('node:path'), and packages resolved from the working directory. Use it directly to read, search, parse, and transform data. Use tools.call for host tools that own permissions, durable records, and child agents.",
    "console output, process.stdout and process.stderr writes, and inherited output of spawned processes return with the cell result, before the value of the last expression. Output a spawned process writes after the cell ends is lost, so await the processes you start.",
    "The value of the last expression is the cell result; an undefined value shows nothing. Top-level await works; a top-level return does not.",
    "Bun.$`cmd`.text() returns stdout only, and Bun.$ pipes stderr away; test runners and many tools report on stderr. Use Bun.spawn with inherited stdio so the output returns with the cell, or .quiet() and read .stderr.",
    "The host tools selected for this turn are listed in the Host Tools section. tools.search(query, offset) returns matching names and descriptions, 20 per page with a nextOffset. tools.describe(name) returns the input schema and guidelines. Both are local and synchronous; they do not grant permission to execute.",
    "Set reset: true to discard retained values and the saved namespace before running new code.",
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
