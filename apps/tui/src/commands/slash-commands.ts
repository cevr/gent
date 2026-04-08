/**
 * Slash command handlers — priority-sorted registry.
 *
 * Builtins register at priority 0, extension commands at priority 10.
 * Lower priority wins. First match by name wins within the same priority.
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
  /** Slash command priority. Lower wins. Builtins are 0, default is 10. Set < 0 to override builtins. */
  readonly priority?: number
  readonly onSelect: () => void
  readonly onSlash?: (args: string) => void
}

/** A registered slash command entry with priority for ordering. */
export interface SlashCommandEntry {
  readonly name: string
  readonly priority: number
  readonly execute: (args: string) => Effect.Effect<SlashCommandResult, UiError>
}

/** Build the builtin command entries from the context. */
const builtinCommands = (ctx: SlashCommandContext): ReadonlyArray<SlashCommandEntry> => [
  { name: "clear", priority: 0, execute: () => runCommandEffect(ctx.newSession()) },
  { name: "new", priority: 0, execute: () => runCommandEffect(ctx.newSession()) },
  {
    name: "sessions",
    priority: 0,
    execute: () =>
      Effect.sync(() => {
        ctx.navigateToSessions()
        return { handled: true }
      }),
  },
  { name: "branch", priority: 0, execute: () => runCommandEffect(ctx.createBranch) },
  {
    name: "tree",
    priority: 0,
    execute: () =>
      Effect.sync(() => {
        ctx.openTree()
        return { handled: true }
      }),
  },
  {
    name: "fork",
    priority: 0,
    execute: () =>
      Effect.sync(() => {
        ctx.openFork()
        return { handled: true }
      }),
  },
  {
    name: "think",
    priority: 0,
    execute: (args) => {
      const level = args.trim().toLowerCase()
      const validLevels = ["off", "low", "medium", "high", "xhigh"]
      if (level === "" || !validLevels.includes(level)) {
        return Effect.succeed({ handled: true, error: `Usage: /think <${validLevels.join("|")}>` })
      }
      return runCommandEffect(
        ctx.setReasoningLevel(level === "off" ? undefined : (level as ReasoningEffort)),
      )
    },
  },
  {
    name: "permissions",
    priority: 0,
    execute: () =>
      Effect.sync(() => {
        ctx.openPermissions()
        return { handled: true }
      }),
  },
  {
    name: "auth",
    priority: 0,
    execute: () =>
      Effect.sync(() => {
        ctx.openAuth()
        return { handled: true }
      }),
  },
]

/** Convert extension commands to registry entries. Default priority 10. */
const extensionEntries = (
  commands: ReadonlyArray<ExtensionSlashCommand> | undefined,
): ReadonlyArray<SlashCommandEntry> =>
  (commands ?? []).map((c) => ({
    name: c.slash.toLowerCase(),
    priority: c.priority ?? 10,
    execute: (args: string) =>
      Effect.sync(() => {
        if (c.onSlash !== undefined) c.onSlash(args)
        else c.onSelect()
        return { handled: true } satisfies SlashCommandResult
      }),
  }))

/**
 * Execute a slash command. All commands (builtin + extension) go through
 * a priority-sorted registry. Lower priority wins; first match by name.
 */
export const executeSlashCommand = (
  cmd: string,
  args: string,
  ctx: SlashCommandContext,
  extensionCommands?: ReadonlyArray<ExtensionSlashCommand>,
): Effect.Effect<SlashCommandResult, UiError> => {
  const all = [...builtinCommands(ctx), ...extensionEntries(extensionCommands)].sort(
    (a, b) => a.priority - b.priority,
  )
  const match = all.find((entry) => entry.name === cmd.toLowerCase())
  if (match !== undefined) return match.execute(args)
  return Effect.succeed({ handled: false, error: `Unknown command: /${cmd}` })
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
