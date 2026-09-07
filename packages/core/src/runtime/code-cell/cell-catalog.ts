import { Effect, Hash, Schema } from "effect"
import * as AiTool from "effect/unstable/ai/Tool"
import { getToolMetadata } from "../../domain/capability/tool.js"
import type { ResolvedToolCapability } from "../agent/tool-runner.js"
import { CellCatalog, CellCatalogEntry } from "./cell-protocol.js"

const encodeEntries = Schema.encodeSync(Schema.fromJsonString(Schema.Array(CellCatalogEntry)))
const decodeEntry = Schema.decodeUnknownEffect(CellCatalogEntry)

/**
 * Read the selected bindings directly. No second schema registry: the entry carries the
 * capability's actual Effect AI input schema. The outer `cell` never lists itself.
 */
export const buildCellCatalog = Effect.fn("CellCatalog.build")(function* (
  bindings: ReadonlyMap<string, ResolvedToolCapability>,
) {
  const selected = [...bindings.entries()]
    .filter(([name]) => name !== "cell")
    .sort(([left], [right]) => left.localeCompare(right))
  const tools = yield* Effect.forEach(selected, ([name, entry]) =>
    decodeEntry({
      name,
      description: entry.capability.description,
      guidelines: getToolMetadata(entry.capability).promptGuidelines ?? [],
      parameters: AiTool.getJsonSchema(entry.capability),
    }),
  )
  return CellCatalog.make({ hash: String(Hash.string(encodeEntries(tools))), tools })
})
