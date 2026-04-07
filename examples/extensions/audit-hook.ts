/**
 * Example: turn.after hook with cwd-aware async setup.
 *
 * Logs turn completion info. Uses async factory to read config from cwd.
 */
import { extension } from "@gent/core/extensions/api"

export default extension("audit-hook", async ({ ext, ctx }) => {
  const logPrefix = `[audit:${ctx.cwd}]`

  return ext.on("turn.after", (input) => {
    console.log(
      `${logPrefix} Turn completed: agent=${input.agentName}, duration=${input.durationMs}ms, interrupted=${String(input.interrupted)}`,
    )
  })
})
