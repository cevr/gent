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
import { Storage } from "../../storage/sqlite-storage.js"
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
import { registerDreamJobs } from "./dreaming.js"

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
  // onInit runs in ambient runtime where MemoryVault + Storage are provided via setup.layer
  // @effect-diagnostics strictEffectProvide:off
  onInit: (({ sessionId, stateRef }) =>
    Effect.gen(function* () {
      const vault = yield* MemoryVault
      yield* vault.ensureDirs()

      const entries = yield* vault.list()
      yield* Ref.update(stateRef, (s) => updateVaultIndex(s, entries))

      const storage = yield* Effect.serviceOption(Storage)
      if (storage._tag === "Some") {
        const session = yield* storage.value
          .getSession(sessionId)
          .pipe(Effect.catchEager(() => Effect.void.pipe(Effect.as(undefined))))
        if (session?.cwd !== undefined && session.cwd !== null) {
          const key = projectKey(session.cwd)
          yield* Ref.update(stateRef, (s) => setProjectKey(s, key))
          yield* vault.ensureDirs(key)
        }
      }
    })) as (ctx: { sessionId: SessionId; stateRef: Ref.Ref<MemoryState> }) => Effect.Effect<void>,
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
    }
    return Effect.succeed(setup)
  },
})
