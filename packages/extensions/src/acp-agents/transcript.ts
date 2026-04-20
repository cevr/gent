/**
 * Transcript composition for external-session rebuilds.
 *
 * Both transports (Claude SDK + ACP protocol) expose only a user-message
 * input channel. When a cached session is rebuilt mid-conversation
 * (fingerprint mismatch, `invalidateDriver`, manual `invalidate`), the
 * remote agent has zero memory of prior turns — sending only the live
 * user message would silently drop the history. The executor seeds the
 * fresh session with a `<transcript>` preamble that renders prior
 * messages as plain text, then appends the live user message.
 *
 * @module
 */

interface MessageLike {
  readonly role: string
  readonly parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}

/**
 * Render every message *before* the final user turn as a `<transcript>`
 * preamble, then append the live user message verbatim.
 *
 * The preamble is intentionally simple text — neither transport supports
 * assistant-side history injection. When there is no prior history the
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

  const lines: string[] = ["<transcript>"]
  for (const msg of history) {
    const text = msg.parts
      .map((p) => (p.type === "text" && p.text !== undefined ? p.text : ""))
      .filter((t) => t.length > 0)
      .join("\n")
    if (text.length === 0) continue
    lines.push(`<${msg.role}>`, text, `</${msg.role}>`)
  }
  lines.push("</transcript>", "", liveUserText)
  return lines.join("\n")
}
