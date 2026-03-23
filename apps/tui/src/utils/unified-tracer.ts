/**
 * TUI-level logging helpers (for Solid/UI events).
 * GentTracer is now in @gent/core/runtime/tracer.
 */

import { appendFileString } from "../platform/fs-runtime"

// Re-export the core tracer for backward compat
export {
  GentTracerLive as UnifiedTracerLive,
  clearTraceLog as clearUnifiedLog,
} from "@gent/core/runtime/tracer.js"

const LOG_PATH = "/tmp/gent-trace.log"

const timestamp = () => {
  const d = new Date()
  return `[${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, "0")}]`
}

const writeLine = (line: string) => {
  void appendFileString(LOG_PATH, line + "\n").catch(() => {})
}

export const tuiLog = (msg: string) => writeLine(`${timestamp()} [tui] ${msg}`)

export const tuiEvent = (tag: string, data?: Record<string, unknown>) =>
  tuiLog(`${tag}${data !== undefined ? " " + JSON.stringify(data) : ""}`)

export const tuiError = (tag: string, err: unknown) =>
  tuiLog(`! ${tag} - ${err instanceof Error ? err.message : String(err)}`)
