/**
 * System prompt construction via ordered sections.
 *
 * Static prompt sections are bundled on capability leaf `prompt`. Dynamic
 * content resolved per-turn from services lives on extension reactions.
 */
export interface PromptSection {
  readonly id: string
  readonly content: string
  /** Lower = earlier in the prompt. Default sections use 0-80 range. */
  readonly priority: number
}

/** Sentinel pair marking the bounds of a swappable section. */
export const sectionStartMarker = (id: string): string => `<!-- @section:${id}:start -->`
export const sectionEndMarker = (id: string): string => `<!-- @section:${id}:end -->`

export const withSectionMarkers = (id: string, content: string): string =>
  `${sectionStartMarker(id)}\n${content}\n${sectionEndMarker(id)}`

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")

export const sectionPatternFor = (id: string): RegExp =>
  new RegExp(
    `${escapeRegExp(sectionStartMarker(id))}\\n([\\s\\S]*?)\\n${escapeRegExp(sectionEndMarker(id))}`,
  )

export const compileSystemPrompt = (sections: ReadonlyArray<PromptSection>): string =>
  [...sections]
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.content)
    .join("\n\n")

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
