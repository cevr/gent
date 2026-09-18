import {
  Cause,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
} from "effect"
import { canonicalJsonString } from "effect-encore"
import { SqlClient } from "effect/unstable/sql"
import { withWideEvent, WideEvent, agentRunBoundary } from "../wide-event-boundary.js"
import {
  AgentRunFailed,
  AgentRunSpawned,
  childRunSucceeded,
  type EventEnvelope,
  EventPublisher,
  EventStore,
  type TurnCompleted,
} from "../../domain/event.js"
import {
  AgentRunError,
  AgentRunnerService,
  AgentRunResult,
  DEFAULT_MAX_PENDING_AGENT_STARTS,
  agentRunUsage,
  makeRunSpec,
  type AgentName,
  type ChildAgentRegistryEntry,
  type RunSpec,
} from "../../domain/agent.js"
import {
  ActorCommandId,
  BranchId,
  MessageId,
  RequestId,
  SessionId,
  type ToolCallId,
} from "../../domain/ids.js"
import { Branch, latestAssistantText, messagesToolCalls, Session } from "../../domain/message.js"
import { GentPlatform } from "../gent-platform.js"
import {
  BranchStorage,
  EventStorage,
  makeStorageTransaction,
  MessageStorage,
  type RelationshipStorage,
  SessionOperationStorage,
  SessionStorage,
  StoredAgentStartInput,
} from "../../storage/storage.js"
import { admitChildSessionDepth } from "../session-depth.js"
import { SessionRuntime } from "../session-runtime.js"
import { ChildCompletionDelivery, turnFailureNames } from "./child-completion.js"

/** Storage and transport faults become the one caller-facing error at their source. */
const toAgentRunError = (cause: { readonly _tag: string; readonly message: string }) => {
  if (Schema.is(AgentRunError)(cause)) return cause
  return new AgentRunError({ message: cause.message, cause })
}
const asAgentRunError = Effect.mapError(toAgentRunError)

const startMessageId = (requestId: RequestId) => MessageId.make(`agent-start:${requestId}`)

const canonicalStartInput = (input: typeof StoredAgentStartInput.Type) =>
  Schema.encodeEffect(Schema.fromJsonString(StoredAgentStartInput))(input).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Json))),
    Effect.map(canonicalJsonString),
    Effect.mapError((cause) => new AgentRunError({ message: "Invalid agent-start input", cause })),
  )

interface ChildAdmission {
  agent: { name: AgentName }
  prompt: string
  parentSessionId: SessionId
  parentBranchId: BranchId
  toolCallId?: ToolCallId
  cwd: string
  /** A background start keeps a durable receipt keyed by the caller's request. */
  admission?: { readonly requestId: RequestId; readonly runSpec?: RunSpec }
  /** `private` admits the child without a spawn receipt on the parent branch. */
  visibility?: RunSpec["visibility"]
}

/**
 * Admit one child session under a parent branch: the depth and pending-start
 * limits, the session and branch rows, the spawn receipt, and (for a
 * background start) the durable start row, in one transaction. A repeated
 * start request with the same input returns the existing child.
 */
export const admitChildSession = Effect.fn("AgentRunner.admitChildSession")(function* (
  params: ChildAdmission,
) {
  const sessionStorage = yield* SessionStorage
  const operations = yield* SessionOperationStorage
  const branchStorage = yield* BranchStorage
  const eventPublisher = yield* EventPublisher
  const platform = yield* GentPlatform
  const storageTransaction = yield* makeStorageTransaction
  const sql = yield* SqlClient.SqlClient
  if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
    return yield* new AgentRunError({
      message: "Child admission must commit outside a caller transaction",
    })
  }
  yield* admitChildSessionDepth(params.parentSessionId)

  const sessionId = SessionId.make(yield* platform.randomId)
  const branchId = BranchId.make(yield* platform.randomId)
  const now = yield* DateTime.nowAsDate
  const startInput = {
    parentSessionId: params.parentSessionId,
    parentBranchId: params.parentBranchId,
    agentName: params.agent.name,
    prompt: params.prompt,
    cwd: params.cwd,
    toolCallId: params.toolCallId,
    runSpec: params.admission?.runSpec,
  }

  const committed = yield* storageTransaction(
    Effect.gen(function* () {
      if (Predicate.isNotUndefined(params.admission)) {
        const parentBranch = yield* branchStorage.getBranch(params.parentBranchId)
        if (parentBranch?.sessionId !== params.parentSessionId) {
          return yield* new AgentRunError({
            message: "Agent-start branch does not belong to parent",
          })
        }
        const saved = yield* operations.getAgentStart(params.admission.requestId)
        if (Option.isSome(saved)) {
          if (
            (yield* canonicalStartInput(saved.value.input)) !==
            (yield* canonicalStartInput(startInput))
          ) {
            return yield* new AgentRunError({ message: "Agent-start request input changed" })
          }
          const child = yield* sessionStorage.getSession(saved.value.sessionId)
          if (Predicate.isUndefined(child)) {
            return yield* new AgentRunError({ message: "Agent-start child no longer exists" })
          }
          return {
            sessionId: saved.value.sessionId,
            branchId: saved.value.branchId,
            envelope: Option.none(),
          }
        }
        const pending = yield* operations.countPendingAgentStarts({
          sessionId: params.parentSessionId,
          branchId: params.parentBranchId,
        })
        if (pending >= DEFAULT_MAX_PENDING_AGENT_STARTS) {
          return yield* new AgentRunError({
            message: `Parent branch already has ${DEFAULT_MAX_PENDING_AGENT_STARTS} unfinished child starts`,
          })
        }
      }
      yield* sessionStorage.createSession(
        new Session({
          id: sessionId,
          name: `${params.agent.name}: ${params.prompt.slice(0, 60)}`,
          cwd: params.cwd,
          parentSessionId: params.parentSessionId,
          parentBranchId: params.parentBranchId,
          activeBranchId: branchId,
          createdAt: now,
          updatedAt: now,
        }),
      )
      yield* branchStorage.createBranch(new Branch({ id: branchId, sessionId, createdAt: now }))
      let envelope = Option.none<EventEnvelope>()
      if (params.visibility !== "private") {
        envelope = Option.some(
          yield* eventPublisher.append(
            AgentRunSpawned.make({
              parentSessionId: params.parentSessionId,
              childSessionId: sessionId,
              agentName: params.agent.name,
              prompt: params.prompt,
              toolCallId: params.toolCallId,
              branchId: params.parentBranchId,
              childBranchId: branchId,
            }),
          ),
        )
      }
      if (Predicate.isNotUndefined(params.admission)) {
        yield* operations.saveAgentStart(params.admission.requestId, {
          sessionId,
          branchId,
          input: startInput,
        })
      }
      return { sessionId, branchId, envelope }
    }),
  )
  if (Option.isSome(committed.envelope)) yield* eventPublisher.deliver(committed.envelope.value)
  return { sessionId: committed.sessionId, branchId: committed.branchId }
}, asAgentRunError)

type AdmissionServices =
  | SessionStorage
  | SessionOperationStorage
  | BranchStorage
  | RelationshipStorage
  | EventPublisher
  | GentPlatform
  | SqlClient.SqlClient

export const InProcessRunner: Layer.Layer<
  AgentRunnerService,
  never,
  | AdmissionServices
  | MessageStorage
  | EventStorage
  | EventStore
  | SessionRuntime
  | ChildCompletionDelivery
> = Layer.effect(
  AgentRunnerService,
  Effect.gen(function* () {
    const eventStore = yield* EventStore
    const messageStorage = yield* MessageStorage
    const eventPublisher = yield* EventPublisher
    const sessionRuntime = yield* SessionRuntime
    const sessionStorage = yield* SessionStorage
    const eventStorage = yield* EventStorage
    const operations = yield* SessionOperationStorage
    const sql = yield* SqlClient.SqlClient
    const delivery = yield* ChildCompletionDelivery
    const admissionServices = yield* Effect.context<AdmissionServices>()
    // Startup recovery runs beside the server, not before it.
    yield* Effect.forkScoped(delivery.reconcile)

    const admit = (params: ChildAdmission) =>
      admitChildSession(params).pipe(Effect.provideContext(admissionServices))

    // A private child is gone once its answer is read: no loop, no rows, no
    // live events. Each step is best effort; a leftover row is not a failed run.
    const forgetPrivateSession = (sessionId: SessionId) =>
      Effect.all(
        [
          sessionRuntime.terminateSession(sessionId),
          sessionStorage.deleteSession(sessionId),
          eventStore.removeSession(sessionId),
        ],
        { discard: true },
      ).pipe(Effect.ignore)

    /** The start row is the owner; a deleted child is reported, not guessed at. */
    const inspect = Effect.fn("AgentRunner.inspect")(function* (params: {
      readonly requestId: RequestId
      readonly parentSessionId: SessionId
      readonly parentBranchId: BranchId
    }) {
      const saved = yield* operations.getAgentStart(params.requestId)
      if (
        Option.isNone(saved) ||
        saved.value.input.parentSessionId !== params.parentSessionId ||
        saved.value.input.parentBranchId !== params.parentBranchId
      ) {
        return yield* new AgentRunError({ message: "Agent-start receipt not owned by parent" })
      }
      const { sessionId, branchId } = saved.value
      const child = yield* sessionStorage.getSession(sessionId)
      if (
        child?.parentSessionId !== params.parentSessionId ||
        child?.parentBranchId !== params.parentBranchId
      ) {
        return yield* new AgentRunError({ message: "Agent-start child no longer exists" })
      }
      const completion = yield* eventStorage.getLatestEvent({
        sessionId,
        branchId,
        tags: ["TurnCompleted"],
        messageId: startMessageId(params.requestId),
      })
      if (completion?._tag === "TurnCompleted") {
        return { sessionId, branchId, completion: Option.some(completion) }
      }
      return { sessionId, branchId, completion: Option.none<TurnCompleted>() }
    }, asAgentRunError)

    /** The child's prompt is one user message on its branch, keyed by the run. */
    const promptChild = (params: {
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly messageId: MessageId
      readonly prompt: string
      readonly agentName: AgentName
      readonly runSpec?: RunSpec
      readonly completion?: "admission"
    }) =>
      sessionRuntime
        .sendUserMessage({
          sessionId: params.sessionId,
          branchId: params.branchId,
          commandId: ActorCommandId.make(params.messageId),
          content: params.prompt,
          agentOverride: params.agentName,
          interactive: false,
          runSpec: params.runSpec,
          completion: params.completion,
        })
        .pipe(
          Effect.mapError(
            (cause) => new AgentRunError({ message: "Child prompt was not admitted", cause }),
          ),
        )

    /** Admission completes when the child's actor holds the prompt; the turn runs on its own. */
    const submitChildMessage = Effect.fn("AgentRunner.submitChildMessage")(function* (
      requestId: RequestId,
    ) {
      const saved = yield* operations.getAgentStart(requestId)
      if (Option.isNone(saved)) {
        return yield* new AgentRunError({ message: "Agent-start receipt no longer exists" })
      }
      const { sessionId, branchId, input } = saved.value
      yield* promptChild({
        sessionId,
        branchId,
        messageId: startMessageId(requestId),
        prompt: input.prompt,
        agentName: input.agentName,
        runSpec: input.runSpec,
        completion: "admission",
      })
    }, asAgentRunError)

    return AgentRunnerService.of({
      start: Effect.fn("AgentRunner.start")(function* (params) {
        const runSpec = makeRunSpec({ ...params.runSpec, parentToolCallId: params.toolCallId })
        const child = yield* admit({
          ...params,
          admission: { requestId: params.requestId, runSpec },
        })
        yield* submitChildMessage(params.requestId)
        // The handle returns now; the result arrives later as a parent message.
        yield* delivery.watch(params.requestId, {
          ...child,
          input: {
            parentSessionId: params.parentSessionId,
            parentBranchId: params.parentBranchId,
            agentName: params.agent.name,
            prompt: params.prompt,
            cwd: params.cwd,
            toolCallId: params.toolCallId,
            runSpec: params.runSpec,
          },
        })
        return child
        // Admission and the completion watcher stand or fall together. A caller
        // interrupted between them (a dying cell worker, a cancelled tool call)
        // would leave a running child nobody delivers.
      }, Effect.uninterruptible),
      inspect,
      list: Effect.fn("AgentRunner.list")(function* (params) {
        const rows = yield* operations.listAgentStarts(
          Option.some({ sessionId: params.parentSessionId, branchId: params.parentBranchId }),
        )
        return rows.map((row): ChildAgentRegistryEntry => ({
          requestId: row.requestId,
          sessionId: row.result.sessionId,
          branchId: row.result.branchId,
          agentName: row.result.input.agentName,
          completed: row.completed,
        }))
      }, asAgentRunError),
      cancel: Effect.fn("AgentRunner.cancel")(function* (params) {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
          return yield* new AgentRunError({
            message: "Child cancellation must run outside a caller transaction",
          })
        }
        const child = yield* inspect(params)
        if (Option.isSome(child.completion)) return
        const messageId = startMessageId(params.requestId)
        yield* operations.cancelTurn({
          sessionId: child.sessionId,
          branchId: child.branchId,
          messageId,
        })
        yield* sessionRuntime
          .steer({
            _tag: "Cancel",
            sessionId: child.sessionId,
            branchId: child.branchId,
            requestId: RequestId.make(`agent-cancel:${params.requestId}`),
            messageId,
          })
          .pipe(
            Effect.mapError(
              (cause) => new AgentRunError({ message: "Cannot submit child cancellation", cause }),
            ),
          )
        // An unstarted child still needs its message admitted so the cancel lands as a receipt.
        yield* submitChildMessage(params.requestId)
      }, asAgentRunError),
      send: Effect.fn("AgentRunner.send")(function* (params) {
        const child = yield* inspect(params)
        if (Option.isSome(child.completion)) {
          return yield* new AgentRunError({
            message:
              "The child already finished and takes no more messages. Read its output, or delegate a new task.",
          })
        }
        yield* sessionRuntime
          .steer({
            _tag: "Interject",
            sessionId: child.sessionId,
            branchId: child.branchId,
            requestId: params.sendId,
            message: params.message,
            // The child can finish between the check above and the actor
            // taking this command. An idle branch only queues steering, so
            // without the wake the message would sit unread forever. The
            // actor makes the idle test itself, under its own permit.
            wake: true,
          })
          .pipe(
            Effect.mapError(
              (cause) => new AgentRunError({ message: "Cannot message the child", cause }),
            ),
          )
      }, asAgentRunError),
      run: Effect.fn("AgentRunner.run")(function* (params) {
        const runSpec = params.runSpec
        const toolCallId = runSpec?.parentToolCallId
        // A private run leaves no trace on the parent: no spawn or completion
        // events, and its session is deleted once the answer is read.
        const isPrivate = runSpec?.visibility === "private"
        const agentName = params.agent.name

        const admitted = yield* admit({
          ...params,
          toolCallId,
          visibility: runSpec?.visibility,
        }).pipe(Effect.exit)
        if (Exit.isFailure(admitted)) {
          if (Cause.hasInterruptsOnly(admitted.cause)) return yield* Effect.interrupt
          return AgentRunResult.cases.Error.make({
            error: Cause.pretty(admitted.cause),
            agentName,
          })
        }
        const { sessionId, branchId } = admitted.value
        const receipt = {
          parentSessionId: params.parentSessionId,
          childSessionId: sessionId,
          agentName,
          toolCallId,
          branchId: params.parentBranchId,
        }

        const run = Effect.gen(function* () {
          yield* WideEvent.set({ childSessionId: sessionId })
          // An inheriting child starts from what the caller's model sees now:
          // hidden rows stay out, as they do in the parent's own turn.
          if (runSpec?.history === "inherit") {
            const seed = yield* messageStorage.listMessages(params.parentBranchId)
            yield* Effect.forEach(
              seed.filter((message) => message.metadata?.hidden !== true),
              (message, index) =>
                messageStorage.createMessage({
                  ...message,
                  id: MessageId.make(`${branchId}:seed:${index}`),
                  sessionId,
                  branchId,
                }),
              { discard: true },
            )
          }
          // The observer sees the child's events as they happen; its failures never fail the run.
          const observer = yield* Option.match(Option.fromUndefinedOr(params.observe), {
            onNone: () => Effect.succeed(Option.none<Fiber.Fiber<void>>()),
            onSome: (notify) =>
              eventStore.subscribe({ sessionId, branchId }).pipe(
                Stream.runForEach((envelope) =>
                  notify(envelope.event).pipe(Effect.catchEager(() => Effect.void)),
                ),
                Effect.catchEager(() => Effect.void),
                Effect.forkChild,
                Effect.asSome,
              ),
          })
          const messageId = MessageId.make(`agent-run:${sessionId}`)
          yield* promptChild({
            sessionId,
            branchId,
            messageId,
            prompt: params.prompt,
            agentName,
            runSpec: makeRunSpec({ ...runSpec, parentToolCallId: toolCallId }),
          }).pipe(
            // A foreground child belongs to this call. Left running after the
            // caller is interrupted, it has no owner to await or cancel it.
            Effect.onInterrupt(() =>
              sessionRuntime
                .steer({
                  _tag: "Interrupt",
                  sessionId,
                  branchId,
                  requestId: RequestId.make(`agent-run-interrupt:${sessionId}`),
                })
                .pipe(Effect.ignore),
            ),
            Effect.ensuring(
              Option.match(observer, { onNone: () => Effect.void, onSome: Fiber.interrupt }),
            ),
          )

          // The answer is the branch's last assistant message; the totals are
          // on the turn receipt. Neither needs an event scan.
          const completion = yield* eventStorage
            .getLatestEvent({ sessionId, branchId, tags: ["TurnCompleted"], messageId })
            .pipe(
              Effect.map(Option.fromUndefinedOr),
              Effect.catchEager(() => Effect.succeedNone),
            )
          const childMessages = yield* messageStorage.listMessages(branchId)
          const usage = Option.getOrUndefined(
            Option.flatMap(completion, (event) => {
              if (event._tag !== "TurnCompleted") return Option.none()
              return Option.map(Option.fromUndefinedOr(event.usage), agentRunUsage)
            }),
          )
          const toolCalls = Option.filter(
            Option.some(messagesToolCalls(childMessages)),
            (calls) => calls.length > 0,
          )
          // A receipt that says the turn ended badly is not a success, whatever
          // text the child left behind. The background path names these same
          // outcomes in its completion message.
          const failures = Option.match(completion, {
            onNone: (): ReadonlyArray<string> => [],
            onSome: (event) => {
              if (event._tag !== "TurnCompleted") return []
              return turnFailureNames(event)
            },
          })
          if (failures.length > 0) {
            if (!isPrivate) yield* eventPublisher.publish(AgentRunFailed.make(receipt))
            const partial = latestAssistantText(childMessages)
            let error = `The child turn ended (${failures.join(", ")}).`
            if (partial.length > 0) error = `${error} Partial output:\n${partial}`
            return AgentRunResult.cases.Error.make({ error, sessionId, agentName })
          }
          const success = AgentRunResult.cases.Success.make({
            text: latestAssistantText(childMessages),
            sessionId,
            agentName,
            usage,
            toolCalls: Option.getOrUndefined(toolCalls),
          })
          if (!isPrivate) {
            yield* eventPublisher.publish(
              childRunSucceeded({ ...receipt, usage: success.usage, text: success.text }),
            )
          }
          yield* WideEvent.set({
            usage: success.usage,
            toolCallCount: success.toolCalls?.length ?? 0,
          })
          return success
        }).pipe(
          withWideEvent(agentRunBoundary(agentName, params.parentSessionId)),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            return Effect.gen(function* () {
              const error = Cause.pretty(cause)
              if (!isPrivate) {
                yield* eventPublisher
                  .publish(AgentRunFailed.make(receipt))
                  .pipe(
                    Effect.catchEager((e) =>
                      Effect.logWarning("failed to publish agent-run event").pipe(
                        Effect.annotateLogs({ error: String(e) }),
                      ),
                    ),
                  )
              }
              return AgentRunResult.cases.Error.make({ error, sessionId, agentName })
            })
          }),
        )
        if (!isPrivate) return yield* run
        return yield* run.pipe(Effect.ensuring(forgetPrivateSession(sessionId)))
      }),
    })
  }),
)
