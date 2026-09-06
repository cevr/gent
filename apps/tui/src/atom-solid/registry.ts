import { createRoot, getOwner, runWithOwner } from "solid-js"
import type { Accessor, Owner } from "solid-js"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type * as Fiber from "effect/Fiber"
import type { Atom, AtomInstance, Writable, WritableInstance } from "./atom"

export interface Registry<Services = unknown> {
  readonly fork: <A, E, R extends Services>(effect: Effect.Effect<A, E, R>) => Fiber.Fiber<A, E>
  readonly read: <A, R extends Services>(atom: Atom<A, R>) => Accessor<A>
  readonly get: <A, R extends Services>(atom: Atom<A, R>) => A
  readonly set: <R, W, AtomServices extends Services>(
    atom: Writable<R, W, AtomServices>,
    value: W | ((value: R) => W),
  ) => void
  readonly refresh: <A, R extends Services>(atom: Atom<A, R>) => void
  readonly mount: <A, R extends Services>(atom: Atom<A, R>) => () => void
  readonly dispose: () => void
}

export interface RegistryOptionsWithoutServices {
  readonly services?: never
  readonly maxEntries?: number
}

export interface RegistryOptionsWithServices<Services> {
  readonly services: Context.Context<Services>
  readonly maxEntries?: number
}

export type RegistryOptions<Services = never> =
  | RegistryOptionsWithoutServices
  | RegistryOptionsWithServices<Services>

export function make(options?: RegistryOptionsWithoutServices): Registry<never>
export function make<Services>(options: RegistryOptionsWithServices<Services>): Registry<Services>
export function make<Services>(
  options?: RegistryOptions<Services>,
): Registry<Services> | Registry<never> {
  const services = Option.fromNullishOr(options?.services)
  if (Option.isSome(services)) {
    return new RegistryImpl(services.value, options?.maxEntries)
  }
  return new RegistryImpl(Context.empty(), options?.maxEntries)
}

const isWritableInstance = <R, W>(instance: AtomInstance<R>): instance is WritableInstance<R, W> =>
  "set" in instance && Predicate.isFunction(instance.set)

class RegistryImpl<Services> implements Registry<Services> {
  private readonly services: Context.Context<Services>
  private readonly instances = new Map<Atom<unknown, Services>, AtomInstance<unknown>>()
  private readonly refCounts = new Map<Atom<unknown, Services>, number>()
  private readonly maxEntries: number
  private readonly shouldEvict: boolean
  private readonly owner: Owner
  private readonly disposeRoot: () => void

  constructor(services: Context.Context<Services>, maxEntries?: number) {
    this.services = services
    this.maxEntries = maxEntries ?? 0
    this.shouldEvict = this.maxEntries > 0
    const root = createRoot((dispose) => ({ owner: Option.fromNullishOr(getOwner()), dispose }))
    this.owner = Option.getOrElse(root.owner, () =>
      Effect.runSync(Effect.die(new Error("Registry root owner not created"))),
    )
    this.disposeRoot = root.dispose
  }

  fork<A, E, R extends Services>(effect: Effect.Effect<A, E, R>): Fiber.Fiber<A, E> {
    return Effect.runForkWith(this.services)(effect)
  }

  read<A, R extends Services>(atom: Atom<A, R>): Accessor<A> {
    return this.ensure(atom).get
  }

  get<A, R extends Services>(atom: Atom<A, R>): A {
    return this.read(atom)()
  }

  set<R, W, AtomServices extends Services>(
    atom: Writable<R, W, AtomServices>,
    value: W | ((value: R) => W),
  ): void {
    this.ensureWritable(atom).set(value)
  }

  refresh<A, R extends Services>(atom: Atom<A, R>): void {
    const instance = Option.fromNullishOr(this.instances.get(atom))
    if (Option.isSome(instance)) {
      this.touch(atom, instance.value)
      instance.value.refresh?.()
    }
  }

  mount<A, R extends Services>(atom: Atom<A, R>): () => void {
    this.ensure(atom)
    this.touch(atom)
    const current = this.refCounts.get(atom) ?? 0
    this.refCounts.set(atom, current + 1)
    return () => {
      const next = (this.refCounts.get(atom) ?? 1) - 1
      if (next <= 0) {
        this.refCounts.delete(atom)
      } else {
        this.refCounts.set(atom, next)
      }
      this.evictIfNeeded()
    }
  }

  dispose(): void {
    for (const instance of this.instances.values()) {
      instance.dispose?.()
    }
    this.instances.clear()
    this.refCounts.clear()
    this.disposeRoot()
  }

  private ensure<A, R extends Services>(atom: Atom<A, R>): AtomInstance<A> {
    const existing = Option.fromNullishOr(this.instances.get(atom))
    if (Option.isSome(existing)) {
      this.touch(atom, existing.value)
      // eslint-disable-next-line effect/noAs, @typescript-eslint/no-unsafe-type-assertion -- Atom identity keys the heterogeneous cache and preserves each instance value type.
      return existing.value as AtomInstance<A>
    }
    const created = Option.getOrElse(
      Option.fromNullishOr(runWithOwner(this.owner, () => atom.build(this))),
      () => Effect.runSync(Effect.die(new Error("Atom build returned no instance"))),
    )
    this.instances.set(atom, created)
    this.evictIfNeeded()
    return created
  }

  private ensureWritable<R, W, AtomServices extends Services>(
    atom: Writable<R, W, AtomServices>,
  ): WritableInstance<R, W> {
    const instance = this.ensure(atom)
    if (!isWritableInstance<R, W>(instance)) {
      return Effect.runSync(Effect.die(new Error("Atom is not writable")))
    }
    return instance
  }

  private touch(key: Atom<unknown, Services>, instance?: AtomInstance<unknown>): void {
    if (!this.shouldEvict) return
    const value = Option.fromNullishOr(instance ?? this.instances.get(key))
    if (Option.isNone(value)) return
    this.instances.delete(key)
    this.instances.set(key, value.value)
  }

  private evictIfNeeded(): void {
    if (!this.shouldEvict) return
    while (this.instances.size > this.maxEntries) {
      const evictable = this.findEvictable()
      if (Option.isNone(evictable)) return
      this.instances.delete(evictable.value.key)
      this.refCounts.delete(evictable.value.key)
      evictable.value.instance.dispose?.()
    }
  }

  private findEvictable(): Option.Option<{
    key: Atom<unknown, Services>
    instance: AtomInstance<unknown>
  }> {
    for (const [key, instance] of this.instances) {
      if (!this.isMounted(key)) {
        return Option.some({ key, instance })
      }
    }
    return Option.none()
  }

  private isMounted(key: Atom<unknown, Services>): boolean {
    return (this.refCounts.get(key) ?? 0) > 0
  }
}
