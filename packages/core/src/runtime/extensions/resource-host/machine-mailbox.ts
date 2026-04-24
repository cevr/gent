import { Cause, Deferred, Effect, Exit, Queue, Ref, Semaphore } from "effect"
import type { Scope } from "effect"
import type { SessionId } from "../../../domain/ids.js"

interface SessionMailboxSlot {
  readonly queue: Queue.Queue<Effect.Effect<void>>
  readonly reentrantQueue: Ref.Ref<Array<Effect.Effect<void>>>
  readonly workerFiberId: number
}

export interface SessionMailbox {
  readonly submit: <A, E>(sessionId: SessionId, task: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly post: (sessionId: SessionId, task: Effect.Effect<void>) => Effect.Effect<void>
  readonly isWorkerFiber: (sessionId: SessionId) => Effect.Effect<boolean>
  readonly shutdown: (sessionId: SessionId) => Effect.Effect<void>
}

export const makeSessionMailbox = (
  runtimeScope: Scope.Closeable,
): Effect.Effect<SessionMailbox, never> =>
  Effect.gen(function* () {
    const slotsRef = yield* Ref.make<Map<SessionId, SessionMailboxSlot>>(new Map())
    const semaphore = yield* Semaphore.make(1)

    const takeNextJob = (slot: SessionMailboxSlot): Effect.Effect<Effect.Effect<void>> =>
      Ref.modify(slot.reentrantQueue, (jobs) => {
        const [next, ...rest] = jobs
        return [next, rest] as const
      }).pipe(
        Effect.flatMap((reentrant) =>
          reentrant === undefined ? Queue.take(slot.queue) : Effect.succeed(reentrant),
        ),
      )

    const runJob = (sessionId: SessionId, job: Effect.Effect<void>) =>
      job.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          return Effect.logWarning("extension.mailbox.job.failed").pipe(
            Effect.annotateLogs({
              sessionId,
              error: String(Cause.squash(cause)),
            }),
          )
        }),
      )

    const mailboxWorker = (sessionId: SessionId, slot: SessionMailboxSlot) =>
      Effect.forever(takeNextJob(slot).pipe(Effect.flatMap((job) => runJob(sessionId, job)))).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void
          return Effect.logWarning("extension.mailbox.worker.failed").pipe(
            Effect.annotateLogs({
              sessionId,
              error: String(Cause.squash(cause)),
            }),
          )
        }),
      )

    const ensureSlot = (sessionId: SessionId): Effect.Effect<SessionMailboxSlot> =>
      semaphore.withPermits(1)(
        Effect.gen(function* () {
          const existing = (yield* Ref.get(slotsRef)).get(sessionId)
          if (existing !== undefined) return existing

          const queue = yield* Queue.unbounded<Effect.Effect<void>>()
          const reentrantQueue = yield* Ref.make<Array<Effect.Effect<void>>>([])
          const slot: SessionMailboxSlot = {
            queue,
            reentrantQueue,
            workerFiberId: -1,
          }
          const worker = yield* Effect.forkIn(mailboxWorker(sessionId, slot), runtimeScope)
          const liveSlot: SessionMailboxSlot = { ...slot, workerFiberId: worker.id }

          yield* Ref.update(slotsRef, (current) => {
            const next = new Map(current)
            next.set(sessionId, liveSlot)
            return next
          })
          return liveSlot
        }),
      )

    const submit: SessionMailbox["submit"] = <A, E>(
      sessionId: SessionId,
      task: Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const slot = yield* ensureSlot(sessionId)
        if ((yield* Effect.fiberId) === slot.workerFiberId) {
          return yield* task
        }

        const done = yield* Deferred.make<Exit.Exit<A, E>>()
        yield* Queue.offer(
          slot.queue,
          Effect.exit(task).pipe(
            Effect.andThen((exit) => Deferred.succeed(done, exit)),
            Effect.asVoid,
          ),
        )
        const exit = yield* Deferred.await(done)
        return yield* Exit.match(exit, {
          onSuccess: Effect.succeed,
          onFailure: Effect.failCause,
        })
      })

    const post: SessionMailbox["post"] = (sessionId, task) =>
      Effect.gen(function* () {
        const slot = yield* ensureSlot(sessionId)
        if ((yield* Effect.fiberId) === slot.workerFiberId) {
          yield* Ref.update(slot.reentrantQueue, (jobs) => [...jobs, task])
          return
        }
        yield* Queue.offer(slot.queue, task)
      })

    const isWorkerFiber: SessionMailbox["isWorkerFiber"] = (sessionId) =>
      Effect.gen(function* () {
        const slot = yield* ensureSlot(sessionId)
        return (yield* Effect.fiberId) === slot.workerFiberId
      })

    const shutdown: SessionMailbox["shutdown"] = (sessionId) =>
      Effect.gen(function* () {
        const slot = (yield* Ref.get(slotsRef)).get(sessionId)
        if (slot === undefined) return
        yield* Queue.shutdown(slot.queue)
        yield* Ref.update(slotsRef, (current) => {
          const next = new Map(current)
          next.delete(sessionId)
          return next
        })
      })

    return { submit, post, isWorkerFiber, shutdown }
  })
