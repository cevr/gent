import { Schema } from "effect"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Parse tool output JSON into an unknown record, returning undefined on failure. */
export const parseToolOutput = (
  output: string | undefined,
): Record<string, unknown> | undefined => {
  if (output === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(output)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    // not JSON
  }
  return undefined
}

/**
 * Decode tool output JSON against an Effect Schema.
 * Returns the decoded value on success, undefined on parse/decode failure.
 */
export const decodeToolOutput = <T>(
  schema: Schema.Decoder<T, never>,
  output: string | undefined,
): T | undefined => {
  if (output === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(output)
    return Schema.decodeUnknownSync(schema)(parsed) as T
  } catch {
    return undefined
  }
}

/** Extract a string property from an unknown value, returning fallback on miss. */
export const getString = (input: unknown, key: string, fallback = ""): string => {
  if (!isRecord(input)) return fallback
  const value = input[key]
  return typeof value === "string" ? value : fallback
}
