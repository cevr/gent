// Centralized defaults for magic numbers
// These can be overridden via configuration where applicable

export const DEFAULTS = {
  // Bash tool timeout (ms)
  bashTimeout: 120_000,

  // Read tool line limit
  readLineLimit: 2_000,

  // Grep tool match limit
  grepMatchLimit: 100,

  // Handoff threshold (% of context window)
  handoffThresholdPercent: 85,

  // Follow-up queue max size
  followUpQueueMax: 10,

  // Tool execution concurrency
  toolConcurrency: 8,
} as const

export type Defaults = typeof DEFAULTS
