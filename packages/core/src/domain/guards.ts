import { Schema } from "effect"
/** Shared type guards for narrowing unknown/JSON boundary values. */

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown)

/** Narrow an unknown value to a string-keyed record. */
export const isRecord = Schema.is(JsonRecord)

/** Narrow an unknown value to an object with a `.message` string property. */
export const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }))

/** Narrow an unknown value to a readonly array of records. */
export const isRecordArray = Schema.is(Schema.Array(JsonRecord))
