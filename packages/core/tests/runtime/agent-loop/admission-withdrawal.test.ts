import { describe, expect, it } from "effect-bun-test"
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Semaphore,
  TxQueue,
  TxSubscriptionRef,
} from "effect"
import { type ActiveStreamHandle, TurnOutcome } from "../../../src/runtime/turn"
import * as Prompt from "effect/unstable/ai/Prompt"
import {
  dateFromMillis,
  emptyLoopQueueState,
  type LoopQueueState,
  Message,
  type QueuedTurnItem,
} from "../../../src/domain/message"
import { BranchId, MessageId, SessionId } from "../../../src/domain/ids"
import {
  buildIdleState,
  buildRunningState,
  type AgentLoopError,
  type LoopState,
  type RunningState,
} from "../../../src/domain/agent-loop"
import {
  type AgentLoopState,
  buildInitialAgentLoopState,
  emptyAdmissionGate,
  makeAgentLoopWorker,
  makeLoopInbox,
} from "../../../src/runtime/agent-loop"
import { AgentLoopQueueStorage } from "../../../src/storage/storage"
import { makeTurnInterruption } from "../../../src/runtime/tools.js"

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
  state: buildRunningState(item, { startedAtMs: 1 }),
  queue: { ...emptyLoopQueueState(), followUp: [...rest], inFlight: item },
})

/**
 * The worker runs against a real `LoopInbox`, not a stub of the queue algebra.
 * The subject is the admission gate, and only a real inbox proves the worker's
 * withdrawal and the inbox's in-flight slot agree about what was admitted.
 * Storage is a memory cell: the durable write is not this test's subject.
 */
const memoryQueueStorage = Layer.effect(
  AgentLoopQueueStorage,
  Effect.gen(function* () {
    const rows = yield* Ref.make(new Map<string, LoopQueueState>())
    const key = (s: string, b: string) => `${s}/${b}`
    return AgentLoopQueueStorage.of({
      getQueueState: (s, b) =>
        Ref.get(rows).pipe(Effect.map((map) => map.get(key(s, b)) ?? emptyLoopQueueState())),
      putQueueState: (s, b, queue) => Ref.update(rows, (map) => new Map(map).set(key(s, b), queue)),
    })
  }),
)

const makeHarness = (initial: { state: LoopState; queue: LoopQueueState }) =>
  Effect.gen(function* () {
    const loopRef = yield* TxSubscriptionRef.make<AgentLoopState>(
      buildInitialAgentLoopState({ state: initial.state, queue: initial.queue }),
    )
    const inbox = yield* makeLoopInbox({
      sessionId,
      branchId,
      loopRef,
      queuePersistenceSemaphore: yield* Semaphore.make(1),
      persistenceFailure: yield* Deferred.make<void, AgentLoopError>(),
      startedRef: yield* Ref.make(true),
    })
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
      turnInterruption: yield* makeTurnInterruption,
      interruptToolWork: Effect.void,
      inbox,
      admissionGateRef: gateRef,
      recordTurnFailure: () => Effect.void,
      publishEvent: () => Effect.void,
      runTurn: (state) =>
        Ref.update(ranTurns, (ids) => [...ids, String(state.message.id)]).pipe(
          Effect.as(TurnOutcome.cases.Done.make({})),
        ),
    })
    const phase = inbox.phase
    const queue = TxSubscriptionRef.get(loopRef).pipe(Effect.map((s) => s.queue))
    const setPhase = (next: LoopState) => inbox.moveToPhase(next)
    return { worker, phase, queue, setPhase, ranTurns, turnWorkerQueue, gateRef }
  }).pipe(Effect.provide(memoryQueueStorage))

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
      expect((yield* harness.phase)._tag).toBe("Idle")
      expect((yield* harness.queue).inFlight).toBeUndefined()
    }),
  )

  it.effect("withdrawing the admitted turn promotes the next queued follow-up", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const second = queuedItem("second")
      const harness = yield* makeHarness(admitted(first, [second]))
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      expect(withdrawn).toBe(true)
      const state = yield* harness.phase
      expect(state._tag).toBe("Running")
      if (state._tag === "Running") expect(String(state.message.id)).toBe("second")
      expect((yield* harness.queue).followUp).toHaveLength(0)
    }),
  )

  it.effect("a message that is not the admitted turn is left alone", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness(admitted(first, []))
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(MessageId.make("other"))
      expect(withdrawn).toBe(false)
      expect((yield* harness.phase)._tag).toBe("Running")
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
      expect((yield* harness.phase)._tag).toBe("Running")
    }),
  )

  it.effect("a resumed turn without an in-flight marker is not withdrawn", () =>
    Effect.gen(function* () {
      const first = queuedItem("first")
      const harness = yield* makeHarness({
        state: buildRunningState(first, { startedAtMs: 1 }),
        queue: emptyLoopQueueState(),
      })
      const withdrawn = yield* harness.worker.withdrawAdmittedTurn(first.message.id)
      expect(withdrawn).toBe(false)
      expect((yield* harness.phase)._tag).toBe("Running")
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
      yield* harness.setPhase(buildIdleState())
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
      expect((yield* harness.phase)._tag).toBe("Idle")
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
      expect((yield* harness.phase)._tag).toBe("Idle")
      expect((yield* harness.queue).followUp).toHaveLength(0)
    }),
  )
})
