import { Schema, type Effect, type Stream } from "effect"
import { ActorId } from "./ids.js"
import type { ToolPolicyFragment } from "./extension.js"
import type { PromptSection } from "./prompt.js"

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
 * Reference to a spawned actor. The phantom `M` is used by `tell` /
 * `ask` to enforce message-type compatibility at every call site.
 *
 * Construct via `ActorEngine.spawn`. Never construct one by hand —
 * the runtime requires the id to map to an active mailbox.
 */
export interface ActorRef<in M> {
  readonly _tag: "ActorRef"
  readonly id: ActorId
  /** Phantom — never read, never written. Erased at runtime. */
  readonly _phantomMessage?: (msg: M) => void
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
  readonly ask: <N, A>(
    target: ActorRef<N>,
    msg: N,
    replyKey: (a: A) => N,
  ) => Effect.Effect<A, ActorAskTimeout>
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
  readonly subscribe: <N>(key: ServiceKey<N>) => Stream.Stream<ActorRef<N>>
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
 * Behavior — the unit an extension declares and the engine spawns.
 *
 * `M` is the message type, `S` the actor's local state, `R` the
 * Effect requirements available to `receive` (services from the
 * extension's layer).
 */
export interface Behavior<M, S, R = never> {
  readonly initialState: S
  readonly receive: (msg: M, state: S, ctx: ActorContext<M>) => Effect.Effect<S, never, R>
  readonly view?: (state: S) => ActorView
  readonly serviceKey?: ServiceKey<M>
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
