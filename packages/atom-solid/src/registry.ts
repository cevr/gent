import { createRoot, getOwner, runWithOwner } from "solid-js"
import type { Accessor, Owner } from "solid-js"
import * as Runtime from "effect/Runtime"
import type { Atom, AtomInstance, Writable, WritableInstance } from "./atom"

export interface Registry {
  readonly runtime: Runtime.Runtime<unknown>
  readonly read: <A>(atom: Atom<A>) => Accessor<A>
  readonly get: <A>(atom: Atom<A>) => A
  readonly set: <R, W>(atom: Writable<R, W>, value: W | ((value: R) => W)) => void
  readonly refresh: <A>(atom: Atom<A>) => void
  readonly mount: <A>(atom: Atom<A>) => () => void
  readonly dispose: () => void
}

export interface RegistryOptions {
  readonly runtime?: Runtime.Runtime<unknown>
  readonly maxEntries?: number
}

export const make = (options?: RegistryOptions): Registry =>
  new RegistryImpl(
    options?.runtime ?? (Runtime.defaultRuntime as Runtime.Runtime<unknown>),
    options?.maxEntries,
  )

class RegistryImpl implements Registry {
  readonly runtime: Runtime.Runtime<unknown>
  private readonly instances = new Map<Atom<unknown>, AtomInstance<unknown>>()
  private readonly refCounts = new Map<Atom<unknown>, number>()
  private readonly maxEntries: number | undefined
  private readonly shouldEvict: boolean
  private readonly owner: Owner
  private readonly disposeRoot: () => void

  constructor(runtime: Runtime.Runtime<unknown>, maxEntries?: number) {
    this.runtime = runtime
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

  read<A>(atom: Atom<A>): Accessor<A> {
    return this.ensure(atom).get
  }

  get<A>(atom: Atom<A>): A {
    return this.read(atom)()
  }

  set<R, W>(atom: Writable<R, W>, value: W | ((value: R) => W)): void {
    const instance = this.ensure(atom) as AtomInstance<unknown>
    if (!("set" in instance)) {
      throw new Error("Atom is not writable")
    }
    ;(instance as WritableInstance<R, W>).set(value)
  }

  refresh<A>(atom: Atom<A>): void {
    const instance = this.instances.get(atom as Atom<unknown>)
    if (instance !== undefined) {
      this.touch(atom as Atom<unknown>, instance)
    }
    instance?.refresh?.()
  }

  mount<A>(atom: Atom<A>): () => void {
    const key = atom as Atom<unknown>
    this.ensure(atom)
    this.touch(key)
    const current = this.refCounts.get(key) ?? 0
    this.refCounts.set(key, current + 1)
    return () => {
      const next = (this.refCounts.get(key) ?? 1) - 1
      if (next <= 0) {
        this.refCounts.delete(key)
      } else {
        this.refCounts.set(key, next)
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

  private ensure<A>(atom: Atom<A>): AtomInstance<A> {
    const existing = this.instances.get(atom as Atom<unknown>)
    if (existing !== undefined) {
      this.touch(atom as Atom<unknown>, existing)
      return existing as AtomInstance<A>
    }
    const created = runWithOwner(this.owner, () => atom.build(this))
    if (created === undefined) {
      throw new Error("Atom build returned no instance")
    }
    this.instances.set(atom as Atom<unknown>, created as AtomInstance<unknown>)
    this.evictIfNeeded()
    return created
  }

  private touch(atom: Atom<unknown>, instance?: AtomInstance<unknown>): void {
    if (!this.shouldEvict) return
    const value = instance ?? this.instances.get(atom)
    if (value === undefined) return
    this.instances.delete(atom)
    this.instances.set(atom, value)
  }

  private evictIfNeeded(): void {
    if (!this.shouldEvict) return
    const maxEntries = this.maxEntries ?? 0
    while (this.instances.size > maxEntries) {
      const evictable = this.findEvictable()
      if (evictable === null) return
      this.instances.delete(evictable.atom)
      this.refCounts.delete(evictable.atom)
      evictable.instance.dispose?.()
    }
  }

  private findEvictable(): { atom: Atom<unknown>; instance: AtomInstance<unknown> } | null {
    for (const [atom, instance] of this.instances) {
      if (!this.isMounted(atom)) {
        return { atom, instance }
      }
    }
    return null
  }

  private isMounted(atom: Atom<unknown>): boolean {
    return (this.refCounts.get(atom) ?? 0) > 0
  }
}
