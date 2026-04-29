import { describe, it, expect, test } from "effect-bun-test"
import { createComponent, createRoot } from "solid-js"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { atom, effect, make, makeRegistryScope, state, type Registry } from "../../src/atom-solid"
import * as Result from "../../src/atom-solid/result"
class Greeting extends Context.Service<
  Greeting,
  {
    readonly text: string
  }
>()("@gent/tui/tests/atom-solid/Greeting") {}
const waitFor = (predicate: () => boolean): Promise<void> =>
  new Promise((resolve, reject) => {
    let attempts = 20
    const check = () => {
      if (predicate()) {
        resolve()
        return
      }
      attempts -= 1
      if (attempts <= 0) {
        reject(new Error("condition did not settle"))
        return
      }
      setTimeout(check, 0)
    }
    check()
  })
describe("atom-solid registry", () => {
  test("keeps distinct atom instances isolated", () => {
    const registry = make()
    const first = state(1)
    const second = state(1)
    const firstUnmount = registry.mount(first)
    const secondUnmount = registry.mount(second)
    registry.set(first, 2)
    expect(registry.get(first)).toBe(2)
    expect(registry.get(second)).toBe(1)
    firstUnmount()
    secondUnmount()
    registry.dispose()
  })
  test("uses atom object identity instead of forgeable public keys", () => {
    const registry = make()
    const first = state(1)
    const clone: typeof first = { ...first }
    const firstUnmount = registry.mount(first)
    const cloneUnmount = registry.mount(clone)
    registry.set(first, 2)
    expect(registry.get(first)).toBe(2)
    expect(registry.get(clone)).toBe(1)
    firstUnmount()
    cloneUnmount()
    registry.dispose()
  })
  test("evicts unmounted atom instances by owned key", () => {
    const registry = make({ maxEntries: 1 })
    const disposed: string[] = []
    const makeDisposableAtom = (id: string) =>
      atom(() => ({
        get: () => id,
        dispose: () => {
          disposed.push(id)
        },
      }))
    const first = makeDisposableAtom("first")
    const second = makeDisposableAtom("second")
    const unmountFirst = registry.mount(first)
    unmountFirst()
    const unmountSecond = registry.mount(second)
    expect(disposed).toEqual(["first"])
    expect(registry.get(second)).toBe("second")
    unmountSecond()
    registry.dispose()
  })
  it.live("runs service-backed atoms through the typed registry services", () =>
    Effect.gen(function* () {
      const services = Context.add(Context.empty(), Greeting, { text: "hello" })
      const registry = make({ services })
      const greeting = effect(
        Effect.gen(function* () {
          const service = yield* Greeting
          return service.text
        }),
      )
      const unmount = registry.mount(greeting)
      yield* Effect.promise(() => waitFor(() => Result.isSuccess(registry.get(greeting))))
      expect(Result.getOrUndefined(registry.get(greeting))).toBe("hello")
      unmount()
      registry.dispose()
    }),
  )
  it.live("typed registry scope hooks read provider-owned services without caller casts", () =>
    Effect.gen(function* () {
      const services = Context.add(Context.empty(), Greeting, { text: "scoped" })
      const registry = make({ services })
      const scope = makeRegistryScope(registry)
      const greeting = effect(
        Effect.gen(function* () {
          const service = yield* Greeting
          return service.text
        }),
      )
      let observedRegistry: Registry<Greeting> | undefined
      let observed: string | undefined
      const dispose = createRoot((disposeRoot) => {
        createComponent(scope.RegistryProvider, {
          registry,
          get children() {
            observedRegistry = scope.useRegistry()
            const result = scope.useAtomValue(greeting)
            observed = Result.getOrUndefined(result())
            return undefined
          },
        })
        return disposeRoot
      })
      yield* Effect.promise(() => waitFor(() => observed === "scoped"))
      expect(observedRegistry).toBe(registry)
      expect(observed).toBe("scoped")
      dispose()
      registry.dispose()
    }),
  )
  it.live("typed registry providers reuse scoped defaults when services are omitted", () =>
    Effect.gen(function* () {
      const services = Context.add(Context.empty(), Greeting, { text: "default-scope" })
      const registry = make({ services })
      const scope = makeRegistryScope(registry)
      const greeting = effect(
        Effect.gen(function* () {
          const service = yield* Greeting
          return service.text
        }),
      )
      let observed: string | undefined
      const dispose = createRoot((disposeRoot) => {
        createComponent(scope.RegistryProvider, {
          get children() {
            const result = scope.useAtomValue(greeting)
            observed = Result.getOrUndefined(result())
            return undefined
          },
        })
        return disposeRoot
      })
      yield* Effect.promise(() => waitFor(() => observed === "default-scope"))
      expect(observed).toBe("default-scope")
      dispose()
      registry.dispose()
    }),
  )
})
