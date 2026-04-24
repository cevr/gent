import { Cause, Deferred, Effect, Exit, Queue, Ref, Semaphore } from "effect"
import type { Scope } from "effect"
import type { SessionId } from "../../../domain/ids.js"

interface SessionMailboxJob {
  readonly effect: Effect.Effect<void>
  readonly discard: Effect.Effect<void>
  readonly terminal: boolean
}

type TerminalDone = Deferred.Deferred<Exit.Exit<void>>
type TerminalClaim =
  | { readonly _tag: "owner"; readonly done: TerminalDone }
  | { readonly _tag: "existing"; readonly done: TerminalDone }

interface SessionMailboxSlot {
  readonly queue: Queue.Queue<SessionMailboxJob>
  readonly reentrantQueue: Ref.Ref<Array<SessionMailboxJob>>
  readonly priorityQueue: Ref.Ref<Array<SessionMailboxJob>>
  readonly closing: Ref.Ref<boolean>
  readonly terminalDone: Ref.Ref<TerminalDone | undefined>
  readonly workerFiberId: Ref.Ref<number>
}

export interface SessionMailbox {
  readonly submit: <A, E>(sessionId: SessionId, task: Effect.Effect<A, E>) => Effect.Effect<A, E>
  readonly post: (sessionId: SessionId, task: Effect.Effect<void>) => Effect.Effect<void>
  readonly terminate: (sessionId: SessionId, task: Effect.Effect<void>) => Effect.Effect<void>
  readonly isWorkerFiber: (sessionId: SessionId) => Effect.Effect<boolean>
  readonly shutdown: (sessionId: SessionId) => Effect.Effect<void>
}

export const makeSessionMailbox = (
  runtimeScope: Scope.Closeable,
): Effect.Effect<SessionMailbox, never> =>
  Effect.gen(function* () {
    const slotsRef = yield* Ref.make<Map<SessionId, SessionMailboxSlot>>(new Map())
    const semaphore = yield* Semaphore.make(1)

    const takeNextJobFromRef = (ref: Ref.Ref<Array<SessionMailboxJob>>) =>
      Ref.modify(ref, (jobs) => {
        const [next, ...rest] = jobs
        return [next, rest] as const
      })

    const takeNextJob = (slot: SessionMailboxSlot): Effect.Effect<SessionMailboxJob> =>
      Effect.gen(function* () {
        if (yield* Ref.get(slot.closing)) {
          const priority = yield* takeNextJobFromRef(slot.priorityQueue)
          if (priority !== undefined) return priority
        }

        const reentrant = yield* Ref.modify(slot.reentrantQueue, (jobs) => {
          const [next, ...rest] = jobs
          return [next, rest] as const
        })
        if (reentrant !== undefined) return reentrant

        const priority = yield* takeNextJobFromRef(slot.priorityQueue)
        if (priority !== undefined) return priority
        return yield* Queue.take(slot.queue)
      })

    const runJob = (sessionId: SessionId, job: SessionMailboxJob) =>
      job.effect.pipe(
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

    const discardJobs = (jobs: Iterable<SessionMailboxJob>) =>
      Effect.forEach(jobs, (job) => job.discard, { discard: true }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void
          return Effect.logWarning("extension.mailbox.discard.failed").pipe(
            Effect.annotateLogs({ error: String(Cause.squash(cause)) }),
          )
        }),
      )

    const removeSlot = (sessionId: SessionId, slot: SessionMailboxSlot) =>
      Ref.update(slotsRef, (current) => {
        if (current.get(sessionId) !== slot) return current
        const next = new Map(current)
        next.delete(sessionId)
        return next
      })

    const closeSlot = (sessionId: SessionId, slot: SessionMailboxSlot) =>
      Effect.gen(function* () {
        yield* Ref.set(slot.closing, true)
        const reentrant = yield* Ref.getAndSet(slot.reentrantQueue, [])
        const priority = yield* Ref.getAndSet(slot.priorityQueue, [])
        const queued = yield* Queue.clear(slot.queue)
        yield* discardJobs([...reentrant, ...priority, ...queued])
        yield* Queue.shutdown(slot.queue)
        yield* removeSlot(sessionId, slot)
      })

    const mailboxWorker = (sessionId: SessionId, slot: SessionMailboxSlot) =>
      Effect.gen(function* () {
        while (true) {
          const job = yield* takeNextJob(slot)
          yield* runJob(sessionId, job)
          if (job.terminal) {
            yield* closeSlot(sessionId, slot)
            return
          }
        }
      }).pipe(
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

          const queue = yield* Queue.unbounded<SessionMailboxJob>()
          const reentrantQueue = yield* Ref.make<Array<SessionMailboxJob>>([])
          const priorityQueue = yield* Ref.make<Array<SessionMailboxJob>>([])
          const closing = yield* Ref.make(false)
          const terminalDone = yield* Ref.make<TerminalDone | undefined>(undefined)
          const workerFiberId = yield* Ref.make(-1)
          const slot: SessionMailboxSlot = {
            queue,
            reentrantQueue,
            priorityQueue,
            closing,
            terminalDone,
            workerFiberId,
          }
          const worker = yield* Effect.forkIn(mailboxWorker(sessionId, slot), runtimeScope)
          yield* Ref.set(workerFiberId, worker.id)

          yield* Ref.update(slotsRef, (current) => {
            const next = new Map(current)
            next.set(sessionId, slot)
            return next
          })
          return slot
        }),
      )

    const getSlot = (sessionId: SessionId): Effect.Effect<SessionMailboxSlot | undefined> =>
      semaphore.withPermits(1)(Effect.map(Ref.get(slotsRef), (slots) => slots.get(sessionId)))

    const offerJob = (slot: SessionMailboxSlot, job: SessionMailboxJob) =>
      Effect.gen(function* () {
        if ((yield* Ref.get(slot.terminalDone)) !== undefined) {
          yield* job.discard
          return false
        }
        const offered = yield* Queue.offer(slot.queue, job)
        if (offered) return true
        yield* job.discard
        return false
      })

    const claimTerminal = (
      slot: SessionMailboxSlot,
      done: TerminalDone,
    ): Effect.Effect<TerminalClaim> =>
      Ref.modify(slot.terminalDone, (existing): readonly [TerminalClaim, TerminalDone] => {
        if (existing !== undefined) return [{ _tag: "existing" as const, done: existing }, existing]
        return [{ _tag: "owner" as const, done }, done]
      })

    const enqueueTerminalJob = (slot: SessionMailboxSlot, job: SessionMailboxJob) =>
      Effect.gen(function* () {
        yield* Ref.set(slot.closing, true)
        yield* Ref.update(slot.priorityQueue, (jobs) => [...jobs, job])
        const offered = yield* Queue.offer(slot.queue, {
          effect: Effect.void,
          discard: Effect.void,
          terminal: false,
        })
        if (!offered) yield* job.discard
      })

    const makeSubmitJob = <A, E>(
      task: Effect.Effect<A, E>,
      done: Deferred.Deferred<Exit.Exit<A, E>>,
    ): SessionMailboxJob => ({
      effect: Effect.exit(task).pipe(
        Effect.andThen((exit) => Deferred.succeed(done, exit)),
        Effect.asVoid,
      ),
      discard: Deferred.interrupt(done).pipe(Effect.asVoid),
      terminal: false,
    })

    const submit: SessionMailbox["submit"] = <A, E>(
      sessionId: SessionId,
      task: Effect.Effect<A, E>,
    ) =>
      Effect.gen(function* () {
        const slot = yield* ensureSlot(sessionId)
        if ((yield* Effect.fiberId) === (yield* Ref.get(slot.workerFiberId))) {
          return yield* task
        }

        const done = yield* Deferred.make<Exit.Exit<A, E>>()
        yield* offerJob(slot, makeSubmitJob(task, done))
        const exit = yield* Deferred.await(done)
        return yield* Exit.match(exit, {
          onSuccess: Effect.succeed,
          onFailure: Effect.failCause,
        })
      })

    const post: SessionMailbox["post"] = (sessionId, task) =>
      Effect.gen(function* () {
        const slot = yield* ensureSlot(sessionId)
        if ((yield* Effect.fiberId) === (yield* Ref.get(slot.workerFiberId))) {
          if ((yield* Ref.get(slot.terminalDone)) !== undefined) return
          yield* Ref.update(slot.reentrantQueue, (jobs) => [
            ...jobs,
            { effect: task, discard: Effect.void, terminal: false },
          ])
          return
        }
        yield* offerJob(slot, { effect: task, discard: Effect.void, terminal: false })
      })

    const terminate: SessionMailbox["terminate"] = (sessionId, task) =>
      Effect.gen(function* () {
        const slot = yield* getSlot(sessionId)
        if (slot === undefined) {
          yield* task
          return
        }

        const done = yield* Deferred.make<Exit.Exit<void>>()
        const claim = yield* claimTerminal(slot, done)
        if (claim._tag === "existing") {
          const exit = yield* Deferred.await(claim.done)
          return yield* Exit.match(exit, {
            onSuccess: Effect.succeed,
            onFailure: Effect.failCause,
          })
        }

        const job: SessionMailboxJob = {
          effect: Effect.exit(task).pipe(
            Effect.andThen((exit) => Deferred.succeed(done, exit)),
            Effect.asVoid,
          ),
          discard: Deferred.interrupt(done).pipe(Effect.asVoid),
          terminal: true,
        }

        if ((yield* Effect.fiberId) === (yield* Ref.get(slot.workerFiberId))) {
          yield* runJob(sessionId, job)
          yield* closeSlot(sessionId, slot)
        } else {
          yield* enqueueTerminalJob(slot, job)
        }

        const exit = yield* Deferred.await(done)
        return yield* Exit.match(exit, {
          onSuccess: Effect.succeed,
          onFailure: Effect.failCause,
        })
      })

    const isWorkerFiber: SessionMailbox["isWorkerFiber"] = (sessionId) =>
      Effect.gen(function* () {
        const slot = yield* ensureSlot(sessionId)
        return (yield* Effect.fiberId) === (yield* Ref.get(slot.workerFiberId))
      })

    const shutdown: SessionMailbox["shutdown"] = (sessionId) =>
      Effect.gen(function* () {
        const slot = (yield* Ref.get(slotsRef)).get(sessionId)
        if (slot === undefined) return
        yield* closeSlot(sessionId, slot)
      })

    return { submit, post, terminate, isWorkerFiber, shutdown }
  })
