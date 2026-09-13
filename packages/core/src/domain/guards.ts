import { Predicate, Schema } from "effect"
/** Shared type guards for narrowing unknown/JSON boundary values. */

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown)

/** Narrow an unknown value to a string-keyed record. */
export const isRecord = Schema.is(JsonRecord)

/** Narrow an unknown value to an object with a `.message` string property. */
export const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }))

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
