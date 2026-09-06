import { Option, Schema } from "effect"

const decodeJsonObject = Schema.decodeUnknownOption(Schema.JsonObject)
const decodeString = Schema.decodeUnknownOption(Schema.String)
export type ToolInput = Parameters<typeof decodeJsonObject>[0]

/** Decode tool output JSON against an Effect Schema. */
export const decodeToolOutputOption = <T>(schema: Schema.Decoder<T, never>, input: ToolInput) =>
  Schema.decodeUnknownOption(Schema.fromJsonString(schema))(input)

/** Decode tool output JSON for framework adapters that use `undefined` for absence. */
export const decodeToolOutput = <T>(schema: Schema.Decoder<T, never>, input: ToolInput) =>
  Option.getOrUndefined(decodeToolOutputOption(schema, input))

/** Extract a string property from an untrusted tool input. */
export const getString = (input: ToolInput, key: string, fallback = ""): string =>
  Option.getOrElse(
    decodeJsonObject(input).pipe(Option.flatMap((record) => decodeString(record[key]))),
    () => fallback,
  )
