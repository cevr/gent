import { ToolResultFailure, tool } from "@gent/core/extensions/api"
import { Effect, Schema } from "effect"
import { CellInput } from "./cell-input.js"
import { dispatchCell } from "./cell-dispatch.js"

/** Declaration only. The turn dispatcher still owns identity, permissions, and execution scope. */
/** The model-facing name of the cell tool. */
export const CELL_TOOL_ID = "cell"

export const CellTool = tool({
  id: CELL_TOOL_ID,
  description: "Run TypeScript in this branch's Bun process. Bindings persist across cells.",
  // The cell calls host tools from inside itself, so recovery must restore
  // host bindings for it, not just its own.
  dispatches: true,
  params: CellInput,
  output: Schema.Json,
  promptGuidelines: [
    "Top-level variables stay bound in later cells on this branch. The host saves them after each cell and restores them after a worker restart; a result then carries restored (names) and omitted (functions, class instances, cycles, oversized values).",
    "Call host tools with await tools.call(name, input). Run independent calls concurrently with Promise.all; chain dependent calls with sequential awaits.",
    "The cell is a full Bun process in the working directory with your user's privileges; nothing is sandboxed. Bun (Bun.file, Bun.write, Bun.$, Bun.spawn), bun:sqlite, fetch, process (cwd, env), node builtins through await import('node:fs/promises') or require('node:path'), and packages resolved from the working directory are all available. Use it directly to read, search, parse, and transform data.",
    "Shell that changes state (git, installs, deletes, network writes) goes through tools.call('bash', { command }): it carries the approval guardrails and the session trailer. Bun.$ and Bun.spawn are for reading: builds, tests, queries, parsers. Use tools.call for host tools that own permissions, durable records, and child agents.",
    "console output, process.stdout and process.stderr writes, and inherited output of spawned processes return with the cell result, before the value of the last expression. Output a spawned process writes after the cell ends is lost, so await the processes you start.",
    "The value of the last expression is the cell result; an undefined value shows nothing. Top-level await works; a top-level return does not.",
    "Return a summary, not the data. The result display is capped near 64KB and the middle is dropped. Slice arrays, count instead of listing, and keep the full value in a binding for the next cell.",
    "Bun.$`cmd`.text() returns stdout only, and Bun.$ pipes stderr away; test runners and many tools report on stderr. Use Bun.spawn with inherited stdio so the output returns with the cell, or .quiet() and read .stderr.",
    "The host tools selected for this turn are listed in the Host Tools section. tools.search(query, offset) returns matching names and descriptions, 20 per page with a nextOffset. tools.describe(name) returns the input schema and guidelines. Both are local and synchronous; they do not grant permission to execute.",
    "context.status() reports what the model sees: tokens, limit, percent, omittedMessages, compactedRevision. context.read(id, { offset, limit }) returns durable text by message id or tool call id, paged by character offset and limit (nextOffset continues); receipts in a cell result carry the ids of inner calls, and omitted messages stay readable. context.compact(instructions?) schedules a summary of older history before the next turn. context.newWindow() drops older history from the model view before the next turn; it stays durable and readable. All four are awaited host calls.",
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
