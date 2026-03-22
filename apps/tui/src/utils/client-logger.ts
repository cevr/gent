/**
 * Client-side structured logger — JSON to /tmp/gent-client.log
 *
 * Logs TUI lifecycle events (session create, message send, event dispatch,
 * errors) as structured JSON for debugging client-server interactions.
 */

import { appendFileSync, writeFileSync } from "node:fs"

const LOG_PATH = "/tmp/gent-client.log"

const isoNow = () => new Date().toISOString()

const writeLine = (line: string) => {
  try {
    appendFileSync(LOG_PATH, line + "\n")
  } catch {
    // ignore
  }
}

export const clearClientLog = () => {
  try {
    writeFileSync(LOG_PATH, "")
  } catch {
    // ignore
  }
}

type LogLevel = "debug" | "info" | "warn" | "error"

const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>) => {
  const entry: Record<string, unknown> = {
    ts: isoNow(),
    level,
    source: "client",
    msg,
    ...data,
  }
  writeLine(JSON.stringify(entry))
}

export const clientLog = {
  debug: (msg: string, data?: Record<string, unknown>) => emit("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
}
