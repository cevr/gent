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
import { createHash } from "node:crypto"

const BILLING_SALT = "59cf53e54c78"

interface Message {
  readonly role?: string
  readonly content?: string | ReadonlyArray<{ readonly type?: string; readonly text?: string }>
}

/**
 * Pull the text of the first user message's first text block — exactly
 * the input Claude Code's `K19()` hashes. Returns the empty string when
 * no user message or no text content is present (matching Claude Code's
 * fallback so the hash stays stable on no-input requests).
 */
export const extractFirstUserMessageText = (messages: ReadonlyArray<Message>): string => {
  const userMsg = messages.find((m) => m.role === "user")
  if (userMsg === undefined) return ""
  const content = userMsg.content
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === "text")
    if (textBlock?.type === "text" && typeof textBlock.text === "string") {
      return textBlock.text
    }
  }
  return ""
}

/**
 * Compute `cch` — first 5 hex chars of `sha256(messageText)`. The
 * Anthropic billing-validation step rejects requests whose `cch`
 * doesn't match the first user message we send, so this MUST be
 * recomputed per request (the previous hardcoded `c5e82` placeholder
 * worked exactly once, by accident).
 */
export const computeCch = (messageText: string): string =>
  createHash("sha256").update(messageText).digest("hex").slice(0, 5)

/**
 * Compute the 3-char version suffix appended to `cc_version`. Samples
 * characters at indices 4, 7, 20 of the message text (zero-padded when
 * the message is shorter), prepends the billing salt + version string,
 * then hashes the lot. Anthropic checks this against the version we
 * advertise in the same header.
 */
export const computeVersionSuffix = (messageText: string, version: string): string => {
  const sampled = [4, 7, 20].map((i) => (i < messageText.length ? messageText[i] : "0")).join("")
  const input = `${BILLING_SALT}${sampled}${version}`
  return createHash("sha256").update(input).digest("hex").slice(0, 3)
}

/**
 * Build the full billing-header value for insertion as `system[0]`.
 * Format matches Claude Code byte-for-byte; do not reorder fields or
 * change the trailing semicolons — the validator is strict.
 */
export const buildBillingHeaderValue = (
  messages: ReadonlyArray<Message>,
  version: string,
  entrypoint: string,
): string => {
  const text = extractFirstUserMessageText(messages)
  const suffix = computeVersionSuffix(text, version)
  const cch = computeCch(text)
  return (
    `x-anthropic-billing-header: ` +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    `cch=${cch};`
  )
}
