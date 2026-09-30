import { Option, Schema } from "effect"

declare const found: Option.Option<string>

export const present = Option.getOrUndefined(found)
export const fallback = Option.getOrUndefined(Option.some("x"))
export const empty = Option.none()

const Payload = Schema.Struct({ id: Schema.String })
export type PayloadType = Schema.Schema.Type<typeof Payload>
export type Unknown = typeof Schema.Unknown
