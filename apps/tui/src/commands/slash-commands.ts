/**
 * Slash command handlers
 *
 * Commands: /model, /clear, /sessions, /compact, /branch
 */

import { Effect } from "effect"
import { formatError, type UiError } from "../utils/format-error"

export type SlashCommandId = "model" | "clear" | "sessions" | "compact" | "branch" | "tree" | "fork"

export interface SlashCommandContext {
  openPalette: () => void
  clearMessages: () => void
  navigateToSessions: () => void
  compactHistory: Effect.Effect<void, UiError>
  createBranch: Effect.Effect<void, UiError>
  openTree: () => void
  openFork: () => void
}

export interface SlashCommandResult {
  handled: boolean
  error?: string
}

const runCommandEffect = (
  effect: Effect.Effect<void, UiError>,
): Effect.Effect<SlashCommandResult, UiError> =>
  effect.pipe(
    Effect.as({ handled: true } satisfies SlashCommandResult),
    Effect.catchAll((error) =>
      Effect.succeed({
        handled: true,
        error: formatError(error),
      }),
    ),
  )

/**
 * Execute a slash command
 */
export const executeSlashCommand = (
  cmd: string,
  _args: string,
  ctx: SlashCommandContext,
): Effect.Effect<SlashCommandResult, UiError> => {
  switch (cmd.toLowerCase()) {
    case "model":
      // Open command palette at model submenu
      return Effect.sync(() => {
        ctx.openPalette()
        return { handled: true }
      })

    case "clear":
      return Effect.sync(() => {
        ctx.clearMessages()
        return { handled: true }
      })

    case "sessions":
      return Effect.sync(() => {
        ctx.navigateToSessions()
        return { handled: true }
      })

    case "compact":
      return runCommandEffect(ctx.compactHistory)

    case "branch":
      return runCommandEffect(ctx.createBranch)

    case "tree":
      return Effect.sync(() => {
        ctx.openTree()
        return { handled: true }
      })

    case "fork":
      return Effect.sync(() => {
        ctx.openFork()
        return { handled: true }
      })

    default:
      return Effect.succeed({ handled: false, error: `Unknown command: /${cmd}` })
  }
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
