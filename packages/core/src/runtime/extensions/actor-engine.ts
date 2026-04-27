/**
 * ActorEngine — W9-2 + W9-4 (snapshot/restore).
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
 * Persistence (W9-4): a `Behavior` is durable iff it sets both
 * `persistenceKey` and `state`. `snapshot()` walks every live
 * durable actor and returns `{ persistenceKey: encodedState }` —
 * mailboxes are NOT captured (peers re-tell on resume). `spawn` takes
 * an optional `restoredState` (encoded form) which the engine decodes
 * via the behavior's `state` schema and uses in place of
 * `initialState`. Wiring into the agent-loop checkpoint surface and
 * loader is W9-5's responsibility.
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
  Exit,
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
  /**
   * Snapshot the actor's current state into the engine-erased form.
   * Returns `undefined` for ephemeral actors (no persistenceKey or
   * no state schema). The persistenceKey is the map slot the
   * snapshot belongs in.
   */
  readonly snapshot: () => Effect.Effect<
    { readonly persistenceKey: string; readonly state: unknown } | undefined
  >
}

/**
 * Encoded snapshot of all durable actors in the engine. Keys are
 * `Behavior.persistenceKey`; values are the result of encoding `S`
 * through the behavior's `state` schema. Ephemeral actors (no
 * persistenceKey / no state schema) are omitted.
 */
export type ActorSnapshot = ReadonlyMap<string, unknown>

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

export interface SpawnOptions {
  /**
   * Previously-snapshotted encoded state for this behavior. The engine
   * decodes via `behavior.state` and uses the decoded value in place
   * of `behavior.initialState`. No-op when the behavior is ephemeral
   * or `restoredState` is `undefined`.
   */
  readonly restoredState?: unknown
}

export interface ActorEngineService {
  readonly spawn: <M, S>(
    behavior: Behavior<M, S, never>,
    options?: SpawnOptions,
  ) => Effect.Effect<ActorRef<M>>
  readonly tell: <M>(target: ActorRef<M>, msg: M) => Effect.Effect<void>
  readonly ask: <M, A>(
    target: ActorRef<M>,
    msg: M,
    replyKey: (a: A) => M,
    options?: { askMs?: number },
  ) => Effect.Effect<A, ActorAskTimeout>
  /**
   * Encoded snapshot of every live durable actor's current state.
   * Ephemeral actors are omitted; mailboxes are not captured.
   */
  readonly snapshot: () => Effect.Effect<ActorSnapshot>
}

export class ActorEngine extends Context.Service<ActorEngine, ActorEngineService>()(
  "@gent/core/src/runtime/extensions/actor-engine/ActorEngine",
) {
  static Live: Layer.Layer<ActorEngine> = Layer.effect(
    ActorEngine,
    Effect.acquireRelease(
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
            const cleanup = Ref.update(pendingAsks, (m) => {
              const next = new Map(m)
              next.delete(askId)
              return next
            })
            const askMs = options?.askMs ?? DEFAULT_ASK_MS
            // Bracket the ask so cleanup runs even if interruption lands
            // between registration and await — closes the leak window
            // where pendingAsks could accumulate dead entries.
            return yield* Effect.acquireUseRelease(
              Effect.gen(function* () {
                yield* Ref.update(pendingAsks, (m) => new Map(m).set(askId, { resolve }))
                yield* entry.offer({ msg, askId })
              }),
              () =>
                Deferred.await(deferred).pipe(
                  Effect.timeoutOrElse({
                    duration: Duration.millis(askMs),
                    orElse: () => Effect.fail(new ActorAskTimeout({ actorId: target.id, askMs })),
                  }),
                ),
              () => cleanup,
            )
          })

        const spawn = <M, S>(
          behavior: Behavior<M, S, never>,
          options?: SpawnOptions,
        ): Effect.Effect<ActorRef<M>> =>
          Effect.gen(function* () {
            const id = Schema.decodeUnknownSync(ActorId)(crypto.randomUUID())
            const ref: ActorRef<M> = { _tag: "ActorRef", id }
            const queue = yield* Queue.unbounded<EnvelopedMessage>()

            // Restore from prior snapshot if both the behavior is
            // durable and a restoredState was provided. Decode failure
            // is fatal — the snapshot was written by a prior run of
            // this same behavior, so a schema mismatch is a real
            // migration problem the caller must surface.
            const initial: S =
              options?.restoredState !== undefined && behavior.state !== undefined
                ? yield* Schema.decodeUnknownEffect(behavior.state)(options.restoredState).pipe(
                    Effect.orDie,
                  )
                : behavior.initialState
            const stateRef = yield* Ref.make<S>(initial)

            const persistenceKey = behavior.persistenceKey
            const stateSchema = behavior.state
            const snapshotForActor: MailboxEntry["snapshot"] = () =>
              Effect.gen(function* () {
                if (persistenceKey === undefined || stateSchema === undefined) return undefined
                const current = yield* Ref.get(stateRef)
                const encoded = yield* Schema.encodeUnknownEffect(stateSchema)(current).pipe(
                  Effect.orDie,
                )
                return { persistenceKey, state: encoded }
              })

            const entry: MailboxEntry = {
              id,
              offer: (env) => Effect.asVoid(Queue.offer(queue, env)),
              snapshot: snapshotForActor,
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

            // Supervision policy:
            //   - interrupts: propagate (scope close is tearing us down)
            //   - defects (Cause.Die): escalate — programming error, kill
            //     the actor so its absence is observable to ask callers
            //     and persistence layers (W9-4)
            //   - typed failures: log + continue, state survives
            const loop: Effect.Effect<void, never> = step.pipe(
              Effect.catchCause((cause: Cause.Cause<never>) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
                if (Cause.hasDies(cause)) {
                  return Effect.logError("actor.receive.defect").pipe(
                    Effect.annotateLogs({ actorId: id, defect: String(Cause.squash(cause)) }),
                    Effect.andThen(Effect.failCause(cause)),
                  )
                }
                return Effect.logWarning("actor.receive.failed").pipe(
                  Effect.annotateLogs({ actorId: id, error: String(Cause.squash(cause)) }),
                )
              }),
              Effect.forever,
            )

            yield* Effect.forkIn(loop, runtimeScope)
            return ref
          })

        const snapshot = (): Effect.Effect<ActorSnapshot> =>
          Effect.gen(function* () {
            const live = yield* Ref.get(mailboxes)
            const out = new Map<string, unknown>()
            for (const entry of live.values()) {
              const dump = yield* entry.snapshot()
              if (dump !== undefined) out.set(dump.persistenceKey, dump.state)
            }
            return out
          })

        return {
          runtimeScope,
          service: { spawn, tell, ask, snapshot } satisfies ActorEngineService,
        }
      }),
      ({ runtimeScope }) => Scope.close(runtimeScope, Exit.void),
    ).pipe(Effect.map(({ service }) => service)),
  )
}
