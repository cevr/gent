import { Cause, Context, Deferred, Effect, Exit, Queue, Ref, Semaphore } from "effect"
import type { Scope } from "effect"
import type { SessionId } from "../../../domain/ids.js"

interface SessionMailboxSlot {
  readonly queue: Queue.Queue<Effect.Effect<void>>
}

const CurrentMailboxSession = Context.Reference<SessionId | undefined>(
  "@gent/core/src/runtime/extensions/resource-host/machine-mailbox/CurrentMailboxSession",
  { defaultValue: () => undefined },
)

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
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((job) => job),
          Effect.provideService(CurrentMailboxSession, sessionId),
        ),
      ).pipe(
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
          yield* Effect.forkIn(mailboxWorker(sessionId, queue), runtimeScope)
          const slot: SessionMailboxSlot = { queue }

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
        if ((yield* CurrentMailboxSession) === sessionId) {
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
