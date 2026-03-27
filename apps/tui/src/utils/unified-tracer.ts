/**
 * Re-exports for the core tracer layer (used by worker setup).
 * TUI-side event logging has been consolidated to clientLog in client-logger.ts.
 */

// Re-export the core tracer for backward compat
export {
  GentTracerLive as UnifiedTracerLive,
  clearTraceLog as clearUnifiedLog,
} from "@gent/core/runtime/tracer.js"
