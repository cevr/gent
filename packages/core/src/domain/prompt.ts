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

export const compileSystemPrompt = (sections: ReadonlyArray<PromptSection>): string =>
  [...sections]
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.content)
    .join("\n\n")

/** The one section core writes: where the loop is running. Everything an agent *is* comes from extensions. */
export function environmentSection(options: {
  cwd: string
  platform: string
  isGitRepo: boolean
  date: string
  shell?: string
  osVersion?: string
}): PromptSection {
  const { cwd, platform, isGitRepo, date, shell, osVersion } = options
  let platformDisplay = platform
  if (!Predicate.isUndefined(osVersion)) platformDisplay = `${platform} (${osVersion})`
  let shellDisplay = "unknown"
  if (!Predicate.isUndefined(shell)) shellDisplay = shell
  let gitRepository = "no"
  if (isGitRepo) gitRepository = "yes"
  return {
    id: "environment",
    content: `# Environment\n\nWorking directory: ${cwd}\nPlatform: ${platformDisplay}\nShell: ${shellDisplay}\nGit repository: ${gitRepository}\nDate: ${date}`,
    priority: 60,
  }
}
