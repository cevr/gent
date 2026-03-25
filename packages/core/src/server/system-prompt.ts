/**
 * System prompt construction via ordered sections
 */

import { formatSkillsForPrompt, type Skill } from "../domain/skills.js"
import type { PromptSection } from "../domain/prompt.js"

export type { PromptSection } from "../domain/prompt.js"

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
  skills?: ReadonlyArray<Skill>
}): ReadonlyArray<PromptSection> {
  const { cwd, platform, isGitRepo, shell, osVersion, customInstructions, skills } = options
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

  const skillsBlock = skills !== undefined ? formatSkillsForPrompt(skills) : ""
  if (skillsBlock !== "") {
    sections.push({ id: "skills", content: skillsBlock, priority: 80 })
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
  skills?: ReadonlyArray<Skill>
}): string {
  return compileSystemPrompt(buildBasePromptSections(options))
}
