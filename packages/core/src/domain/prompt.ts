import { Predicate } from "effect"
/**
 * System prompt construction via ordered sections.
 *
 * Static prompt sections are bundled on capability leaf `prompt`. Dynamic
 * content resolved per-turn from services lives on extension hooks.
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

const IDENTITY = `You are Gent, a general purpose agent that uses code to solve tasks.
You solve tasks by breaking problems into sub-tasks, writing and running TypeScript in the cell, observing results, and iterating one step at a time.
When you are done, stop calling tools and state your final answer.`

const WORK = `# Work

- The cell is your persistent control environment. Keep intermediate values in named variables, inspect and transform outputs, and write small helpers. Use it for loops, parsing, and state; call host tools for effects.
- Evaluate an external project through its own interface (its build, tests, and commands). The cell coordinates and analyzes; it is not the target's runtime.
- Read before you edit. Match the existing style. Fix root causes. Touch only what the task needs. Verify with the project's checks before you report.
- For slow or independent work, start it, keep the handle, and end the turn. Do not keep a turn open by sleeping or polling.
- Delegate independent, self-contained work to children. A child inherits your agent and model and has no conversation history, so give it a complete task. Do a single lookup, edit, or command inline.
- When work spans many steps or children, give short progress updates: what is done, what is blocked, what is next.`

const COMMUNICATION = `# Communication

- Short sentences. Common words. One action or fact per sentence. Lists for steps and conditions.
- Keep commands, code, paths, names, and quoted text exact. State uncertainty directly.
- Reference code as \`file:line\`. No preamble. No emoji unless asked.`

const BOUNDARIES = `# Boundaries

- Never revert changes you did not make.
- Never run destructive git commands without explicit permission.
- Never expose secrets, API keys, or credentials in code or output.`

export function buildBasePromptSections(options: {
  cwd: string
  platform: string
  isGitRepo: boolean
  date: string
  shell?: string
  osVersion?: string
  customInstructions?: string
}): ReadonlyArray<PromptSection> {
  const { cwd, platform, isGitRepo, date, shell, osVersion, customInstructions } = options
  let platformDisplay = platform
  if (!Predicate.isUndefined(osVersion)) platformDisplay = `${platform} (${osVersion})`
  let shellDisplay = "unknown"
  if (!Predicate.isUndefined(shell)) shellDisplay = shell
  let gitRepository = "no"
  if (isGitRepo) gitRepository = "yes"

  const sections: PromptSection[] = [
    { id: "identity", content: IDENTITY, priority: 0 },
    { id: "work", content: WORK, priority: 10 },
    { id: "communication", content: COMMUNICATION, priority: 20 },
    { id: "boundaries", content: BOUNDARIES, priority: 50 },
    {
      id: "environment",
      content: `# Environment\n\nWorking directory: ${cwd}\nPlatform: ${platformDisplay}\nShell: ${shellDisplay}\nGit repository: ${gitRepository}\nDate: ${date}`,
      priority: 60,
    },
  ]

  if (!Predicate.isUndefined(customInstructions) && customInstructions !== "") {
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
  date: string
  shell?: string
  osVersion?: string
  customInstructions?: string
}): string {
  return compileSystemPrompt(buildBasePromptSections(options))
}
