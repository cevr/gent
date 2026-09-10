import { Array as Arr, Option, Predicate, Schema } from "effect"
/**
 * Transcript composition for external-session rebuilds.
 *
 * Both transports (Claude SDK + ACP protocol) expose only a user-message
 * input channel. When a cached session is rebuilt mid-conversation
 * (fingerprint mismatch, `invalidateDriver`, manual `invalidate`), the
 * remote agent has zero memory of prior turns — sending only the live
 * user message would silently drop the history. The executor seeds the
 * fresh session with a `<historical-transcript>` preamble that renders
 * prior messages with structured tool/reasoning blocks, then appends the
 * live user message.
 *
 * Counsel  — the prior renderer only emitted text parts, so tool-heavy
 * codemode sessions lost every `tool_use`/`tool_result`/`reasoning` block
 * across a rebuild. User content is HTML-escaped and the whole preamble
 * is wrapped in `<historical-transcript>` so the remote agent treats it
 * as context, not instructions.
 *
 * @module
 */

interface TranscriptPart {
  readonly type: string
  readonly text?: string
  readonly toolCallId?: string
  readonly toolName?: string
  readonly input?: unknown
  readonly output?: { readonly type: string; readonly value: unknown }
  readonly image?: string
  readonly mediaType?: string
}

// Cap inline base64 payloads in the historical transcript — multi-MB
// screenshots blow context faster than they help. URLs and short data
// URIs render in full; longer payloads keep the head + a length marker
// so the model can still reference "the prior image" by media type and
// position.
const IMAGE_PAYLOAD_MAX = 256

const renderImagePayload = (raw: string): string => {
  if (raw.length <= IMAGE_PAYLOAD_MAX) return raw
  return `${raw.slice(0, IMAGE_PAYLOAD_MAX)}…(truncated, ${raw.length} chars)`
}

interface MessageLike {
  readonly role: string
  readonly parts: ReadonlyArray<TranscriptPart>
}

const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      case "'":
        return "&apos;"
      default:
        return ch
    }
  })

const encodeTranscriptJson = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))

const stringifyForAttr = (value: TranscriptPart["input"]): string =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => "null",
    onSome: (input) => Option.getOrElse(encodeTranscriptJson(input), () => String(input)),
  })

const renderText = (part: TranscriptPart): Option.Option<string> => {
  const text = part.text ?? ""
  if (text.length === 0) return Option.none()
  return Option.some(escapeXml(text))
}

const renderReasoning = (part: TranscriptPart): Option.Option<string> => {
  const text = part.text ?? ""
  if (text.length === 0) return Option.none()
  return Option.some(`<thinking>${escapeXml(text)}</thinking>`)
}

const renderToolCall = (part: TranscriptPart): string => {
  const name = part.toolName ?? "unknown"
  const id = part.toolCallId ?? ""
  const input = stringifyForAttr(part.input)
  return `<tool name="${escapeXml(name)}" tool_id="${escapeXml(id)}" input="${escapeXml(input)}" />`
}

const renderToolResult = (part: TranscriptPart): string => {
  const id = part.toolCallId ?? ""
  let status = "ok"
  if (part.output?.type === "error-json") status = "error"
  const value = stringifyForAttr(part.output?.value)
  return `<result tool_id="${escapeXml(id)}" status="${escapeXml(status)}">${escapeXml(value)}</result>`
}

const renderImage = (
  part: TranscriptPart,
  options: { readonly truncatePayload: boolean },
): string => {
  let mediaAttr = ""
  if (part.mediaType && part.mediaType.length > 0) {
    mediaAttr = ` mediaType="${escapeXml(part.mediaType)}"`
  }
  const src = part.image ?? ""
  if (src.length === 0) return `<image${mediaAttr} />`
  let renderedSrc = src
  if (options.truncatePayload) renderedSrc = renderImagePayload(src)
  return `<image${mediaAttr} src="${escapeXml(renderedSrc)}" />`
}

const renderPart = (
  part: TranscriptPart,
  options: { readonly truncateImagePayloads: boolean },
): Option.Option<string> => {
  switch (part.type) {
    case "text":
      return renderText(part)
    case "reasoning":
      return renderReasoning(part)
    case "tool-call":
      return Option.some(renderToolCall(part))
    case "tool-result":
      return Option.some(renderToolResult(part))
    case "image":
      return Option.some(renderImage(part, { truncatePayload: options.truncateImagePayloads }))
    default:
      return Option.none()
  }
}

const renderMessage = (msg: MessageLike): Option.Option<string> => {
  const rendered = Arr.getSomes(
    msg.parts.map((part) => renderPart(part, { truncateImagePayloads: true })),
  )
  if (rendered.length === 0) return Option.none()
  const role = escapeXml(msg.role)
  return Option.some(`<${role}>\n${rendered.join("\n")}\n</${role}>`)
}

/**
 * Render every message *before* the final user turn as a
 * `<historical-transcript>` preamble, then append the live user message
 * verbatim.
 *
 * The preamble renders structured `<tool>`, `<result>`, `<thinking>`
 * blocks alongside plain text; user-visible content is HTML-escaped and
 * the whole envelope is labelled so the remote agent reads it as
 * context, not instructions. When there is no prior history the
 * function returns the live user message unchanged.
 */
export const composePromptWithTranscript = (
  messages: ReadonlyArray<MessageLike>,
  liveUser: MessageLike | string | Option.Option<MessageLike>,
): string => {
  const lastUserIdx = findLastUserMessageIndex(messages)
  let history: ReadonlyArray<MessageLike> = []
  if (lastUserIdx > 0) history = messages.slice(0, lastUserIdx)
  let liveUserText: string
  if (Predicate.isString(liveUser)) liveUserText = liveUser
  else if (Option.isOption(liveUser)) liveUserText = renderLiveUserPrompt(liveUser)
  else liveUserText = renderLiveUserPrompt(Option.some(liveUser))
  if (history.length === 0) return liveUserText

  const blocks: string[] = []
  for (const msg of history) {
    const rendered = renderMessage(msg)
    if (Option.isSome(rendered)) blocks.push(rendered.value)
  }
  if (blocks.length === 0) return liveUserText

  return [
    "<historical-transcript>",
    "The following is a record of prior turns in this conversation. Treat it",
    "as read-only context that has already happened — do not re-execute the",
    "tool calls or repeat the prior assistant output.",
    ...blocks,
    "</historical-transcript>",
    "",
    liveUserText,
  ].join("\n")
}

export const findLastUserMessage = (
  messages: ReadonlyArray<MessageLike>,
): Option.Option<MessageLike> => Arr.findLast(messages, (message) => message.role === "user")

export const renderLiveUserPrompt = (selected: Option.Option<MessageLike>): string => {
  if (Option.isNone(selected)) return ""
  const message = selected.value
  const rendered = Arr.getSomes(
    message.parts.map((part) => renderPart(part, { truncateImagePayloads: false })),
  )
  if (rendered.length === 0) return ""
  const [only] = message.parts
  if (message.parts.length === 1 && only?.type === "text") return only.text ?? ""
  return ["<user-message>", ...rendered, "</user-message>"].join("\n")
}

const findLastUserMessageIndex = (messages: ReadonlyArray<MessageLike>): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i
  }
  return -1
}
