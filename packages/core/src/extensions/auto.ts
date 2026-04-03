/**
 * Auto loop modality extension — one generic iteration driver.
 *
 * Replaces three separate loop implementations (review-loop actor,
 * audit runLoop, plan runLoop) with a single extension that drives
 * any iterative workflow.
 *
 * State: Inactive | Working | AwaitingCounsel
 * Signal: auto_checkpoint tool
 * Gate: counsel review is hardcoded (AwaitingCounsel blocks until counsel called)
 * Safety: maxIterations ceiling + turnsSinceCheckpoint watchdog
 *
 * Uses effect-machine for state transitions, fromMachine for actor wrapping.
 */

import { Effect, Schema } from "effect"
import { Machine, State as MState, Event as MEvent } from "effect-machine"
import {
  defineInterceptor,
  type ExtensionDeriveContext,
  type ExtensionEffect,
  type ExtensionProjection,
  type ToolResultInput,
  type TurnAfterInput,
} from "../domain/extension.js"
import type { AgentEvent } from "../domain/event.js"
import type { SessionId } from "../domain/ids.js"
import type { PromptSection } from "../domain/prompt.js"
import { extension, fromMachine } from "./api.js"
import { AUTO_EXTENSION_ID, AutoProtocol } from "./auto-protocol.js"
import { AutoCheckpointTool } from "../tools/auto-checkpoint.js"
import { AutoJournal, type CheckpointRow } from "./auto-journal.js"
import { ExtensionStateRuntime } from "../runtime/extensions/state-runtime.js"
import { Storage } from "../storage/sqlite-storage.js"
import { ExtensionRegistry } from "../runtime/extensions/registry.js"
import { resolveAgentModel, DEFAULT_MODEL_ID } from "../domain/agent.js"
import { estimateContextPercent } from "../runtime/context-estimation.js"
import { DEFAULTS } from "../domain/defaults.js"
import { ExtensionTurnControl } from "../runtime/extensions/turn-control.js"

// ── Constants ──

export { AUTO_EXTENSION_ID } from "./auto-protocol.js"
const AUTO_CHECKPOINT_TOOL = "auto_checkpoint"
const COUNSEL_TOOL = "counsel"
const DEFAULT_MAX_ITERATIONS = 10
const MAX_TURNS_WITHOUT_CHECKPOINT = 5

// ── State ──

const AutoLearning = Schema.Struct({
  iteration: Schema.Number,
  content: Schema.String,
})
type AutoLearning = typeof AutoLearning.Type

const AutoMetricEntry = Schema.Struct({
  iteration: Schema.Number,
  values: Schema.Record(Schema.String, Schema.Number),
})
type AutoMetricEntry = typeof AutoMetricEntry.Type

const TerminationReason = Schema.Literals(["completed", "abandoned", "cancelled", "wedged"])
type TerminationReason = typeof TerminationReason.Type

// Machine-branded state (single source of truth)
const MachineState = MState({
  Inactive: {
    reason: Schema.optional(TerminationReason),
    finalLearnings: Schema.optional(Schema.Array(AutoLearning)),
    finalMetrics: Schema.optional(Schema.Array(AutoMetricEntry)),
  },
  Working: {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    turnsSinceCheckpoint: Schema.Number,
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
  },
  AwaitingCounsel: {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
  },
})
type MachineState = typeof MachineState.Type

/** Unbranded state schema for persistence/transport. Derived from MachineState.plain. */
export const AutoState = MachineState.plain
export type AutoState = typeof AutoState.Type

// ── Machine Events ──

const MachineEvent = MEvent({
  StartAuto: {
    goal: Schema.String,
    maxIterations: Schema.optional(Schema.Number),
  },
  CancelAuto: {},
  AutoSignal: {
    status: Schema.Literals(["continue", "complete", "abandon"]),
    summary: Schema.String,
    learnings: Schema.optional(Schema.String),
    metrics: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
    nextIdea: Schema.optional(Schema.String),
  },
  CounselSignal: {},
  TurnTick: {},
})
type MachineEvent = typeof MachineEvent.Type

// ── Intents (external API) ──

export const StartAutoIntent = Schema.TaggedStruct("StartAuto", {
  goal: Schema.String,
  maxIterations: Schema.optional(Schema.Number),
})

export const CancelAutoIntent = Schema.TaggedStruct("CancelAuto", {})

export const ToggleAutoIntent = Schema.TaggedStruct("ToggleAuto", {
  goal: Schema.optional(Schema.String),
  maxIterations: Schema.optional(Schema.Number),
})

export const AutoIntent = Schema.Union([StartAutoIntent, CancelAutoIntent, ToggleAutoIntent])
export type AutoIntent = typeof AutoIntent.Type

// ── UI Model ──

export const AutoUiModel = Schema.Struct({
  active: Schema.Boolean,
  phase: Schema.optional(Schema.Literals(["working", "awaiting-counsel"])),
  iteration: Schema.optional(Schema.Number),
  maxIterations: Schema.optional(Schema.Number),
  goal: Schema.optional(Schema.String),
  learningsCount: Schema.Number,
})
export type AutoUiModel = typeof AutoUiModel.Type

// ── Prompt sections ──

const workingPromptSection = (state: Extract<MachineState, { _tag: "Working" }>): PromptSection => {
  const parts: string[] = [
    `## Auto Loop — Iteration ${state.iteration}/${state.maxIterations}`,
    "",
    `**Goal**: ${state.goal}`,
  ]

  if (state.learnings.length > 0) {
    parts.push("", "### Accumulated Learnings:")
    for (const l of state.learnings) {
      parts.push(`- [Iteration ${l.iteration}] ${l.content}`)
    }
  }

  if (state.lastSummary !== undefined) {
    parts.push("", `### Last iteration summary:`, state.lastSummary)
  }

  if (state.nextIdea !== undefined) {
    parts.push("", `### Suggested next step:`, state.nextIdea)
  }

  parts.push(
    "",
    "Maintain a findings doc at `.gent/auto/findings.md` — update it with wins, dead ends, and open questions.",
    "",
    "When you have completed this iteration's work, call `auto_checkpoint` with your results.",
    `This is iteration ${state.iteration} of ${state.maxIterations}.`,
  )

  return {
    id: "auto-loop-context",
    content: parts.join("\n"),
    priority: 91,
  }
}

const counselPromptSection = (
  state: Extract<MachineState, { _tag: "AwaitingCounsel" }>,
): PromptSection => ({
  id: "auto-loop-context",
  content: [
    `## Auto Loop — Counsel Review Required`,
    "",
    `Iteration ${state.iteration}/${state.maxIterations} is complete.`,
    "",
    "You MUST call the `counsel` tool to review this iteration before continuing.",
    "The loop cannot proceed until counsel review is done.",
  ].join("\n"),
  priority: 91,
})

// ── Machine definition ──

const autoMachine = Machine.make({
  state: MachineState,
  event: MachineEvent,
  initial: MachineState.Inactive({}),
})
  // Inactive + StartAuto → Working
  .on(MachineState.Inactive, MachineEvent.StartAuto, ({ event }) =>
    MachineState.Working({
      iteration: 1,
      maxIterations: event.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      goal: event.goal,
      learnings: [],
      metrics: [],
      turnsSinceCheckpoint: 0,
    }),
  )
  // Working + AutoSignal → AwaitingCounsel or Inactive (complete/abandon)
  .on(MachineState.Working, MachineEvent.AutoSignal, ({ state, event }) => {
    const newLearnings =
      event.learnings !== undefined
        ? [...state.learnings, { iteration: state.iteration, content: event.learnings }]
        : state.learnings
    const newMetrics =
      event.metrics !== undefined
        ? [...state.metrics, { iteration: state.iteration, values: event.metrics }]
        : state.metrics

    if (event.status === "complete") {
      return MachineState.Inactive({
        reason: "completed",
        finalLearnings: newLearnings,
        finalMetrics: newMetrics,
      })
    }
    if (event.status === "abandon") {
      return MachineState.Inactive({
        reason: "abandoned",
        finalLearnings: newLearnings,
        finalMetrics: newMetrics,
      })
    }

    // continue → mandate counsel review
    return MachineState.AwaitingCounsel({
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      goal: state.goal,
      learnings: newLearnings,
      metrics: newMetrics,
      lastSummary: event.summary,
      nextIdea: event.nextIdea,
    })
  })
  // AwaitingCounsel + CounselSignal → Working (next iteration) or Inactive (max reached)
  .on(MachineState.AwaitingCounsel, MachineEvent.CounselSignal, ({ state }) => {
    if (state.iteration >= state.maxIterations) {
      return MachineState.Inactive({
        reason: "completed",
        finalLearnings: state.learnings,
        finalMetrics: state.metrics,
      })
    }
    return MachineState.Working({
      iteration: state.iteration + 1,
      maxIterations: state.maxIterations,
      goal: state.goal,
      learnings: state.learnings,
      metrics: state.metrics,
      turnsSinceCheckpoint: 0,
      lastSummary: state.lastSummary,
      nextIdea: state.nextIdea,
    })
  })
  // Working + TurnTick → Working (increment) or Inactive (wedge threshold)
  .on(MachineState.Working, MachineEvent.TurnTick, ({ state }) => {
    const next = state.turnsSinceCheckpoint + 1
    if (next >= MAX_TURNS_WITHOUT_CHECKPOINT) {
      return MachineState.Inactive({ reason: "wedged" })
    }
    return MachineState.Working({
      ...state,
      turnsSinceCheckpoint: next,
    })
  })
  // Cancel from any active state
  .on(MachineState.Working, MachineEvent.CancelAuto, () =>
    MachineState.Inactive({ reason: "cancelled" }),
  )
  .on(MachineState.AwaitingCounsel, MachineEvent.CancelAuto, () =>
    MachineState.Inactive({ reason: "cancelled" }),
  )

// ── Derive ──

const derive = (state: MachineState, _ctx?: ExtensionDeriveContext): ExtensionProjection => {
  if (state._tag === "Inactive") {
    const uiModel: AutoUiModel = { active: false, learningsCount: 0 }
    return { toolPolicy: { exclude: [AUTO_CHECKPOINT_TOOL] }, uiModel }
  }

  if (state._tag === "Working") {
    const uiModel: AutoUiModel = {
      active: true,
      phase: "working",
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      goal: state.goal,
      learningsCount: state.learnings.length,
    }
    return {
      promptSections: [workingPromptSection(state)],
      uiModel,
    }
  }

  // AwaitingCounsel
  const uiModel: AutoUiModel = {
    active: true,
    phase: "awaiting-counsel",
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    goal: state.goal,
    learningsCount: state.learnings.length,
  }
  return {
    promptSections: [counselPromptSection(state)],
    uiModel,
  }
}

// ── afterTransition ──

const afterTransition = (
  before: MachineState,
  after: MachineState,
): ReadonlyArray<ExtensionEffect> => {
  // Note: fromMachine already persists on transition when persist: true.
  // No need to emit Persist effect here.
  const effects: ExtensionEffect[] = []

  // → Working: only on genuine entry (not TurnTick which keeps Working → Working at same iteration)
  if (after._tag === "Working") {
    const isNewEntry =
      before._tag !== "Working" ||
      (before._tag === "Working" && before.iteration !== after.iteration)
    if (isNewEntry) {
      if (after.iteration === 1) {
        // Kickoff — journal start is handled by tool.result interceptor
        effects.push({
          _tag: "QueueFollowUp",
          content: `Begin: ${after.goal}. Update \`.gent/auto/findings.md\` as you work. Call \`auto_checkpoint\` when this iteration is done.`,
          metadata: { extensionId: "auto", hidden: true },
        })
      } else {
        // Next iteration
        const hint = after.nextIdea ?? after.goal
        effects.push({
          _tag: "QueueFollowUp",
          content: `Iteration ${after.iteration}/${after.maxIterations}. ${hint}. Review learnings, update findings doc. Call \`auto_checkpoint\` when done.`,
          metadata: { extensionId: "auto", hidden: true },
        })
      }
    }
  }

  // → AwaitingCounsel: queue counsel instruction
  if (after._tag === "AwaitingCounsel") {
    effects.push({
      _tag: "QueueFollowUp",
      content: "Run `counsel` to review this iteration before continuing.",
      metadata: { extensionId: "auto", hidden: true },
    })
  }

  // cancelled/wedged/completed/abandoned: persist handled by fromMachine

  return effects
}

// ── Map AgentEvent → Machine Event ──

const mapEvent = (event: AgentEvent): MachineEvent | undefined => {
  if (event._tag === "ToolCallSucceeded") {
    if (event.toolName === AUTO_CHECKPOINT_TOOL) {
      // Parse checkpoint output
      try {
        const parsed = JSON.parse(event.output ?? "{}")
        return MachineEvent.AutoSignal({
          status: parsed.status ?? "continue",
          summary: parsed.summary ?? event.summary ?? "Checkpoint",
          learnings: parsed.learnings,
          metrics: parsed.metrics,
          nextIdea: parsed.nextIdea,
        })
      } catch {
        return MachineEvent.AutoSignal({
          status: "continue",
          summary: event.summary ?? "Checkpoint",
        })
      }
    }
    if (event.toolName === COUNSEL_TOOL) {
      return MachineEvent.CounselSignal
    }
  }

  if (event._tag === "TurnCompleted") {
    return MachineEvent.TurnTick
  }

  return undefined
}

// ── Map Message → Machine Event ──

const mapMessage = (message: AutoIntent, state: MachineState): MachineEvent | undefined => {
  switch (message._tag) {
    case "StartAuto":
      return MachineEvent.StartAuto({
        goal: message.goal,
        maxIterations: message.maxIterations,
      })
    case "CancelAuto":
      return MachineEvent.CancelAuto
    case "ToggleAuto":
      if (state._tag === "Inactive") {
        return MachineEvent.StartAuto({
          goal: message.goal ?? "Continue working autonomously",
          maxIterations: message.maxIterations,
        })
      }
      return MachineEvent.CancelAuto
  }
}

// ── Actor Config (exported for test harness — pure reducer compat) ──

export const AutoActorConfig = {
  id: AUTO_EXTENSION_ID,
  initial: { _tag: "Inactive" as const } satisfies AutoState,
  reduce: (state: AutoState, event: AgentEvent): { state: AutoState } => {
    const mapped = mapEvent(event)
    if (mapped === undefined) return { state }

    // Simulate machine transitions for pure reducer testing
    if (state._tag === "Inactive") {
      if (mapped._tag === "StartAuto") {
        return {
          state: {
            _tag: "Working",
            iteration: 1,
            maxIterations: mapped.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            goal: mapped.goal,
            learnings: [],
            metrics: [],
            turnsSinceCheckpoint: 0,
          },
        }
      }
      return { state }
    }

    if (state._tag === "Working") {
      if (mapped._tag === "AutoSignal") {
        const newLearnings =
          mapped.learnings !== undefined
            ? [...state.learnings, { iteration: state.iteration, content: mapped.learnings }]
            : state.learnings
        const newMetrics =
          mapped.metrics !== undefined
            ? [...state.metrics, { iteration: state.iteration, values: mapped.metrics }]
            : state.metrics

        if (mapped.status === "complete") {
          return {
            state: {
              _tag: "Inactive",
              reason: "completed" as const,
              finalLearnings: newLearnings,
              finalMetrics: newMetrics,
            },
          }
        }
        if (mapped.status === "abandon") {
          return {
            state: {
              _tag: "Inactive",
              reason: "abandoned" as const,
              finalLearnings: newLearnings,
              finalMetrics: newMetrics,
            },
          }
        }
        return {
          state: {
            _tag: "AwaitingCounsel",
            iteration: state.iteration,
            maxIterations: state.maxIterations,
            goal: state.goal,
            learnings: newLearnings,
            metrics: newMetrics,
            lastSummary: mapped.summary,
            nextIdea: mapped.nextIdea,
          },
        }
      }
      if (mapped._tag === "TurnTick") {
        const next = state.turnsSinceCheckpoint + 1
        if (next >= MAX_TURNS_WITHOUT_CHECKPOINT) {
          return { state: { _tag: "Inactive", reason: "wedged" as const } }
        }
        return { state: { ...state, turnsSinceCheckpoint: next } }
      }
      if (mapped._tag === "CancelAuto") {
        return { state: { _tag: "Inactive", reason: "cancelled" as const } }
      }
      return { state }
    }

    if (state._tag === "AwaitingCounsel") {
      if (mapped._tag === "CounselSignal") {
        if (state.iteration >= state.maxIterations) {
          return {
            state: {
              _tag: "Inactive",
              reason: "completed" as const,
              finalLearnings: state.learnings,
              finalMetrics: state.metrics,
            },
          }
        }
        return {
          state: {
            _tag: "Working",
            iteration: state.iteration + 1,
            maxIterations: state.maxIterations,
            goal: state.goal,
            learnings: state.learnings,
            metrics: state.metrics,
            turnsSinceCheckpoint: 0,
            lastSummary: state.lastSummary,
            nextIdea: state.nextIdea,
          },
        }
      }
      if (mapped._tag === "CancelAuto") {
        return { state: { _tag: "Inactive", reason: "cancelled" as const } }
      }
      return { state }
    }

    return { state }
  },
  derive: derive as (state: AutoState, ctx?: ExtensionDeriveContext) => ExtensionProjection,
  receive: (state: AutoState, message: AutoIntent): { state: AutoState } => {
    switch (message._tag) {
      case "StartAuto": {
        if (state._tag !== "Inactive") return { state }
        return {
          state: {
            _tag: "Working",
            iteration: 1,
            maxIterations: message.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            goal: message.goal,
            learnings: [],
            metrics: [],
            turnsSinceCheckpoint: 0,
          },
        }
      }
      case "CancelAuto": {
        if (state._tag === "Inactive") return { state }
        return { state: { _tag: "Inactive", reason: "cancelled" as const } }
      }
      case "ToggleAuto": {
        if (state._tag === "Inactive") {
          return {
            state: {
              _tag: "Working",
              iteration: 1,
              maxIterations: message.maxIterations ?? DEFAULT_MAX_ITERATIONS,
              goal: message.goal ?? "Continue working autonomously",
              learnings: [],
              metrics: [],
              turnsSinceCheckpoint: 0,
            },
          }
        }
        return { state: { _tag: "Inactive", reason: "cancelled" as const } }
      }
    }
  },
}

// ── Actor (effect-machine based) ──

const autoActor = fromMachine<MachineState, MachineEvent, AutoIntent, never, AutoJournal>({
  id: AUTO_EXTENSION_ID,
  built: autoMachine,
  mapEvent,
  mapMessage,
  messageSchema: AutoIntent,
  derive,
  stateSchema: MachineState.plain as Schema.Schema<MachineState>,
  uiModelSchema: AutoUiModel,
  persist: true,
  afterTransition,
  onInit: (ctx) =>
    Effect.gen(function* () {
      const journalOpt = yield* Effect.serviceOption(AutoJournal)
      if (journalOpt._tag === "None") return
      const journal = journalOpt.value
      const active = yield* journal.readActive()
      if (active === undefined) return

      // Check if current state is already non-Inactive (hydrated from persistence)
      const current = (yield* ctx.snapshot) as MachineState
      if (current._tag !== "Inactive") return

      // Only replay in child sessions whose ancestry matches the journal's originator
      const storageOpt = yield* Effect.serviceOption(Storage)
      if (storageOpt._tag === "Some") {
        const store = storageOpt.value
        const session = yield* store
          .getSession(ctx.sessionId as SessionId)
          .pipe(Effect.catchEager(() => Effect.void as Effect.Effect<undefined>))

        // Root sessions never replay
        if (session?.parentSessionId === undefined) return

        // Journal must have a sessionId — fail closed for legacy pointers without one
        if (active.sessionId === undefined) return

        // Verify this session descends from the journal's originator
        const ancestors = yield* store
          .getSessionAncestors(ctx.sessionId as SessionId)
          .pipe(Effect.catchEager(() => Effect.succeed([] as const)))
        const ancestorIds = new Set(ancestors.map((a) => a.id as string))
        if (!ancestorIds.has(active.sessionId)) return
      }

      // Replay journal rows as machine events
      const config = active.rows.find((r) => r.type === "config")
      if (config === undefined || config.type !== "config") return

      // Start the machine
      yield* ctx.send(
        MachineEvent.StartAuto({
          goal: config.goal,
          maxIterations: config.maxIterations,
        }),
      )

      // Replay checkpoints and counsel signals in order
      for (const row of active.rows) {
        if (row.type === "checkpoint") {
          yield* ctx.send(
            MachineEvent.AutoSignal({
              status: row.status,
              summary: row.summary,
              learnings: row.learnings,
              metrics: row.metrics,
              nextIdea: row.nextIdea,
            }),
          )
        }
        if (row.type === "counsel") {
          yield* ctx.send(MachineEvent.CounselSignal)
        }
      }

      yield* Effect.logInfo("auto.onInit.replayed").pipe(
        Effect.annotateLogs({
          journalPath: active.path,
          rowCount: active.rows.length,
        }),
      )
    }).pipe(Effect.catchEager(() => Effect.void)),
})

export const AutoSpawnActor = autoActor.spawn

// ── tool.result interceptor — JSONL append on checkpoint/counsel ──

const EXTENSION_ID = AUTO_EXTENSION_ID

const journalInterceptorImpl = (
  input: ToolResultInput,
  next: (input: ToolResultInput) => Effect.Effect<unknown>,
) =>
  Effect.gen(function* () {
    const result = yield* next(input)

    // Journal writes are best-effort side effects — never fail the tool result
    yield* Effect.gen(function* () {
      const journal = yield* Effect.serviceOption(AutoJournal)
      if (journal._tag === "None") return

      const stateRuntime = yield* ExtensionStateRuntime
      const snapshots = yield* stateRuntime
        .getUiSnapshots(input.sessionId, input.branchId)
        .pipe(Effect.catchEager(() => Effect.succeed([] as const)))
      const autoSnap = snapshots.find((s) => s.extensionId === EXTENSION_ID)
      const uiModel = autoSnap?.model as AutoUiModel | undefined
      if (uiModel === undefined || !uiModel.active) return

      if (input.toolName === "auto_checkpoint") {
        const params = input.input as {
          status?: string
          summary?: string
          learnings?: string
          metrics?: Record<string, number>
          nextIdea?: string
        }

        const activePath = yield* journal.value.getActivePath()
        if (activePath === undefined && uiModel.goal !== undefined) {
          yield* journal.value.start({
            goal: uiModel.goal,
            maxIterations: uiModel.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            sessionId: input.sessionId,
          })
        }

        yield* journal.value.appendCheckpoint({
          iteration: uiModel.iteration ?? 1,
          status: (params.status ?? "continue") as CheckpointRow["status"],
          summary: params.summary ?? "Checkpoint",
          learnings: params.learnings,
          metrics: params.metrics,
          nextIdea: params.nextIdea,
        })

        if (params.status === "complete" || params.status === "abandon") {
          yield* journal.value.finish()
        }
      }

      if (input.toolName === "counsel") {
        yield* journal.value.appendCounsel(uiModel.iteration ?? 1)
      }
    }).pipe(Effect.catchEager(() => Effect.void))

    return result
  })

// Cast: interceptor runs in agent loop fiber where services are ambient
const journalInterceptor = defineInterceptor(
  "tool.result",
  journalInterceptorImpl as unknown as (
    input: ToolResultInput,
    next: (input: ToolResultInput) => Effect.Effect<unknown>,
  ) => Effect.Effect<unknown>,
)

// ── turn.after interceptor — auto-handoff on context fill ──

const autoHandoffImpl = (
  input: TurnAfterInput,
  next: (input: TurnAfterInput) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    yield* next(input)

    if (input.interrupted) return

    // Check if auto is active
    const stateRuntime = yield* ExtensionStateRuntime
    const snapshots = yield* stateRuntime
      .getUiSnapshots(input.sessionId, input.branchId)
      .pipe(Effect.catchEager(() => Effect.succeed([] as const)))
    const autoSnap = snapshots.find((s) => s.extensionId === EXTENSION_ID)
    const uiModel = autoSnap?.model as AutoUiModel | undefined
    if (uiModel === undefined || !uiModel.active) return

    // Estimate context fill
    const storage = yield* Storage
    const registry = yield* ExtensionRegistry

    const allMessages = yield* storage.listMessages(input.branchId)
    const agentDef = yield* registry.getAgent(input.agentName)
    const coworkDef = yield* registry.getAgent("cowork")
    let modelId = DEFAULT_MODEL_ID
    if (agentDef !== undefined) modelId = resolveAgentModel(agentDef)
    else if (coworkDef !== undefined) modelId = resolveAgentModel(coworkDef)
    const contextPercent = estimateContextPercent(allMessages, modelId)
    if (contextPercent < DEFAULTS.handoffThresholdPercent) return

    yield* Effect.logInfo("auto.handoff.threshold").pipe(
      Effect.annotateLogs({ contextPercent, iteration: uiModel.iteration }),
    )

    // Ensure journal exists before handoff — if no checkpoint has fired yet,
    // create the journal now so the child session can replay from it
    const journal = yield* Effect.serviceOption(AutoJournal)
    let journalPath: string | undefined
    if (journal._tag === "Some") {
      journalPath = yield* journal.value.getActivePath()
      if (journalPath === undefined && uiModel.goal !== undefined) {
        journalPath = yield* journal.value.start({
          goal: uiModel.goal,
          maxIterations: uiModel.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          sessionId: input.sessionId,
        })
      }
    }

    // Queue follow-up telling model to call the handoff tool.
    // @gent/handoff owns presentation — auto just requests the handoff.
    const turnControl = yield* ExtensionTurnControl
    yield* turnControl.queueFollowUp({
      sessionId: input.sessionId,
      branchId: input.branchId,
      content: [
        `Context is at ${contextPercent}%. Call the \`handoff\` tool to transfer to a new session.`,
        `Include this context:`,
        `- Auto loop iteration ${uiModel.iteration}/${uiModel.maxIterations}`,
        `- Goal: ${uiModel.goal}`,
        journalPath !== undefined ? `- Journal: ${journalPath}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { extensionId: "auto", hidden: true },
    })
  }).pipe(Effect.catchEager(() => Effect.void))

// Cast: interceptor runs in agent loop fiber where services are ambient
const autoHandoffInterceptor = defineInterceptor(
  "turn.after",
  autoHandoffImpl as unknown as (
    input: TurnAfterInput,
    next: (input: TurnAfterInput) => Effect.Effect<void>,
  ) => Effect.Effect<void>,
)

// ── Extension ──

export const AutoExtension = extension("@gent/auto", (ext) => {
  ext.protocol(AutoProtocol)
  ext.actor(autoActor)
  ext.tool(AutoCheckpointTool)
  ext.interceptor(journalInterceptor)
  ext.interceptor(autoHandoffInterceptor)
  ext.layer(AutoJournal.Live)
})
