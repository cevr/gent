/**
 * Executor state machine + actor definition.
 *
 * States: Idle → Connecting → Ready | Error
 * Connection work runs in slot implementations (sidecar + bridge),
 * keeping the machine pure.
 */

import { Effect, Schema } from "effect"
import { Machine, Slot, State as MState, Event as MEvent } from "effect-machine"
import type {
  ExtensionActorDefinition,
  ExtensionTurnContext,
  TurnProjection,
} from "../../domain/extension.js"
import type { PromptSection } from "../../domain/prompt.js"
import { ExecutorEndpoint, ExecutorMode, EXECUTOR_EXTENSION_ID } from "./domain.js"
import { ExecutorSidecar } from "./sidecar.js"
import { ExecutorMcpBridge } from "./mcp-bridge.js"

// ── States ──

const MachineState = MState({
  Idle: {},
  Connecting: { mode: ExecutorMode },
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
  Connect: {},
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
})

// ── Machine ──

const executorMachine = Machine.make({
  state: MachineState,
  event: MachineEvent,
  slots: ExecutorSlots,
  initial: MachineState.Idle,
})
  // Idle + Connect → Connecting
  .on(MachineState.Idle, MachineEvent.Connect, () => MachineState.Connecting({ mode: "local" }))
  // Error + Connect → Connecting (retry)
  .on(MachineState.Error, MachineEvent.Connect, () => MachineState.Connecting({ mode: "local" }))
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

const projectSnapshot = (state: MachineState): ExecutorUiModel => {
  switch (state._tag) {
    case "Idle":
      return { status: "idle" }
    case "Connecting":
      return { status: "connecting", mode: state.mode }
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
      return { state: { _tag: "Connecting", mode: "local" } }
    }
    if (state._tag === "Error" && event._tag === "Connect") {
      return { state: { _tag: "Connecting", mode: "local" } }
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

// ── Intent protocol ──

export const ConnectIntent = Schema.TaggedStruct("Connect", {})
export const DisconnectIntent = Schema.TaggedStruct("Disconnect", {})
export const ExecutorIntent = Schema.Union([ConnectIntent, DisconnectIntent])
export type ExecutorIntent = typeof ExecutorIntent.Type

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
        resolveEndpoint: ({ cwd }: { cwd: string }) =>
          sidecar.resolveEndpoint(cwd).pipe(Effect.map((ep) => ep as unknown)),
        inspectMcp: ({ baseUrl }: { baseUrl: string }) =>
          bridge.inspect(baseUrl).pipe(Effect.map((i) => i as unknown)),
      }
    }),
  mapCommand: (message, _state) => {
    if (!Schema.is(ExecutorIntent)(message)) return undefined
    switch (message._tag) {
      case "Connect":
        return MachineEvent.Connect
      case "Disconnect":
        return MachineEvent.Disconnect
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
  persist: true,
  onInit: (ctx) =>
    Effect.gen(function* () {
      if (ctx.slots === undefined) return

      // Transition to Connecting first
      yield* ctx.send(MachineEvent.Connect)

      // Resolve endpoint via slot (wired to ExecutorSidecar)
      const endpointRaw = yield* ctx.slots.resolveEndpoint({ cwd: ctx.sessionCwd ?? "/" })
      const endpoint = Schema.decodeUnknownSync(ExecutorEndpoint)(endpointRaw)

      // Inspect MCP for instructions (best-effort)
      const inspectionRaw = yield* ctx.slots
        .inspectMcp({ baseUrl: endpoint.baseUrl })
        .pipe(Effect.orElseSucceed(() => undefined))
      const inspection = inspectionRaw as { instructions?: string } | undefined

      yield* ctx.send(
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
        ctx.send(
          MachineEvent.ConnectionFailed({
            message: e instanceof Error ? e.message : String(e),
          }),
        ),
      ),
    ),
}
