import { Effect, Schema } from "effect"

declare const entry: object
declare const result: object
declare const call: { readonly id: string; readonly status: string } | undefined
declare const s: { readonly _tag: string; readonly toolCall: object }
declare const a: { readonly id: string }
declare const b: { readonly id: string }
declare const toolFingerprint: (value: object) => ReadonlyArray<string>

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// An encode for a log line or a display string decides nothing.
export const logged = Effect.log(encodeJson(entry))
export const text = encodeJson(result)
export const keyboardHint = 1

// A fixed-order projection: a fingerprint call, or an array of field
// accesses, primitives and fingerprint calls.
export const toolIdentity = (c: object) => encodeJson(toolFingerprint(c))
export const identity = encodeJson([call?.id, call?.status])
export const tagged = encodeJson(["tool", 1, -1, true, call?.id, null, undefined])
export const key = encodeJson([s._tag, toolFingerprint(s.toolCall)])
export const same = encodeJson([a.id]) === encodeJson([b.id])

// A struct schema written in place writes its fields in its own order.
const cacheKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ source: Schema.String, maxWidth: Schema.Finite })),
)
export const cached = new Map<string, string>().get(cacheKey({ source: "a", maxWidth: 1 }))
