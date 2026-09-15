import { DateTime, Effect, Option, Result } from "effect"
import { ErrorOccurred, type EventStoreError } from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { type BranchId, type MessageId, type SessionId } from "../../domain/ids.js"
import type { Message } from "../../domain/message.js"
import { type ModelId } from "../../domain/model.js"
import type { StorageError } from "../../domain/storage-error.js"
import {
  handoffAnchorWithinTurn,
  type ModelContextBudget,
  type ModelContextProjection,
  type ModelContextProjectionError,
} from "../model-context.js"
import {
  type CompactionRequest,
  type CompactionSummary,
  ModelContextCompactor,
} from "../model-context-compactor.js"
import { type ContextDirective } from "../model-context-ledger.js"
import {
  latestUserMessageId,
  messagesInCurrentWindow,
  windowMarkerMessage,
} from "../model-context-window.js"

/** What the model asked the summary to focus on, when the pending directive is a compaction. */
const compactionInstructions = (
  directive: Option.Option<ContextDirective>,
): Option.Option<string> =>
  directive.pipe(
    Option.filter((value) => value._tag === "Compact"),
    Option.flatMap((value) => Option.fromUndefinedOr(value.instructions)),
  )

/** The handoff marker's record of what it replaced, taken from the history's ends. */
const summarizedRange = (history: ReadonlyArray<Message>, summary: CompactionSummary) =>
  Option.all([Option.fromUndefinedOr(history[0]), Option.fromUndefinedOr(history.at(-1))]).pipe(
    Option.map(([first, last]) => ({
      firstMessageId: first.id,
      lastMessageId: last.id,
      count: history.length,
      modelId: summary.modelId,
      usage: summary.usage,
    })),
  )

type WindowProjection = {
  readonly durableMessages: ReadonlyArray<Message>
  readonly compacted: boolean
}

/**
 * Where the window hands off and whether it must. The newest user message
 * anchors it; when the newest turn alone exceeds the budget the anchor moves
 * inside the turn, to a step boundary. Any other projection failure is the
 * caller's to raise.
 */
const handoffPlan = (
  window: ReadonlyArray<Message>,
  budget: ModelContextBudget,
  fit: Result.Result<ModelContextProjection, ModelContextProjectionError>,
): Result.Result<
  { readonly anchor: Option.Option<MessageId>; readonly overflowing: boolean },
  ModelContextProjectionError
> =>
  Result.match(fit, {
    onSuccess: (projection) =>
      Result.succeed({
        anchor: latestUserMessageId(window),
        overflowing: projection.omittedMessageIds.length > 0,
      }),
    onFailure: (error) => {
      if (error.failure._tag !== "BudgetExceeded") return Result.fail(error)
      return Result.succeed({ anchor: handoffAnchorWithinTurn(window, budget), overflowing: true })
    },
  })

/**
 * The window the model sees this step. A fresh window puts the issuer's notice
 * at the head; a handoff moves the history before the newest user message
 * behind one marker that summarizes it and names the ids it replaced. The
 * loop hands off when the window overflows, or when the model asked.
 */
export const projectContextWindow = Effect.fn("TurnHelpers.projectContextWindow")(
  function* (params: {
    readonly sessionId: SessionId
    readonly branchId: BranchId
    readonly modelId: ModelId
    readonly messages: ReadonlyArray<Message>
    readonly budget: ModelContextBudget
    readonly directive: Option.Option<ContextDirective>
    readonly project: (
      messages: ReadonlyArray<Message>,
    ) => Effect.Effect<ModelContextProjection, ModelContextProjectionError>
    readonly persist: (message: Message) => Effect.Effect<Message, StorageError | EventStoreError>
    readonly summaryModel: CompactionRequest["summaryModel"]
  }) {
    const eventPublisher = yield* EventPublisher
    const now = yield* DateTime.nowAsDate
    let durableMessages = params.messages
    const newWindow = params.directive.pipe(Option.filter((value) => value._tag === "NewWindow"))
    const newWindowAnchor = Option.all([newWindow, latestUserMessageId(durableMessages)])
    if (Option.isSome(newWindowAnchor)) {
      const [directive, anchor] = newWindowAnchor.value
      const marker = yield* params.persist(
        windowMarkerMessage({
          sessionId: params.sessionId,
          branchId: params.branchId,
          keepFromMessageId: anchor,
          notice: directive.notice,
          createdAt: now,
        }),
      )
      durableMessages = [...durableMessages, marker]
    }

    const window = messagesInCurrentWindow(durableMessages)
    const fit = yield* Effect.result(params.project(window))
    const plan = yield* Effect.fromResult(handoffPlan(window, params.budget, fit))
    const anchor = plan.anchor.pipe(
      Option.flatMap((id) => Option.fromUndefinedOr(window.find((message) => message.id === id))),
    )
    const anchorIndex = Math.max(
      0,
      window.findIndex((m) => Option.contains(anchor, m)),
    )
    const history = window.slice(0, anchorIndex)
    const kept = window.slice(anchorIndex)
    const requested = params.directive.pipe(Option.exists((value) => value._tag === "Compact"))
    const overflowing = plan.overflowing
    // Summarising is an extension's job. With no compactor installed the
    // transcript is truncated and the omission is reported as usual.
    const compactor = yield* Effect.serviceOption(ModelContextCompactor)
    if (!(requested || overflowing) || history.length === 0 || Option.isNone(compactor)) {
      return { durableMessages, compacted: false } satisfies WindowProjection
    }
    const summary = yield* compactor.value
      .compact({
        modelId: params.modelId,
        sessionId: params.sessionId,
        branchId: params.branchId,
        history,
        kept,
        budget: params.budget,
        instructions: Option.getOrUndefined(compactionInstructions(params.directive)),
        summaryModel: params.summaryModel,
      })
      .pipe(
        Effect.asSome,
        Effect.catchTag("ModelCompactionError", (error) =>
          // A summary that cannot be produced must not cost the turn: the window
          // is truncated instead, with a visible notice.
          Effect.gen(function* () {
            const plain = yield* params.project(window)
            yield* eventPublisher.publish(
              ErrorOccurred.make({
                sessionId: params.sessionId,
                branchId: params.branchId,
                error: `Context compaction failed (${error.reason}); continuing with ${plain.omittedMessageIds.length} older messages omitted`,
              }),
            )
            return Option.none()
          }),
        ),
      )
    const handoff = Option.all([summary, anchor]).pipe(
      Option.flatMap(([value, anchorMessage]) =>
        summarizedRange(history, value).pipe(
          Option.map((summarized) => ({ notice: value.notice, summarized, anchorMessage })),
        ),
      ),
    )
    if (Option.isNone(handoff))
      return { durableMessages, compacted: false } satisfies WindowProjection
    const marker = yield* params.persist(
      windowMarkerMessage({
        sessionId: params.sessionId,
        branchId: params.branchId,
        keepFromMessageId: handoff.value.anchorMessage.id,
        notice: handoff.value.notice,
        summarized: handoff.value.summarized,
        createdAt: now,
      }),
    )
    return {
      durableMessages: [...durableMessages, marker],
      compacted: true,
    } satisfies WindowProjection
  },
)
