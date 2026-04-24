import {
  createComponent,
  createContext,
  createEffect,
  createMemo,
  onCleanup,
  useContext,
} from "solid-js"
import type { Accessor, ParentProps } from "solid-js"
import type * as Context from "effect/Context"
import type { Atom, Writable } from "./atom"
import * as Registry from "./registry"
import type { Result } from "./result"

let _defaultRegistry: Registry.Registry | undefined
const defaultRegistry = (() => {
  if (_defaultRegistry === undefined) {
    _defaultRegistry = Registry.make()
  }
  return _defaultRegistry
})()

export const RegistryContext = createContext<Registry.Registry<unknown>>(defaultRegistry)

export const useRegistry = <Services = never>(): Registry.Registry<Services> =>
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TUI adapter narrows heterogeneous framework value shape
  useContext(RegistryContext) as Registry.Registry<Services>

type AtomInput<A, Services = never> = Atom<A, Services> | Accessor<Atom<A, Services>>

type WritableInput<R, W, Services = never> =
  | Writable<R, W, Services>
  | Accessor<Writable<R, W, Services>>

const toAccessor = <A, Services>(atom: AtomInput<A, Services>): Accessor<Atom<A, Services>> =>
  typeof atom === "function" ? (atom as Accessor<Atom<A, Services>>) : () => atom

const toWritableAccessor = <R, W, Services>(
  atom: WritableInput<R, W, Services>,
): Accessor<Writable<R, W, Services>> =>
  typeof atom === "function" ? (atom as Accessor<Writable<R, W, Services>>) : () => atom

export interface RegistryProviderProps<Services = unknown> extends ParentProps {
  readonly registry?: Registry.Registry<Services>
  readonly services?: Context.Context<Services>
  readonly maxEntries?: number
}

export const RegistryProvider = <Services = unknown>(props: RegistryProviderProps<Services>) => {
  const registry =
    props.registry ??
    (props.services === undefined
      ? Registry.make({ maxEntries: props.maxEntries })
      : Registry.make({ services: props.services, maxEntries: props.maxEntries }))
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

const mountAtom = <A, Services>(
  registry: Registry.Registry<Services>,
  atomAccessor: Accessor<Atom<A, Services>>,
) => {
  createEffect(() => {
    const atom = atomAccessor()
    const unmount = registry.mount(atom)
    onCleanup(unmount)
  })
}

export const useAtomValue = <A, Services = never>(atom: AtomInput<A, Services>): Accessor<A> => {
  const registry = useRegistry<Services>()
  const atomAccessor = toAccessor(atom)
  mountAtom(registry, atomAccessor)
  return createMemo(() => registry.read(atomAccessor())())
}

export const useAtomSet = <R, W, Services = never>(atom: WritableInput<R, W, Services>) => {
  const registry = useRegistry<Services>()
  const atomAccessor = toWritableAccessor(atom)
  mountAtom(registry, atomAccessor)

  return (value: W | ((value: R) => W)) => {
    registry.set(atomAccessor(), value)
  }
}

export const useAtomRefresh = <A, Services = never>(atom: AtomInput<A, Services>) => {
  const registry = useRegistry<Services>()
  const atomAccessor = toAccessor(atom)
  mountAtom(registry, atomAccessor)
  return () => registry.refresh(atomAccessor())
}

export const useAtomSubscribe = <A, Services = never>(
  atom: AtomInput<A, Services>,
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

export const useAtom = <R, W, Services = never>(atom: WritableInput<R, W, Services>) => {
  const registry = useRegistry<Services>()
  const atomAccessor = toWritableAccessor(atom)
  mountAtom(registry, atomAccessor)
  const value = createMemo(() => registry.read(atomAccessor())())
  const set = (next: W | ((value: R) => W)) => {
    registry.set(atomAccessor(), next)
  }
  return [value, set] as const
}

export const useAtomResult = <A, E, Services = never>(atom: AtomInput<Result<A, E>, Services>) => {
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
