import { AgentName, type ResourceSchedule } from "@gent/core/extensions/api"

/**
 * Durable host-owned jobs for memory consolidation.
 *
 * The extension declares these schedules. Host startup installs/removes
 * them via the schedule engine; nothing happens during extension setup
 * or workflow startup.
 */

const MEMORY_REFLECT_AGENT = AgentName.make("memory:reflect")
const MEMORY_MEDITATE_AGENT = AgentName.make("memory:meditate")

export const MemoryDreamJobs = (): ReadonlyArray<ResourceSchedule> => [
  {
    id: "reflect",
    cron: "0 21 * * 1-5",
    target: {
      agent: MEMORY_REFLECT_AGENT,
      prompt:
        "Review today's sessions and extract memories worth keeping. Focus on corrections, preferences, decisions, and gotchas.",
    },
  },
  {
    id: "meditate",
    cron: "0 9 * * 0",
    target: {
      agent: MEMORY_MEDITATE_AGENT,
      prompt:
        "Review all stored memories. Merge duplicates, prune noise, and promote recurring project patterns to global principles.",
    },
  },
]
