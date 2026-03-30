/**
 * Slash command handlers
 *
 * Commands: /clear, /new, /sessions, /branch, /tree, /fork, /bypass, /handoff
 */

import { Effect } from "effect"
import type { ReasoningEffort } from "@gent/core/domain/agent.js"
import { formatError, type UiError } from "../utils/format-error"

export interface SlashCommandContext {
  openPalette: () => void
  clearMessages: () => void
  navigateToSessions: () => void
  createBranch: Effect.Effect<void, UiError>
  openTree: () => void
  openFork: () => void
  toggleBypass: Effect.Effect<void, UiError>
  setReasoningLevel: (level: ReasoningEffort | undefined) => Effect.Effect<void, UiError>
  openPermissions: () => void
  openAuth: () => void
  newSession: () => Effect.Effect<void, UiError>
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
    Effect.catchEager((error) =>
      Effect.succeed({
        handled: true,
        error: formatError(error),
      }),
    ),
  )

export interface ExtensionSlashCommand {
  readonly slash: string
  readonly onSelect: () => void
  readonly onSlash?: (args: string) => void
}

const tryExtensionCommand = (
  cmd: string,
  args: string,
  extensionCommands: ReadonlyArray<ExtensionSlashCommand> | undefined,
): Effect.Effect<SlashCommandResult, UiError> => {
  const extCmd = extensionCommands?.find((c) => c.slash.toLowerCase() === cmd.toLowerCase())
  if (extCmd !== undefined) {
    return Effect.sync(() => {
      if (extCmd.onSlash !== undefined) {
        extCmd.onSlash(args)
      } else {
        extCmd.onSelect()
      }
      return { handled: true }
    })
  }
  return Effect.succeed({ handled: false, error: `Unknown command: /${cmd}` })
}

/**
 * Execute a slash command. Builtins take priority; extension commands are checked on fallthrough.
 */
export const executeSlashCommand = (
  cmd: string,
  _args: string,
  ctx: SlashCommandContext,
  extensionCommands?: ReadonlyArray<ExtensionSlashCommand>,
): Effect.Effect<SlashCommandResult, UiError> => {
  switch (cmd.toLowerCase()) {
    case "clear":
      return runCommandEffect(ctx.newSession())

    case "new":
      return runCommandEffect(ctx.newSession())

    case "sessions":
      return Effect.sync(() => {
        ctx.navigateToSessions()
        return { handled: true }
      })

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

    case "bypass":
      return runCommandEffect(ctx.toggleBypass)

    case "think": {
      const level = _args.trim().toLowerCase()
      const validLevels = ["off", "low", "medium", "high", "xhigh"]
      if (level === "" || !validLevels.includes(level)) {
        return Effect.succeed({
          handled: true,
          error: `Usage: /think <${validLevels.join("|")}>`,
        })
      }
      return runCommandEffect(
        ctx.setReasoningLevel(level === "off" ? undefined : (level as ReasoningEffort)),
      )
    }

    case "permissions":
      return Effect.sync(() => {
        ctx.openPermissions()
        return { handled: true }
      })

    case "auth":
      return Effect.sync(() => {
        ctx.openAuth()
        return { handled: true }
      })

    default:
      return tryExtensionCommand(cmd, _args, extensionCommands)
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
