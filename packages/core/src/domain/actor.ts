import { Schema, type Effect, type Stream } from "effect"
import { ActorId } from "./ids.js"
import type { ToolPolicyFragment } from "./extension.js"
import type { PromptSection } from "./prompt.js"
import type { AskBranded, ExtractAskReply } from "./schema-tagged-enum-class.js"

/**
 * Actor primitives — W9 foundation.
 *
 * `ActorRef<M>` and `ServiceKey<M>` carry a phantom message type so
 * `tell` / `ask` / `find` / `subscribe` reject mismatched targets at
 * the type level. The runtime carries only `id` / `name`; `M` is
 * structural-only and erased at runtime.
 *
 * Behaviors compose by message: `receive` is the sole reducer-like
 * surface, `view` is the sole projection surface, `serviceKey` is
 * the sole discovery surface. ActorEngine (W9-2) consumes Behaviors;
 * Receptionist (W9-3) consumes ServiceKeys.
 */

/**
 * Reference to a spawned actor. The phantom `M` enforces message-type
 * compatibility on `tell` / `ask`. The phantom `S` (defaulted to
 * `unknown`) carries the actor's state type so `subscribeState` can
 * return `Stream<S>` instead of `Stream<unknown>` — callers that own
 * the spawning Behavior get typed state observation without a cast,
 * while callers that erase the ref (e.g. discovery via `find` /
 * `subscribe`, where the registry only knows `M`) keep the
 * `S = unknown` default and narrow at the consumption seam.
 *
 * Construct via `ActorEngine.spawn`. Never construct one by hand —
 * the runtime requires the id to map to an active mailbox.
 */
export interface ActorRef<in M, out S = unknown> {
  readonly _tag: "ActorRef"
  readonly id: ActorId
  /** Phantom — never read, never written. Erased at runtime. */
  readonly _phantomMessage?: (msg: M) => void
  /** Phantom — never read, never written. Erased at runtime. */
  readonly _phantomState?: () => S
}

/**
 * Discovery handle for actor lookup. Two ServiceKeys with the same
 * name and matching `M` resolve to the same registry entry.
 */
export interface ServiceKey<in M> {
  readonly _tag: "ServiceKey"
  readonly name: string
  /** Phantom — never read, never written. Erased at runtime. */
  readonly _phantomMessage?: (msg: M) => void
}

/**
 * Build a `ServiceKey<M>` for runtime use.
 *
 * Two calls with the same `name` produce keys that compare equal in
 * the receptionist registry. The type parameter is the only
 * distinction the type system enforces — registering the same name
 * with mismatched message types is a runtime collision.
 */
export const ServiceKey = <M>(name: string): ServiceKey<M> => ({
  _tag: "ServiceKey",
  name,
})

/**
 * Per-actor view onto runtime services. Constructed by the
 * ActorEngine and threaded into every `receive` invocation.
 */
export interface ActorContext<M> {
  readonly self: ActorRef<M>
  readonly tell: <N>(target: ActorRef<N>, msg: N) => Effect.Effect<void>
  /**
   * Ask-correlated send. Reply type is inferred from the message's
   * `AskBranded<Reply>` brand, which is attached at variant declaration time
   * via `TaggedEnumClass.askVariant<R>()(fields)`. Tell-only variants do not
   * carry the brand and are rejected at the type level — callers cannot
   * accidentally `ask` a fire-and-forget variant.
   */
  readonly ask: <N, ReplyMsg extends N & AskBranded<unknown>>(
    target: ActorRef<N>,
    msg: ReplyMsg,
  ) => Effect.Effect<ExtractAskReply<ReplyMsg>, ActorAskTimeout>
  /**
   * Fulfill the ask correlation that delivered the current message.
   *
   * Only valid inside a `receive` invocation that was triggered by an
   * `ask`. Outside that scope, `reply` is a no-op (the engine drops
   * replies that don't match a pending correlation). The answer type
   * is `unknown` at this seam — the asker pins it via the `replyKey`
   * type parameter on `ask`.
   */
  readonly reply: (answer: unknown) => Effect.Effect<void>
  readonly find: <N>(key: ServiceKey<N>) => Effect.Effect<ReadonlyArray<ActorRef<N>>>
  /**
   * Live stream of the ref set registered under `key`. Emits the
   * current set on subscribe, then a fresh snapshot on every change.
   * Snapshot semantics (not per-ref) so subscribers observe both
   * register and unregister.
   */
  readonly subscribe: <N>(key: ServiceKey<N>) => Stream.Stream<ReadonlyArray<ActorRef<N>>>
  /**
   * Live stream of an actor's `S` state. Emits the current state on
   * subscribe (via the underlying `replay: 1` PubSub), then on every
   * change. Consecutive duplicates are deduped via `Equal.equals`,
   * so subscribers only observe genuine transitions.
   *
   * Equality contract: `Stream.changes` uses structural equality.
   * `TaggedEnumClass`/`Schema.TaggedStruct`/`Data.Class` instances
   * dedupe correctly (their fields are compared structurally). State
   * shapes that include closures, `Map`, `Set`, or other reference-
   * compared values will fall back to reference equality and emit
   * spuriously on every receive — keep `S` to plain data.
   *
   * `S` is carried on the ref: a ref returned by `spawn(behavior)` has
   * `behavior`'s state type pinned to its second phantom slot, so the
   * returned stream is `Stream<S>` for callers that hold the spawned
   * ref. Callers that erase the ref (discovery via `find` / `subscribe`,
   * which only know `M`) get `Stream<unknown>` from the default
   * `S = unknown` and narrow at the consumption seam — typically by
   * `_tag` for `TaggedEnumClass` state shapes.
   *
   * Returns `Stream.empty` for unknown refs (mirrors `tell` semantics).
   */
  readonly subscribeState: <N, U>(target: ActorRef<N, U>) => Stream.Stream<U>
}

/**
 * Optional projection emitted by an actor's current state.
 *
 * The runtime samples `view(state)` whenever it needs a snapshot for
 * prompt assembly or tool policy resolution. Should be cheap and
 * deterministic.
 */
export interface ActorView {
  readonly prompt?: ReadonlyArray<PromptSection>
  readonly toolPolicy?: ToolPolicyFragment
}

/**
 * JSON-shaped value used as the `Encoded` parameter on durable
 * persistence codecs. This is a *type-level* constraint only — it
 * pins what TypeScript will accept as a behavior's encoded shape, so
 * codecs whose static `Encoded` is a `Date` or `Map` are rejected at
 * the declaration site. It does not validate the codec's runtime
 * encoder; an authored transform that lies about its `Encoded` type
 * will still smuggle non-JSON values through and surface as
 * `ActorRestoreError` on the next restore.
 */
export type JsonValueT =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<JsonValueT>
  | { readonly [k: string]: JsonValueT }

/**
 * Persistence configuration for a durable actor. Both `key` and
 * `state` must be present — a half-set persistence config is a
 * make-impossible-states-unrepresentable violation, so the engine
 * accepts a single optional `persistence` field instead of two.
 *
 * `key` is the stable map slot; must be unique within an engine
 * instance (collisions are rejected at spawn).
 *
 * `state` encodes `S` to a `JsonValueT`. The engine does not own the
 * persistence transport — whoever calls `snapshot()` is responsible
 * for writing the resulting map; whoever calls `spawn(..., {
 * restoredState })` is responsible for reading the prior encoded
 * value. The encoded shape is JSON-typed so any standard transport
 * works.
 */
export interface PersistenceConfig<S> {
  readonly key: string
  readonly state: Schema.Codec<S, JsonValueT>
}

/**
 * Behavior — the unit an extension declares and the engine spawns.
 *
 * `M` is the message type, `S` the actor's local state, `R` the
 * Effect requirements available to `receive` (services from the
 * extension's layer).
 *
 * Persistence is opt-in via `persistence`. When set, the engine
 * snapshots the live `S` through `persistence.state` at checkpoint
 * time and rehydrates it back into `initialState` at restore time.
 * Behaviors without `persistence` are ephemeral — they restart from
 * `initialState` after a crash and peers re-tell them on resume.
 */
export interface Behavior<M, S, R = never> {
  readonly initialState: S
  readonly receive: (msg: M, state: S, ctx: ActorContext<M>) => Effect.Effect<S, never, R>
  readonly view?: (state: S) => ActorView
  readonly serviceKey?: ServiceKey<M>
  readonly persistence?: PersistenceConfig<S>
}

/**
 * Raised by `ctx.ask` when the reply does not arrive within the
 * configured ask deadline. Encodes the target actor and the
 * deadline that was breached so callers can decide whether to
 * retry, escalate, or fall back.
 */
export class ActorAskTimeout extends Schema.TaggedErrorClass<ActorAskTimeout>()("ActorAskTimeout", {
  actorId: ActorId,
  askMs: Schema.Number,
}) {}

/**
 * Raised by `ActorEngine.spawn` when `restoredState` cannot be
 * decoded through the behavior's `persistence.state` schema. A
 * typed error (rather than `Effect.die`) lets the loader degrade
 * gracefully — log + fall back to `initialState` for one quarantined
 * key — instead of interrupting the entire restore fiber and losing
 * every other durable actor on a single schema bump.
 */
export class ActorRestoreError extends Schema.TaggedErrorClass<ActorRestoreError>()(
  "ActorRestoreError",
  {
    persistenceKey: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/**
 * Raised by `ActorEngine.snapshot` when an actor's current state
 * cannot be encoded through its `persistence.state` schema. Typed
 * (rather than `Effect.die`) so the checkpoint boundary — which has
 * domain context — chooses skip-and-log vs abort-checkpoint, instead
 * of the engine making that policy call.
 */
export class ActorSnapshotError extends Schema.TaggedErrorClass<ActorSnapshotError>()(
  "ActorSnapshotError",
  {
    persistenceKey: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/**
 * Raised by `ActorEngine.spawn` when two durable behaviors in the
 * same engine declare the same `persistence.key`. Last-write-wins
 * silent collisions corrupt durable state on snapshot/restore — the
 * second behavior's encoded form would overwrite the first in the
 * snapshot map, then both would decode the *same* encoded value
 * through *different* schemas at restore. Strict failure at spawn
 * is the only correct policy.
 */
export class ActorPersistenceKeyCollision extends Schema.TaggedErrorClass<ActorPersistenceKeyCollision>()(
  "ActorPersistenceKeyCollision",
  {
    persistenceKey: Schema.String,
  },
) {}
