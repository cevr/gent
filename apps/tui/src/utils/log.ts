/**
 * Simple file logger for TUI debugging
 * Writes to /tmp/gent-tui.log
 */

import { appendFileSync, writeFileSync } from "node:fs"

const LOG_PATH = "/tmp/gent-tui.log"

const timestamp = () => {
  const d = new Date()
  return `[${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}]`
}

/** Clear log file */
export const clearLog = () => writeFileSync(LOG_PATH, "")

/** Log a message */
export const log = (msg: string) => appendFileSync(LOG_PATH, `${timestamp()} ${msg}\n`)

/** Log an event */
export const logEvent = (tag: string, data?: Record<string, unknown>) =>
  log(`${tag}${data ? " " + JSON.stringify(data) : ""}`)

/** Log an error */
export const logError = (tag: string, err: unknown) =>
  log(`! ${tag} - ${err instanceof Error ? err.message : String(err)}`)
