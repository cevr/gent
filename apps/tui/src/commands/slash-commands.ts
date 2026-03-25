/**
 * Slash command handlers
 *
 * Commands: /agent, /clear, /new, /sessions, /branch, /tree, /fork, /bypass, /handoff
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
  sendMessage: (content: string) => void
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
}

const tryExtensionCommand = (
  cmd: string,
  extensionCommands: ReadonlyArray<ExtensionSlashCommand> | undefined,
): Effect.Effect<SlashCommandResult, UiError> => {
  const extCmd = extensionCommands?.find((c) => c.slash.toLowerCase() === cmd.toLowerCase())
  if (extCmd !== undefined) {
    return Effect.sync(() => {
      extCmd.onSelect()
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
    case "agent":
      return Effect.sync(() => {
        ctx.openPalette()
        return { handled: true }
      })

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

    case "handoff":
      return Effect.sync(() => {
        ctx.sendMessage(
          "Please create a handoff by distilling the current context into a concise summary. Use the handoff tool with the distilled context. Include: current task status, key decisions made, relevant file paths, open questions, and any state that needs to carry over to the new session.",
        )
        return { handled: true }
      })

    case "counsel":
      return Effect.sync(() => {
        const prompt = _args.trim()
        if (prompt.length === 0) {
          ctx.sendMessage(
            "Use the counsel tool to get a peer review from the opposite vendor model. Review the most recent changes or topic of discussion. Focus on correctness, edge cases, and architectural issues.",
          )
        } else {
          ctx.sendMessage(`Use the counsel tool with this prompt: ${prompt}`)
        }
        return { handled: true }
      })

    case "loop":
      return Effect.sync(() => {
        const prompt = _args.trim()
        if (prompt.length === 0) {
          ctx.sendMessage(
            "Use the loop tool to iterate on the current task until complete or a condition is met.",
          )
        } else {
          ctx.sendMessage(`Use the loop tool: ${prompt}`)
        }
        return { handled: true }
      })

    case "plan":
      return Effect.sync(() => {
        const prompt = _args.trim()
        if (prompt.length === 0) {
          ctx.sendMessage(
            "Use the plan tool to create an implementation plan for the current task using adversarial dual-model planning.",
          )
        } else {
          ctx.sendMessage(`Use the plan tool to create an implementation plan for: ${prompt}`)
        }
        return { handled: true }
      })

    case "audit":
      return Effect.sync(() => {
        const prompt = _args.trim()
        if (prompt.length === 0) {
          ctx.sendMessage(
            "Use the audit tool to audit the current changes. Detects concerns, audits in parallel, synthesizes findings, and applies fixes.",
          )
        } else {
          ctx.sendMessage(`Use the audit tool to audit: ${prompt}`)
        }
        return { handled: true }
      })

    default:
      return tryExtensionCommand(cmd, extensionCommands)
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
