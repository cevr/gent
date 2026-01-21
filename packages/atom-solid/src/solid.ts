import { createComponent, createContext, createEffect, createMemo, onCleanup, useContext } from "solid-js"
import type { Accessor, ParentProps } from "solid-js"
import { globalValue } from "effect/GlobalValue"
import * as Runtime from "effect/Runtime"
import type { Atom, Writable } from "./atom"
import * as Registry from "./registry"
import type { Result } from "./result"

const defaultRegistry = globalValue("@gent/atom-solid/defaultRegistry", () =>
  Registry.make({ runtime: Runtime.defaultRuntime as Runtime.Runtime<unknown> }),
)

export const RegistryContext = createContext<Registry.Registry>(defaultRegistry)

export const useRegistry = (): Registry.Registry => useContext(RegistryContext)

type AtomInput<A> = Atom<A> | Accessor<Atom<A>>

type WritableInput<R, W> = Writable<R, W> | Accessor<Writable<R, W>>

const toAccessor = <A>(atom: AtomInput<A>): Accessor<Atom<A>> =>
  typeof atom === "function" ? (atom as Accessor<Atom<A>>) : () => atom

const toWritableAccessor = <R, W>(atom: WritableInput<R, W>): Accessor<Writable<R, W>> =>
  typeof atom === "function" ? (atom as Accessor<Writable<R, W>>) : () => atom

export interface RegistryProviderProps extends ParentProps {
  readonly registry?: Registry.Registry
  readonly runtime?: Runtime.Runtime<unknown>
  readonly maxEntries?: number
}

export const RegistryProvider = (props: RegistryProviderProps) => {
  const runtime = props.runtime ?? (Runtime.defaultRuntime as Runtime.Runtime<unknown>)
  const registry = props.registry ?? Registry.make({ runtime, maxEntries: props.maxEntries })
  const shouldDispose = props.registry === undefined

  onCleanup(() => {
    if (shouldDispose) registry.dispose()
  })

  return createComponent(RegistryContext.Provider, {
    value: registry,
    get children() {
      return props.children
    },
  })
}

const mountAtom = <A>(registry: Registry.Registry, atomAccessor: Accessor<Atom<A>>) => {
  createEffect(() => {
    const atom = atomAccessor()
    const unmount = registry.mount(atom)
    onCleanup(unmount)
  })
}

export const useAtomValue = <A>(atom: AtomInput<A>): Accessor<A> => {
  const registry = useRegistry()
  const atomAccessor = toAccessor(atom)
  mountAtom(registry, atomAccessor)
  return createMemo(() => registry.read(atomAccessor())())
}

export const useAtomSet = <R, W>(atom: WritableInput<R, W>) => {
  const registry = useRegistry()
  const atomAccessor = toWritableAccessor(atom)
  mountAtom(registry, atomAccessor)

  return (value: W | ((value: R) => W)) => {
    registry.set(atomAccessor(), value)
  }
}

export const useAtomRefresh = <A>(atom: AtomInput<A>) => {
  const registry = useRegistry()
  const atomAccessor = toAccessor(atom)
  mountAtom(registry, atomAccessor)
  return () => registry.refresh(atomAccessor())
}

export const useAtomSubscribe = <A>(
  atom: AtomInput<A>,
  f: (value: A) => void,
  options?: { readonly immediate?: boolean },
): void => {
  const value = useAtomValue(atom)
  let first = true
  createEffect(() => {
    const next = value()
    if (first) {
      first = false
      if (!options?.immediate) return
    }
    f(next)
  })
}

export const useAtom = <R, W>(atom: WritableInput<R, W>) => {
  const registry = useRegistry()
  const atomAccessor = toWritableAccessor(atom)
  mountAtom(registry, atomAccessor)
  const value = createMemo(() => registry.read(atomAccessor())())
  const set = (next: W | ((value: R) => W)) => {
    registry.set(atomAccessor(), next)
  }
  return [value, set] as const
}

export const useAtomResult = <A, E>(atom: AtomInput<Result<A, E>>) => {
  const result = useAtomValue(atom)
  const value = () => {
    const current = result()
    return current._tag === "Success" ? current.value : undefined
  }
  const error = () => {
    const current = result()
    return current._tag === "Failure" ? current.cause : undefined
  }
  const loading = () => {
    const current = result()
    return current._tag === "Initial" || current.waiting
  }
  return { result, value, error, loading }
}
