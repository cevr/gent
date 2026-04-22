/**
 * System prompt construction via ordered sections.
 *
 * Prompt slots that need to swap or strip a section (e.g. codemode
 * replacing `tool-list` / `tool-guidelines`) ask the section author to
 * wrap content in `<!-- @section:<id>:start --> ... @section:<id>:end -->`
 * sentinel comments via `withSectionMarkers`. Markers are HTML comments
 * so they're invisible to most renderers but survive whatever upstream
 * rewrite an earlier slot did. Counsel C6 — replaces brittle
 * `indexOf(section.content)` string surgery; the previous shape broke
 * the moment any upstream slot rewrote a single character inside the
 * native section.
 *
 * Markers are opt-in (per-section, by author) rather than wrapped around
 * every section automatically — most sections never need to be swapped
 * by another extension, and unconditional markers add token noise to
 * every turn for no benefit.
 */

import type { PromptSection } from "../domain/prompt.js"

export type { PromptSection } from "../domain/prompt.js"

/** Sentinel pair marking the bounds of a section that downstream
 *  prompt slots may swap or strip. */
export const sectionStartMarker = (id: string): string => `<!-- @section:${id}:start -->`
export const sectionEndMarker = (id: string): string => `<!-- @section:${id}:end -->`

/**
 * Wrap section content with start/end sentinels so downstream prompt
 * slots can locate it for atomic replacement. Used by section authors
 * whose content is intentionally swappable (currently `tool-list` and
 * `tool-guidelines`, swapped by the ACP codemode slot).
 */
export const withSectionMarkers = (id: string, content: string): string =>
  `${sectionStartMarker(id)}\n${content}\n${sectionEndMarker(id)}`

// Counsel C6 — full regex escape for the marker strings. PromptSection
// `id` is unconstrained (extension-authored), so a section named e.g.
// `tool.list+v2` would otherwise carry regex metacharacters straight
// into `new RegExp(...)`. The previous shape only escaped `-`.
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")

/**
 * Match a compiled section by id. Returns the regex that captures the
 * inner content (group 1) and supports atomic replacement.
 */
export const sectionPatternFor = (id: string): RegExp =>
  new RegExp(
    `${escapeRegExp(sectionStartMarker(id))}\\n([\\s\\S]*?)\\n${escapeRegExp(sectionEndMarker(id))}`,
  )

/** Compile ordered sections into a single system prompt string */
export const compileSystemPrompt = (sections: ReadonlyArray<PromptSection>): string =>
  [...sections]
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.content)
    .join("\n\n")

// Default section content

const CHARACTER = `# Character

- Finish what you start. Stay with a problem until it's truly solved.
- Honest over agreeable. If an approach is flawed, say so and show the better way.
- Calm under pressure. Errors and setbacks are information, not failure.`

const COMMUNICATION = `# Communication

- Concise. No preambles. Summarize changes briefly at the end of each turn.
- Direct. When the path is clear, act. When uncertain, investigate before asking.
- Encouraging. Meet people where they are. The work matters.
- Markdown for structure. Reference code as \`file:line\`.
- No emoji unless asked.`

const CODE = `# Code

- Read before writing. Understand existing code first.
- Match existing style and conventions.
- Fix root causes, not symptoms.
- Only touch what you were asked to touch.
- Defer complexity. Start simple, earn abstraction through measurement.
- Progressive disclosure. Hide details until they're needed.
- Verify: run tests, check types. Don't hand back something broken.`

const TOOLS_HEADER = `# Tools

- Parallel when independent. Sequential when one depends on another.
- Read before edit. Always.`

const BOUNDARIES = `# Boundaries

- Never revert changes you didn't make
- Never use destructive git commands without explicit permission
- Never expose secrets, API keys, or credentials in code or output
- Deliver what you promise`

/**
 * Build the base prompt sections (everything except agent addendum and per-turn tool list).
 * Returns sections that can be extended with tool-aware and extension-contributed sections.
 */
export function buildBasePromptSections(options: {
  cwd: string
  platform: string
  isGitRepo: boolean
  shell?: string
  osVersion?: string
  customInstructions?: string
}): ReadonlyArray<PromptSection> {
  const { cwd, platform, isGitRepo, shell, osVersion, customInstructions } = options
  const date = new Date().toISOString().split("T")[0]
  const platformDisplay = osVersion !== undefined ? `${platform} (${osVersion})` : platform

  const sections: PromptSection[] = [
    {
      id: "identity",
      content: "You are Gent, a coding assistant operating inside gent, an agent harness.",
      priority: 0,
    },
    { id: "character", content: CHARACTER, priority: 10 },
    { id: "communication", content: COMMUNICATION, priority: 20 },
    { id: "code", content: CODE, priority: 30 },
    { id: "tools", content: TOOLS_HEADER, priority: 40 },
    { id: "boundaries", content: BOUNDARIES, priority: 50 },
    {
      id: "environment",
      content: `# Environment\n\nWorking directory: ${cwd}\nPlatform: ${platformDisplay}\nShell: ${shell ?? "unknown"}\nGit repository: ${isGitRepo ? "yes" : "no"}\nDate: ${date}`,
      priority: 60,
    },
  ]

  if (customInstructions !== undefined && customInstructions !== "") {
    sections.push({
      id: "project-instructions",
      content: `# Project Instructions\n\n${customInstructions}`,
      priority: 70,
    })
  }

  return sections
}

/**
 * Build the full system prompt string (convenience for callers that don't need per-turn tool awareness).
 * Used at startup for the base prompt; per-turn prompt is built by buildTurnPrompt in agent-loop.utils.
 */
export function buildSystemPrompt(options: {
  cwd: string
  platform: string
  isGitRepo: boolean
  shell?: string
  osVersion?: string
  customInstructions?: string
}): string {
  return compileSystemPrompt(buildBasePromptSections(options))
}
