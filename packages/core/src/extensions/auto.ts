/**
 * Auto loop modality extension — one generic iteration driver.
 *
 * Replaces three separate loop implementations (review-loop actor,
 * audit runLoop, plan runLoop) with a single extension that drives
 * any iterative workflow.
 *
 * State: Inactive | Working | AwaitingReview
 * Signal: auto_checkpoint tool
 * Gate: peer review via review tool (AwaitingReview blocks until review tool called)
 * Safety: maxIterations ceiling + turnsSinceCheckpoint watchdog
 *
 * Uses effect-machine directly for state transitions and actor runtime.
 */

import { Effect, Schema } from "effect"
import { Machine, Slot, State as MState, Event as MEvent } from "effect-machine"
import {
  type ExtensionActorDefinition,
  type ExtensionDeriveContext,
  type ExtensionEffect,
  type ToolResultInput,
  type TurnAfterInput,
  type TurnProjection,
} from "../domain/extension.js"
import type { AgentEvent } from "../domain/event.js"
import type { PromptSection } from "../domain/prompt.js"
import { extension } from "./api.js"
import { AUTO_EXTENSION_ID, AutoProtocol } from "./auto-protocol.js"
import { AutoCheckpointTool } from "./auto-checkpoint.js"
import { AutoJournal, type CheckpointRow } from "./auto-journal.js"
import type { ExtensionHostContext } from "../domain/extension-host-context.js"
import { DEFAULTS } from "../domain/defaults.js"

// ── Constants ──

export { AUTO_EXTENSION_ID } from "./auto-protocol.js"
const AUTO_CHECKPOINT_TOOL = "auto_checkpoint"
const REVIEW_TOOL = "review"
const DEFAULT_MAX_ITERATIONS = 10
const MAX_TURNS_WITHOUT_CHECKPOINT = 5

/** Schema for checkpoint tool output — used for typed sync parsing in mapEvent */
const CheckpointOutput = Schema.Struct({
  status: Schema.optional(Schema.Literals(["continue", "complete", "abandon"])),
  summary: Schema.optional(Schema.String),
  learnings: Schema.optional(Schema.String),
  metrics: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  nextIdea: Schema.optional(Schema.String),
})
const decodeCheckpointOutput = Schema.decodeUnknownSync(Schema.fromJsonString(CheckpointOutput))

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
  AwaitingReview: {
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
  ReviewSignal: {},
  TurnTick: {},
  IsActive: MEvent.reply({}, Schema.Boolean),
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
  phase: Schema.optional(Schema.Literals(["working", "awaiting-review"])),
  iteration: Schema.optional(Schema.Number),
  maxIterations: Schema.optional(Schema.Number),
  goal: Schema.optional(Schema.String),
  learningsCount: Schema.Number,
})
export type AutoUiModel = typeof AutoUiModel.Type

const ReplayCheckpoint = Schema.Struct({
  type: Schema.Literal("checkpoint"),
  iteration: Schema.Number,
  status: Schema.Literals(["continue", "complete", "abandon"]),
  summary: Schema.String,
  learnings: Schema.optional(Schema.String),
  metrics: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  nextIdea: Schema.optional(Schema.String),
})

const ReplayReview = Schema.Struct({
  type: Schema.Literal("review"),
  iteration: Schema.Number,
})

const ReplaySeedWithOrigin = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  goal: Schema.String,
  maxIterations: Schema.Number,
  rows: Schema.Array(Schema.Union([ReplayCheckpoint, ReplayReview])),
})

const AutoMachineSlots = Slot.define({
  loadReplaySeed: Slot.fn({}, Schema.NullOr(ReplaySeedWithOrigin)),
})

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

const reviewPromptSection = (
  state: Extract<MachineState, { _tag: "AwaitingReview" }>,
): PromptSection => ({
  id: "auto-loop-context",
  content: [
    `## Auto Loop — Peer Review Required`,
    "",
    `Iteration ${state.iteration}/${state.maxIterations} is complete.`,
    "",
    "You MUST call the `review` tool to run an adversarial review of this iteration before continuing.",
    "The loop cannot proceed until the review is done.",
  ].join("\n"),
  priority: 91,
})

// ── Machine definition ──

const autoMachine = Machine.make({
  state: MachineState,
  event: MachineEvent,
  slots: AutoMachineSlots,
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
  // Working + AutoSignal → AwaitingReview or Inactive (complete/abandon)
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

    // continue → mandate peer review via review tool
    return MachineState.AwaitingReview({
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      goal: state.goal,
      learnings: newLearnings,
      metrics: newMetrics,
      lastSummary: event.summary,
      nextIdea: event.nextIdea,
    })
  })
  // AwaitingReview + ReviewSignal → Working (next iteration) or Inactive (max reached)
  .on(MachineState.AwaitingReview, MachineEvent.ReviewSignal, ({ state }) => {
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
  .on(MachineState.AwaitingReview, MachineEvent.CancelAuto, () =>
    MachineState.Inactive({ reason: "cancelled" }),
  )
  // IsActive — pure read, returns boolean without state change
  .on(MachineState.Inactive, MachineEvent.IsActive, ({ state }) => Machine.reply(state, false))
  .on(MachineState.Working, MachineEvent.IsActive, ({ state }) => Machine.reply(state, true))
  .on(MachineState.AwaitingReview, MachineEvent.IsActive, ({ state }) => Machine.reply(state, true))

// ── Derive ──

const derive = (state: MachineState, _ctx?: ExtensionDeriveContext) => {
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

  // AwaitingReview
  const uiModel: AutoUiModel = {
    active: true,
    phase: "awaiting-review",
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    goal: state.goal,
    learningsCount: state.learnings.length,
  }
  return {
    promptSections: [reviewPromptSection(state)],
    uiModel,
  }
}

const projectSnapshot = (state: MachineState): AutoUiModel => {
  const { uiModel } = derive(state)
  return (uiModel ?? { active: false, learningsCount: 0 }) as AutoUiModel
}

const projectTurn = (state: MachineState, ctx: ExtensionDeriveContext): TurnProjection => {
  const { uiModel: _, ...turn } = derive(state, ctx)
  return turn
}

// ── afterTransition ──

const afterTransition = (
  before: MachineState,
  after: MachineState,
): ReadonlyArray<ExtensionEffect> => {
  // Persist happens in the actor runtime on each state change.
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

  // → AwaitingReview: queue review instruction
  if (after._tag === "AwaitingReview") {
    effects.push({
      _tag: "QueueFollowUp",
      content:
        "Run the `review` tool to perform an adversarial review of this iteration before continuing.",
      metadata: { extensionId: "auto", hidden: true },
    })
  }

  return effects
}

// ── Map AgentEvent → Machine Event ──

const mapEvent = (event: AgentEvent): MachineEvent | undefined => {
  if (event._tag === "ToolCallSucceeded") {
    if (event.toolName === AUTO_CHECKPOINT_TOOL) {
      try {
        const parsed = decodeCheckpointOutput(event.output ?? "{}")
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
    if (event.toolName === REVIEW_TOOL) {
      return MachineEvent.ReviewSignal
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
  derive: (state: AutoState, ctx?: ExtensionDeriveContext) => derive(state as MachineState, ctx),
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
            _tag: "AwaitingReview",
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

    if (state._tag === "AwaitingReview") {
      if (mapped._tag === "ReviewSignal") {
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

const autoActor: ExtensionActorDefinition<
  MachineState,
  MachineEvent,
  AutoJournal,
  typeof AutoMachineSlots.definitions
> = {
  machine: autoMachine,
  slots: () =>
    Effect.gen(function* () {
      const journalOpt = yield* Effect.serviceOption(AutoJournal)
      if (journalOpt._tag === "None") {
        return {
          loadReplaySeed: () => Effect.succeed(null),
        }
      }
      const journal = journalOpt.value
      return {
        loadReplaySeed: () =>
          Effect.gen(function* () {
            const active = yield* journal.readActive()
            if (active === undefined) return null

            const config = active.rows.find((row) => row.type === "config")
            if (config === undefined || config.type !== "config") return null

            return {
              sessionId: active.sessionId,
              goal: config.goal,
              maxIterations: config.maxIterations,
              rows: active.rows.filter(
                (row): row is typeof ReplayCheckpoint.Type | typeof ReplayReview.Type =>
                  row.type === "checkpoint" || row.type === "review",
              ),
            }
          }),
      }
    }),
  mapEvent,
  mapCommand: (message, state) =>
    Schema.is(AutoIntent)(message) ? mapMessage(message, state) : undefined,
  mapRequest: (message) => {
    if (message.extensionId !== AUTO_EXTENSION_ID) return undefined
    if (message._tag === "IsActive") return MachineEvent.IsActive
    return undefined
  },
  snapshot: {
    schema: AutoUiModel,
    project: projectSnapshot,
  },
  turn: {
    project: projectTurn,
  },
  stateSchema: MachineState.plain as Schema.Schema<MachineState>,
  persist: true,
  afterTransition,
  onInit: (ctx) =>
    Effect.gen(function* () {
      if (ctx.slots === undefined) return
      const replaySeed = yield* ctx.slots.loadReplaySeed()
      if (replaySeed === null) return

      // Root sessions never replay — must be a child session
      if (ctx.parentSessionId === undefined) return

      // Legacy pointers without sessionId are rejected
      if (replaySeed.sessionId === undefined) return

      // Verify the journal's origin session is an ancestor of the current session
      const ancestors = yield* ctx.getSessionAncestors()
      const ancestorIds = new Set(ancestors.map((a) => a.id))
      if (!ancestorIds.has(replaySeed.sessionId)) return

      // Check if current state is already non-Inactive (hydrated from persistence)
      const current = (yield* ctx.snapshot) as MachineState
      if (current._tag !== "Inactive") return

      // Start the machine
      yield* ctx.send(
        MachineEvent.StartAuto({
          goal: replaySeed.goal,
          maxIterations: replaySeed.maxIterations,
        }),
      )

      // Replay checkpoints and review signals in order
      for (const row of replaySeed.rows) {
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
        if (row.type === "review") {
          yield* ctx.send(MachineEvent.ReviewSignal)
        }
      }

      yield* Effect.logInfo("auto.onInit.replayed").pipe(
        Effect.annotateLogs({
          rowCount: replaySeed.rows.length + 1,
        }),
      )
    }),
  protocols: AutoProtocol,
}

// ── tool.result interceptor — JSONL append on checkpoint/review ──

const EXTENSION_ID = AUTO_EXTENSION_ID

const journalInterceptorImpl = (
  input: ToolResultInput,
  next: (input: ToolResultInput) => Effect.Effect<unknown>,
  ctx: ExtensionHostContext,
) =>
  Effect.gen(function* () {
    const result = yield* next(input)

    // Journal writes are best-effort side effects — never fail the tool result
    yield* Effect.gen(function* () {
      const journal = yield* Effect.serviceOption(AutoJournal)
      if (journal._tag === "None") return

      const uiModel = yield* ctx.extension
        .getUiSnapshot<AutoUiModel>(EXTENSION_ID)
        .pipe(Effect.catchEager(() => Effect.void))
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

      if (input.toolName === "review") {
        yield* journal.value.appendReview(uiModel.iteration ?? 1)
      }
    }).pipe(Effect.catchEager(() => Effect.void))

    return result
  })

// ── turn.after interceptor — auto-handoff on context fill ──

const autoHandoffImpl = (
  input: TurnAfterInput,
  next: (input: TurnAfterInput) => Effect.Effect<void>,
  ctx: ExtensionHostContext,
) =>
  Effect.gen(function* () {
    yield* next(input)

    if (input.interrupted) return

    // Check if auto is active
    const uiModel = yield* ctx.extension
      .getUiSnapshot<AutoUiModel>(EXTENSION_ID)
      .pipe(Effect.catchEager(() => Effect.void))
    if (uiModel === undefined || !uiModel.active) return

    // Estimate context fill
    const contextPercent = yield* ctx.session.estimateContextPercent()
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
    yield* ctx.turn.queueFollowUp({
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

// ── Extension ──

export const AutoExtension = extension("@gent/auto", ({ ext }) =>
  ext
    .actor(autoActor)
    .tools(AutoCheckpointTool)
    .on("tool.result", journalInterceptorImpl)
    .on("turn.after", autoHandoffImpl)
    .layer(AutoJournal.Live),
)
