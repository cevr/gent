/**
 * Executor state — volatile process-local state for the executor resource.
 *
 * No persistence: a restored `Ready{baseUrl}` snapshot would point at a
 * sidecar URL that no longer exists. The next process starts from `Idle` and
 * re-bootstraps via autoStart.
 */

import { Schema } from "effect"
import { TaggedEnumClass, type PromptSection, type TurnProjection } from "@gent/core/extensions/api"
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

// ── UI Model (kept for tooling that consumes the projection shape) ──

export const ExecutorUiModel = Schema.Struct({
  status: Schema.Literals(["idle", "connecting", "ready", "error"]),
  mode: Schema.optional(ExecutorMode),
  baseUrl: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
})
export type ExecutorUiModel = typeof ExecutorUiModel.Type

// ── Snapshot projection ──

export const projectSnapshot = (state: ExecutorState): ExecutorSnapshotReply => {
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

// ── Turn projection (prompt + tool policy) ──
//
// Pure derivation from `ExecutorState`, sampled by ExecutorRuntime's
// turnProjection reaction. When state is `Ready` and an `executorPrompt`
// is present, contribute the executor-guidance prompt section; otherwise
// exclude `execute`/`resume` from the active policy until the connection
// is up.

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

const buildPromptSection = (snapshot: ExecutorSnapshotReply): PromptSection | undefined => {
  if (snapshot.status !== "ready") return undefined
  if (snapshot.executorPrompt === undefined || snapshot.executorPrompt.length === 0)
    return undefined
  return {
    id: "executor-guidance",
    content: buildExecutorPrompt(snapshot.executorPrompt),
    priority: 85,
  }
}

export const viewForState = (state: ExecutorState): TurnProjection => {
  const snapshot = projectSnapshot(state)
  const section = buildPromptSection(snapshot)
  return {
    ...(section !== undefined ? { promptSections: [section] } : {}),
    toolPolicy: snapshot.status === "ready" ? {} : { exclude: ["execute", "resume"] },
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
  // `Ready → Idle` and `Connecting → Idle` both honor user disconnect
  // intent. The runtime service interrupts the in-flight connection fork
  // before writing Idle, so a disconnect mid-handshake cancels the sidecar
  // resolve before it can race back to Ready.
  if (state._tag === "Ready" || state._tag === "Connecting") return ExecutorState.Idle.make({})
  return state
}
