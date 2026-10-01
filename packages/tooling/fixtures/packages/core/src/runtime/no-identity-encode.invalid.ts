import { Schema } from "effect"

declare const Item: Schema.Codec<unknown, string>
declare const m: object
declare const a: object
declare const b: object
declare const item: { readonly id: string }
declare const rest: (value: object) => object
declare const seen: Set<string>

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

// Stored under a name that says identity: camelCase, snake_case, a bare word.
export const identity = encodeJson(m)
export const messageIdentity = encodeJson(m)
export const dedupeKey = encodeJson(m)
export const cache_key = encodeJson(m)

// Compared, looked up or collected where it is produced.
export const same = encodeJson(a) === "{}"
export const known = seen.has(encodeJson(m))
seen.add(encodeJson(m))

// An array literal that still carries a whole object.
export const itemIdentity = encodeJson([item])
export const withObjectKey = encodeJson([item.id, { a: 1 }])
export const withCallKey = encodeJson([item.id, rest(item)])

// A safe encode on one side does not excuse the other side.
export const mixed = encodeJson([item.id]) === encodeJson(b)

// The formatter breaks a long binding across lines.
const encodeItem = Schema.encodeSync(
  Schema.fromJsonString(Item),
)
export const split = encodeItem(a) !== encodeItem([item.id])

// An encoder called where it is built.
export const inline = seen.has(Schema.encodeSync(Schema.fromJsonString(Item))(a))

// A struct written in place fixes only its own fields' order: a field that
// holds an open value writes that value's keys in the value's order.
const encodePayload = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, payload: Schema.Unknown })),
)
export const payloadIdentity = encodePayload(a)
const encodeTags = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      inner: Schema.Struct({ tags: Schema.Record(Schema.String, Schema.String) }),
    }),
  ),
)
export const tagsKey = encodeTags(a)
const encodeNamed = Schema.encodeSync(Schema.fromJsonString(Schema.Struct({ item: Item })))
export const namedKey = encodeNamed(a)
