/**
 * ActorEngine — actor host with optional persistence.
 *
 * Each `spawn(behavior)` allocates a `Mailbox<M>` (Queue.unbounded),
 * forks a fiber that runs the behavior's `receive` loop, and returns
 * a typed `ActorRef<M>`. `tell` enqueues a message; `ask` correlates a
 * one-shot reply via `Deferred<A>` plus a per-correlation `reply` shim
 * attached to the `ActorContext` for the duration of one `receive`.
 *
 * Supervision policy in the receive loop:
 *   - interrupts propagate (scope close is tearing the actor down).
 *   - typed failures: log + continue, state survives the transient
 *     crash because the loop re-reads `Ref<S>` on the next iteration.
 *   - defects (`Effect.die`): log + escalate, killing the fiber so the
 *     absence is observable to ask callers.
 *
 * Persistence is opt-in per `Behavior.persistence`:
 *   - `snapshot()` walks every live durable actor and returns a
 *     `Map<key, encodedState>`. Encode failures surface as
 *     `ActorSnapshotError`; the caller decides skip-vs-abort.
 *   - `spawn(b, { restoredState })` decodes via `persistence.state`
 *     and uses the decoded value in place of `initialState`. Decode
 *     failures surface as `ActorRestoreError`.
 *   - Two durable behaviors with the same `persistence.key` in one
 *     engine fail with `ActorPersistenceKeyCollision` at spawn.
 *   - Mailboxes are NOT captured (peers re-tell on resume).
 *   - `snapshot()` is unsynchronized; cross-actor atomicity is the
 *     caller's contract (invoke at a quiescent point).
 *
 * `find` / `subscribe` on `ActorContext` are stubs here (empty / never).
 * The Receptionist wires them in.
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
  ActorPersistenceKeyCollision,
  ActorRestoreError,
  ActorSnapshotError,
  type ActorContext,
  type ActorRef,
  type Behavior,
  type JsonValueT,
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
   * Returns `undefined` for ephemeral actors (no `persistence`).
   * Encode failures surface as `ActorSnapshotError` so the checkpoint
   * caller decides skip-vs-abort.
   */
  readonly snapshot: () => Effect.Effect<
    { readonly persistenceKey: string; readonly state: JsonValueT } | undefined,
    ActorSnapshotError
  >
}

/**
 * Encoded snapshot of all durable actors in the engine. Keys are
 * `Behavior.persistence.key`; values are the result of encoding `S`
 * through `persistence.state`. Ephemeral actors (no `persistence`)
 * are omitted. Values are JSON-typed so the snapshot map round-trips
 * through any standard transport.
 */
export type ActorSnapshot = ReadonlyMap<string, JsonValueT>

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
   * decodes via `behavior.persistence.state` and uses the decoded value
   * in place of `behavior.initialState`. No-op when the behavior is
   * ephemeral or `restoredState` is `undefined`.
   */
  readonly restoredState?: JsonValueT
}

export interface ActorEngineService {
  readonly spawn: <M, S>(
    behavior: Behavior<M, S, never>,
    options?: SpawnOptions,
  ) => Effect.Effect<ActorRef<M>, ActorRestoreError | ActorPersistenceKeyCollision>
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
   * Encode failures surface as `ActorSnapshotError` — the checkpoint
   * caller decides whether to skip the offending actor or abort.
   *
   * **Quiescence contract**: callers must invoke at a point where no
   * `receive` is in flight (e.g. between agent-loop turns). The engine
   * does not lock during snapshot — cross-actor atomicity is the
   * caller's responsibility.
   */
  readonly snapshot: () => Effect.Effect<ActorSnapshot, ActorSnapshotError>
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
        // Persistence keys claimed by live durable actors. Spawn-time
        // collision check rejects double-claims (silent overwrite is
        // data corruption — see ActorPersistenceKeyCollision).
        const claimedPersistenceKeys = yield* Ref.make<Set<string>>(new Set())

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
        ): Effect.Effect<ActorRef<M>, ActorRestoreError | ActorPersistenceKeyCollision> =>
          Effect.gen(function* () {
            const persistence = behavior.persistence
            if (persistence !== undefined) {
              const claimed = yield* Ref.get(claimedPersistenceKeys)
              if (claimed.has(persistence.key)) {
                return yield* new ActorPersistenceKeyCollision({
                  persistenceKey: persistence.key,
                })
              }
              yield* Ref.update(claimedPersistenceKeys, (s) => new Set(s).add(persistence.key))
            }

            const id = Schema.decodeUnknownSync(ActorId)(crypto.randomUUID())
            const ref: ActorRef<M> = { _tag: "ActorRef", id }
            const queue = yield* Queue.unbounded<EnvelopedMessage>()

            const initial: S =
              options?.restoredState !== undefined && persistence !== undefined
                ? yield* Schema.decodeUnknownEffect(persistence.state)(options.restoredState).pipe(
                    Effect.mapError(
                      (cause) => new ActorRestoreError({ persistenceKey: persistence.key, cause }),
                    ),
                  )
                : behavior.initialState
            const stateRef = yield* Ref.make<S>(initial)

            const snapshotForActor: MailboxEntry["snapshot"] = () =>
              Effect.gen(function* () {
                if (persistence === undefined) return undefined
                const current = yield* Ref.get(stateRef)
                const encoded = yield* Schema.encodeUnknownEffect(persistence.state)(current).pipe(
                  Effect.mapError(
                    (cause) => new ActorSnapshotError({ persistenceKey: persistence.key, cause }),
                  ),
                )
                return { persistenceKey: persistence.key, state: encoded }
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

            // Interrupts propagate so scope close ends the loop. Typed
            // failures log + continue (state survives via Ref). Defects
            // log + escalate so the fiber dies — subsequent asks observe
            // ActorAskTimeout instead of silently hanging.
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

            // On fiber exit (interrupt or defect): drop the mailbox entry
            // and free the persistence-key claim so a redeploy of the
            // same key in this engine is allowed.
            const cleanup = Effect.gen(function* () {
              yield* Ref.update(mailboxes, (m) => {
                const next = new Map(m)
                next.delete(id)
                return next
              })
              if (persistence !== undefined) {
                yield* Ref.update(claimedPersistenceKeys, (s) => {
                  const next = new Set(s)
                  next.delete(persistence.key)
                  return next
                })
              }
            })

            yield* Effect.forkIn(loop.pipe(Effect.ensuring(cleanup)), runtimeScope)
            return ref
          })

        const snapshot = (): Effect.Effect<ActorSnapshot, ActorSnapshotError> =>
          Effect.gen(function* () {
            const live = yield* Ref.get(mailboxes)
            const out = new Map<string, JsonValueT>()
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
