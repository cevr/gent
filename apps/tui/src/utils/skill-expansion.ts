/**
 * Skill mention expansion — `$skill-name` tokens in user messages
 *
 * Finds `$skill-name` tokens, loads SKILL.md content from preloaded skills,
 * wraps in XML context blocks, and prepends to the user message.
 */

import { dirname } from "path"

/** Escape a string for use in an XML attribute value. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

/** Max total bytes of expanded skill content (~100KB) */
const MAX_EXPANDED_BYTES = 100_000

// Match $skill-name but not $$, \$, or mid-word $
const SKILL_TOKEN_RE = /(?<![\\$\w])\$([a-z][a-z0-9-]*)/g

export interface SkillToken {
  readonly name: string
  readonly start: number
  readonly end: number
}

/** Parse all `$skill-name` tokens from text. */
export function parseSkillTokens(text: string): SkillToken[] {
  const tokens: SkillToken[] = []
  for (const match of text.matchAll(SKILL_TOKEN_RE)) {
    const name = match[1]
    if (name === undefined) continue
    const start = match.index
    tokens.push({ name, start, end: start + match[0].length })
  }
  return tokens
}

/**
 * Expand skill mentions in user text.
 *
 * Finds `$skill-name` tokens, looks up content via `getContent`,
 * and prepends loaded skill context as XML blocks.
 *
 * @param text - User message text (may contain `$skill-name` tokens)
 * @param getContent - Sync lookup: skill name → content string or null
 * @param getFilePath - Sync lookup: skill name → file path or null (for base_dir)
 * @returns Expanded message with skill context prepended, or original text if no skills found
 */
export function expandSkillMentions(
  text: string,
  getContent: (name: string) => string | null,
  getFilePath?: (name: string) => string | null,
): string {
  const tokens = parseSkillTokens(text)
  if (tokens.length === 0) return text

  const seen = new Set<string>()
  const blocks: string[] = []
  let totalBytes = 0

  for (const token of tokens) {
    if (seen.has(token.name)) continue
    seen.add(token.name)

    const content = getContent(token.name)
    if (content === null) continue

    // Cap total expanded bytes
    if (totalBytes + content.length > MAX_EXPANDED_BYTES) continue

    const filePath = getFilePath?.(token.name)
    const baseDir = filePath !== null && filePath !== undefined ? dirname(filePath) : undefined
    const baseDirAttr = baseDir !== undefined ? ` base_dir="${escapeAttr(baseDir)}"` : ""

    // CDATA wrapping prevents skill content (arbitrary markdown) from breaking the XML envelope
    const safeContent = content.includes("]]>")
      ? content.replaceAll("]]>", "]]]]><![CDATA[>")
      : content
    blocks.push(
      `<loaded_skill name="${escapeAttr(token.name)}"${baseDirAttr}>\n<![CDATA[${safeContent}]]>\n</loaded_skill>`,
    )
    totalBytes += content.length
  }

  if (blocks.length === 0) return text

  return `<skill-context>\n${blocks.join("\n\n")}\n</skill-context>\n\n${text}`
}
