/**
 * Memory extension — persistent memory system for gent.
 *
 * Three-tier: global, per-project, session-local.
 * Flat .md files at ~/.gent/memory/ for durability.
 * Agent tools (remember, recall, forget) + intent API.
 * Prompt injection: compact summary + recall tool for deep dives.
 */

import { Effect, Ref } from "effect"
import { defineExtension } from "../../domain/extension.js"
import type { ExtensionSetup, ReduceResult } from "../../domain/extension.js"
import { fromReducer } from "../../runtime/extensions/from-reducer.js"
import type { SessionId } from "../../domain/ids.js"
import type { AnyToolDefinition } from "../../domain/tool.js"
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

const { spawnActor: MemorySpawnActor, projection: MemoryProjection } = fromReducer<
  MemoryState,
  MemoryIntent
>({
  ...MemoryActorConfig,
  intentSchema: MemoryIntent,
  // onInit runs in ambient runtime where MemoryVault is provided via setup.layer
  // @effect-diagnostics strictEffectProvide:off
  onInit: (({ stateRef, sessionCwd }) =>
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
    })) as (ctx: {
    sessionId: SessionId
    stateRef: Ref.Ref<MemoryState>
    sessionCwd?: string
  }) => Effect.Effect<void>,
})

// ── Extension ──

export const MemoryExtension = defineExtension({
  manifest: { id: "@gent/memory" },
  setup: () => {
    const setup: ExtensionSetup = {
      tools: [...MemoryTools] as ReadonlyArray<AnyToolDefinition>,
      agents: [...MemoryAgents],
      spawnActor: MemorySpawnActor,
      projection: MemoryProjection,
      layer: MemoryVaultLive(),
      onStartup: registerDreamJobs,
      onShutdown: removeDreamJobs,
    }
    return Effect.succeed(setup)
  },
})
