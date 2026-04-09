/**
 * Slash command resolution — looks up commands by slash name or alias.
 */

import { Effect } from "effect"
import type { Command } from "../command/types"

export interface SlashCommandResult {
  handled: boolean
  error?: string
}

/**
 * Find and execute a slash command from the command registry.
 * Matches by `slash` or `aliases`, sorted by `slashPriority` (lower wins).
 */
export const executeSlashCommand = (
  cmd: string,
  args: string,
  commands: ReadonlyArray<Command>,
): Effect.Effect<SlashCommandResult> => {
  const lowerCmd = cmd.toLowerCase()

  // Collect all matching commands, sort by priority
  const matches = commands
    .filter((c) => {
      if (c.slash === undefined) return false
      if (c.slash.toLowerCase() === lowerCmd) return true
      return c.aliases?.some((a) => a.toLowerCase() === lowerCmd) === true
    })
    .sort((a, b) => (a.slashPriority ?? 10) - (b.slashPriority ?? 10))

  const match = matches[0]
  if (match === undefined) {
    return Effect.succeed({ handled: false, error: `Unknown command: /${cmd}` })
  }

  if (match.onSlash !== undefined) match.onSlash(args)
  else match.onSelect()
  return Effect.succeed({ handled: true })
}

/**
 * Parse slash command from input
 * @returns [command, args] or null if not a slash command
 */
export function parseSlashCommand(input: string): [string, string] | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null

  const spaceIdx = trimmed.indexOf(" ")
  if (spaceIdx === -1) {
    return [trimmed.slice(1), ""]
  }

  return [trimmed.slice(1, spaceIdx), trimmed.slice(spaceIdx + 1).trim()]
}
