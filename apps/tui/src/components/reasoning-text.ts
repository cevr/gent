/**
 * Reasoning summaries, prepared for the markdown renderer.
 *
 * A model emits reasoning as a run of summaries, and each one is its own bold
 * markdown heading. `messagePartsReasoning` joins the parts with an empty
 * string, so the headings collide and the pane showed one unreadable line:
 *
 *     **Verifying final test output****Refactoring LedgerStore.list…**
 *
 * The literal asterisks were there because reasoning rendered as plain text
 * rather than through the markdown element the reply uses.
 *
 * Splitting the run back into summaries and joining them with a blank line
 * gives markdown the paragraph break it needs, so each summary renders as its
 * own line with the emphasis applied rather than printed.
 */

/** A bold span that ends where the next one begins, with no separator between. */
const collidingSummaries = /\*\*(?=\*\*)/g

export const reasoningMarkdown = (reasoning: string): string => {
  if (reasoning.length === 0) return ""
  return reasoning
    .replace(collidingSummaries, "**\n\n")
    .split("\n\n")
    .map((summary) => summary.trim())
    .filter((summary) => summary.length > 0)
    .join("\n\n")
}
