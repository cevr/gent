/**
 * Client-side structured logger — JSON to /tmp/gent-client.log
 *
 * Logs TUI lifecycle events (session create, message send, event dispatch,
 * errors) as structured JSON for debugging client-server interactions.
 *
 * `clientLog` — async (fire-and-forget), use for normal lifecycle logs.
 * `syncLog` — synchronous, survives process.exit(). Use for shutdown paths.
 */

// @effect-diagnostics-next-line nodeBuiltinImport:off
import { appendFileSync } from "node:fs"
import { appendFileString, writeFileString } from "../platform/fs-runtime"

const LOG_PATH = "/tmp/gent-client.log"

const isoNow = () => new Date().toISOString()

const writeLine = (line: string) => {
  void appendFileString(LOG_PATH, line + "\n").catch(() => {})
}

export const clearClientLog = () => {
  void writeFileString(LOG_PATH, "").catch(() => {})
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

/** Synchronous log — survives process.exit(). Use for shutdown paths only. */
export const syncLog = (msg: string, data?: Record<string, unknown>) => {
  const entry: Record<string, unknown> = {
    ts: isoNow(),
    level: "info",
    source: "sync",
    msg,
    ...data,
  }
  try {
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n")
  } catch {}
}

export const clientLog = {
  debug: (msg: string, data?: Record<string, unknown>) => emit("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
}
