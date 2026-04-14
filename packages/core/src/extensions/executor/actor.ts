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
import type {
  ExtensionActorDefinition,
  ExtensionTurnContext,
  TurnProjection,
} from "../../domain/extension.js"
import type { PromptSection } from "../../domain/prompt.js"
import {
  ExecutorEndpoint,
  ExecutorMcpInspection,
  ExecutorMode,
  type ResolvedExecutorSettings,
  EXECUTOR_EXTENSION_ID,
} from "./domain.js"
import { ExecutorSidecar } from "./sidecar.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"
import { ExecutorProtocol } from "./protocol.js"

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

export const ExecutorState = MachineState.plain
export type ExecutorState = typeof ExecutorState.Type

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
      Effect.catchDefect((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
      Effect.catchEager((e) =>
        self.send(
          MachineEvent.ConnectionFailed({
            message: e instanceof Error ? e.message : String(e),
          }),
        ),
      ),
    ),
  )

// ── Prompt builder ──

const buildExecutorPrompt = (instructions: string): string =>
  [
    "## Executor Runtime",
    "",
    "You have access to the `execute` tool which runs TypeScript in a sandboxed runtime with configured API tools.",
    "",
    "### Executor Instructions",
    instructions,
    "",
    "### Usage Tips",
    "- Use `tools.search({ query })` inside execute to discover available API tools.",
    "- Use `tools.describe.tool({ path })` to get TypeScript shapes before calling.",
    "- If execution pauses for approval, use the `resume` tool with the returned executionId.",
  ].join("\n")

// ── Projections ──

export const projectSnapshot = (state: MachineState): ExecutorUiModel => {
  switch (state._tag) {
    case "Idle":
      return { status: "idle" }
    case "Connecting":
      return { status: "connecting" }
    case "Ready":
      return { status: "ready", mode: state.mode, baseUrl: state.baseUrl }
    case "Error":
      return { status: "error", errorMessage: state.message }
  }
}

const projectTurn = (state: MachineState, _ctx: ExtensionTurnContext): TurnProjection => {
  if (state._tag !== "Ready") {
    return { toolPolicy: { exclude: ["execute", "resume"] } }
  }
  const sections: PromptSection[] = []
  if (state.executorPrompt) {
    sections.push({
      id: "executor-guidance",
      content: buildExecutorPrompt(state.executorPrompt),
      priority: 85,
    })
  }
  return { promptSections: sections }
}

// ── Actor config (exported for pure reducer tests) ──

export const ExecutorActorConfig = {
  id: EXECUTOR_EXTENSION_ID,
  initial: { _tag: "Idle" as const } satisfies ExecutorState,
  derive: (state: ExecutorState, ctx?: ExtensionTurnContext) =>
    ctx ? projectTurn(state as MachineState, ctx) : {},
  reduce: (state: ExecutorState, event: MachineEvent): { state: ExecutorState } => {
    if (state._tag === "Idle" && event._tag === "Connect") {
      return { state: { _tag: "Connecting", cwd: event.cwd } }
    }
    if (state._tag === "Error" && event._tag === "Connect") {
      return { state: { _tag: "Connecting", cwd: event.cwd } }
    }
    if (state._tag === "Connecting" && event._tag === "Connected") {
      return {
        state: {
          _tag: "Ready",
          mode: event.mode,
          baseUrl: event.baseUrl,
          scopeId: event.scopeId,
          executorPrompt: event.executorPrompt,
        },
      }
    }
    if (state._tag === "Connecting" && event._tag === "ConnectionFailed") {
      return { state: { _tag: "Error", message: event.message } }
    }
    if (state._tag === "Ready" && event._tag === "Disconnect") {
      return { state: { _tag: "Idle" } }
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
        return MachineEvent.Connect({ cwd: (message["cwd"] as string | undefined) ?? "/" })
      case "Disconnect":
        return MachineEvent.Disconnect
      default:
        return undefined
    }
  },
  snapshot: {
    schema: ExecutorUiModel,
    project: projectSnapshot,
  },
  turn: {
    project: projectTurn,
  },
  stateSchema: MachineState.plain as Schema.Schema<MachineState>,
  protocols: ExecutorProtocol,
  onInit: (ctx) =>
    Effect.gen(function* () {
      if (ctx.slots === undefined) return
      const current = yield* ctx.snapshot
      if (current._tag !== "Idle") return

      // Check autoStart setting
      const settingsRaw = yield* ctx.slots.resolveSettings({ cwd: ctx.sessionCwd ?? "/" })
      const settings = settingsRaw as ResolvedExecutorSettings
      if (!settings.autoStart) return

      // Send Connect — .spawn(Connecting) handles the rest
      yield* ctx.send(MachineEvent.Connect({ cwd: ctx.sessionCwd ?? "/" }))
    }).pipe(
      Effect.catchDefect((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
      Effect.catchEager(() => Effect.void),
    ),
}
