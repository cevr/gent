/**
 * Receptionist — W9-3.
 *
 * Typed `ServiceKey<M>` registry. Actors that declare a
 * `serviceKey` on their `Behavior` register here at spawn time;
 * peers discover them via `ctx.find(key)` (snapshot) or
 * `ctx.subscribe(key)` (live stream of refs as registrations
 * change).
 *
 * Backed by `SubscriptionRef<Map<string, Set<ActorRef<unknown>>>>`
 * — keyed on the ServiceKey's `name`. The `M` parameter is type
 * erased at the registry boundary; ServiceKey<M>'s phantom carries
 * M end-to-end at the call sites.
 */

import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import type { ActorRef, ServiceKey } from "../../domain/actor.js"

type RegistryMap = ReadonlyMap<string, ReadonlySet<ActorRef<unknown>>>

const emptyRegistry: RegistryMap = new Map()

const addToRegistry = (registry: RegistryMap, key: string, ref: ActorRef<unknown>): RegistryMap => {
  const next = new Map(registry)
  const existing = next.get(key) ?? new Set<ActorRef<unknown>>()
  const updated = new Set(existing)
  updated.add(ref)
  next.set(key, updated)
  return next
}

const removeFromRegistry = (
  registry: RegistryMap,
  key: string,
  ref: ActorRef<unknown>,
): RegistryMap => {
  const existing = registry.get(key)
  if (existing === undefined) return registry
  const updated = new Set(existing)
  updated.delete(ref)
  const next = new Map(registry)
  if (updated.size === 0) next.delete(key)
  else next.set(key, updated)
  return next
}

export interface ReceptionistService {
  /** Register `ref` under `key`. Idempotent on (key, ref). */
  readonly register: <M>(key: ServiceKey<M>, ref: ActorRef<M>) => Effect.Effect<void>
  /** Remove `ref` from `key`. No-op if not registered. */
  readonly unregister: <M>(key: ServiceKey<M>, ref: ActorRef<M>) => Effect.Effect<void>
  /** Snapshot of refs registered under `key`. Empty array when missing. */
  readonly find: <M>(key: ServiceKey<M>) => Effect.Effect<ReadonlyArray<ActorRef<M>>>
  /**
   * Live stream of the ref set under `key`. Emits the current set on
   * subscribe, then a fresh snapshot on every register/unregister
   * touching this key.
   */
  readonly subscribe: <M>(key: ServiceKey<M>) => Stream.Stream<ReadonlyArray<ActorRef<M>>>
}

export class Receptionist extends Context.Service<Receptionist, ReceptionistService>()(
  "@gent/core/src/runtime/extensions/receptionist",
) {
  static Live: Layer.Layer<Receptionist> = Layer.effect(
    Receptionist,
    Effect.gen(function* () {
      const ref = yield* SubscriptionRef.make<RegistryMap>(emptyRegistry)

      const register = <M>(key: ServiceKey<M>, actorRef: ActorRef<M>): Effect.Effect<void> =>
        SubscriptionRef.update(ref, (registry) =>
          addToRegistry(
            registry,
            key.name,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type-erased registry storage; M pinned by ServiceKey<M>
            actorRef as ActorRef<unknown>,
          ),
        )

      const unregister = <M>(key: ServiceKey<M>, actorRef: ActorRef<M>): Effect.Effect<void> =>
        SubscriptionRef.update(ref, (registry) =>
          removeFromRegistry(
            registry,
            key.name,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type-erased registry storage; M pinned by ServiceKey<M>
            actorRef as ActorRef<unknown>,
          ),
        )

      const find = <M>(key: ServiceKey<M>): Effect.Effect<ReadonlyArray<ActorRef<M>>> =>
        SubscriptionRef.get(ref).pipe(
          Effect.map((registry) => {
            const set = registry.get(key.name)
            if (set === undefined) return []
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type-erased registry storage; M pinned by ServiceKey<M>
            return Array.from(set) as ReadonlyArray<ActorRef<M>>
          }),
        )

      const subscribe = <M>(key: ServiceKey<M>): Stream.Stream<ReadonlyArray<ActorRef<M>>> =>
        SubscriptionRef.changes(ref).pipe(
          Stream.map((registry: RegistryMap) => {
            const set = registry.get(key.name)
            if (set === undefined) return [] as ReadonlyArray<ActorRef<M>>
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- type-erased registry storage; M pinned by ServiceKey<M>
            return Array.from(set) as ReadonlyArray<ActorRef<M>>
          }),
        )

      return { register, unregister, find, subscribe }
    }),
  )
}
