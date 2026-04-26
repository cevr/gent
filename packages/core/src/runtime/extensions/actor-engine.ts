/**
 * ActorEngine — W9-2.
 *
 * Hosts actors declared by extensions. Each `spawn(behavior)` allocates
 * a `Mailbox<M>` (Queue.unbounded), forks a fiber that runs the
 * behavior's `receive` loop, and returns a typed `ActorRef<M>`. `tell`
 * enqueues a message; `ask` correlates a one-shot reply via
 * `Deferred<A>` plus a per-correlation `reply` shim attached to the
 * `ActorContext` for the duration of that one `receive`.
 *
 * Supervision: the receive loop is wrapped in `Effect.catchAllCause`
 * — interrupts propagate (the actor is being torn down by scope
 * close), all other failures restart the loop with the *current*
 * `Ref<S>` (state survives a transient crash). Successful `receive`
 * returns a new S; failed receives keep the prior S. Defects
 * (`Effect.die`) escalate by interrupting the actor's fiber.
 *
 * `find` / `subscribe` are wired through Receptionist (W9-3). For
 * W9-2, they return empty / never to keep the surface complete.
 */

import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  Layer,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  ActorAskTimeout,
  type ActorContext,
  type ActorRef,
  type Behavior,
  type ServiceKey,
} from "../../domain/actor.js"
import { ActorId } from "../../domain/ids.js"

/**
 * Default ask deadline. Mirrors the FSM-era 5s default before
 * `ActorAskTimeout` was a typed error; tunable per-call later.
 */
export const DEFAULT_ASK_MS = 5_000

interface MailboxEntry {
  readonly id: ActorId
  readonly offer: (env: EnvelopedMessage) => Effect.Effect<void>
}

/**
 * Engine-internal envelope. `askId`, when present, ties the message
 * to a pending `Deferred<A>` in `pendingAsks`. The behavior's
 * `receive` is invoked with the bare `msg`; the engine threads
 * `askId` through the per-receive `ActorContext.reply`.
 */
interface EnvelopedMessage {
  readonly msg: unknown
  readonly askId?: string
}

interface PendingAsk {
  /** Erased succeed — the asker created the Deferred, only it knows A. */
  readonly resolve: (answer: unknown) => Effect.Effect<void>
}

export interface ActorEngineService {
  readonly spawn: <M, S>(behavior: Behavior<M, S, never>) => Effect.Effect<ActorRef<M>>
  readonly tell: <M>(target: ActorRef<M>, msg: M) => Effect.Effect<void>
  readonly ask: <M, A>(
    target: ActorRef<M>,
    msg: M,
    replyKey: (a: A) => M,
    options?: { askMs?: number },
  ) => Effect.Effect<A, ActorAskTimeout>
}

export class ActorEngine extends Context.Service<ActorEngine, ActorEngineService>()(
  "@gent/core/src/runtime/extensions/actor-engine/ActorEngine",
) {
  static Live: Layer.Layer<ActorEngine> = Layer.effect(
    ActorEngine,
    Effect.gen(function* () {
      const runtimeScope = yield* Scope.make()
      const mailboxes = yield* Ref.make<Map<string, MailboxEntry>>(new Map())
      const pendingAsks = yield* Ref.make<Map<string, PendingAsk>>(new Map())

      const lookup = (id: ActorId): Effect.Effect<MailboxEntry | undefined> =>
        Ref.get(mailboxes).pipe(Effect.map((m) => m.get(id)))

      const tell = <M>(target: ActorRef<M>, msg: M): Effect.Effect<void> =>
        Effect.gen(function* () {
          const entry = yield* lookup(target.id)
          if (entry === undefined) return
          yield* entry.offer({ msg })
        })

      const ask = <M, A>(
        target: ActorRef<M>,
        msg: M,
        _replyKey: (a: A) => M,
        options?: { askMs?: number },
      ): Effect.Effect<A, ActorAskTimeout> =>
        Effect.gen(function* () {
          const entry = yield* lookup(target.id)
          if (entry === undefined) {
            return yield* new ActorAskTimeout({
              actorId: target.id,
              askMs: options?.askMs ?? DEFAULT_ASK_MS,
            })
          }
          const askId = crypto.randomUUID()
          const deferred = yield* Deferred.make<A, ActorAskTimeout>()
          const resolve = (answer: unknown): Effect.Effect<void> =>
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type-erased ask correlation; A pinned by replyKey at the call site
            Effect.asVoid(Deferred.succeed(deferred, answer as A))
          yield* Ref.update(pendingAsks, (m) => new Map(m).set(askId, { resolve }))
          yield* entry.offer({ msg, askId })
          const askMs = options?.askMs ?? DEFAULT_ASK_MS
          return yield* Deferred.await(deferred).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(askMs),
              orElse: () => Effect.fail(new ActorAskTimeout({ actorId: target.id, askMs })),
            }),
            Effect.ensuring(
              Ref.update(pendingAsks, (m) => {
                const next = new Map(m)
                next.delete(askId)
                return next
              }),
            ),
          )
        })

      const spawn = <M, S>(behavior: Behavior<M, S, never>): Effect.Effect<ActorRef<M>> =>
        Effect.gen(function* () {
          const id = Schema.decodeUnknownSync(ActorId)(crypto.randomUUID())
          const ref: ActorRef<M> = { _tag: "ActorRef", id }
          const queue = yield* Queue.unbounded<EnvelopedMessage>()
          const stateRef = yield* Ref.make<S>(behavior.initialState)

          const entry: MailboxEntry = {
            id,
            offer: (env) => Effect.asVoid(Queue.offer(queue, env)),
          }
          yield* Ref.update(mailboxes, (m) => new Map(m).set(id, entry))

          const replyFor =
            (askId: string | undefined): ActorContext<M>["reply"] =>
            (answer: unknown): Effect.Effect<void> =>
              Effect.gen(function* () {
                if (askId === undefined) return
                const pending = yield* Ref.get(pendingAsks).pipe(Effect.map((m) => m.get(askId)))
                if (pending === undefined) return
                yield* pending.resolve(answer)
              })

          const ctxFor = (askId: string | undefined): ActorContext<M> => ({
            self: ref,
            tell: <N>(target: ActorRef<N>, msg: N) => tell(target, msg),
            ask: <N, A>(target: ActorRef<N>, msg: N, replyKey: (a: A) => N) =>
              ask(target, msg, replyKey),
            reply: replyFor(askId),
            find: <N>(_key: ServiceKey<N>): Effect.Effect<ReadonlyArray<ActorRef<N>>> =>
              Effect.succeed([]),
            subscribe: <N>(_key: ServiceKey<N>): Stream.Stream<ActorRef<N>> => Stream.never,
          })

          // The mailbox stores envelopes typed as `unknown msg`. The
          // behavior's M is fixed at spawn time, so the message that
          // arrives is by construction an M. The cast widens unknown
          // → M; type safety is preserved by the spawn-time type
          // parameter on `Behavior<M, S>`.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type-erased mailbox storage; M pinned at spawn time
          const receiveMsg = (msg: unknown): M => msg as M

          const step = Effect.gen(function* () {
            const env = yield* Queue.take(queue)
            const state = yield* Ref.get(stateRef)
            const next = yield* behavior.receive(receiveMsg(env.msg), state, ctxFor(env.askId))
            yield* Ref.set(stateRef, next)
          })

          const loop: Effect.Effect<void, never> = step.pipe(
            Effect.catchCause((cause: Cause.Cause<never>) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
              return Effect.logWarning("actor.receive.failed").pipe(
                Effect.annotateLogs({ actorId: id, error: String(Cause.squash(cause)) }),
              )
            }),
            Effect.forever,
          )

          yield* Effect.forkIn(loop, runtimeScope)
          return ref
        })

      return { spawn, tell, ask }
    }),
  )
}
