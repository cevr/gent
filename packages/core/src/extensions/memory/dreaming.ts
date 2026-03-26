// @effect-diagnostics nodeBuiltinImport:off
/**
 * Dream scheduling — registers Bun.cron jobs for memory consolidation.
 *
 * Called ONLY from the long-lived server process, NOT from headless workers.
 * The dream worker shells out to gent headless with the appropriate memory agent.
 */

import * as Path from "node:path"
import { Effect } from "effect"

const WORKER_PATH = Path.resolve(import.meta.dir, "dream-worker.ts")

/**
 * Register dream cron jobs. Idempotent — same title overwrites.
 * Only call from server startup, never from headless runs.
 */
export const registerDreamJobs = Effect.sync(() => {
  if (typeof Bun === "undefined" || typeof Bun.cron !== "function") {
    // Not running in Bun or cron not available — skip silently
    return
  }

  // Daily reflect: weekdays 9pm — review today's sessions
  Bun.cron(WORKER_PATH, "0 21 * * 1-5", "gent-memory-reflect")

  // Weekly meditate: Sunday 9am — consolidate vault
  Bun.cron(WORKER_PATH, "0 9 * * 0", "gent-memory-meditate")
})

/**
 * Remove dream cron jobs.
 */
export const removeDreamJobs = Effect.sync(() => {
  if (typeof Bun === "undefined" || typeof Bun.cron !== "function") return
  Bun.cron.remove("gent-memory-reflect")
  Bun.cron.remove("gent-memory-meditate")
})
