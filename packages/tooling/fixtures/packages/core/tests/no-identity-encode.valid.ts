import { Schema } from "effect"

declare const m: object

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// A test is not shipped source: it may compare whole encodes.
export const identity = encodeJson(m)
