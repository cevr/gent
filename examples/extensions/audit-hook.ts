/**
 * Example: turn.after hook with cwd-aware async setup.
 *
 * Logs turn completion info. Uses async factory to read config from cwd.
 */
import { simpleExtension } from "@gent/core/extensions/api"

export default simpleExtension("audit-hook", async (ext, ctx) => {
  const logPrefix = `[audit:${ctx.cwd}]`

  ext.on("turn.after", (input) => {
    console.log(
      `${logPrefix} Turn completed: agent=${input.agentName}, duration=${input.durationMs}ms, interrupted=${String(input.interrupted)}`,
    )
  })
})
