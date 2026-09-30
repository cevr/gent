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

// Nested in-place structs, arrays, tuples, literals and optional fields of
// primitives write every key in the schema's order.
const nestedKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      kind: Schema.Literals(["a", "b"]),
      size: Schema.optional(Schema.Int),
      tags: Schema.Array(Schema.String),
      pair: Schema.Tuple([Schema.Boolean, Schema.NullOr(Schema.Number)]),
      inner: Schema.Struct({ name: Schema.optionalKey(Schema.String) }),
    }),
  ),
)
export const nested = new Set<string>().has(
  nestedKey({ kind: "a", tags: [], pair: [true, null], inner: {} }),
)
