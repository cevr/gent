import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import type { Registry } from "./registry"
import * as Result from "./result"
import type { Result as AtomResult } from "./result"

export interface Atom<A, Services = never> {
  readonly key: symbol
  readonly build: (registry: Registry<Services>) => AtomInstance<A>
}

export interface AtomInstance<A> {
  readonly get: Accessor<A>
  readonly refresh?: () => void
  readonly dispose?: () => void
}

export interface Writable<R, W = R, Services = never> extends Atom<R, Services> {
  readonly build: (registry: Registry<Services>) => WritableInstance<R, W>
}

export interface WritableInstance<R, W> extends AtomInstance<R> {
  readonly set: (value: W | ((value: R) => W)) => void
}

export const atom = <A, Services = never>(
  build: (registry: Registry<Services>) => AtomInstance<A>,
): Atom<A, Services> => ({ key: Symbol("atom"), build })

export const writableAtom = <R, W, Services = never>(
  build: (registry: Registry<Services>) => WritableInstance<R, W>,
): Writable<R, W, Services> => ({ key: Symbol("writableAtom"), build })

export const state = <A>(initialValue: A): Writable<A> =>
  writableAtom(() => {
    const [value, setValue] = createSignal(initialValue)
    const set = (next: A | ((value: A) => A)) => {
      if (typeof next === "function") {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- TUI adapter narrows heterogeneous framework value shape
        setValue(next as (value: A) => A)
        return
      }
      setValue(() => next)
    }
    return { get: value, set }
  })

export const readable = <A, Services = never>(
  read: (get: <T, AtomServices extends Services>(atom: Atom<T, AtomServices>) => T) => A,
): Atom<A, Services> =>
  atom((registry) => {
    const get = <T, AtomServices extends Services>(atom: Atom<T, AtomServices>) =>
      registry.read(atom)()
    const memo = createMemo(() => read(get))
    return { get: memo }
  })

export const map = <A, B, Services>(
  atom: Atom<A, Services>,
  f: (value: A) => B,
): Atom<B, Services> => readable((get) => f(get(atom)))

export const effect = <A, E, R>(
  create:
    | Effect.Effect<A, E, R>
    | ((get: <T, Services extends R>(atom: Atom<T, Services>) => T) => Effect.Effect<A, E, R>),
  options?: { readonly initialValue?: A },
): Atom<AtomResult<A, E>, R> =>
  atom((registry) => {
    const initialResult =
      options?.initialValue !== undefined
        ? Result.success<A, E>(options.initialValue)
        : Result.initial<A, E>(true)
    const [result, setResult] = createSignal<AtomResult<A, E>>(initialResult)
    const [version, setVersion] = createSignal(0)
    const get = <T, Services extends R>(atom: Atom<T, Services>) => registry.read(atom)()

    const runEffect = (eff: Effect.Effect<A, E, R>) => {
      let cancelled = false
      const fiber = registry.fork(eff)
      fiber.addObserver((exit) => {
        if (cancelled) return
        setResult(Exit.isSuccess(exit) ? Result.success(exit.value) : Result.failure(exit.cause))
      })
      return () => {
        cancelled = true
        Effect.runFork(Fiber.interrupt(fiber))
      }
    }

    let cancel: (() => void) | undefined
    const cleanup = () => {
      if (cancel === undefined) return
      cancel()
      cancel = undefined
    }

    createEffect(() => {
      version()
      cleanup()
      const eff = typeof create === "function" ? create(get) : create
      setResult((prev) => Result.waiting(prev))
      cancel = runEffect(eff)
      onCleanup(cleanup)
    })

    return {
      get: result,
      refresh: () => setVersion((current) => current + 1),
      dispose: cleanup,
    }
  })
