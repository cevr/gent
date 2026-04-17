/**
 * Executor state machine + actor definition.
 *
 * States: Idle → Connecting → Ready | Error
 *
 * Connection work runs via `.spawn(Connecting)` — a state-scoped effect
 * that fires on ANY entry into Connecting (onInit auto-start, /executor-start
 * command, retry from Error). Cancelled automatically on state exit.
 */

import { Effect, Schema } from "effect"
import { Machine, Slot, State as MState, Event as MEvent } from "effect-machine"

class ActorDefectError extends Schema.TaggedErrorClass<ActorDefectError>()("ActorDefectError", {
  message: Schema.String,
}) {}
import { type ExtensionActorDefinition } from "@gent/core/extensions/api"
import {
  ExecutorEndpoint,
  ExecutorMcpInspection,
  ExecutorMode,
  type ResolvedExecutorSettings,
  EXECUTOR_EXTENSION_ID,
} from "./domain.js"
import { ExecutorSidecar } from "./sidecar.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"
import { ExecutorProtocol, ExecutorSnapshotReply } from "./protocol.js"

// ── States ──

const MachineState = MState({
  Idle: {},
  Connecting: { cwd: Schema.String },
  Ready: {
    mode: ExecutorMode,
    baseUrl: Schema.String,
    scopeId: Schema.String,
    executorPrompt: Schema.optional(Schema.String),
  },
  Error: { message: Schema.String },
})
type MachineState = typeof MachineState.Type

export const ExecutorState = MachineState
export type ExecutorState = typeof MachineState.Type

// ── Events ──

const MachineEvent = MEvent({
  Connect: { cwd: Schema.String },
  Connected: {
    mode: ExecutorMode,
    baseUrl: Schema.String,
    scopeId: Schema.String,
    executorPrompt: Schema.optional(Schema.String),
  },
  ConnectionFailed: { message: Schema.String },
  Disconnect: {},
  /** Pure read for the projection. Reply carries enough to drive both prompt
   *  injection (executorPrompt) and tool gating (status). */
  GetSnapshot: MEvent.reply({}, ExecutorSnapshotReply),
})
type MachineEvent = typeof MachineEvent.Type

// ── UI Model ──

export const ExecutorUiModel = Schema.Struct({
  status: Schema.Literals(["idle", "connecting", "ready", "error"]),
  mode: Schema.optional(ExecutorMode),
  baseUrl: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
})
export type ExecutorUiModel = typeof ExecutorUiModel.Type

// ── Slots ──

const ExecutorSlots = Slot.define({
  resolveEndpoint: Slot.fn({ cwd: Schema.String }, Schema.Unknown),
  inspectMcp: Slot.fn({ baseUrl: Schema.String }, Schema.Unknown),
  resolveSettings: Slot.fn({ cwd: Schema.String }, Schema.Unknown),
})

// ── Machine ──

const executorMachine = Machine.make({
  state: MachineState,
  event: MachineEvent,
  slots: ExecutorSlots,
  initial: MachineState.Idle,
})
  // Idle + Connect → Connecting
  .on(MachineState.Idle, MachineEvent.Connect, ({ event }) =>
    MachineState.Connecting({ cwd: event.cwd }),
  )
  // Error + Connect → Connecting (retry)
  .on(MachineState.Error, MachineEvent.Connect, ({ event }) =>
    MachineState.Connecting({ cwd: event.cwd }),
  )
  // Connecting + Connected → Ready
  .on(MachineState.Connecting, MachineEvent.Connected, ({ event }) =>
    MachineState.Ready({
      mode: event.mode,
      baseUrl: event.baseUrl,
      scopeId: event.scopeId,
      executorPrompt: event.executorPrompt,
    }),
  )
  // Connecting + ConnectionFailed → Error
  .on(MachineState.Connecting, MachineEvent.ConnectionFailed, ({ event }) =>
    MachineState.Error({ message: event.message }),
  )
  // Ready + Disconnect → Idle
  .on(MachineState.Ready, MachineEvent.Disconnect, () => MachineState.Idle)
  // GetSnapshot — pure read per state
  .on(MachineState.Idle, MachineEvent.GetSnapshot, ({ state }) =>
    Machine.reply(state, { status: "idle" } satisfies ExecutorSnapshotReply),
  )
  .on(MachineState.Connecting, MachineEvent.GetSnapshot, ({ state }) =>
    Machine.reply(state, { status: "connecting" } satisfies ExecutorSnapshotReply),
  )
  .on(MachineState.Ready, MachineEvent.GetSnapshot, ({ state }) =>
    Machine.reply(state, {
      status: "ready",
      baseUrl: state.baseUrl,
      executorPrompt: state.executorPrompt,
    } satisfies ExecutorSnapshotReply),
  )
  .on(MachineState.Error, MachineEvent.GetSnapshot, ({ state }) =>
    Machine.reply(state, {
      status: "error",
      errorMessage: state.message,
    } satisfies ExecutorSnapshotReply),
  )
  // ── Spawn: connection work on Connecting entry ──
  .spawn(MachineState.Connecting, ({ self, slots, state }) =>
    Effect.gen(function* () {
      const endpointRaw = yield* slots.resolveEndpoint({ cwd: state.cwd })
      const endpoint = yield* Schema.decodeUnknownEffect(ExecutorEndpoint)(endpointRaw)

      const inspection = yield* slots.inspectMcp({ baseUrl: endpoint.baseUrl }).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknownEffect(ExecutorMcpInspection)(raw)),
        Effect.orElseSucceed(() => undefined),
      )

      yield* self.send(
        MachineEvent.Connected({
          mode: endpoint.mode,
          baseUrl: endpoint.baseUrl,
          scopeId: endpoint.scope.id,
          executorPrompt: inspection?.instructions,
        }),
      )
    }).pipe(
      Effect.catchDefect((e) => Effect.fail(new ActorDefectError({ message: String(e) }))),
      Effect.catchEager((e) =>
        self.send(
          MachineEvent.ConnectionFailed({
            message: e instanceof Error ? e.message : String(e),
          }),
        ),
      ),
    ),
  )

// Prompt section building lives in `executor/projection.ts` — the projection
// reads the workflow's typed snapshot and produces the executor-guidance
// prompt section (only when `status === "ready"`).

// ── Actor config (exported for pure reducer tests) ──

export const ExecutorActorConfig = {
  id: EXECUTOR_EXTENSION_ID,
  initial: MachineState.Idle,
  reduce: (state: MachineState, event: MachineEvent): { state: MachineState } => {
    if (state._tag === "Idle" && event._tag === "Connect") {
      return { state: MachineState.Connecting({ cwd: event.cwd }) }
    }
    if (state._tag === "Error" && event._tag === "Connect") {
      return { state: MachineState.Connecting({ cwd: event.cwd }) }
    }
    if (state._tag === "Connecting" && event._tag === "Connected") {
      return {
        state: MachineState.Ready({
          mode: event.mode,
          baseUrl: event.baseUrl,
          scopeId: event.scopeId,
          executorPrompt: event.executorPrompt,
        }),
      }
    }
    if (state._tag === "Connecting" && event._tag === "ConnectionFailed") {
      return { state: MachineState.Error({ message: event.message }) }
    }
    if (state._tag === "Ready" && event._tag === "Disconnect") {
      return { state: MachineState.Idle }
    }
    return { state }
  },
}

// ── Actor definition ──

export const executorActor: ExtensionActorDefinition<
  MachineState,
  MachineEvent,
  ExecutorSidecar | ExecutorMcpBridge,
  typeof ExecutorSlots.definitions
> = {
  machine: executorMachine,
  slots: () =>
    Effect.gen(function* () {
      const sidecar = yield* ExecutorSidecar
      const bridge = yield* ExecutorMcpBridge
      return {
        resolveEndpoint: ({ cwd }: { cwd: string }) => sidecar.resolveEndpoint(cwd),
        inspectMcp: ({ baseUrl }: { baseUrl: string }) => bridge.inspect(baseUrl),
        resolveSettings: ({ cwd }: { cwd: string }) => sidecar.resolveSettings(cwd),
      }
    }),
  mapCommand: (message, _state) => {
    if (message.extensionId !== EXECUTOR_EXTENSION_ID) return undefined
    switch (message._tag) {
      case "Connect":
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return MachineEvent.Connect({ cwd: (message["cwd"] as string | undefined) ?? "/" })
      case "Disconnect":
        return MachineEvent.Disconnect
      default:
        return undefined
    }
  },
  mapRequest: (message) => {
    if (message.extensionId !== EXECUTOR_EXTENSION_ID) return undefined
    if (message._tag === "GetSnapshot") return MachineEvent.GetSnapshot
    return undefined
  },
  stateSchema: MachineState.schema,
  protocols: ExecutorProtocol,
  onInit: (ctx) =>
    Effect.gen(function* () {
      if (ctx.slots === undefined) return
      const current = yield* ctx.snapshot
      if (current._tag !== "Idle") return

      // Check autoStart setting
      const settingsRaw = yield* ctx.slots.resolveSettings({ cwd: ctx.sessionCwd ?? "/" })
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      const settings = settingsRaw as ResolvedExecutorSettings
      if (!settings.autoStart) return

      // Send Connect — .spawn(Connecting) handles the rest
      yield* ctx.send(MachineEvent.Connect({ cwd: ctx.sessionCwd ?? "/" }))
    }).pipe(
      Effect.catchDefect((e) => Effect.fail(new ActorDefectError({ message: String(e) }))),
      Effect.catchEager(() => Effect.void),
    ),
}
