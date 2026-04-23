import { Cause, Deferred, Effect, Queue, Ref, Semaphore } from "effect"
import type { Scope } from "effect"
import type { SessionId } from "../../../domain/ids.js"

interface SessionMailboxSlot {
  readonly queue: Queue.Queue<Effect.Effect<void>>
  readonly workerFiberId: number
}

export interface SessionMailbox {
  readonly submit: <A, E>(sessionId: SessionId, task: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly shutdown: (sessionId: SessionId) => Effect.Effect<void>
}

export const makeSessionMailbox = (
  runtimeScope: Scope.Closeable,
): Effect.Effect<SessionMailbox, never> =>
  Effect.gen(function* () {
    const slotsRef = yield* Ref.make<Map<SessionId, SessionMailboxSlot>>(new Map())
    const semaphore = yield* Semaphore.make(1)

    const mailboxWorker = (sessionId: SessionId, queue: Queue.Queue<Effect.Effect<void>>) =>
      Effect.forever(Queue.take(queue).pipe(Effect.flatMap((job) => job))).pipe(
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
          const worker = yield* Effect.forkIn(mailboxWorker(sessionId, queue), runtimeScope)
          const slot: SessionMailboxSlot = { queue, workerFiberId: worker.id }

          yield* Ref.update(slotsRef, (current) => {
            const next = new Map(current)
            next.set(sessionId, slot)
            return next
          })
          return slot
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

        const done = yield* Deferred.make<A, E>()
        yield* Queue.offer(slot.queue, Deferred.completeWith(done, task).pipe(Effect.asVoid))
        return yield* Deferred.await(done)
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

    return { submit, shutdown }
  })
