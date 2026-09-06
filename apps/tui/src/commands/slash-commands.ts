/**
 * Slash command resolution — looks up commands by slash name or alias.
 */

import { Effect, Option } from "effect"
import type { Command } from "../command/types"

export interface SlashCommandResult {
  handled: boolean
  // eslint-disable-next-line effect/noNullish -- command results omit an error on success.
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
      const slash = Option.fromNullishOr(c.slash)
      if (Option.isNone(slash)) return false
      if (slash.value.toLowerCase() === lowerCmd) return true
      const aliases = Option.fromNullishOr(c.aliases)
      if (Option.isNone(aliases)) return false
      return aliases.value.some((a) => a.toLowerCase() === lowerCmd)
    })
    .sort((a, b) => {
      const aPriority = Option.getOrElse(Option.fromNullishOr(a.slashPriority), () => 10)
      const bPriority = Option.getOrElse(Option.fromNullishOr(b.slashPriority), () => 10)
      return aPriority - bPriority
    })

  const match = Option.fromNullishOr(matches[0])
  if (Option.isNone(match)) {
    return Effect.succeed({ handled: false, error: `Unknown command: /${cmd}` })
  }

  const onSlash = Option.fromNullishOr(match.value.onSlash)
  if (Option.isSome(onSlash)) onSlash.value(args)
  else match.value.onSelect()
  return Effect.succeed({ handled: true })
}

/**
 * Parse slash command from input
 * @returns [command, args] or null if not a slash command
 */
// eslint-disable-next-line effect/noNullish -- parser API uses null as its no-match sentinel.
export function parseSlashCommand(input: string): [string, string] | null {
  const trimmed = input.trim()
  // eslint-disable-next-line effect/noNullish -- parser API uses null as its no-match sentinel.
  if (!trimmed.startsWith("/")) return null

  const spaceIdx = trimmed.indexOf(" ")
  if (spaceIdx === -1) {
    return [trimmed.slice(1), ""]
  }

  return [trimmed.slice(1, spaceIdx), trimmed.slice(spaceIdx + 1).trim()]
}
