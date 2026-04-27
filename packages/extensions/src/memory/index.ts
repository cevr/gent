/**
 * Memory extension — persistent memory system for gent.
 *
 * Composition:
 *   - Tools (memory_remember / memory_recall / memory_forget) for the LLM
 *   - MemoryVaultProjection — derives the on-disk vault index + project
 *     key on demand, contributing both `prompt` and `ui` surfaces. No
 *     actor mirror; vault files are the durable store.
 *   - MemoryAgents — system agents
 *   - MemoryDreamJobs — durable background memory promotion jobs
 *
 * Three-tier: global, per-project, session-local.
 * Flat .md files at ~/.gent/memory/ for durability.
 *
 * The session-memory state-holder (W10-1d) was deleted alongside the
 * legacy `Resource.machine` plumbing here: nothing read the session list
 * (the projection-time inject was already removed in C8), `MemoryIntent`
 * had zero external publishers, and `reduce` was a no-op. Tools write
 * straight to `MemoryVault`; the prompt surface comes exclusively from
 * `MemoryVaultProjection` over the on-disk vault.
 */

import { defineExtension, defineResource, ExtensionId } from "@gent/core/extensions/api"
import { MemoryTools } from "./tools.js"
import { MemoryVaultProjection } from "./projection.js"
import { MemoryAgents } from "./agents.js"
import { Live as MemoryVaultLive } from "./vault.js"
import { MemoryDreamJobs } from "./dreaming.js"

export const MEMORY_EXTENSION_ID = ExtensionId.make("@gent/memory")

// ── Extension ──

export const MemoryExtension = defineExtension({
  id: MEMORY_EXTENSION_ID,
  tools: [...MemoryTools],
  agents: [...MemoryAgents],
  projections: [MemoryVaultProjection],
  resources: [
    defineResource({
      scope: "process",
      layer: MemoryVaultLive(),
      schedule: MemoryDreamJobs(),
    }),
  ],
})
