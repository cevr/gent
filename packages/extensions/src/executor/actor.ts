/**
 * Executor state — volatile process-local state for the executor resource.
 *
 * No persistence: a restored `Ready{baseUrl}` snapshot would point at a
 * sidecar URL that no longer exists. The next process starts from `Idle` and
 * re-bootstraps via autoStart.
 */

import { Match, Option, Predicate, Schema } from "effect"
import { type PromptSection, type TurnProjection } from "@gent/core/extensions/api"
import { ExecutorMode } from "./domain.js"
import type { ExecutorSnapshotReply } from "./protocol.js"

// ── State ──

export const ExecutorState = Schema.TaggedUnion({
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

export const projectSnapshot: (state: ExecutorState) => ExecutorSnapshotReply =
  Match.type<ExecutorState>().pipe(
    Match.tagsExhaustive({
      Idle: () => ({ status: "idle" }) satisfies ExecutorSnapshotReply,
      Connecting: () => ({ status: "connecting" }) satisfies ExecutorSnapshotReply,
      Ready: (state) =>
        ({
          status: "ready",
          baseUrl: state.baseUrl,
          executorPrompt: state.executorPrompt,
        }) satisfies ExecutorSnapshotReply,
      Error: (state) =>
        ({ status: "error", errorMessage: state.message }) satisfies ExecutorSnapshotReply,
    }),
  )

// ── Turn projection (prompt + tool policy) ──
//
// Pure derivation from `ExecutorState`, sampled by ExecutorRuntime's
// turnProjection hook. When state is `Ready` and an `executorPrompt`
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

const buildPromptSection = (snapshot: ExecutorSnapshotReply): Option.Option<PromptSection> => {
  if (snapshot.status !== "ready") return Option.none()
  const executorPrompt = Option.fromNullishOr(snapshot.executorPrompt)
  if (Option.isNone(executorPrompt) || executorPrompt.value.length === 0) return Option.none()
  return Option.some({
    id: "executor-guidance",
    content: buildExecutorPrompt(executorPrompt.value),
    priority: 85,
  })
}

export const viewForState = (state: ExecutorState): TurnProjection => {
  const snapshot = projectSnapshot(state)
  const section = buildPromptSection(snapshot)
  if (snapshot.status === "ready") {
    if (Option.isSome(section)) return { promptSections: [section.value], toolPolicy: {} }
    return { toolPolicy: {} }
  }
  const toolPolicy = { exclude: ["execute", "resume"] }
  if (Option.isSome(section)) return { promptSections: [section.value], toolPolicy }
  return { toolPolicy }
}

// ── Pure transitions ──

const isConnectable = Predicate.or(Predicate.isTagged("Idle"), Predicate.isTagged("Error"))

export const transitionConnect = (state: ExecutorState, cwd: string): ExecutorState => {
  if (isConnectable(state)) {
    return ExecutorState.cases.Connecting.make({ cwd })
  }
  return state
}

export const transitionConnected = (
  state: ExecutorState,
  msg: {
    readonly mode: ExecutorMode
    readonly baseUrl: string
    readonly scopeId: string
    readonly executorPrompt?: string
  },
): ExecutorState => {
  if (state._tag !== "Connecting") return state
  return ExecutorState.cases.Ready.make({
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
  return ExecutorState.cases.Error.make({ message })
}

export const transitionDisconnect = (state: ExecutorState): ExecutorState => {
  // `Ready → Idle` and `Connecting → Idle` both honor user disconnect
  // intent. The runtime service interrupts the in-flight connection fork
  // before writing Idle, so a disconnect mid-handshake cancels the sidecar
  // resolve before it can race back to Ready.
  const isConnected = Predicate.or(Predicate.isTagged("Ready"), Predicate.isTagged("Connecting"))
  if (isConnected(state)) return ExecutorState.cases.Idle.make({})
  return state
}
