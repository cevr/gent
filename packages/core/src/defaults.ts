// Centralized defaults for magic numbers
// These can be overridden via configuration where applicable

export const DEFAULTS = {
  // Bash tool timeout (ms)
  bashTimeout: 120_000,

  // Read tool line limit
  readLineLimit: 2_000,

  // Grep tool match limit
  grepMatchLimit: 100,

  // Compaction thresholds (tokens)
  compactionThreshold: 100_000,
  pruneProtect: 40_000,
  pruneMinimum: 20_000,

  // Follow-up queue max size
  followUpQueueMax: 10,

  // Tool execution concurrency
  toolConcurrency: 4,
} as const

export type Defaults = typeof DEFAULTS
