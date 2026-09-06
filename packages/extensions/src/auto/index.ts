/**
 * Auto loop modality extension — one generic iteration driver.
 *
 * The loop is process-local workflow state. Public commands/readers are typed
 * request capabilities backed by `AutoRead` / `AutoWrite`; turn/tool hooks
 * yield the same services directly instead of routing through an actor mailbox.
 */

import { Effect, Option, Schema } from "effect"
import {
  defineExtension,
  defineResource,
  estimateContextPercent,
  ExtensionContext,
  ExtensionSetupContext,
  hook,
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

class AutoCheckpointDecodeError extends Schema.TaggedError<AutoCheckpointDecodeError>()(
  "AutoCheckpointDecodeError",
  {
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

const CheckpointStatus = Schema.Literals(["continue", "complete", "abandon"])
type CheckpointStatus = typeof CheckpointStatus.Type
const DEFAULT_CHECKPOINT_STATUS: CheckpointStatus = "continue"

const CheckpointOutput = Schema.Struct({
  status: Schema.OptionFromOptional(CheckpointStatus),
  summary: Schema.OptionFromOptional(Schema.String),
  learnings: Schema.OptionFromOptional(Schema.String),
  metrics: Schema.OptionFromOptional(Schema.Record(Schema.String, Schema.Finite)),
  nextIdea: Schema.OptionFromOptional(Schema.String),
})
const CheckpointResultInput = Schema.Union([
  CheckpointOutput,
  Schema.fromJsonString(CheckpointOutput),
])
const decodeCheckpointOutput = Schema.decodeUnknownSync(CheckpointResultInput)

const parseCheckpointParams = (input: ToolResultInput["input"]) => {
  const decoded = Schema.decodeUnknownSync(CheckpointOutput)(input)
  return {
    status: Option.getOrElse(decoded.status, () => DEFAULT_CHECKPOINT_STATUS),
    summary: Option.getOrElse(decoded.summary, () => "Checkpoint"),
    learnings: decoded.learnings,
    metrics: decoded.metrics,
    nextIdea: decoded.nextIdea,
  }
}

const parseCheckpointResult = (result: ToolResultInput["result"]) => decodeCheckpointOutput(result)

const readSnapshot = Effect.fn("Auto.readSnapshot")(function* () {
  const auto = yield* Effect.serviceOption(AutoRead)
  if (Option.isNone(auto)) return Option.none()
  return Option.some(yield* auto.value.snapshot)
})

const drainAndQueueFollowUp = Effect.fn("Auto.drainAndQueueFollowUp")(function* () {
  const auto = yield* Effect.serviceOption(AutoWrite)
  if (auto._tag === "None") return

  const followUp = yield* auto.value.drainFollowUp
  if (Option.isNone(followUp) || followUp.value.content === "") return

  const ctx = yield* ExtensionContext
  yield* ctx.Session.queueFollowUp({
    sourceId: followUp.value.sourceId,
    content: followUp.value.content,
    metadata: { extensionId: "auto", hidden: true },
  }).pipe(Effect.catchEager(() => Effect.void))
})

const tellAutoFromTool = Effect.fn("Auto.tellFromTool")(function* (input: ToolResultInput) {
  const auto = yield* Effect.serviceOption(AutoWrite)
  if (auto._tag === "None") return

  if (input.toolName === AUTO_CHECKPOINT_TOOL) {
    const parsed = yield* Effect.try({
      try: () => parseCheckpointResult(input.result),
      catch: (decodeError) =>
        new AutoCheckpointDecodeError({
          message: String(decodeError),
          cause: decodeError,
        }),
    }).pipe(
      Effect.asSome,
      Effect.catchEager((decodeError) =>
        Effect.logWarning("auto.checkpoint.decode-failed").pipe(
          Effect.annotateLogs({ error: decodeError.message }),
          Effect.as(Option.none<typeof CheckpointOutput.Type>()),
        ),
      ),
    )
    const status = parsed.pipe(
      Option.flatMap((value) => value.status),
      Option.getOrElse(() => DEFAULT_CHECKPOINT_STATUS),
    )
    const summary = parsed.pipe(
      Option.flatMap((value) => value.summary),
      Option.getOrElse(() => "Checkpoint"),
    )
    yield* auto.value.autoSignal({
      status,
      summary,
      learnings: Option.getOrUndefined(parsed.pipe(Option.flatMap((value) => value.learnings))),
      metrics: Option.getOrUndefined(parsed.pipe(Option.flatMap((value) => value.metrics))),
      nextIdea: Option.getOrUndefined(parsed.pipe(Option.flatMap((value) => value.nextIdea))),
    })
    return
  }

  if (input.toolName === REVIEW_TOOL) {
    yield* auto.value.reviewSignal
  }
})

const onToolResult = (input: ToolResultInput) =>
  Effect.gen(function* () {
    yield* tellAutoFromTool(input).pipe(Effect.catchEager(() => Effect.void))

    yield* Effect.gen(function* () {
      const journal = yield* Effect.serviceOption(AutoJournal)
      if (journal._tag === "None") return

      const snapshot = yield* readSnapshot()
      if (Option.isNone(snapshot) || !snapshot.value.active) return

      if (input.toolName === AUTO_CHECKPOINT_TOOL) {
        const cp = parseCheckpointParams(input.input)

        const activePath = yield* journal.value.getActivePath
        const goal = Option.fromNullishOr(snapshot.value.goal)
        if (Option.isNone(activePath) && Option.isSome(goal)) {
          yield* journal.value.start({
            goal: goal.value,
            maxIterations: snapshot.value.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            sessionId: input.sessionId,
          })
        }

        yield* journal.value.appendCheckpoint({
          iteration: snapshot.value.iteration ?? 1,
          status: cp.status,
          summary: cp.summary,
          learnings: Option.getOrUndefined(cp.learnings),
          metrics: Option.getOrUndefined(cp.metrics),
          nextIdea: Option.getOrUndefined(cp.nextIdea),
        })

        if (cp.status === "complete" || cp.status === "abandon") {
          yield* journal.value.finish
        }
      }

      if (input.toolName === REVIEW_TOOL) {
        yield* journal.value.appendReview(snapshot.value.iteration ?? 1)
      }
    }).pipe(Effect.catchEager(() => Effect.void))

    return input.result
  })

const autoHandoffImpl = (input: TurnAfterInput) =>
  Effect.gen(function* () {
    if (input.interrupted) return

    const auto = yield* Effect.serviceOption(AutoWrite)
    if (auto._tag === "None") return

    yield* auto.value.turnCompleted
    yield* drainAndQueueFollowUp()

    const snapshot = yield* auto.value.snapshot
    if (!snapshot.active) return

    const contextPercent = yield* estimateContextPercent()
    if (contextPercent < 85) return

    yield* Effect.logInfo("auto.handoff.threshold").pipe(
      Effect.annotateLogs({ contextPercent, iteration: snapshot.iteration }),
    )

    const journal = yield* Effect.serviceOption(AutoJournal)
    let journalPath = Option.none<string>()
    if (journal._tag === "Some") {
      journalPath = yield* journal.value.getActivePath
      const goal = Option.fromNullishOr(snapshot.goal)
      if (Option.isNone(journalPath) && Option.isSome(goal)) {
        journalPath = Option.some(
          yield* journal.value.start({
            goal: goal.value,
            maxIterations: snapshot.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            sessionId: input.sessionId,
          }),
        )
      }
    }

    const handoffLines = [
      `Context is at ${contextPercent}%. Call the \`handoff\` tool to transfer to a new session.`,
      `Include this context:`,
      `- Auto loop iteration ${snapshot.iteration}/${snapshot.maxIterations}`,
      `- Goal: ${snapshot.goal}`,
    ]
    if (Option.isSome(journalPath)) {
      handoffLines.push(`- Journal: ${journalPath.value}`)
    }
    yield* auto.value.requestHandoff(handoffLines.join("\n"))

    yield* drainAndQueueFollowUp()
  }).pipe(Effect.catchEager(() => Effect.void))

const turnProjection = () =>
  Effect.gen(function* () {
    const auto = yield* Effect.serviceOption(AutoRead)
    if (auto._tag === "None") return viewForState(AutoState.cases.Inactive.make({}))
    return yield* auto.value.turnProjection
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
    Schema.Record(Schema.String, Schema.Finite).annotate({
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
  hooks: [
    hook.turnProjection(turnProjection),
    hook.toolResult(onToolResult),
    hook.turnAfter(autoHandoffImpl),
  ],
  resources: () =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionSetupContext
      return [
        defineResource({
          id: "@gent/auto/controller",
          scope: "process",
          layer: AutoControllerLive,
        }),
        defineResource({
          id: "@gent/auto/journal",
          tag: AutoJournal,
          scope: "process",
          layer: AutoJournal.Live({ cwd: ctx.cwd }),
        }),
      ]
    }),
})
