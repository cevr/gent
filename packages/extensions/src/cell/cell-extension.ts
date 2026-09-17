import { Effect, Option } from "effect"
import {
  defineExtension,
  ExtensionHost,
  ExtensionId,
  ExtensionContext,
  getToolId,
  getToolPrompt,
  type ToolCapability,
} from "@gent/core/extensions/api"
import { CellTool } from "./cell-tool.js"

export const CELL_EXTENSION_ID = ExtensionId.make("@gent/cell")

/**
 * The default model execution surface. When this builtin is registered, a native
 * model turn advertises only `cell`; host tools stay callable inside the cell
 * through the turn's bound identities, and the kernel's local `tools.search` and
 * `tools.describe` read the catalog the host ships with each changed turn.
 * The extension owns the model selection and catalog through ordinary hooks.
 */
export const CellExtension = defineExtension({
  id: CELL_EXTENSION_ID,
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", CellTool)
    yield* host.on("turnProjection", () =>
      Effect.gen(function* () {
        const ctx = yield* ExtensionContext
        if (
          ctx.turn?.agent.driver?._tag === "External" ||
          ctx.turn?.agent.deniedTools?.includes("cell")
        ) {
          return {}
        }
        return { toolPolicy: { include: ["cell"], modelSet: ["cell"] } }
      }),
    )
    yield* host.on("systemPrompt", (input) =>
      Effect.sync(() => {
        if (
          input.agent.driver?._tag === "External" ||
          input.tools?.length !== 1 ||
          !input.tools.some((tool) => getToolId(tool) === "cell")
        ) {
          return input.basePrompt
        }
        const entries = (input.hostTools ?? [])
          .filter((tool) => getToolId(tool) !== "cell")
          .toSorted((left, right) => getToolId(left).localeCompare(getToolId(right)))
          .map(
            (tool) =>
              `- **${getToolId(tool)}**${describeInputKeys(tool)}: ${getToolPrompt(tool).promptSnippet ?? tool.description}`,
          )
        if (entries.length === 0) return `${input.basePrompt}\n\n${CELL_WORK}`
        const catalog = `## Host Tools\n\nCallable inside \`cell\` with \`await tools.call(name, input)\`. \`tools.describe(name)\` returns the input schema.\n\n${entries.join("\n")}`
        return `${input.basePrompt}\n\n${CELL_WORK}\n\n${catalog}`
      }),
    )
  }),
})

/**
 * How to work when the cell is the execution surface.
 *
 * Core's base prompt says a turn ends when the model stops calling tools; it
 * does not say the work happens in a cell, because a deployment without this
 * extension has no cell. The sentences that assume one live here.
 */
const CELL_WORK = `# Working in the cell

- The cell is your persistent control environment. Keep intermediate values in named variables, inspect and transform outputs, and write small helpers. Use it for loops, parsing, and state; call host tools for effects.
- You solve tasks by writing and running TypeScript in the cell, observing results, and iterating. Batch independent work inside one cell; iterate between cells.
- Independent work goes to children: Promise.all over tools.call('delegate', { todo }) from one cell. Single reads, searches, and edits stay inline.
- Example: \`const run = await Bun.$\`bun test\`.quiet().nothrow(); const lines = (run.stdout.toString() + run.stderr.toString()).split("\\n"); const failing = lines.filter((l) => l.includes("(fail)")); ({ exit: run.exitCode, total: failing.length, sample: failing.slice(0, 5) })\` returns the outcome and a sample; lines stays bound for the next cell.
- To find files, prefer tools.call('grep', ...) over a raw directory walk: it honours .gitignore and caches the listing.`

const describeInputKeys = (tool: ToolCapability): string => {
  const ast = tool.parametersSchema.ast
  if (ast._tag !== "Objects") return ""
  const keys = ast.propertySignatures.map((signature) => {
    const optional = Option.fromUndefinedOr(signature.type.context).pipe(
      Option.exists((context) => context.isOptional),
    )
    if (optional) return `${String(signature.name)}?`
    return String(signature.name)
  })
  return `(${keys.join(", ")})`
}
