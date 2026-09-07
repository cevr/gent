import { Cause, Context, Effect, Layer, Option, Predicate, Semaphore, Stream } from "effect"
import type { AgentName } from "../../domain/agent.js"
import {
  type AgentEvent,
  AgentRunSucceeded,
  EventStore,
  type TurnCompleted,
} from "../../domain/event.js"
import { EventPublisher } from "../../domain/event-publisher.js"
import { headTailChars } from "../../domain/output-buffer.js"
import { MessageId, type RequestId } from "../../domain/ids.js"
import { MessageStorage } from "../../storage/message-storage.js"
import {
  SessionOperationStorage,
  type StoredAgentStartResult,
} from "../../storage/session-operation-storage.js"
import { CurrentWorkspaceId } from "../../server/workspace-rpc.js"
import { followUpMessageIdForSource, SessionRuntime } from "../session-runtime.js"
import { makeAgentRunMetadataRuntime } from "./agent-runner.metadata.js"

/** Follow-up source for one child completion. The parent message id derives from it. */
export const childCompletionSourceId = (requestId: RequestId) => `child:${requestId}:complete`

/** Bounded preview inside the parent message; the full output lives in a file. */
const maximumPreviewChars = 4_000

export interface ChildCompletionDeliveryService {
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
      const metadata = yield* makeAgentRunMetadataRuntime
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

      const describe = (params: {
        readonly requestId: RequestId
        readonly agentName: AgentName
        readonly child: StoredAgentStartResult
        readonly completion: TurnCompleted
        readonly text: string
        readonly savedPath: Option.Option<string>
      }) => {
        const outcome: Array<string> = []
        if (params.completion.interrupted === true) outcome.push("interrupted")
        if (params.completion.streamFailed === true) outcome.push("model stream failed")
        let status = "completed"
        if (outcome.length > 0) status = `ended (${outcome.join(", ")})`
        const preview = headTailChars(params.text, maximumPreviewChars)
        const lines = [
          `Child agent "${params.agentName}" ${status}. requestId ${params.requestId}; session ${params.child.sessionId}; branch ${params.child.branchId}.`,
          "Completion is a turn receipt, not task success. Read the output before relying on it.",
          "",
          preview.text,
        ]
        if (Option.isSome(params.savedPath))
          lines.push("", `Full output: ${params.savedPath.value}`)
        return lines.join("\n")
      }

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
        const { success, reasoning } = yield* metadata.loadAgentRunSuccessData({
          sessionId: child.sessionId,
          branchId: child.branchId,
          agentName: child.input.agentName,
          persistence: "durable",
        })
        const savedPath = yield* metadata.saveAgentRunOutput({
          text: success.text,
          reasoning,
          agentName: child.input.agentName,
          sessionId: child.sessionId,
        })
        yield* sessionRuntime.queueFollowUp({
          sourceId,
          ...parent,
          // A parent with no prior turn still gets to read the completion.
          wake: true,
          content: describe({
            requestId,
            agentName: child.input.agentName,
            child,
            completion,
            text: success.text,
            savedPath,
          }),
          metadata: {
            customType: "child-completion",
            details: { requestId, sessionId: child.sessionId, branchId: child.branchId },
          },
        })
        // The transcript event follows the durable message so a replayed client never sees it alone.
        yield* eventPublisher.publish(
          AgentRunSucceeded.make({
            parentSessionId: parent.sessionId,
            childSessionId: child.sessionId,
            agentName: child.input.agentName,
            toolCallId: child.input.toolCallId,
            branchId: parent.branchId,
            usage: success.usage,
            preview: success.text.slice(0, 200),
            savedPath: Option.getOrUndefined(savedPath),
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
