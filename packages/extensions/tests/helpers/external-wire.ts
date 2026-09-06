import { Schema } from "effect"

const decodeWireNull = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Null))
const encodeWireJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

export const externalWireNull = decodeWireNull("null")
export const encodeExternalJson = encodeWireJson
