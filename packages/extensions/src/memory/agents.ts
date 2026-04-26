/**
 * Memory extension agents for dreaming (reflect + meditate).
 *
 * They are normally invoked by the dream worker via headless mode
 * (`gent -H -a memory:reflect "..."`).
 */

import { AgentName, defineAgent, ModelId } from "@gent/core/extensions/api"

// ── Reflect Agent ──

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

export const MemoryReflectAgent = defineAgent({
  name: AgentName.make("memory:reflect"),
  model: ModelId.make("anthropic/claude-sonnet-4-6"),
  description: "Review recent sessions and extract project-level memories",
  systemPromptAddendum: REFLECT_PROMPT,
  allowedTools: ["memory_remember", "memory_recall", "memory_forget", "search_sessions"],
  reasoningEffort: "medium",
})

// ── Meditate Agent ──

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

export const MemoryMeditateAgent = defineAgent({
  name: AgentName.make("memory:meditate"),
  model: ModelId.make("anthropic/claude-sonnet-4-6"),
  description: "Consolidate project memories, prune duplicates, promote to global principles",
  systemPromptAddendum: MEDITATE_PROMPT,
  allowedTools: ["memory_remember", "memory_recall", "memory_forget"],
  reasoningEffort: "high",
})

export const MemoryAgents = [MemoryReflectAgent, MemoryMeditateAgent] as const
