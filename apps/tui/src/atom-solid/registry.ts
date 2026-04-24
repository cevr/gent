import { createRoot, getOwner, runWithOwner } from "solid-js"
import type { Accessor, Owner } from "solid-js"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
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
  readonly services?: undefined
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
  if (options?.services !== undefined) {
    return new RegistryImpl(options.services, options.maxEntries)
  }
  return new RegistryImpl(Context.empty(), options?.maxEntries)
}

const isWritableInstance = <R, W>(instance: AtomInstance<R>): instance is WritableInstance<R, W> =>
  "set" in instance && typeof instance.set === "function"

class RegistryImpl<Services> implements Registry<Services> {
  private readonly services: Context.Context<Services>
  private readonly instances = new Map<object, AtomInstance<unknown>>()
  private readonly refCounts = new Map<object, number>()
  private readonly maxEntries: number | undefined
  private readonly shouldEvict: boolean
  private readonly owner: Owner
  private readonly disposeRoot: () => void

  constructor(services: Context.Context<Services>, maxEntries?: number) {
    this.services = services
    this.maxEntries = maxEntries
    this.shouldEvict = maxEntries !== undefined && maxEntries > 0
    let owner: Owner | null = null
    let disposeRoot: () => void = () => {}

    createRoot((dispose) => {
      owner = getOwner()
      disposeRoot = dispose
      return undefined
    })

    if (owner === null) {
      throw new Error("Registry root owner not created")
    }

    this.owner = owner
    this.disposeRoot = disposeRoot
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
    const instance = this.instances.get(atom)
    if (instance !== undefined) {
      this.touch(atom, instance)
    }
    instance?.refresh?.()
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
    const existing = this.instances.get(atom)
    if (existing !== undefined) {
      this.touch(atom, existing)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- cached atom identity owns the instance type relation
      return existing as AtomInstance<A>
    }
    const created = runWithOwner(this.owner, () => atom.build(this))
    if (created === undefined) {
      throw new Error("Atom build returned no instance")
    }
    this.instances.set(atom, created)
    this.evictIfNeeded()
    return created
  }

  private ensureWritable<R, W, AtomServices extends Services>(
    atom: Writable<R, W, AtomServices>,
  ): WritableInstance<R, W> {
    const instance = this.ensure(atom)
    if (!isWritableInstance<R, W>(instance)) {
      throw new Error("Atom is not writable")
    }
    return instance
  }

  private touch(key: object, instance?: AtomInstance<unknown>): void {
    if (!this.shouldEvict) return
    const value = instance ?? this.instances.get(key)
    if (value === undefined) return
    this.instances.delete(key)
    this.instances.set(key, value)
  }

  private evictIfNeeded(): void {
    if (!this.shouldEvict) return
    const maxEntries = this.maxEntries ?? 0
    while (this.instances.size > maxEntries) {
      const evictable = this.findEvictable()
      if (evictable === null) return
      this.instances.delete(evictable.key)
      this.refCounts.delete(evictable.key)
      evictable.instance.dispose?.()
    }
  }

  private findEvictable(): {
    key: object
    instance: AtomInstance<unknown>
  } | null {
    for (const [key, instance] of this.instances) {
      if (!this.isMounted(key)) {
        return { key, instance }
      }
    }
    return null
  }

  private isMounted(key: object): boolean {
    return (this.refCounts.get(key) ?? 0) > 0
  }
}
