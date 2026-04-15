import { type AgentName, type ScheduledJobContribution } from "../api.js"

/**
 * Durable host-owned jobs for memory consolidation.
 *
 * The extension declares these jobs. Host startup installs/removes them.
 * No scheduler side effects happen during extension setup or actor startup.
 */

const MEMORY_REFLECT_AGENT = "memory:reflect" as AgentName
const MEMORY_MEDITATE_AGENT = "memory:meditate" as AgentName

export const MemoryDreamJobs = (): ReadonlyArray<ScheduledJobContribution> => [
  {
    id: "reflect",
    schedule: "0 21 * * 1-5",
    target: {
      kind: "headless-agent",
      agent: MEMORY_REFLECT_AGENT,
      prompt:
        "Review today's sessions and extract memories worth keeping. Focus on corrections, preferences, decisions, and gotchas.",
    },
  },
  {
    id: "meditate",
    schedule: "0 9 * * 0",
    target: {
      kind: "headless-agent",
      agent: MEMORY_MEDITATE_AGENT,
      prompt:
        "Review all stored memories. Merge duplicates, prune noise, and promote recurring project patterns to global principles.",
    },
  },
]
