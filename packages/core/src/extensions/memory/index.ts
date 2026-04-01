/**
 * Memory extension — persistent memory system for gent.
 *
 * Three-tier: global, per-project, session-local.
 * Flat .md files at ~/.gent/memory/ for durability.
 * Agent tools (remember, recall, forget) + intent API.
 * Prompt injection: compact summary + recall tool for deep dives.
 */

import { Effect, Ref } from "effect"
import type { ReduceResult } from "../../domain/extension.js"
import type { AnyToolDefinition } from "../../domain/tool.js"
import { extension, fromReducer } from "../api.js"
import {
  type MemoryState,
  type SessionMemory,
  initialMemoryState,
  reduce,
  addSessionMemory,
  removeSessionMemory,
  updateVaultIndex,
  setProjectKey,
} from "./state.js"
import { MemoryTools } from "./tools.js"
import { MemoryIntent } from "./intents.js"
import { deriveProjection } from "./projection.js"
import { MemoryAgents } from "./agents.js"
import { MemoryVault, Live as MemoryVaultLive, projectKey } from "./vault.js"
import { registerDreamJobs, removeDreamJobs } from "./dreaming.js"

// ── Handle Intent ──

const handleIntent = (state: MemoryState, intent: MemoryIntent): ReduceResult<MemoryState> => {
  switch (intent._tag) {
    case "AddMemory": {
      if (intent.scope === "session") {
        const memory: SessionMemory = {
          title: intent.title,
          content: intent.content,
          tags: intent.tags ?? [],
          created: new Date().toISOString(),
        }
        return { state: addSessionMemory(state, memory) }
      }
      // project/global writes happen via tool — intent just acknowledges
      return { state }
    }
    case "SearchMemory":
      // Search is read-only — handled by tool, intent is no-op for state
      return { state }
    case "ForgetMemory": {
      if (intent.scope === "session") {
        return { state: removeSessionMemory(state, intent.title) }
      }
      // project/global removals happen via tool
      return { state }
    }
    case "PromoteMemory": {
      // Find the session memory to promote
      const found = state.sessionMemories.find((m) => m.title === intent.title)
      if (found === undefined) return { state }
      // Remove from session (the tool handles vault write)
      return { state: removeSessionMemory(state, intent.title) }
    }
    case "ListMemories":
      // Read-only — no state change
      return { state }
  }
}

// ── Actor config ──

export const MemoryActorConfig = {
  id: "memory" as const,
  initial: initialMemoryState,
  reduce,
  derive: deriveProjection,
  handleIntent,
}

const memoryActor = fromReducer<MemoryState, MemoryIntent, MemoryVault>({
  ...MemoryActorConfig,
  intentSchema: MemoryIntent,
  onInit: ({ stateRef, sessionCwd }) =>
    Effect.gen(function* () {
      const vault = yield* MemoryVault
      yield* vault.ensureDirs()

      const entries = yield* vault.list()
      yield* Ref.update(stateRef, (s) => updateVaultIndex(s, entries))

      if (sessionCwd !== undefined) {
        const key = projectKey(sessionCwd)
        yield* Ref.update(stateRef, (s) => setProjectKey(s, key))
        yield* vault.ensureDirs(key)
      }
    }),
})

// ── Extension ──

export const MemoryExtension = extension("@gent/memory", (ext) => {
  for (const tool of MemoryTools as ReadonlyArray<AnyToolDefinition>) {
    ext.tool(tool)
  }
  for (const agent of MemoryAgents) {
    ext.agent(agent)
  }
  ext.actor(memoryActor)
  ext.layer(MemoryVaultLive())
  ext.onStartupEffect(registerDreamJobs)
  ext.onShutdownEffect(removeDreamJobs)
})
