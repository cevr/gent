/**
 * Memory extension — persistent memory system for gent.
 *
 * Composition:
 *   - Tools (memory_remember / memory_recall / memory_forget) for the LLM
 *   - `reactions.turnProjection` derives the on-disk vault index + project
 *     key on demand. No actor mirror; vault files are the durable store.
 *   - MemoryAgents — system agents
 *   - MemoryDreamJobs — durable background memory promotion jobs
 *
 * Three-tier: global, per-project, session-local.
 * Flat .md files at ~/.gent/memory/ for durability.
 *
 * The session-memory state-holder () was deleted alongside the old
 * session-local FSM plumbing here: nothing read the session list (the
 * projection-time inject was already removed in ), `MemoryIntent` had
 * zero external publishers, and `reduce` was a no-op. Tools write
 * straight to `MemoryVault`; the prompt surface comes exclusively from a
 * turn projection over the on-disk vault.
 */

import { defineExtension, defineResource, ExtensionId } from "@gent/core/extensions/api"
import { MemoryTools } from "./tools.js"
import { projectMemoryVaultTurn } from "./projection.js"
import { MemoryAgents } from "./agents.js"
import { Live as MemoryVaultLive } from "./vault.js"
import { MemoryDreamJobs } from "./dreaming.js"

export const MEMORY_EXTENSION_ID = ExtensionId.make("@gent/memory")

// ── Extension ──

export const MemoryExtension = defineExtension({
  id: MEMORY_EXTENSION_ID,
  tools: [...MemoryTools],
  agents: [...MemoryAgents],
  reactions: {
    turnProjection: (ctx) => projectMemoryVaultTurn(ctx),
  },
  resources: [
    defineResource({
      scope: "process",
      layer: MemoryVaultLive(),
      schedule: MemoryDreamJobs(),
    }),
  ],
})
