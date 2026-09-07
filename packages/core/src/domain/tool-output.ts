import { Option, Predicate, Result, Schema } from "effect"
import type * as Prompt from "effect/unstable/ai/Prompt"

/** Structured failure data. The runner, not the tool, owns transcript identity. */
export class ToolResultFailure extends Schema.TaggedError<ToolResultFailure>()(
  "ToolResultFailure",
  { message: Schema.String, result: Schema.Json },
) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))

// The event transcript stores this lossless JSON form for replay. Keep the
// human-facing summary and display string separate from this value.
// oxlint-disable-next-line effect/noUnknownParameters -- Tool output is decoded at this schema boundary.
export const encodeToolOutput = (value: unknown): string => encodeJson(value)

// oxlint-disable-next-line effect/noUnknownParameters -- Persisted tool output crosses a schema boundary.
export const decodeToolOutput = (value: string): Option.Option<unknown> =>
  Result.try(() => decodeJson(value)).pipe(Result.getSuccess)

// oxlint-disable-next-line effect/noUnknownParameters -- Tool output is an external provider value parsed by the JSON codec below.
const tryStringifyJson = (value: unknown): Option.Option<string> =>
  Result.try(() => encodeJson(value)).pipe(Result.getSuccess)

// oxlint-disable-next-line effect/noUnknownParameters -- Tool output is an external provider value parsed by the JSON codec below.
const tryPrettyStringifyJson = (value: unknown): Option.Option<string> =>
  Result.try(() => {
    const encoded = encodeJson(value)
    const decoded = decodeJson(encoded)
    // oxlint-disable-next-line effect/noGlobals, effect/noNullish -- Pretty output preserves the established tool transcript format.
    const pretty = JSON.stringify(decoded, null, 2)
    if (Predicate.isUndefined(pretty)) return String(value)
    return pretty
  }).pipe(Result.getSuccess)

export type ToolOutput = {
  readonly type: "json" | "error-json"
  readonly value: unknown
}

// oxlint-disable-next-line effect/noUnknownParameters -- Tool output is an external provider value parsed by the JSON codec below.
export const stringifyOutput = (value: unknown): string => {
  if (Predicate.isString(value)) return value
  return Option.getOrElse(tryPrettyStringifyJson(value), () => String(value))
}

export const summarizeOutput = (output: ToolOutput): string => {
  const value = output.value
  if (Predicate.isString(value)) {
    const firstLine = value.split("\n")[0] ?? ""
    if (firstLine.length > 100) {
      return firstLine.slice(0, 100) + "..."
    }
    return firstLine
  }
  const json = tryStringifyJson(value)
  if (Option.isSome(json)) {
    const str = json.value
    if (str.length > 100) return str.slice(0, 100) + "..."
    return str
  }
  return String(value)
}

export const summarizeToolOutput = (result: Prompt.ToolResultPart): string => {
  let type: ToolOutput["type"] = "json"
  if (result.isFailure) type = "error-json"
  return summarizeOutput({ type, value: result.result })
}
