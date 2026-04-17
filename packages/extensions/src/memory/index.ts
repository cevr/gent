/**
 * Memory extension — persistent memory system for gent.
 *
 * Composition:
 *   - Tools (memory_remember / memory_recall / memory_forget) for the LLM
 *   - MemoryVaultProjection — derives the on-disk vault index + project
 *     key on demand, contributing both `prompt` and `ui` surfaces. No
 *     actor mirror; vault files are the durable store.
 *   - Session-memory actor — volatile per-session list, projects its own
 *     `turn` (prompt) + `snapshot` (UI) for the session portion. Migrated
 *     to a `WorkflowContribution` in C8.
 *   - MemoryAgents — system agents
 *   - MemoryDreamJobs — durable background memory promotion jobs
 *
 * Three-tier: global, per-project, session-local.
 * Flat .md files at ~/.gent/memory/ for durability.
 */

import { Schema } from "effect"
import { Event as MEvent, Machine, State as MState } from "effect-machine"
import {
  agentContribution,
  AgentEvent,
  defineExtension,
  defineResource,
  jobContribution,
  projectionContribution,
  toolContribution,
  workflowContribution,
  type AnyToolDefinition,
  type ReduceResult,
  type WorkflowContribution,
} from "@gent/core/extensions/api"
import {
  type MemoryState,
  type SessionMemory,
  initialMemoryState,
  MemoryStateSchema,
  reduce,
  addSessionMemory,
  removeSessionMemory,
} from "./state.js"
import { MemoryTools } from "./tools.js"
import { MemoryIntent } from "./intents.js"
import { MemoryVaultProjection } from "./projection.js"
import { MemoryAgents } from "./agents.js"
import { Live as MemoryVaultLive } from "./vault.js"
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

// ── Actor config (session memory only — vault is a projection) ──

export const MemoryActorConfig = {
  id: MEMORY_EXTENSION_ID,
  initial: initialMemoryState,
  reduce,
  receive,
}

const MemoryMachineState = MState({
  Active: {
    memory: MemoryStateSchema,
  },
})

const MemoryMachineEvent = MEvent({
  Published: {
    event: AgentEvent,
  },
  Intent: {
    message: MemoryIntent,
  },
})

const memoryMachine = Machine.make({
  state: MemoryMachineState,
  event: MemoryMachineEvent,
  initial: MemoryMachineState.Active({ memory: initialMemoryState }),
})
  .on(MemoryMachineState.Active, MemoryMachineEvent.Published, ({ state, event }) => {
    const nextMemory = reduce(state.memory as MemoryState, event.event, {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      sessionId: "" as never,
      branchId: undefined,
    }).state
    return nextMemory === state.memory ? state : MemoryMachineState.Active({ memory: nextMemory })
  })
  .on(MemoryMachineState.Active, MemoryMachineEvent.Intent, ({ state, event }) => {
    const nextMemory = receive(state.memory as MemoryState, event.message).state
    return nextMemory === state.memory ? state : MemoryMachineState.Active({ memory: nextMemory })
  })

const memoryWorkflow: WorkflowContribution<
  typeof MemoryMachineState.Type,
  typeof MemoryMachineEvent.Type,
  never,
  Record<string, never>
> = {
  machine: memoryMachine,
  mapEvent: (event) => MemoryMachineEvent.Published({ event }),
  mapCommand: (message) =>
    Schema.is(MemoryIntent)(message) ? MemoryMachineEvent.Intent({ message }) : undefined,
  // Session-memory prompt is no longer surfaced — `workflow.turn` is gone
  // and projections cannot read workflow machine state. Session memories
  // remain queryable via the memory_recall tool; they just don't auto-inject
  // into the system prompt anymore. If we want them back we add a typed
  // workflow-state read on the host context and a Projection that consumes
  // it. For now the vault-derived prompt section is the only memory surface.
}

// ── Extension ──

export const MemoryExtension = defineExtension({
  id: MEMORY_EXTENSION_ID,
  contributions: () => [
    ...(MemoryTools as ReadonlyArray<AnyToolDefinition>).map(toolContribution),
    ...MemoryAgents.map(agentContribution),
    workflowContribution(memoryWorkflow),
    projectionContribution(MemoryVaultProjection),
    defineResource({ scope: "process", layer: MemoryVaultLive() }),
    ...MemoryDreamJobs().map(jobContribution),
  ],
})
