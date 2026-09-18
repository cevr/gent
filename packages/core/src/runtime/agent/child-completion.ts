import { Cause, Context, Effect, Layer, Option, Predicate, Semaphore, Stream } from "effect"
import { agentRunUsage, type AgentName } from "../../domain/agent.js"
import {
  type AgentEvent,
  childRunSucceeded,
  EventPublisher,
  EventStore,
  type TurnCompleted,
} from "../../domain/event.js"
import { headTailChars, latestAssistantText } from "../../domain/message.js"
import { MessageId, type RequestId } from "../../domain/ids.js"
import {
  MessageStorage,
  SessionOperationStorage,
  type StoredAgentStartResult,
} from "../../storage/storage.js"
import { CurrentWorkspaceId } from "../../server/workspace-rpc.js"
import { SessionRuntime } from "../session-runtime.js"
import { followUpMessageIdForSource } from "../../domain/agent-loop.js"

/** Follow-up source for one child completion. The parent message id derives from it. */
const childCompletionSourceId = (requestId: RequestId) => `child:${requestId}:complete`

/** Bounded preview inside the parent message; the full output lives in a file. */
const maximumPreviewChars = 4_000

/**
 * The ways a turn receipt says the turn ended badly, in words a model reads.
 * Both child paths use it: the background completion message and the
 * foreground run result.
 */
export const turnFailureNames = (completion: TurnCompleted): ReadonlyArray<string> => {
  const names: Array<string> = []
  if (completion.interrupted === true) names.push("interrupted")
  if (completion.streamFailed === true) names.push("model stream failed")
  if (completion.unanswered === true) names.push("no answer produced")
  return names
}

/**
 * The message a parent reads when a child finishes.
 *
 * A turn receipt is not task success, and the ways a turn can end badly are
 * not visible in the child's text: an interrupted turn, a failed model
 * stream, and a turn that spent its continuations without answering all
 * produce output a parent would otherwise read as a completed result. Each
 * flag the receipt carries is named here so the parent model sees it.
 *
 * Pure, and exported, so those outcomes are testable without standing up
 * the delivery layer.
 */
export const describeChildCompletion = (params: {
  readonly requestId: RequestId
  readonly agentName: AgentName
  readonly child: StoredAgentStartResult
  readonly completion: TurnCompleted
  readonly text: string
}): string => {
  const outcome = turnFailureNames(params.completion)
  let status = "completed"
  if (outcome.length > 0) status = `ended (${outcome.join(", ")})`
  const preview = headTailChars(params.text, maximumPreviewChars)
  const lines = [
    `Child agent "${params.agentName}" ${status}. requestId ${params.requestId}; session ${params.child.sessionId}; branch ${params.child.branchId}.`,
    "Completion is a turn receipt, not task success. Read the output before relying on it.",
    "",
    preview.text,
  ]
  return lines.join("\n")
}

interface ChildCompletionDeliveryService {
  /** Deliver one completed child to its parent branch. Repeats are no-ops. */
  readonly deliver: (requestId: RequestId) => Effect.Effect<void>
  /** Deliver when the admitted turn completes. Returns after the watcher is running. */
  readonly watch: (requestId: RequestId, child: StoredAgentStartResult) => Effect.Effect<void>
  /** Bounded startup pass: deliver finished children, watch unfinished ones. */
  readonly reconcile: Effect.Effect<void>
}

/**
 * Child results never return through the admitting call. The parent host watches
 * the child's turn receipt and delivers an ordinary message on the parent branch.
 * The durable start registry plus the idempotent follow-up id make restart safe.
 */
export class ChildCompletionDelivery extends Context.Service<
  ChildCompletionDelivery,
  ChildCompletionDeliveryService
>()("@gent/core/src/runtime/agent/child-completion/ChildCompletionDelivery") {
  static Live = Layer.effect(
    ChildCompletionDelivery,
    Effect.gen(function* () {
      const operations = yield* SessionOperationStorage
      const messages = yield* MessageStorage
      const eventStore = yield* EventStore
      const eventPublisher = yield* EventPublisher
      const sessionRuntime = yield* SessionRuntime
      const workspaceId = yield* CurrentWorkspaceId

      const scope = yield* Effect.scope
      // One delivery at a time keeps the existence check and the enqueue atomic.
      const permit = yield* Semaphore.make(1)
      // A start admitted while the startup pass runs must not get two watchers.
      const watching = new Set<string>()
      const isTurnCompleted = Predicate.isTagged("TurnCompleted")
      const isCompletionOf =
        (requestId: RequestId) =>
        (event: AgentEvent): event is TurnCompleted =>
          isTurnCompleted(event) && event.messageId === MessageId.make(`agent-start:${requestId}`)

      /** The subscription replays history first, so a finished child is seen at once. */
      const completionOf = (requestId: RequestId, child: StoredAgentStartResult) =>
        eventStore.subscribe({ sessionId: child.sessionId, branchId: child.branchId }).pipe(
          Stream.map((envelope) => envelope.event),
          Stream.filter(isCompletionOf(requestId)),
          Stream.runHead,
        )

      const deliverCompletion = Effect.fn("ChildCompletionDelivery.deliverCompletion")(function* (
        requestId: RequestId,
        child: StoredAgentStartResult,
        completion: TurnCompleted,
      ) {
        const parent = {
          sessionId: child.input.parentSessionId,
          branchId: child.input.parentBranchId,
        }
        const sourceId = childCompletionSourceId(requestId)
        const existing = yield* messages.getMessage(
          followUpMessageIdForSource({ workspaceId, ...parent, sourceId }),
        )
        if (Predicate.isNotUndefined(existing)) return
        const text = latestAssistantText(yield* messages.listMessages(child.branchId))
        yield* sessionRuntime.queueFollowUp({
          sourceId,
          ...parent,
          // A parent with no prior turn still gets to read the completion.
          wake: true,
          content: describeChildCompletion({
            requestId,
            agentName: child.input.agentName,
            child,
            completion,
            text,
          }),
          metadata: {
            customType: "child-completion",
            details: { requestId, sessionId: child.sessionId, branchId: child.branchId },
          },
        })
        // The transcript event follows the durable message so a replayed client never sees it alone.
        yield* eventPublisher.publish(
          childRunSucceeded({
            parentSessionId: parent.sessionId,
            childSessionId: child.sessionId,
            agentName: child.input.agentName,
            toolCallId: child.input.toolCallId,
            branchId: parent.branchId,
            usage: Option.getOrUndefined(
              Option.map(Option.fromUndefinedOr(completion.usage), agentRunUsage),
            ),
            text,
          }),
        )
      })

      const warn = (requestId: RequestId, stage: string) => (cause: Cause.Cause<unknown>) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
        return Effect.logWarning("child completion delivery failed").pipe(
          Effect.annotateLogs({ requestId, stage, error: Cause.pretty(cause) }),
        )
      }

      const deliver = Effect.fn("ChildCompletionDelivery.deliver")(function* (
        requestId: RequestId,
      ) {
        yield* Effect.gen(function* () {
          const saved = yield* operations.getAgentStart(requestId)
          if (Option.isNone(saved)) return
          const completion = yield* completionOf(requestId, saved.value).pipe(
            Effect.timeout("2 seconds"),
            Effect.option,
            Effect.map(Option.flatten),
          )
          if (Option.isNone(completion)) return
          yield* Semaphore.withPermit(
            permit,
            deliverCompletion(requestId, saved.value, completion.value),
          )
        }).pipe(Effect.catchCause(warn(requestId, "deliver")))
      })

      const watch = Effect.fn("ChildCompletionDelivery.watch")(function* (
        requestId: RequestId,
        child: StoredAgentStartResult,
      ) {
        if (watching.has(requestId)) return
        watching.add(requestId)
        yield* completionOf(requestId, child).pipe(
          Effect.flatMap((completion) => {
            if (Option.isNone(completion)) return Effect.void
            return Semaphore.withPermit(
              permit,
              deliverCompletion(requestId, child, completion.value),
            )
          }),
          Effect.catchCause(warn(requestId, "watch")),
          Effect.ensuring(Effect.sync(() => watching.delete(requestId))),
          Effect.forkIn(scope),
        )
      })

      const reconcile = Effect.gen(function* () {
        const rows = yield* operations.listAgentStarts(Option.none())
        for (const row of rows) {
          if (row.completed) yield* deliver(row.requestId)
          else yield* watch(row.requestId, row.result)
        }
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
          return Effect.logWarning("child completion reconcile failed").pipe(
            Effect.annotateLogs({ error: Cause.pretty(cause) }),
          )
        }),
      )

      return ChildCompletionDelivery.of({ deliver, watch, reconcile })
    }),
  )

  /** No delivery. For runner tests that assert admission and control only. */
  static Silent = Layer.succeed(
    ChildCompletionDelivery,
    ChildCompletionDelivery.of({
      deliver: () => Effect.void,
      watch: () => Effect.void,
      reconcile: Effect.void,
    }),
  )
}
