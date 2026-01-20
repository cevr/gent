/**
 * Slash command handlers
 *
 * Commands: /model, /clear, /sessions, /compact, /branch
 */

export type SlashCommandId = "model" | "clear" | "sessions" | "compact" | "branch"

export interface SlashCommandContext {
  openPalette: () => void
  clearMessages: () => void
  navigateToSessions: () => void
  compactHistory: () => Promise<void>
  createBranch: () => Promise<void>
}

export interface SlashCommandResult {
  handled: boolean
  error?: string
}

/**
 * Execute a slash command
 */
export async function executeSlashCommand(
  cmd: string,
  _args: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  switch (cmd.toLowerCase()) {
    case "model":
      // Open command palette at model submenu
      ctx.openPalette()
      return { handled: true }

    case "clear":
      ctx.clearMessages()
      return { handled: true }

    case "sessions":
      ctx.navigateToSessions()
      return { handled: true }

    case "compact":
      try {
        await ctx.compactHistory()
        return { handled: true }
      } catch (e) {
        return { handled: true, error: e instanceof Error ? e.message : String(e) }
      }

    case "branch":
      try {
        await ctx.createBranch()
        return { handled: true }
      } catch (e) {
        return { handled: true, error: e instanceof Error ? e.message : String(e) }
      }

    default:
      return { handled: false, error: `Unknown command: /${cmd}` }
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
