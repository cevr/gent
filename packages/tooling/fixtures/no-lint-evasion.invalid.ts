import { Option, Schema } from "effect"

export const absent = Option.getOrUndefined(Option.none())
export const absentTyped = Option.getOrUndefined(Option.none<string>())
export const record = { model: Option.getOrUndefined(Option.none()) }

export type Payload = Schema.Schema.Type<typeof Schema.Unknown>
export const accept = (value: Schema.Schema.Type<typeof Schema.Unknown>) => value
