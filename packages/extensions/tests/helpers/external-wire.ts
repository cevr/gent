import { Schema } from "effect"

/** A provider's wire JSON as it is sent: fixtures of the Anthropic and OpenAI APIs. */

// oxlint-disable-next-line effect/noNullish -- the provider's wire JSON holds null, and the fixtures carry it as sent
export const externalWireNull = null

export const encodeExternalJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
