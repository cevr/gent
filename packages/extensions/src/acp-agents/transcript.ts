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
 * Counsel C5 — the prior renderer only emitted text parts, so tool-heavy
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

const stringifyForAttr = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "null"
  } catch {
    return String(value)
  }
}

const renderPart = (part: TranscriptPart): string | undefined => {
  switch (part.type) {
    case "text": {
      const text = part.text ?? ""
      if (text.length === 0) return undefined
      return escapeXml(text)
    }
    case "reasoning": {
      const text = part.text ?? ""
      if (text.length === 0) return undefined
      return `<thinking>${escapeXml(text)}</thinking>`
    }
    case "tool-call": {
      const name = part.toolName ?? "unknown"
      const id = part.toolCallId ?? ""
      const input = stringifyForAttr(part.input ?? null)
      return `<tool name="${escapeXml(name)}" tool_id="${escapeXml(id)}" input="${escapeXml(input)}" />`
    }
    case "tool-result": {
      const id = part.toolCallId ?? ""
      const status = part.output?.type === "error-json" ? "error" : "ok"
      const value = stringifyForAttr(part.output?.value ?? null)
      return `<result tool_id="${escapeXml(id)}" status="${escapeXml(status)}">${escapeXml(value)}</result>`
    }
    case "image":
      return `<image />`
    default:
      return undefined
  }
}

const renderMessage = (msg: MessageLike): string | undefined => {
  const rendered = msg.parts.map(renderPart).filter((s): s is string => s !== undefined)
  if (rendered.length === 0) return undefined
  const role = escapeXml(msg.role)
  return `<${role}>\n${rendered.join("\n")}\n</${role}>`
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
  liveUserText: string,
): string => {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i
      break
    }
  }
  const history = lastUserIdx <= 0 ? [] : messages.slice(0, lastUserIdx)
  if (history.length === 0) return liveUserText

  const blocks: string[] = []
  for (const msg of history) {
    const rendered = renderMessage(msg)
    if (rendered !== undefined) blocks.push(rendered)
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
