/**
 * Claude Code billing-header signing.
 *
 * Anthropic validates OAuth-authenticated requests against a per-message
 * billing signature. The signature lives in `system[0]` (NOT an HTTP
 * header) and encodes:
 *
 *   x-anthropic-billing-header:
 *     cc_version=<version>.<3-hex suffix>;
 *     cc_entrypoint=<entrypoint>;
 *     cch=<5-hex hash of first user message text>;
 *
 * Both hashes are computed from the raw text of the FIRST user message —
 * matching Claude Code's `K19()` extractor. A wrong `cch` (e.g. the
 * placeholder we shipped before this module) trips the validation and
 * surfaces as an `InvalidKey` error from the SDK.
 *
 * Constants and algorithm reverse-engineered by
 * `griffinmartin/opencode-claude-auth` from the Claude Code CLI; both
 * the salt and the format are stable across CLI versions in the field.
 *
 * @module
 */
import { Effect, Option, Schema } from "effect"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform.js"

const BILLING_SALT = "59cf53e54c78"

const MessageBlock = Schema.Struct({
  type: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
})
const MessageContent = Schema.Union([Schema.String, Schema.Array(MessageBlock)])
const Message = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(MessageContent),
})
const decodeMessages = Schema.decodeUnknownOption(Schema.Array(Message))
const decodeTextContent = Schema.decodeUnknownOption(Schema.String)
const decodeBlockContent = Schema.decodeUnknownOption(Schema.Array(MessageBlock))

/**
 * Pull the text of the first user message's first text block — exactly
 * the input Claude Code's `K19()` hashes. Returns the empty string when
 * no user message or no text content is present (matching Claude Code's
 * fallback so the hash stays stable on no-input requests).
 */
export const extractFirstUserMessageText = (messages: ReadonlyArray<object>): string =>
  decodeMessages(messages).pipe(
    Option.flatMap((decoded) =>
      Option.fromNullishOr(decoded.find((message) => message.role === "user")),
    ),
    Option.flatMap((message) => Option.fromNullishOr(message.content)),
    Option.flatMap((content) => {
      const text = decodeTextContent(content)
      if (Option.isSome(text)) return text
      return decodeBlockContent(content).pipe(
        Option.flatMap((blocks) =>
          Option.fromNullishOr(blocks.find((block) => block.type === "text")),
        ),
        Option.flatMap((block) => Option.fromNullishOr(block.text)),
      )
    }),
    Option.getOrElse(() => ""),
  )

/**
 * Compute `cch` — first 5 hex chars of `sha256(messageText)`. The
 * Anthropic billing-validation step rejects requests whose `cch`
 * doesn't match the first user message we send, so this MUST be
 * recomputed per request (the previous hardcoded `c5e82` placeholder
 * worked exactly once, by accident).
 */
export const computeCch = (messageText: string): Effect.Effect<string, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    return platform.hash("sha256", messageText).slice(0, 5)
  })

/**
 * Compute the 3-char version suffix appended to `cc_version`. Samples
 * characters at indices 4, 7, 20 of the message text (zero-padded when
 * the message is shorter), prepends the billing salt + version string,
 * then hashes the lot. Anthropic checks this against the version we
 * advertise in the same header.
 */
export const computeVersionSuffix = (
  messageText: string,
  version: string,
): Effect.Effect<string, never, GentPlatform> =>
  Effect.gen(function* () {
    const platform = yield* GentPlatform
    const sampled = [4, 7, 20]
      .map((index) => Option.getOrElse(Option.fromNullishOr(messageText[index]), () => "0"))
      .join("")
    const input = `${BILLING_SALT}${sampled}${version}`
    return platform.hash("sha256", input).slice(0, 3)
  })

/**
 * Build the full billing-header value for insertion as `system[0]`.
 * Format matches Claude Code byte-for-byte; do not reorder fields or
 * change the trailing semicolons — the validator is strict.
 */
export const buildBillingHeaderValue = (
  messages: ReadonlyArray<object>,
  version: string,
  entrypoint: string,
): Effect.Effect<string, never, GentPlatform> =>
  Effect.gen(function* () {
    const text = extractFirstUserMessageText(messages)
    const suffix = yield* computeVersionSuffix(text, version)
    const cch = yield* computeCch(text)
    return (
      `x-anthropic-billing-header: ` +
      `cc_version=${version}.${suffix}; ` +
      `cc_entrypoint=${entrypoint}; ` +
      `cch=${cch};`
    )
  })
