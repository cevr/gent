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
  defineExtension,
  isRecord,
  type ToolResultInput,
  type TurnAfterInput,
  type AgentEvent,
  type ExtensionHostContext,
} from "@gent/core/extensions/api"
import { defineInternalResource, type InternalResourceMachine } from "./core-internal.js"
import { AUTO_EXTENSION_ID, AutoProtocol, AutoSnapshotReply } from "./auto-protocol.js"
import { AutoCheckpointTool } from "./auto-checkpoint.js"
import { AutoJournal } from "./auto-journal.js"
import { AutoProjection } from "./auto-projection.js"

const parseCheckpointParams = (
  input: Record<string, unknown>,
): {
  status: "continue" | "complete" | "abandon"
  summary: string
  learnings: string | undefined
  metrics: Record<string, number> | undefined
  nextIdea: string | undefined
} => {
  const raw = typeof input["status"] === "string" ? input["status"] : "continue"
  const status: "continue" | "complete" | "abandon" =
    raw === "continue" || raw === "complete" || raw === "abandon" ? raw : "continue"
  return {
    status,
    summary: typeof input["summary"] === "string" ? input["summary"] : "Checkpoint",
    learnings: typeof input["learnings"] === "string" ? input["learnings"] : undefined,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    metrics: isRecord(input["metrics"]) ? (input["metrics"] as Record<string, number>) : undefined,
    nextIdea: typeof input["nextIdea"] === "string" ? input["nextIdea"] : undefined,
  }
}

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
    promptPending: Schema.Boolean,
    turnsSinceCheckpoint: Schema.Number,
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
    handoffRequestSeq: Schema.Number.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(0))),
    handoffContent: Schema.optional(Schema.String),
  },
  AwaitingReview: {
    iteration: Schema.Number,
    maxIterations: Schema.Number,
    goal: Schema.String,
    learnings: Schema.Array(AutoLearning),
    metrics: Schema.Array(AutoMetricEntry),
    promptPending: Schema.Boolean,
    lastSummary: Schema.optional(Schema.String),
    nextIdea: Schema.optional(Schema.String),
    handoffRequestSeq: Schema.Number.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(0))),
    handoffContent: Schema.optional(Schema.String),
  },
})
type MachineState = typeof MachineState.Type

export const AutoState = MachineState
export type AutoState = typeof MachineState.Type

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
  RequestHandoff: {
    content: Schema.String,
  },
  ReviewSignal: {},
  TurnCompleted: {},
  IsActive: MEvent.reply({}, Schema.Boolean),
  /** Typed self-read for interceptors: replaces the workflow's loss of
   *  `getUiSnapshot` by exposing the projected snapshot through a typed
   *  protocol reply. The reply schema is `AutoSnapshotReply` end-to-end —
   *  machine event, protocol envelope, and consumer all share one schema. */
  GetSnapshot: MEvent.reply({}, AutoSnapshotReply),
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

// Prompt sections live in `auto-projection.ts` now — the projection reads
// the workflow's typed snapshot and produces the system-prompt section.

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
      promptPending: true,
      turnsSinceCheckpoint: 0,
      handoffRequestSeq: 0,
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
      promptPending: true,
      lastSummary: event.summary,
      nextIdea: event.nextIdea,
      handoffRequestSeq: state.handoffRequestSeq,
      handoffContent: state.handoffContent,
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
      promptPending: true,
      turnsSinceCheckpoint: 0,
      lastSummary: state.lastSummary,
      nextIdea: state.nextIdea,
      handoffRequestSeq: state.handoffRequestSeq,
      handoffContent: state.handoffContent,
    })
  })
  .on(MachineState.Working, MachineEvent.RequestHandoff, ({ state, event }) =>
    MachineState.Working({
      ...state,
      handoffRequestSeq: state.handoffRequestSeq + 1,
      handoffContent: event.content,
    }),
  )
  .on(MachineState.AwaitingReview, MachineEvent.RequestHandoff, ({ state, event }) =>
    MachineState.AwaitingReview({
      ...state,
      handoffRequestSeq: state.handoffRequestSeq + 1,
      handoffContent: event.content,
    }),
  )
  // Working + TurnCompleted → Working (increment) or Inactive (wedge threshold)
  .on(MachineState.Working, MachineEvent.TurnCompleted, ({ state }) => {
    const next = state.turnsSinceCheckpoint + 1
    if (next >= MAX_TURNS_WITHOUT_CHECKPOINT) {
      return MachineState.Inactive({ reason: "wedged" })
    }
    return MachineState.Working({
      ...state,
      promptPending: false,
      turnsSinceCheckpoint: next,
    })
  })
  .on(MachineState.AwaitingReview, MachineEvent.TurnCompleted, ({ state }) =>
    MachineState.AwaitingReview({
      ...state,
      promptPending: false,
    }),
  )
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
  // GetSnapshot — pure read, returns projected UI model
  .on(MachineState.Inactive, MachineEvent.GetSnapshot, ({ state }) =>
    Machine.reply(state, projectSnapshot(state)),
  )
  .on(MachineState.Working, MachineEvent.GetSnapshot, ({ state }) =>
    Machine.reply(state, projectSnapshot(state)),
  )
  .on(MachineState.AwaitingReview, MachineEvent.GetSnapshot, ({ state }) =>
    Machine.reply(state, projectSnapshot(state)),
  )

// ── Snapshot projection (reply for AutoProtocol.GetSnapshot) ──

const projectSnapshot = (state: MachineState): AutoSnapshotReply => {
  if (state._tag === "Inactive") {
    return { active: false }
  }
  if (state._tag === "Working") {
    return {
      active: true,
      phase: "working",
      iteration: state.iteration,
      maxIterations: state.maxIterations,
      goal: state.goal,
      learnings: state.learnings,
      lastSummary: state.lastSummary,
      nextIdea: state.nextIdea,
    }
  }
  return {
    active: true,
    phase: "awaiting-review",
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    goal: state.goal,
    learnings: state.learnings,
    lastSummary: state.lastSummary,
    nextIdea: state.nextIdea,
  }
}

// ── afterTransition ──

const afterTransition = (before: MachineState, after: MachineState) => {
  const effects: Array<{
    readonly _tag: "QueueFollowUp"
    readonly content: string
    readonly metadata?: { readonly extensionId: string; readonly hidden: boolean }
  }> = []

  // Emit queued follow-ups only after the turn boundary. That prevents
  // transient mid-turn states (continue → review → complete) from leaving
  // stale hidden follow-ups behind.
  if (
    before._tag === "Working" &&
    after._tag === "Working" &&
    before.promptPending &&
    !after.promptPending
  ) {
    if (after.iteration === 1) {
      effects.push({
        _tag: "QueueFollowUp",
        content: `Begin: ${after.goal}. Update \`.gent/auto/findings.md\` as you work. Call \`auto_checkpoint\` when this iteration is done.`,
        metadata: { extensionId: "auto", hidden: true },
      })
    } else {
      const hint = after.nextIdea ?? after.goal
      effects.push({
        _tag: "QueueFollowUp",
        content: `Iteration ${after.iteration}/${after.maxIterations}. ${hint}. Review learnings, update findings doc. Call \`auto_checkpoint\` when done.`,
        metadata: { extensionId: "auto", hidden: true },
      })
    }
  }

  if (
    before._tag === "AwaitingReview" &&
    after._tag === "AwaitingReview" &&
    before.promptPending &&
    !after.promptPending
  ) {
    effects.push({
      _tag: "QueueFollowUp",
      content:
        "Run the `review` tool to perform an adversarial review of this iteration before continuing.",
      metadata: { extensionId: "auto", hidden: true },
    })
  }

  if (
    before._tag === "Working" &&
    after._tag === "Working" &&
    after.handoffRequestSeq !== before.handoffRequestSeq &&
    after.handoffContent !== undefined
  ) {
    effects.push({
      _tag: "QueueFollowUp",
      content: after.handoffContent,
      metadata: { extensionId: "auto", hidden: true },
    })
  }

  if (
    before._tag === "AwaitingReview" &&
    after._tag === "AwaitingReview" &&
    after.handoffRequestSeq !== before.handoffRequestSeq &&
    after.handoffContent !== undefined
  ) {
    effects.push({
      _tag: "QueueFollowUp",
      content: after.handoffContent,
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
    return MachineEvent.TurnCompleted
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

// ── Workflow (effect-machine based) ──
//
// The auto extension is a genuine state machine with declared effects. The
// machine is hosted on the AutoJournal Resource (one Resource per extension
// owns the long-lived state — service layer + machine — per the C3.5
// "Resource = layer + lifecycle + machine" merge). UI / turn projections
// moved out of the machine; the TUI widget reads state via
// `AutoProtocol.GetSnapshot` (typed `ctx.ask`), and per-turn prompt comes
// from a separate `ProjectionContribution` (auto-projection.ts).

const autoWorkflow: InternalResourceMachine<
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
  mapCommand: (message, state) => {
    if (Schema.is(AutoIntent)(message)) {
      return mapMessage(message, state)
    }
    if (AutoProtocol.RequestHandoff.is(message)) {
      return MachineEvent.RequestHandoff({ content: message.content })
    }
    return undefined
  },
  mapRequest: (message) => {
    if (message.extensionId !== AUTO_EXTENSION_ID) return undefined
    if (message._tag === "IsActive") return MachineEvent.IsActive
    if (message._tag === "GetSnapshot") return MachineEvent.GetSnapshot
    return undefined
  },
  stateSchema: MachineState.schema,
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

      // Verify the journal's origin session is in the ancestry chain (includes self)
      const ancestors = yield* ctx.getSessionAncestors()
      const ancestorIds = new Set(ancestors.map((a) => a.id))
      if (!ancestorIds.has(replaySeed.sessionId)) return

      // Check if current state is already non-Inactive (hydrated from persistence)
      const current = yield* ctx.snapshot
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

// ── tool.result pipeline — JSONL append on checkpoint/review ──
//
// Reads the workflow snapshot via `AutoProtocol.GetSnapshot` typed reply
// instead of the actor-era `getUiSnapshot` self-read — workflows have no
// UI snapshot pipe (per `composability-not-flags`).

const EXTENSION_ID = AUTO_EXTENSION_ID

const readSnapshot = (ctx: ExtensionHostContext) =>
  ctx.extension
    .ask(AutoProtocol.GetSnapshot.make())
    .pipe(Effect.catchEager(() => Effect.succeed(undefined as AutoSnapshotReply | undefined)))

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

      const snapshot = yield* readSnapshot(ctx)
      if (snapshot === undefined || !snapshot.active) return

      if (input.toolName === "auto_checkpoint" && isRecord(input.input)) {
        const cp = parseCheckpointParams(input.input)

        const activePath = yield* journal.value.getActivePath()
        if (activePath === undefined && snapshot.goal !== undefined) {
          yield* journal.value.start({
            goal: snapshot.goal,
            maxIterations: snapshot.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            sessionId: input.sessionId,
          })
        }

        yield* journal.value.appendCheckpoint({
          iteration: snapshot.iteration ?? 1,
          ...cp,
        })

        if (cp.status === "complete" || cp.status === "abandon") {
          yield* journal.value.finish()
        }
      }

      if (input.toolName === "review") {
        yield* journal.value.appendReview(snapshot.iteration ?? 1)
      }
    }).pipe(Effect.catchEager(() => Effect.void))

    return result
  })

// ── turn.after subscription — auto-handoff on context fill ──

const autoHandoffImpl = (input: TurnAfterInput, ctx: ExtensionHostContext) =>
  Effect.gen(function* () {
    if (input.interrupted) return

    // Check if auto is active via typed reply protocol
    const snapshot = yield* readSnapshot(ctx)
    if (snapshot === undefined || !snapshot.active) return

    // Estimate context fill
    const contextPercent = yield* ctx.session.estimateContextPercent()
    if (contextPercent < 85) return

    yield* Effect.logInfo("auto.handoff.threshold").pipe(
      Effect.annotateLogs({ contextPercent, iteration: snapshot.iteration }),
    )

    // Ensure journal exists before handoff — if no checkpoint has fired yet,
    // create the journal now so the child session can replay from it
    const journal = yield* Effect.serviceOption(AutoJournal)
    let journalPath: string | undefined
    if (journal._tag === "Some") {
      journalPath = yield* journal.value.getActivePath()
      if (journalPath === undefined && snapshot.goal !== undefined) {
        journalPath = yield* journal.value.start({
          goal: snapshot.goal,
          maxIterations: snapshot.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          sessionId: input.sessionId,
        })
      }
    }

    // Queue follow-up telling model to call the handoff tool.
    // @gent/handoff owns presentation — auto just requests the handoff.
    yield* ctx.extension.send(
      AutoProtocol.RequestHandoff.make({
        content: [
          `Context is at ${contextPercent}%. Call the \`handoff\` tool to transfer to a new session.`,
          `Include this context:`,
          `- Auto loop iteration ${snapshot.iteration}/${snapshot.maxIterations}`,
          `- Goal: ${snapshot.goal}`,
          journalPath !== undefined ? `- Journal: ${journalPath}` : undefined,
        ]
          .filter(Boolean)
          .join("\n"),
      }),
    )
  }).pipe(Effect.catchEager(() => Effect.void))

// ── Extension ──

export const AutoExtension = defineExtension({
  id: EXTENSION_ID,
  projections: [AutoProjection],
  capabilities: [AutoCheckpointTool],
  // Single Resource carries the AutoJournal service layer AND the auto
  // workflow machine. The machine declares `AutoJournal` in its `slots`
  // requirements; the `layer` here provides it. C3.5b merge per the
  // "Resource = layer + lifecycle + machine" design intent.
  resources: ({ ctx }) => [
    defineInternalResource({
      tag: AutoJournal,
      scope: "process",
      layer: AutoJournal.Live({ cwd: ctx.cwd }),
      machine: autoWorkflow,
      runtime: {
        toolResult: (input, hostCtx) =>
          journalInterceptorImpl(input, (state) => Effect.succeed(state.result), hostCtx),
        turnAfter: {
          failureMode: "isolate",
          handler: autoHandoffImpl,
        },
      },
    }),
  ],
})
