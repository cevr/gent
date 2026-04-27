/**
 * Executor actor — pure FSM hosted on a `Behavior` (W10-1c).
 *
 * States: Idle | Connecting{cwd} | Ready{...} | Error{message}
 *
 * Connection work lives in `connection-runner.ts` — a `Layer.scoped`
 * observer that subscribes to this actor's state via
 * `ActorEngine.subscribeState` and forks the connection effect on entry
 * to `Connecting`. The actor itself stays sync-only and free of side
 * effects.
 *
 * No persistence: connection state is volatile per process. Restoring a
 * `Ready{baseUrl}` snapshot would point at a sidecar URL that no longer
 * exists. The next process starts from `Idle` and re-bootstraps via
 * autoStart (handled by the connection runner).
 */

import { Effect, Schema } from "effect"
import { behavior, ServiceKey, TaggedEnumClass, type Behavior } from "@gent/core/extensions/api"
import { ExecutorMode } from "./domain.js"
import type { ExecutorSnapshotReply } from "./protocol.js"

// ── State ──

export const ExecutorState = TaggedEnumClass("ExecutorState", {
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
export type ExecutorState = Schema.Schema.Type<typeof ExecutorState>

// ── Messages ──
//
// `_tag` strings are shared with `ExecutorProtocol.*` ExtensionMessage
// envelopes so the actor-route fallback in MachineEngine (W10-1b.0) can
// forward envelopes directly into the actor mailbox.

export const ExecutorMsg = TaggedEnumClass("ExecutorMsg", {
  Connect: { cwd: Schema.String },
  Connected: {
    mode: ExecutorMode,
    baseUrl: Schema.String,
    scopeId: Schema.String,
    executorPrompt: Schema.optional(Schema.String),
  },
  ConnectionFailed: { message: Schema.String },
  Disconnect: {},
  GetSnapshot: {},
})
export type ExecutorMsg = Schema.Schema.Type<typeof ExecutorMsg>

export const ExecutorService = ServiceKey<ExecutorMsg>("@gent/executor/workflow")

// ── UI Model (kept for tooling that consumes the projection shape) ──

export const ExecutorUiModel = Schema.Struct({
  status: Schema.Literals(["idle", "connecting", "ready", "error"]),
  mode: Schema.optional(ExecutorMode),
  baseUrl: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
})
export type ExecutorUiModel = typeof ExecutorUiModel.Type

// ── Snapshot projection ──

const projectSnapshot = (state: ExecutorState): ExecutorSnapshotReply => {
  switch (state._tag) {
    case "Idle":
      return { status: "idle" }
    case "Connecting":
      return { status: "connecting" }
    case "Ready":
      return {
        status: "ready",
        baseUrl: state.baseUrl,
        executorPrompt: state.executorPrompt,
      }
    case "Error":
      return { status: "error", errorMessage: state.message }
  }
}

// ── Pure transitions ──

export const transitionConnect = (state: ExecutorState, cwd: string): ExecutorState => {
  if (state._tag === "Idle" || state._tag === "Error") {
    return ExecutorState.Connecting.make({ cwd })
  }
  return state
}

export const transitionConnected = (
  state: ExecutorState,
  msg: {
    readonly mode: ExecutorMode
    readonly baseUrl: string
    readonly scopeId: string
    readonly executorPrompt?: string | undefined
  },
): ExecutorState => {
  if (state._tag !== "Connecting") return state
  return ExecutorState.Ready.make({
    mode: msg.mode,
    baseUrl: msg.baseUrl,
    scopeId: msg.scopeId,
    executorPrompt: msg.executorPrompt,
  })
}

export const transitionConnectionFailed = (
  state: ExecutorState,
  message: string,
): ExecutorState => {
  if (state._tag !== "Connecting") return state
  return ExecutorState.Error.make({ message })
}

export const transitionDisconnect = (state: ExecutorState): ExecutorState => {
  if (state._tag === "Ready") return ExecutorState.Idle.make({})
  return state
}

// ── Behavior ──

export const executorBehavior: Behavior<ExecutorMsg, ExecutorState, never> = {
  initialState: ExecutorState.Idle.make({}),
  serviceKey: ExecutorService,
  receive: (msg, state, ctx) =>
    Effect.gen(function* () {
      switch (msg._tag) {
        case "Connect":
          return transitionConnect(state, msg.cwd)
        case "Connected":
          return transitionConnected(state, msg)
        case "ConnectionFailed":
          return transitionConnectionFailed(state, msg.message)
        case "Disconnect":
          return transitionDisconnect(state)
        case "GetSnapshot":
          yield* ctx.reply(projectSnapshot(state))
          return state
      }
    }),
}

export const executorActor = behavior(executorBehavior)
