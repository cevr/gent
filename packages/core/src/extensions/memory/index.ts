/**
 * Memory extension — persistent memory system for gent.
 *
 * Three-tier: global, per-project, session-local.
 * Flat .md files at ~/.gent/memory/ for durability.
 * Agent tools (remember, recall, forget) + durable dream job declarations.
 * Prompt injection: compact summary + recall tool for deep dives.
 */

import { Effect } from "effect"
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
import { MemoryDreamJobs } from "./dreaming.js"

export const MEMORY_EXTENSION_ID = "@gent/memory"

// ── Receive ──

const receive = (state: MemoryState, message: MemoryIntent): ReduceResult<MemoryState> => {
  switch (message._tag) {
    case "AddMemory": {
      if (message.scope === "session") {
        const memory: SessionMemory = {
          title: message.title,
          content: message.content,
          tags: message.tags ?? [],
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
      if (message.scope === "session") {
        return { state: removeSessionMemory(state, message.title) }
      }
      // project/global removals happen via tool
      return { state }
    }
    case "PromoteMemory": {
      // Find the session memory to promote
      const found = state.sessionMemories.find((m) => m.title === message.title)
      if (found === undefined) return { state }
      // Remove from session (the tool handles vault write)
      return { state: removeSessionMemory(state, message.title) }
    }
    case "ListMemories":
      // Read-only — no state change
      return { state }
  }
}

// ── Actor config ──

export const MemoryActorConfig = {
  id: MEMORY_EXTENSION_ID,
  initial: initialMemoryState,
  reduce,
  derive: deriveProjection,
  receive,
}

const memoryActor = fromReducer<MemoryState, MemoryIntent, never, MemoryVault>({
  ...MemoryActorConfig,
  messageSchema: MemoryIntent,
  onInit: ({ updateState, sessionCwd }) =>
    Effect.gen(function* () {
      const vault = yield* MemoryVault
      yield* vault.ensureDirs()

      const entries = yield* vault.list()
      yield* updateState((s) => updateVaultIndex(s, entries))

      if (sessionCwd !== undefined) {
        const key = projectKey(sessionCwd)
        yield* updateState((s) => setProjectKey(s, key))
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
  ext.jobs(...MemoryDreamJobs())
})
