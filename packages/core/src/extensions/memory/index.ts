/**
 * Memory extension — persistent memory system for gent.
 *
 * Three-tier: global, per-project, session-local.
 * Flat .md files at ~/.gent/memory/ for durability.
 * Agent tools (remember, recall, forget) + durable dream job declarations.
 * Prompt injection: compact summary + recall tool for deep dives.
 */

import { Effect, Schema } from "effect"
import { Event as MEvent, Machine, Slot, State as MState } from "effect-machine"
import type { ReduceResult, ExtensionActorDefinition } from "../../domain/extension.js"
import type { AnyToolDefinition } from "../../domain/tool.js"
import { AgentEvent } from "../../domain/event.js"
import { extension } from "../api.js"
import {
  type MemoryState,
  type SessionMemory,
  initialMemoryState,
  MemoryStateSchema,
  reduce,
  addSessionMemory,
  removeSessionMemory,
  updateVaultIndex,
  setProjectKey,
} from "./state.js"
import { MemoryTools } from "./tools.js"
import { MemoryIntent } from "./intents.js"
import { MemorySnapshot, projectMemorySnapshot, projectMemoryTurn } from "./projection.js"
import { MemoryAgents } from "./agents.js"
import { MemoryEntrySchema, MemoryVault, Live as MemoryVaultLive, projectKey } from "./vault.js"
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
  HydrateVaultIndex: {
    entries: Schema.Array(MemoryEntrySchema),
  },
  SetProjectKey: {
    key: Schema.optional(Schema.String),
  },
})

const MemoryMachineSlots = Slot.define({
  loadBootState: Slot.fn(
    {
      sessionCwd: Schema.optional(Schema.String),
    },
    Schema.Struct({
      entries: Schema.Array(MemoryEntrySchema),
      projectKey: Schema.optional(Schema.String),
    }),
  ),
})

const memoryMachine = Machine.make({
  state: MemoryMachineState,
  event: MemoryMachineEvent,
  slots: MemoryMachineSlots,
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
  .on(MemoryMachineState.Active, MemoryMachineEvent.HydrateVaultIndex, ({ state, event }) =>
    MemoryMachineState.Active({
      memory: updateVaultIndex(state.memory, event.entries),
    }),
  )
  .on(MemoryMachineState.Active, MemoryMachineEvent.SetProjectKey, ({ state, event }) =>
    MemoryMachineState.Active({
      memory: setProjectKey(state.memory, event.key),
    }),
  )

const memoryActor: ExtensionActorDefinition<
  typeof MemoryMachineState.Type,
  typeof MemoryMachineEvent.Type,
  MemoryVault,
  typeof MemoryMachineSlots.definitions
> = {
  machine: memoryMachine,
  slots: () =>
    Effect.gen(function* () {
      const vault = yield* MemoryVault
      return {
        loadBootState: ({ sessionCwd }) =>
          Effect.gen(function* () {
            yield* vault.ensureDirs()
            const entries = yield* vault.list()
            const key = sessionCwd !== undefined ? projectKey(sessionCwd) : undefined
            if (key !== undefined) {
              yield* vault.ensureDirs(key)
            }
            return {
              entries,
              projectKey: key,
            }
          }),
      }
    }),
  mapEvent: (event) => MemoryMachineEvent.Published({ event }),
  mapCommand: (message) =>
    Schema.is(MemoryIntent)(message) ? MemoryMachineEvent.Intent({ message }) : undefined,
  snapshot: {
    schema: MemorySnapshot,
    project: (state) => projectMemorySnapshot(state.memory),
  },
  turn: {
    project: (state) => projectMemoryTurn(state.memory),
  },
  onInit: ({ send, sessionCwd, slots }) =>
    Effect.gen(function* () {
      if (slots === undefined) return
      const boot = yield* slots.loadBootState({ sessionCwd })
      yield* send(
        MemoryMachineEvent.HydrateVaultIndex({
          entries: boot.entries,
        }),
      )

      if (boot.projectKey !== undefined) {
        yield* send(MemoryMachineEvent.SetProjectKey({ key: boot.projectKey }))
      }
    }),
}

// ── Extension ──

export const MemoryExtension = extension("@gent/memory", ({ ext }) =>
  ext
    .tools(...(MemoryTools as ReadonlyArray<AnyToolDefinition>))
    .agents(...MemoryAgents)
    .actor(memoryActor)
    .layer(MemoryVaultLive())
    .jobs(...MemoryDreamJobs()),
)
