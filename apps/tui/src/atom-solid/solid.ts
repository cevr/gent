import {
  createComponent,
  createContext,
  createEffect,
  createMemo,
  onCleanup,
  useContext,
} from "solid-js"
import type { Accessor, ParentProps } from "solid-js"
import * as Context from "effect/Context"
import type { Atom, Writable } from "./atom"
import * as Registry from "./registry"
import type { Result } from "./result"

let _defaultRegistry: Registry.Registry | undefined
const defaultRegistry = (() => {
  if (_defaultRegistry === undefined) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _defaultRegistry = Registry.make({ services: Context.empty() as Context.Context<any> })
  }
  return _defaultRegistry
})()

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
  readonly services?: Context.Context<unknown>
  readonly maxEntries?: number
}

export const RegistryProvider = (props: RegistryProviderProps) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const services = props.services ?? (Context.empty() as Context.Context<any>)
  const registry = props.registry ?? Registry.make({ services, maxEntries: props.maxEntries })
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
      if (options?.immediate !== true) return
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
