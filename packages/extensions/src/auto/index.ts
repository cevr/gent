/**
 * Auto loop modality extension — one generic iteration driver.
 *
 * The loop is process-local workflow state. Public commands/readers are typed
 * request capabilities backed by `AutoRead` / `AutoWrite`; turn/tool reactions
 * yield the same services directly instead of routing through an actor mailbox.
 */

import { Effect, Schema } from "effect"
import {
  defineExtension,
  defineResource,
  estimateContextPercent,
  ExtensionContext,
  ExtensionSetupContext,
  isRecord,
  tool,
  type ToolResultInput,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import { AutoControllerLive, AutoRead, AutoState, AutoWrite, viewForState } from "./controller.js"
import { AutoJournal } from "./journal.js"
import { AUTO_EXTENSION_ID, AutoRpc } from "./protocol.js"

export { AutoRead, AutoState, AutoWrite, projectSnapshot, viewForState } from "./controller.js"
export { AUTO_EXTENSION_ID } from "./protocol.js"

const AUTO_CHECKPOINT_TOOL = "auto_checkpoint"
const REVIEW_TOOL = "review"
const DEFAULT_MAX_ITERATIONS = 10

class AutoCheckpointDecodeError extends Schema.TaggedErrorClass<AutoCheckpointDecodeError>()(
  "AutoCheckpointDecodeError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

const CheckpointOutput = Schema.Struct({
  status: Schema.optional(Schema.Literals(["continue", "complete", "abandon"])),
  summary: Schema.optional(Schema.String),
  learnings: Schema.optional(Schema.String),
  metrics: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  nextIdea: Schema.optional(Schema.String),
})
const decodeCheckpointOutput = Schema.decodeUnknownSync(CheckpointOutput)

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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
    metrics: isRecord(input["metrics"]) ? (input["metrics"] as Record<string, number>) : undefined,
    nextIdea: typeof input["nextIdea"] === "string" ? input["nextIdea"] : undefined,
  }
}

const parseCheckpointResult = (result: unknown) => {
  const value = typeof result === "string" ? JSON.parse(result) : result
  return decodeCheckpointOutput(value)
}

const readSnapshot = Effect.fn("Auto.readSnapshot")(function* () {
  const auto = yield* Effect.serviceOption(AutoRead)
  if (auto._tag === "None") return undefined
  return yield* auto.value.snapshot()
})

const drainAndQueueFollowUp = Effect.fn("Auto.drainAndQueueFollowUp")(function* () {
  const auto = yield* Effect.serviceOption(AutoWrite)
  if (auto._tag === "None") return

  const followUp = yield* auto.value.drainFollowUp()
  if (followUp === undefined || followUp.content === "") return

  const ctx = yield* ExtensionContext
  yield* ctx.Session.queueFollowUp({
    sourceId: followUp.sourceId,
    content: followUp.content,
    metadata: { extensionId: "auto", hidden: true },
  }).pipe(Effect.catchEager(() => Effect.void))
})

const tellAutoFromTool = Effect.fn("Auto.tellFromTool")(function* (input: ToolResultInput) {
  const auto = yield* Effect.serviceOption(AutoWrite)
  if (auto._tag === "None") return

  if (input.toolName === AUTO_CHECKPOINT_TOOL) {
    let parsed:
      | {
          status?: "continue" | "complete" | "abandon"
          summary?: string
          learnings?: string
          metrics?: Record<string, number>
          nextIdea?: string
        }
      | undefined
    parsed = yield* Effect.try({
      try: () => parseCheckpointResult(input.result),
      catch: (decodeError) =>
        new AutoCheckpointDecodeError({
          message: String(decodeError),
          cause: decodeError,
        }),
    }).pipe(
      Effect.catchEager((decodeError) =>
        Effect.logWarning("auto.checkpoint.decode-failed").pipe(
          Effect.annotateLogs({
            error: decodeError.message,
            resultType: typeof input.result,
          }),
          Effect.as(undefined),
        ),
      ),
    )
    yield* auto.value.autoSignal({
      status: parsed?.status ?? "continue",
      summary: parsed?.summary ?? "Checkpoint",
      learnings: parsed?.learnings,
      metrics: parsed?.metrics,
      nextIdea: parsed?.nextIdea,
    })
    return
  }

  if (input.toolName === REVIEW_TOOL) {
    yield* auto.value.reviewSignal()
  }
})

const onToolResult = (input: ToolResultInput) =>
  Effect.gen(function* () {
    yield* tellAutoFromTool(input).pipe(Effect.catchEager(() => Effect.void))

    yield* Effect.gen(function* () {
      const journal = yield* Effect.serviceOption(AutoJournal)
      if (journal._tag === "None") return

      const snapshot = yield* readSnapshot()
      if (snapshot === undefined || !snapshot.active) return

      if (input.toolName === AUTO_CHECKPOINT_TOOL && isRecord(input.input)) {
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

      if (input.toolName === REVIEW_TOOL) {
        yield* journal.value.appendReview(snapshot.iteration ?? 1)
      }
    }).pipe(Effect.catchEager(() => Effect.void))

    return input.result
  })

const autoHandoffImpl = (input: TurnAfterInput) =>
  Effect.gen(function* () {
    if (input.interrupted) return

    const auto = yield* Effect.serviceOption(AutoWrite)
    if (auto._tag === "None") return

    yield* auto.value.turnCompleted()
    yield* drainAndQueueFollowUp()

    const snapshot = yield* auto.value.snapshot()
    if (!snapshot.active) return

    const contextPercent = yield* estimateContextPercent()
    if (contextPercent < 85) return

    yield* Effect.logInfo("auto.handoff.threshold").pipe(
      Effect.annotateLogs({ contextPercent, iteration: snapshot.iteration }),
    )

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

    yield* auto.value.requestHandoff(
      [
        `Context is at ${contextPercent}%. Call the \`handoff\` tool to transfer to a new session.`,
        `Include this context:`,
        `- Auto loop iteration ${snapshot.iteration}/${snapshot.maxIterations}`,
        `- Goal: ${snapshot.goal}`,
        journalPath !== undefined ? `- Journal: ${journalPath}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    )

    yield* drainAndQueueFollowUp()
  }).pipe(Effect.catchEager(() => Effect.void))

const turnProjection = () =>
  Effect.gen(function* () {
    const auto = yield* Effect.serviceOption(AutoRead)
    if (auto._tag === "None") return viewForState(AutoState.cases.Inactive.make({}))
    return yield* auto.value.turnProjection()
  })

const AutoCheckpointParams = Schema.Struct({
  status: Schema.Literals(["continue", "complete", "abandon"]).annotate({
    description: "Whether to continue iterating, mark as complete, or abandon",
  }),
  summary: Schema.String.annotate({
    description: "Brief summary of what happened this iteration",
  }),
  learnings: Schema.optionalKey(
    Schema.String.annotate({
      description: "New insights from this iteration — appended to accumulated learnings",
    }),
  ),
  metrics: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Number).annotate({
      description: "Optional quantitative tracking (e.g. findings count, coverage %)",
    }),
  ),
  nextIdea: Schema.optionalKey(
    Schema.String.annotate({
      description: "What to try next iteration — injected into the follow-up prompt",
    }),
  ),
})

const AutoCheckpointTool = tool({
  id: "auto_checkpoint",
  description:
    "Report your iteration results. Call with status 'continue' to proceed to the next iteration, " +
    "'complete' when the goal is met, or 'abandon' to stop. You MUST call this tool at the end of each iteration.",
  params: AutoCheckpointParams,
  output: AutoCheckpointParams,
  execute: (params) => Effect.succeed(params),
})

export const AutoExtension = defineExtension({
  id: AUTO_EXTENSION_ID,
  tools: [AutoCheckpointTool],
  requests: [
    AutoRpc.StartAuto,
    AutoRpc.RequestHandoff,
    AutoRpc.CancelAuto,
    AutoRpc.ToggleAuto,
    AutoRpc.IsActive,
    AutoRpc.GetSnapshot,
  ],
  reactions: {
    turnProjection,
    toolResult: onToolResult,
    turnAfter: {
      handler: autoHandoffImpl,
    },
  },
  resources: () =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionSetupContext
      return [
        defineResource({
          scope: "process",
          layer: AutoControllerLive,
        }),
        defineResource({
          tag: AutoJournal,
          scope: "process",
          layer: AutoJournal.Live({ cwd: ctx.cwd }),
        }),
      ]
    }),
})
