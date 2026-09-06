import {
  createComponent,
  createContext,
  createEffect,
  createMemo,
  onCleanup,
  useContext,
} from "solid-js"
import type { Accessor, JSX, ParentProps } from "solid-js"
import type * as Cause from "effect/Cause"
import type * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import type { Atom, Writable } from "./atom"
import * as Registry from "./registry"
import type { Result } from "./result"

const defaultRegistry: Registry.Registry<unknown> = Registry.make()

type AtomInput<A, Services = never> = Atom<A, Services> | Accessor<Atom<A, Services>>

type WritableInput<R, W, Services = never> =
  | Writable<R, W, Services>
  | Accessor<Writable<R, W, Services>>

const isAtomAccessor = <A, Services>(
  atom: AtomInput<A, Services>,
): atom is Accessor<Atom<A, Services>> => Predicate.isFunction(atom)

const toAccessor = <A, Services>(atom: AtomInput<A, Services>): Accessor<Atom<A, Services>> => {
  if (isAtomAccessor(atom)) return atom
  return () => atom
}

const isWritableAccessor = <R, W, Services>(
  atom: WritableInput<R, W, Services>,
): atom is Accessor<Writable<R, W, Services>> => Predicate.isFunction(atom)

const toWritableAccessor = <R, W, Services>(
  atom: WritableInput<R, W, Services>,
): Accessor<Writable<R, W, Services>> => {
  if (isWritableAccessor(atom)) return atom
  return () => atom
}

export interface RegistryProviderProps<Services = unknown> extends ParentProps {
  readonly registry?: Registry.Registry<Services>
  readonly services?: Context.Context<Services>
  readonly maxEntries?: number
}

export interface RegistryScope<Services> {
  readonly RegistryContext: ReturnType<typeof createContext<Registry.Registry<Services>>>
  readonly RegistryProvider: (props: RegistryProviderProps<Services>) => JSX.Element
  readonly useRegistry: () => Registry.Registry<Services>
  readonly useAtomValue: <A, AtomServices extends Services = never>(
    atom: AtomInput<A, AtomServices>,
  ) => Accessor<A>
  readonly useAtomSet: <R, W, AtomServices extends Services = never>(
    atom: WritableInput<R, W, AtomServices>,
  ) => (value: W | ((value: R) => W)) => void
  readonly useAtomRefresh: <A, AtomServices extends Services = never>(
    atom: AtomInput<A, AtomServices>,
  ) => () => void
  readonly useAtomSubscribe: <A, AtomServices extends Services = never>(
    atom: AtomInput<A, AtomServices>,
    f: (value: A) => void,
    options?: { readonly immediate?: boolean },
  ) => void
  readonly useAtom: <R, W, AtomServices extends Services = never>(
    atom: WritableInput<R, W, AtomServices>,
  ) => readonly [Accessor<R>, (next: W | ((value: R) => W)) => void]
  readonly useAtomResult: <A, E, AtomServices extends Services = never>(
    atom: AtomInput<Result<A, E>, AtomServices>,
  ) => {
    readonly result: Accessor<Result<A, E>>
    // eslint-disable-next-line effect/noNullish -- Solid accessors omit absent JSX content with undefined.
    readonly value: () => A | undefined
    // eslint-disable-next-line effect/noNullish -- Solid accessors omit absent JSX content with undefined.
    readonly error: () => Cause.Cause<E> | undefined
    readonly loading: () => boolean
  }
}

const mountAtom = <A, Services, AtomServices extends Services>(
  registry: Registry.Registry<Services>,
  atomAccessor: Accessor<Atom<A, AtomServices>>,
) => {
  createEffect(() => {
    const atom = atomAccessor()
    const unmount = registry.mount(atom)
    onCleanup(unmount)
  })
}

const makeRegistryHooks = <Services>(useRegistry: () => Registry.Registry<Services>) => {
  const useAtomValue = <A, AtomServices extends Services = never>(
    atom: AtomInput<A, AtomServices>,
  ): Accessor<A> => {
    const registry = useRegistry()
    const atomAccessor = toAccessor(atom)
    mountAtom(registry, atomAccessor)
    return createMemo(() => registry.read(atomAccessor())())
  }

  const useAtomSet = <R, W, AtomServices extends Services = never>(
    atom: WritableInput<R, W, AtomServices>,
  ) => {
    const registry = useRegistry()
    const atomAccessor = toWritableAccessor(atom)
    mountAtom(registry, atomAccessor)

    return (value: W | ((value: R) => W)) => {
      registry.set(atomAccessor(), value)
    }
  }

  const useAtomRefresh = <A, AtomServices extends Services = never>(
    atom: AtomInput<A, AtomServices>,
  ) => {
    const registry = useRegistry()
    const atomAccessor = toAccessor(atom)
    mountAtom(registry, atomAccessor)
    return () => registry.refresh(atomAccessor())
  }

  const useAtomSubscribe = <A, AtomServices extends Services = never>(
    atom: AtomInput<A, AtomServices>,
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

  const useAtom = <R, W, AtomServices extends Services = never>(
    atom: WritableInput<R, W, AtomServices>,
  ): readonly [Accessor<R>, (next: W | ((value: R) => W)) => void] => {
    const registry = useRegistry()
    const atomAccessor = toWritableAccessor(atom)
    mountAtom(registry, atomAccessor)
    const value = createMemo(() => registry.read(atomAccessor())())
    const set = (next: W | ((value: R) => W)) => {
      registry.set(atomAccessor(), next)
    }
    return [value, set]
  }

  const useAtomResult = <A, E, AtomServices extends Services = never>(
    atom: AtomInput<Result<A, E>, AtomServices>,
  ) => {
    const result = useAtomValue(atom)
    const value = () => {
      const current = result()
      if (current._tag === "Success") return current.value
      // eslint-disable-next-line effect/noNullish -- Preserve the Solid accessor absence contract.
      return undefined
    }
    const error = () => {
      const current = result()
      if (current._tag === "Failure") return current.cause
      // eslint-disable-next-line effect/noNullish -- Preserve the Solid accessor absence contract.
      return undefined
    }
    const loading = () => {
      const current = result()
      return current._tag === "Initial" || current.waiting
    }
    return { result, value, error, loading }
  }

  return {
    useAtomValue,
    useAtomSet,
    useAtomRefresh,
    useAtomSubscribe,
    useAtom,
    useAtomResult,
  }
}

export const makeRegistryScope = <Services>(defaultValue: Registry.Registry<Services>) => {
  const RegistryContext = createContext<Registry.Registry<Services>>(defaultValue)

  const useRegistry = (): Registry.Registry<Services> => useContext(RegistryContext)

  const RegistryProvider = (props: RegistryProviderProps<Services>): JSX.Element => {
    const providedRegistry = Option.fromNullishOr(props.registry)
    const services = Option.fromNullishOr(props.services)
    const registry = Option.getOrElse(providedRegistry, () =>
      Option.match(services, {
        onNone: () => defaultValue,
        onSome: (services) => Registry.make({ services, maxEntries: props.maxEntries }),
      }),
    )
    const shouldDispose = Option.isNone(providedRegistry) && Option.isSome(services)

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

  return {
    RegistryContext,
    RegistryProvider,
    useRegistry,
    ...makeRegistryHooks(useRegistry),
  } satisfies RegistryScope<Services>
}

const defaultScope = makeRegistryScope(defaultRegistry)

export const RegistryContext = defaultScope.RegistryContext
export const RegistryProvider = defaultScope.RegistryProvider
export const useRegistry = defaultScope.useRegistry
export const useAtomValue = defaultScope.useAtomValue
export const useAtomSet = defaultScope.useAtomSet
export const useAtomRefresh = defaultScope.useAtomRefresh
export const useAtomSubscribe = defaultScope.useAtomSubscribe
export const useAtom = defaultScope.useAtom
export const useAtomResult = defaultScope.useAtomResult
