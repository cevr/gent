/**
 * Memory extension — persistent memory system for gent.
 *
 * Composition:
 *   - Tools (memory_remember / memory_recall / memory_forget) for the LLM
 *   - `reactions.turnProjection` derives the on-disk vault index + project
 *     key on demand. No actor mirror; vault files are the durable store.
 *   - Reflect/Meditate agents — system agents
 *   - Scheduled dream jobs — durable background memory promotion jobs
 *
 * Three-tier: global, per-project, session-local.
 * Flat .md files at ~/.gent/memory/ for durability.
 */

import { Effect } from "effect"
import {
  AgentName,
  defineAgent,
  defineExtension,
  defineResource,
  defineScheduledJob,
  ExtensionId,
  ExtensionSetupContext,
  ModelId,
  type ScheduledJobContribution,
} from "@gent/core/extensions/api"
import { MemoryTools } from "./tools.js"
import { projectMemoryVaultTurn } from "./projection.js"
import { Live as MemoryVaultLive } from "./vault.js"

export const MEMORY_EXTENSION_ID = ExtensionId.make("@gent/memory")

const REFLECT_PROMPT = `
You are the memory reflect agent. Your job is to review recent sessions and extract project-level memories worth keeping.

## Process

1. Use \`search_sessions\` to find recent sessions (today).
2. For each session, review the conversation for:
   - Corrections the user made (preferences, patterns, anti-patterns)
   - Decisions and their rationale
   - Codebase gotchas and workarounds discovered
   - Tool quirks or failure modes
   - Recurring manual steps that could be automated
3. Use \`memory_recall\` to check what's already stored — avoid duplicates.
4. Use \`memory_remember\` with scope "project" to store new memories.

## Quality Bar

Only store memories that are:
- **High-signal**: the agent would reliably get this wrong without it
- **High-frequency**: comes up in most sessions for this project
- **High-impact**: getting it wrong causes significant rework

Skip: trivial one-offs, already captured memories, generic knowledge.

## Structural Check

Before writing a memory, ask: can this be a lint rule, config flag, or runtime check?
If yes, note it as a suggestion but don't store as a memory.

## Output

After processing, summarize what you extracted and stored.
`.trim()

const MEMORY_REFLECT_AGENT = AgentName.make("memory:reflect")

const MemoryReflectAgent = defineAgent({
  name: MEMORY_REFLECT_AGENT,
  model: ModelId.make("anthropic/claude-sonnet-4-6"),
  description: "Review recent sessions and extract project-level memories",
  systemPromptAddendum: REFLECT_PROMPT,
  allowedTools: ["memory_remember", "memory_recall", "memory_forget", "search_sessions"],
  reasoningEffort: "medium",
})

const MEDITATE_PROMPT = `
You are the memory meditate agent. Your job is to consolidate the memory vault — prune noise, merge duplicates, promote recurring patterns.

## Process

1. Use \`memory_recall\` (no query) to list all stored memories.
2. For each memory with content worth reviewing, use \`memory_recall\` with a query to read the full content.
3. Identify:
   - **Duplicates**: memories covering the same topic → merge into one, \`memory_forget\` the others
   - **Overlaps**: related memories that should be a single entry → merge
   - **Stale entries**: memories about things that have changed → update or remove
   - **Promotable patterns**: project-level memories that are actually general principles → \`memory_forget\` the project entry, \`memory_remember\` as global
   - **Low-value entries**: memories that fail the quality bar → \`memory_forget\`
4. Keep the vault lean. Fewer high-quality entries > many mediocre ones.

## Quality Bar

A memory earns its keep if it's high-signal, high-frequency, OR high-impact.
Fail all three → remove it.

## Output

Summarize: how many entries reviewed, merged, promoted, pruned.
`.trim()

const MEMORY_MEDITATE_AGENT = AgentName.make("memory:meditate")

const MemoryMeditateAgent = defineAgent({
  name: MEMORY_MEDITATE_AGENT,
  model: ModelId.make("anthropic/claude-sonnet-4-6"),
  description: "Consolidate project memories, prune duplicates, promote to global principles",
  systemPromptAddendum: MEDITATE_PROMPT,
  allowedTools: ["memory_remember", "memory_recall", "memory_forget"],
  reasoningEffort: "high",
})

const MemoryDreamJobs: ReadonlyArray<ScheduledJobContribution> = [
  defineScheduledJob({
    id: "reflect",
    cron: "0 21 * * 1-5",
    target: {
      agent: MEMORY_REFLECT_AGENT,
      prompt:
        "Review today's sessions and extract memories worth keeping. Focus on corrections, preferences, decisions, and gotchas.",
    },
  }),
  defineScheduledJob({
    id: "meditate",
    cron: "0 9 * * 0",
    target: {
      agent: MEMORY_MEDITATE_AGENT,
      prompt:
        "Review all stored memories. Merge duplicates, prune noise, and promote recurring project patterns to global principles.",
    },
  }),
]

export const MemoryExtension = defineExtension({
  id: MEMORY_EXTENSION_ID,
  tools: [...MemoryTools],
  agents: [MemoryReflectAgent, MemoryMeditateAgent],
  reactions: {
    turnProjection: () => projectMemoryVaultTurn(),
  },
  scheduledJobs: MemoryDreamJobs,
  resources: () =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionSetupContext
      return [
        defineResource({
          scope: "process",
          layer: MemoryVaultLive(ctx.home),
        }),
      ]
    }),
})
