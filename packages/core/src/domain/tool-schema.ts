import { Schema } from "effect"

type ToolSchemaCarrier =
  | {
      readonly input: Schema.Schema<unknown>
    }
  | {
      readonly params: Schema.Schema<unknown>
    }

/**
 * Flatten allOf into parent object. Effect's `.check()` emits constraints
 * (minItems, maxItems, minLength, maxLength) as allOf entries, but some
 * providers reject allOf sub-schemas that lack required fields like `items`.
 * Merging them into the parent keeps the constraints while producing a flat,
 * provider-compatible schema.
 */
export function flattenAllOf(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(schema)) {
    if (key === "allOf" && Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "object" && entry !== null) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
          Object.assign(result, flattenAllOf(entry as Record<string, unknown>))
        }
      }
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
      result[key] = flattenAllOf(value as Record<string, unknown>)
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema and brand factory owns nominal type boundary
            flattenAllOf(item as Record<string, unknown>)
          : item,
      )
    } else {
      result[key] = value
    }
  }

  return result
}

export function buildToolJsonSchema(source: ToolSchemaCarrier): Record<string, unknown> {
  const schema = "input" in source ? source.input : source.params
  const doc = Schema.toJsonSchemaDocument(schema)
  const merged =
    Object.keys(doc.definitions).length > 0 ? { ...doc.schema, $defs: doc.definitions } : doc.schema
  const flat = flattenAllOf(merged as Record<string, unknown>)
  // Ensure top-level type: "object" — Anthropic rejects schemas without it
  if (flat["type"] === undefined) {
    flat["type"] = "object"
    if (flat["properties"] === undefined) flat["properties"] = {}
    delete flat["anyOf"]
    delete flat["oneOf"]
  }
  return flat
}
