import { Option, Schema } from "effect"
import type { ToolCall } from "./types"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))
const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject)
const decodeString = Schema.decodeUnknownOption(Schema.String)
const decodeStringArray = Schema.decodeUnknownOption(Schema.Array(Schema.String))
const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json, { space: 2 }))

export const formatGenericToolInput = (input: ToolCall["input"]) =>
  Schema.decodeUnknownOption(Schema.Json)(input).pipe(
    Option.map(encodePrettyJson),
    Option.getOrElse(() => "(none)"),
  )

export const formatGenericToolDetail = (text: string) =>
  decodeJson(text).pipe(
    Option.map(encodePrettyJson),
    Option.getOrElse(() => text),
  )

function uniqueNonEmpty(parts: ReadonlyArray<Option.Option<string>>): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const part of parts) {
    if (Option.isNone(part)) continue
    const trimmed = part.value.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }

  return result
}

function extractPrimaryMessage(value: Schema.JsonObject) {
  const primary = decodeString(value["error"]).pipe(
    Option.orElse(() => decodeString(value["message"])),
    Option.orElse(() => decodeString(value["summary"])),
  )
  const secondary = decodeString(value["details"]).pipe(
    Option.orElse(() => decodeString(value["reason"])),
  )
  const issues = Option.getOrElse(decodeStringArray(value["errors"]), () => [])
  const parts = uniqueNonEmpty([primary, secondary, ...issues.map((issue) => Option.some(issue))])
  if (parts.length === 0) return Option.none<string>()
  return Option.some(parts.join("\n"))
}

export function formatGenericToolText(text: ToolCall["output"]) {
  const source = Option.fromNullishOr(text)
  if (Option.isNone(source)) return Option.getOrUndefined(source)

  const trimmed = source.value.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return source.value

  const parsed = decodeJson(source.value)
  if (Option.isNone(parsed)) return source.value

  const stringValue = decodeString(parsed.value)
  if (Option.isSome(stringValue)) return stringValue.value

  const record = decodeJsonObject(parsed.value)
  if (Option.isSome(record)) {
    const extracted = extractPrimaryMessage(record.value)
    if (Option.isSome(extracted)) return extracted.value
  }

  return encodePrettyJson(parsed.value)
}
