import { describe, expect, it } from "effect-bun-test"
import { DateTime, Effect, Fiber, Option, Ref, Semaphore, TxQueue } from "effect"
import type { ActiveStreamHandle } from "../../../src/runtime/agent/turn-response"
import * as Prompt from "effect/unstable/ai/Prompt"
import { dateFromMillis, Message } from "@gent/core-internal/domain/message"
import { BranchId, MessageId, SessionId } from "@gent/core-internal/domain/ids"
import {
  buildIdleState,
  buildRunningState,
  clearInFlightQueuedTurn,
  emptyLoopQueueState,
  takeNextQueuedTurn,
  type LoopQueueState,
  type LoopState,
  type QueuedTurnItem,
  type RunningState,
} from "../../../src/runtime/agent/agent-loop.state"
import {
  emptyAdmissionGate,
  makeAgentLoopWorker,
} from "../../../src/runtime/agent/agent-loop.worker"
import { TurnOutcome } from "../../../src/runtime/agent/agent-loop.turn-execution"

const sessionId = SessionId.make("withdrawal-session")
const branchId = BranchId.make("withdrawal-branch")

const queuedItem = (id: string): QueuedTurnItem => ({
  message: Message.cases.regular.make({
    id: MessageId.make(id),
    sessionId,
    branchId,
    role: "user",
    parts: [Prompt.textPart({ text: id })],
    createdAt: dateFromMillis(1_767_225_600_000),
  }),
})

/** The admitted item sits in `inFlight` and names the Running checkpoint; the turn has not started. */
const admitted = (item: QueuedTurnItem, rest: ReadonlyArray<QueuedTurnItem>) => ({
  state: buildRunningState({}, item, { startedAtMs: 1 }),
  queue: { ...emptyLoopQueueState(), followUp: [...rest], inFlight: item },
})

const makeHarness = (initial: { state: LoopState; queue: LoopQueueState }) =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<LoopState>(initial.state)
    const queueRef = yield* Ref.make<LoopQueueState>(initial.queue)
    const ranTurns = yield* Ref.make<ReadonlyArray<string>>([])
    const turnWorkerQueue = yield* TxQueue.unbounded<RunningState>()
    const gateRef = yield* Ref.make(emptyAdmissionGate)
    const worker = makeAgentLoopWorker<never, never>({
      sessionId,
      branchId,
      sideMutationSemaphore: yield* Semaphore.make(1),
      interruptSemaphore: yield* Semaphore.make(1),
      turnWorkerQueue,
      activeStreamRef: yield* Ref.make(Option.none<ActiveStreamHandle>()),
      interruptedRef: yield* Ref.make(false),
      interruptCell: Effect.void,
      currentLoopState: Ref.get(stateRef),
      saveCheckpoint: (next) => Ref.set(stateRef, next),
      takeNextQueuedTurn: Effect.gen(function* () {
        const now = yield* DateTime.nowAsDate
        const queue = yield* Ref.get(queueRef)
        const { queue: next, nextItem } = takeNextQueuedTurn(queue, now)
        yield* Ref.set(queueRef, next)
        return nextItem
      }),
      clearInFlightTurn: (messageId) =>
        Ref.modify(queueRef, (queue): [boolean, LoopQueueState] => {
          const next = clearInFlightQueuedTurn(queue, messageId)
          return [next !== queue, next]
        }),
      admissionGateRef: gateRef,
      recordTurnFailure: () => Effect.void,
      publishEvent: () => Effect.void,
      runTurn: (state) =>
        Ref.update(ranTurns, (ids) => [...ids, String(state.message.id)]).pipe(
          Effect.as(TurnOutcome.cases.Done.make({})),
        ),
      switchAgentOnState: (state) => Effect.succeed(state),
    })
    return { worker, stateRef, queueRef, ranTurns, turnWorkerQueue, gateRef }
  })

const waitForEmptyWorkerQueue = (queue: TxQueue.TxQueue<RunningState>): Effect.Effect<void> =>
  TxQueue.size(queue).pipe(
    Effect.flatMap((size) => {
      if (size === 0) return Effect.void
      return Effect.yieldNow.pipe(Effect.andThen(waitForEmptyWorkerQueue(queue)))
    }),
  )

describe("admitted turn withdrawal", () => {
  it.effect("withdrawing the admitted turn returns the branch to idle", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness(admitted(first, []))
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      expect(withdrawn).toBe(true)
      expect((yield* Ref.get(harness.stateRef))._tag).toBe("Idle")
      expect((yield* Ref.get(harness.queueRef)).inFlight).toBeUndefined()
    }),
  )

  it.effect("withdrawing the admitted turn promotes the next queued follow-up", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const second = queuedItem("second")
      const harness = yield* makeHarness(admitted(first, [second]))
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      expect(withdrawn).toBe(true)
      const state = yield* Ref.get(harness.stateRef)
      expect(state._tag).toBe("Running")
      if (state._tag === "Running") expect(String(state.message.id)).toBe("second")
      expect((yield* Ref.get(harness.queueRef)).followUp).toHaveLength(0)
    }),
  )

  it.effect("a message that is not the admitted turn is left alone", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness(admitted(first, []))
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(MessageId.make("other"))
      expect(withdrawn).toBe(false)
      expect((yield* Ref.get(harness.stateRef))._tag).toBe("Running")
    }),
  )

  it.effect("a turn the worker already claimed cannot be withdrawn", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness(admitted(first, []))
      yield* Ref.set(harness.gateRef, {
        ...emptyAdmissionGate,
        started: Option.some(first.message.id),
      })
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      expect(withdrawn).toBe(false)
      expect((yield* Ref.get(harness.stateRef))._tag).toBe("Running")
    }),
  )

  it.effect("a resumed turn without an in-flight marker is not withdrawn", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness({
        state: buildRunningState({}, first, { startedAtMs: 1 }),
        queue: emptyLoopQueueState(),
      })
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      expect(withdrawn).toBe(false)
      expect((yield* Ref.get(harness.stateRef))._tag).toBe("Running")
    }),
  )

  it.effect("the worker skips a withdrawn admission left in its queue", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const initial = admitted(first, [])
      const harness = yield* makeHarness(initial)
      // The finishing turn enqueued `first`; the withdrawal lands before the worker takes it.
      yield* TxQueue.offer(harness.turnWorkerQueue, initial.state)
      yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      yield* Ref.set(harness.stateRef, buildIdleState())
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      yield* waitForEmptyWorkerQueue(harness.turnWorkerQueue)
      expect(yield* Ref.get(harness.ranTurns)).toEqual([])
      yield* Fiber.interrupt(loop)
    }),
  )

  it.effect("two concurrent withdrawals of one admission remove it exactly once", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const initial = admitted(first, [])
      const harness = yield* makeHarness(initial)
      yield* TxQueue.offer(harness.turnWorkerQueue, initial.state)
      const results = yield* Effect.all(
        [
          harness.worker.withdrawAdmittedTurn(first.message.id),
          harness.worker.withdrawAdmittedTurn(first.message.id),
        ],
        { concurrency: "unbounded" },
      )
      expect(results.filter((removed) => removed)).toHaveLength(1)
      expect((yield* Ref.get(harness.stateRef))._tag).toBe("Idle")
      // The losing call must not clear the marker the worker checks.
      expect(Option.getOrUndefined((yield* Ref.get(harness.gateRef)).withdrawn)).toBe(
        first.message.id,
      )
      const loop = yield* Effect.forkChild(harness.worker.turnWorkerLoop)
      yield* waitForEmptyWorkerQueue(harness.turnWorkerQueue)
      expect(yield* Ref.get(harness.ranTurns)).toEqual([])
      yield* Fiber.interrupt(loop)
    }),
  )

  it.effect("a promoted follow-up can be withdrawn in turn", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const second = queuedItem("second")
      const harness = yield* makeHarness(admitted(first, [second]))
      expect(yield* harness.worker.withdrawAdmittedTurn(first.message.id)).toBe(true)
      expect(yield* harness.worker.withdrawAdmittedTurn(first.message.id)).toBe(false)
      expect(yield* harness.worker.withdrawAdmittedTurn(second.message.id)).toBe(true)
      expect((yield* Ref.get(harness.stateRef))._tag).toBe("Idle")
      expect((yield* Ref.get(harness.queueRef)).followUp).toHaveLength(0)
    }),
  )
})
