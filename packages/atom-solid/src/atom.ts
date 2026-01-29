import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Runtime from "effect/Runtime"
import type { Registry } from "./registry"
import * as Result from "./result"
import type { Result as AtomResult } from "./result"

export interface Atom<A> {
  readonly build: (registry: Registry) => AtomInstance<A>
}

export interface AtomInstance<A> {
  readonly get: Accessor<A>
  readonly refresh?: () => void
  readonly dispose?: () => void
}

export interface Writable<R, W = R> extends Atom<R> {
  readonly build: (registry: Registry) => WritableInstance<R, W>
}

export interface WritableInstance<R, W> extends AtomInstance<R> {
  readonly set: (value: W | ((value: R) => W)) => void
}

export const atom = <A>(build: (registry: Registry) => AtomInstance<A>): Atom<A> => ({ build })

export const writableAtom = <R, W>(
  build: (registry: Registry) => WritableInstance<R, W>,
): Writable<R, W> => ({ build })

export const state = <A>(initialValue: A): Writable<A> =>
  writableAtom(() => {
    const [value, setValue] = createSignal(initialValue)
    const set = (next: A | ((value: A) => A)) => {
      if (typeof next === "function") {
        setValue(next as (value: A) => A)
        return
      }
      setValue(() => next)
    }
    return { get: value, set }
  })

export const readable = <A>(read: (get: <T>(atom: Atom<T>) => T) => A): Atom<A> =>
  atom((registry) => {
    const get = <T>(atom: Atom<T>) => registry.read(atom)()
    const memo = createMemo(() => read(get))
    return { get: memo }
  })

export const map = <A, B>(atom: Atom<A>, f: (value: A) => B): Atom<B> =>
  readable((get) => f(get(atom)))

export const effect = <A, E, R>(
  create: Effect.Effect<A, E, R> | ((get: <T>(atom: Atom<T>) => T) => Effect.Effect<A, E, R>),
  options?: { readonly initialValue?: A },
): Atom<AtomResult<A, E>> =>
  atom((registry) => {
    const initialResult =
      options?.initialValue !== undefined
        ? Result.success<A, E>(options.initialValue)
        : Result.initial<A, E>(true)
    const [result, setResult] = createSignal<AtomResult<A, E>>(initialResult)
    const [version, setVersion] = createSignal(0)
    const get = <T>(atom: Atom<T>) => registry.read(atom)()

    const runEffect = (eff: Effect.Effect<A, E, R>) => {
      const runtime = registry.runtime as Runtime.Runtime<R>
      let cancelled = false
      const fiber = Runtime.runFork(runtime)(eff)
      fiber.addObserver((exit) => {
        if (cancelled) return
        setResult(Exit.isSuccess(exit) ? Result.success(exit.value) : Result.failure(exit.cause))
      })
      return () => {
        cancelled = true
        const interrupt = Fiber.interruptFork(fiber)
        Runtime.runFork(runtime)(interrupt)
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
