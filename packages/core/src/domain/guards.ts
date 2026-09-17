import { Predicate, Schema } from "effect"
/** Shared type guards for narrowing unknown/JSON boundary values. */

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown)

/** Narrow an unknown value to a string-keyed record. */
export const isRecord = Schema.is(JsonRecord)

/** Narrow an unknown value to an object with a `.message` string property. */
const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }))

/** The message an unknown failure carries, or its string form. */
export const causeMessage = (cause: unknown): string => {
  if (hasMessage(cause)) return cause.message
  return String(cause)
}

const hasCause = Schema.is(Schema.Struct({ cause: Schema.Unknown }))

/**
 * The messages down a failure's `cause` chain, outermost first. It is what a
 * reader needs from a wrapped failure: the outer message says what was being
 * done, the innermost says why it failed. Stack frames belong in the log.
 */
export const causeChainMessage = (cause: unknown): string => {
  const messages: Array<string> = []
  let current = cause
  // A cycle would be a bug in the thrower; the bound keeps it from hanging the reader.
  for (let depth = 0; depth < 8; depth += 1) {
    const message = causeMessage(current)
    if (!messages.includes(message)) messages.push(message)
    if (!hasCause(current) || Predicate.isNullish(current.cause)) break
    current = current.cause
  }
  return messages.join(": ")
}

/** Narrow an unknown value to a readonly array of records. */
export const isRecordArray = Schema.is(Schema.Array(JsonRecord))

/** Drop every absent-valued key so an optional field is missing, not present-and-empty. */
export const omitUndefined = <T extends object>(fields: T): Partial<T> => {
  const kept: Partial<T> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!Predicate.isUndefined(value)) Object.assign(kept, { [key]: value })
  }
  return kept
}
