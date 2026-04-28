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
 *     crash because the loop re-reads `SubscriptionRef<S>` on the next iteration.
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
 *   - `snapshot()` is per-actor synchronized via the same per-instance
 *     semaphore that gates `receive`, so each row is the post-state of
 *     a completed message. Cross-actor atomicity is still the caller's
 *     contract: a snapshot iterating multiple actors does not freeze
 *     the engine, so two actors can advance independently between rows.
 *
 * Discovery: spawn auto-registers behaviors that declare a
 * `serviceKey` with the Receptionist; the per-actor `ActorContext`
 * forwards `find` / `subscribe` to the same registry. Cleanup
 * unregisters the ref when the actor's fiber exits, so dead refs do
 * not leak into discovery results.
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
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import {
  ActorAskTimeout,
  ActorPersistenceKeyCollision,
  ActorRestoreError,
  ActorSnapshotError,
  type ActorContext,
  type ActorRef,
  type ActorView,
  type Behavior,
  type JsonValueT,
  type ServiceKey,
} from "../../domain/actor.js"
import type { AskBranded, ExtractAskReply } from "../../domain/schema-tagged-enum-class.js"
import { ActorId } from "../../domain/ids.js"
import { Receptionist } from "./receptionist.js"

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
   *
   * Quiescence: implementations of durable actors run inside the
   * actor's per-instance semaphore, so a snapshot cannot interleave
   * with an in-flight `receive`. The encoded value is therefore the
   * post-state of whatever message most recently completed.
   */
  readonly snapshot: () => Effect.Effect<
    { readonly persistenceKey: string; readonly state: JsonValueT } | undefined,
    ActorSnapshotError
  >
  /**
   * Live changes-stream of this actor's state. Emits the current
   * state on subscribe, then on every change. Consecutive duplicates
   * are deduped. Engine-erased to `unknown` at the mailbox seam; the
   * concrete `S` is pinned by the caller's `Behavior<M, S>`.
   */
  readonly subscribeState: () => Stream.Stream<unknown>
  /**
   * Sample the actor's `behavior.view(state)` once. Returns
   * `undefined` when the spawned behavior did not declare a `view`
   * (most actors don't — only the ones that contribute to prompt
   * assembly). The mailbox owns both the live `S` and the
   * `view` closure captured at spawn time, so this is the only
   * surface that can pair them; callers outside the engine can't
   * because `ActorRef<M>` does not carry `S` or `view`.
   *
   * Quiescence: the read acquires the same per-actor permit as
   * `receive` and `snapshot`, so the sampled state is the post-state
   * of whatever message most recently completed — never an in-flight
   * `receive` mid-step.
   */
  readonly peekView: () => Effect.Effect<ActorView | undefined>
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
  ) => Effect.Effect<ActorRef<M, S>, ActorRestoreError | ActorPersistenceKeyCollision>
  readonly tell: <M>(target: ActorRef<M>, msg: M) => Effect.Effect<void>
  /**
   * Ask-correlated send. The reply type is inferred from the message's
   * `AskBranded<Reply>` brand attached by `TaggedEnumClass.askVariant<R>()`.
   * Tell-only variants do not carry the brand and are rejected at the type
   * level. The runtime channel is the same as before (per-correlation
   * `Deferred` plus a per-receive `reply` shim) — only the type signature
   * changed.
   */
  readonly ask: <M, ReplyMsg extends M & AskBranded<unknown>>(
    target: ActorRef<M>,
    msg: ReplyMsg,
    options?: { askMs?: number },
  ) => Effect.Effect<ExtractAskReply<ReplyMsg>, ActorAskTimeout>
  /**
   * Encoded snapshot of every live durable actor's current state.
   * Ephemeral actors are omitted; mailboxes are not captured.
   * Encode failures surface as `ActorSnapshotError` — the checkpoint
   * caller decides whether to skip the offending actor or abort.
   *
   * Each row is per-actor synchronized: the engine acquires that
   * actor's permit before reading its `Ref`, so the row is the
   * post-state of whatever `receive` most recently completed. Cross-
   * actor atomicity is NOT provided — two actors can advance between
   * rows of the same snapshot. Callers needing a globally-consistent
   * cut must invoke at a quiescent point (e.g. between agent-loop turns).
   */
  readonly snapshot: () => Effect.Effect<ActorSnapshot, ActorSnapshotError>
  /**
   * Live changes-stream of the target actor's state. Emits the
   * current `S` on subscribe, then on every change. Consecutive
   * duplicates are deduped via `Stream.changes`. Returns
   * `Stream.empty` for unknown refs (mirrors `tell` semantics).
   *
   * `S` is carried on `ActorRef<M, S>` — a ref returned by
   * `spawn(behavior)` pins the spawn-time state type, so the returned
   * stream is `Stream<S>`. Discovery surfaces (`find` / `subscribe`)
   * only know `M`, so refs sourced from them keep `S = unknown` and
   * the caller narrows at the consumption seam (typically by `_tag`).
   */
  readonly subscribeState: <M, S>(target: ActorRef<M, S>) => Stream.Stream<S>
  /**
   * Sample the target actor's `behavior.view(state)` once. Returns
   * `undefined` for unknown refs (mirrors `tell` no-op semantics) or
   * for behaviors that did not declare a `view`. Used by prompt
   * assembly to fold actor-derived prompt sections + tool policy
   * fragments into the per-turn prompt evaluation without a round-trip
   * through `ask`.
   */
  readonly peekView: <M>(target: ActorRef<M>) => Effect.Effect<ActorView | undefined>
}

export class ActorEngine extends Context.Service<ActorEngine, ActorEngineService>()(
  "@gent/core/src/runtime/extensions/actor-engine/ActorEngine",
) {
  // Composes `Receptionist.Live` and re-exposes it via provideMerge so
  // downstream layers (`ActorHost`) and external callers share the
  // same registry instance the engine writes into. Scope-close order
  // is load-bearing: the engine's `acquireRelease` finalizer runs
  // before Receptionist's scope close, so per-actor cleanup fibers
  // can still call `receptionist.unregister` while the registry is
  // alive.
  static Live: Layer.Layer<ActorEngine | Receptionist> = Layer.effect(
    ActorEngine,
    Effect.acquireRelease(
      Effect.gen(function* () {
        const receptionist = yield* Receptionist
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

        const ask = <M, ReplyMsg extends M & AskBranded<unknown>>(
          target: ActorRef<M>,
          msg: ReplyMsg,
          options?: { askMs?: number },
        ): Effect.Effect<ExtractAskReply<ReplyMsg>, ActorAskTimeout> =>
          Effect.gen(function* () {
            type Reply = ExtractAskReply<ReplyMsg>
            const entry = yield* lookup(target.id)
            if (entry === undefined) {
              return yield* new ActorAskTimeout({
                actorId: target.id,
                askMs: options?.askMs ?? DEFAULT_ASK_MS,
              })
            }
            const askId = crypto.randomUUID()
            const deferred = yield* Deferred.make<Reply, ActorAskTimeout>()
            const resolve = (answer: unknown): Effect.Effect<void> =>
              // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type-erased ask correlation; Reply pinned by AskBranded<R> on the message at the call site
              Effect.asVoid(Deferred.succeed(deferred, answer as Reply))
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

        const releaseClaim = (key: string): Effect.Effect<void> =>
          Ref.update(claimedPersistenceKeys, (s) => {
            const next = new Set(s)
            next.delete(key)
            return next
          })

        const spawn = <M, S>(
          behavior: Behavior<M, S, never>,
          options?: SpawnOptions,
        ): Effect.Effect<ActorRef<M, S>, ActorRestoreError | ActorPersistenceKeyCollision> =>
          Effect.gen(function* () {
            const persistence = behavior.persistence
            if (persistence !== undefined) {
              // Single-CAS claim: Ref.modify atomically reads the prior
              // claim set and writes the new one in one step. A separate
              // get + update pair would let two concurrent spawns both
              // pass the membership check before either wrote, admitting
              // a silent duplicate.
              const collided = yield* Ref.modify(claimedPersistenceKeys, (s) => {
                if (s.has(persistence.key)) return [true, s] as const
                return [false, new Set(s).add(persistence.key)] as const
              })
              if (collided) {
                return yield* new ActorPersistenceKeyCollision({
                  persistenceKey: persistence.key,
                })
              }
            }

            const id = Schema.decodeUnknownSync(ActorId)(crypto.randomUUID())
            const ref: ActorRef<M, S> = { _tag: "ActorRef", id }
            const queue = yield* Queue.unbounded<EnvelopedMessage>()

            const initial: S =
              options?.restoredState !== undefined && persistence !== undefined
                ? yield* Schema.decodeUnknownEffect(persistence.state)(options.restoredState).pipe(
                    Effect.mapError(
                      (cause) => new ActorRestoreError({ persistenceKey: persistence.key, cause }),
                    ),
                  )
                : behavior.initialState
            // Per-actor permit. `receive` and `snapshot` both acquire
            // it, so a snapshot read sees the post-state of whatever
            // message most recently completed — never an in-flight
            // `receive` mid-step. Cross-actor snapshot atomicity is
            // still the caller's contract; this guards each actor in
            // isolation.
            const stateSemaphore = yield* Semaphore.make(1)
            // Sole storage of `S`. `SubscriptionRef` provides both the
            // current-value reads `snapshot()` needs and the changes-
            // channel `subscribeState` exposes — keeping a separate
            // `Ref<S>` would be a `derive-dont-sync` violation (two
            // sources of truth, one write per receive split across
            // both, drift on next edit). The wrapping PubSub uses
            // `replay: 1`, so a late subscriber observes the latest
            // published value; the public stream is wrapped in
            // `Stream.changes` to dedupe consecutive equals via
            // `Equal.equals` (filter-changed semantics; structural
            // equality on `TaggedEnumClass`/`Data.Class` instances).
            const stateChannel = yield* SubscriptionRef.make<S>(initial)

            const snapshotForActor: MailboxEntry["snapshot"] = () =>
              stateSemaphore.withPermits(1)(
                Effect.gen(function* () {
                  if (persistence === undefined) return undefined
                  const current = yield* SubscriptionRef.get(stateChannel)
                  const encoded = yield* Schema.encodeUnknownEffect(persistence.state)(
                    current,
                  ).pipe(
                    Effect.mapError(
                      (cause) => new ActorSnapshotError({ persistenceKey: persistence.key, cause }),
                    ),
                  )
                  return { persistenceKey: persistence.key, state: encoded }
                }),
              )

            const peekViewForActor: MailboxEntry["peekView"] = () =>
              behavior.view === undefined
                ? Effect.succeed(undefined)
                : stateSemaphore.withPermits(1)(
                    Effect.gen(function* () {
                      const current = yield* SubscriptionRef.get(stateChannel)
                      const viewFn = behavior.view
                      if (viewFn === undefined) return undefined
                      return viewFn(current)
                    }),
                  )

            const entry: MailboxEntry = {
              id,
              offer: (env) => Effect.asVoid(Queue.offer(queue, env)),
              snapshot: snapshotForActor,
              subscribeState: () =>
                SubscriptionRef.changes(stateChannel).pipe(
                  Stream.changes,
                ) as Stream.Stream<unknown>,
              peekView: peekViewForActor,
            }
            yield* Ref.update(mailboxes, (m) => new Map(m).set(id, entry))

            if (behavior.serviceKey !== undefined) {
              yield* receptionist.register(behavior.serviceKey, ref)
            }

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
              ask: <N, ReplyMsg extends N & AskBranded<unknown>>(
                target: ActorRef<N>,
                msg: ReplyMsg,
              ) => ask(target, msg),
              reply: replyFor(askId),
              find: <N>(key: ServiceKey<N>): Effect.Effect<ReadonlyArray<ActorRef<N>>> =>
                receptionist.find(key),
              findOne: <N>(key: ServiceKey<N>): Effect.Effect<ActorRef<N> | undefined> =>
                receptionist.findOne(key),
              subscribe: <N>(key: ServiceKey<N>): Stream.Stream<ReadonlyArray<ActorRef<N>>> =>
                receptionist.subscribe(key),
              subscribeState: <N, U>(target: ActorRef<N, U>): Stream.Stream<U> =>
                subscribeState(target),
            })

            // The mailbox stores envelopes typed as `unknown msg`. The
            // behavior's M is fixed at spawn time, so the message that
            // arrives is by construction an M. The cast widens unknown
            // → M; type safety is preserved by the spawn-time type
            // parameter on `Behavior<M, S>`.
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type-erased mailbox storage; M pinned at spawn time
            const receiveMsg = (msg: unknown): M => msg as M

            // Take outside the permit so the next message's blocking
            // dequeue does not hold the snapshot lock. Receive + state
            // write run under the permit, so a concurrent `snapshot()`
            // observes the post-state of whatever message most recently
            // completed — never a torn read mid-receive.
            const step = Effect.gen(function* () {
              const env = yield* Queue.take(queue)
              yield* stateSemaphore.withPermits(1)(
                Effect.gen(function* () {
                  const state = yield* SubscriptionRef.get(stateChannel)
                  const next = yield* behavior.receive(
                    receiveMsg(env.msg),
                    state,
                    ctxFor(env.askId),
                  )
                  // Single write — `SubscriptionRef.set` updates the
                  // current value AND notifies subscribers atomically.
                  yield* SubscriptionRef.set(stateChannel, next)
                }),
              )
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

            // On fiber exit (interrupt or defect): drop the mailbox entry,
            // free the persistence-key claim, and unregister from the
            // Receptionist so dead refs do not leak into discovery results.
            const cleanup = Effect.gen(function* () {
              yield* Ref.update(mailboxes, (m) => {
                const next = new Map(m)
                next.delete(id)
                return next
              })
              if (persistence !== undefined) {
                yield* releaseClaim(persistence.key)
              }
              if (behavior.serviceKey !== undefined) {
                yield* receptionist.unregister(behavior.serviceKey, ref)
              }
            })

            yield* Effect.forkIn(loop.pipe(Effect.ensuring(cleanup)), runtimeScope)
            return ref
          }).pipe((eff) => {
            // Backstop for the leak window between the persistence-key
            // claim above and the successful `Effect.forkIn` below it.
            // If anything in that window fails or interrupts (decode
            // error, queue/Ref allocation interrupt, receptionist
            // register failure), free the claim so a retry isn't
            // locked out by an orphan key. `onError` only fires on the
            // failure path, so when `forkIn` succeeds the spawned
            // fiber's `cleanup` owns the release and there is no
            // double-free. The collision-return path also flows
            // through here as a typed failure, but it never reached
            // the claim-write branch — `releaseClaim` on a key not in
            // the set is a no-op delete.
            const key = behavior.persistence?.key
            if (key === undefined) return eff
            return eff.pipe(Effect.onError(() => releaseClaim(key)))
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

        const subscribeState = <M, S>(target: ActorRef<M, S>): Stream.Stream<S> =>
          // Resolve the mailbox lazily on subscribe so callers can
          // hand the stream around before the actor is necessarily
          // spawned. Unknown refs degrade to `Stream.empty` (matches
          // `tell` no-op semantics).
          //
          // The mailbox's `subscribeState()` is engine-erased to
          // `Stream<unknown>` because mailboxes are heterogeneous in
          // `S`. The cast back to `Stream<S>` is safe: `S` is pinned
          // by the ref's phantom (set at spawn time), the underlying
          // `SubscriptionRef<S>` stores exactly that `S`, and the
          // engine never publishes anything else into that channel.
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- erased mailbox channel; S pinned by ActorRef<M, S> phantom set at spawn time
          Stream.unwrap(
            lookup(target.id).pipe(
              Effect.map((entry) => (entry === undefined ? Stream.empty : entry.subscribeState())),
            ),
          ) as Stream.Stream<S>

        const peekView = <M>(target: ActorRef<M>): Effect.Effect<ActorView | undefined> =>
          lookup(target.id).pipe(
            Effect.flatMap((entry) =>
              entry === undefined ? Effect.succeed(undefined) : entry.peekView(),
            ),
          )

        return {
          runtimeScope,
          service: {
            spawn,
            tell,
            ask,
            snapshot,
            subscribeState,
            peekView,
          } satisfies ActorEngineService,
        }
      }),
      ({ runtimeScope }) => Scope.close(runtimeScope, Exit.void),
    ).pipe(Effect.map(({ service }) => service)),
  ).pipe(Layer.provideMerge(Receptionist.Live))
}
