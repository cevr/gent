/* eslint-disable @typescript-eslint/no-explicit-any */
import { Effect } from "effect"
import type {
  ExtensionKind,
  ExtensionHookMap,
  Interceptor,
  LoadedExtension,
  Observer,
} from "../../domain/extension.js"

// Compiled Hook Map — pre-built middleware chains and observer dispatchers
//
// Uses `any` for runtime dispatch since hooks are heterogeneous.
// Type safety is enforced at the registration site (defineExtension / ExtensionHookMap).

export interface CompiledHookMap {
  readonly runInterceptor: <K extends keyof ExtensionHookMap>(
    key: K,
    input: Parameters<ExtensionHookMap[K]>[0],
    base: (input: Parameters<ExtensionHookMap[K]>[0]) => ReturnType<ExtensionHookMap[K]>,
  ) => ReturnType<ExtensionHookMap[K]>

  readonly notifyObservers: <K extends keyof ExtensionHookMap>(
    key: K,
    event: Parameters<ExtensionHookMap[K]>[0],
  ) => Effect.Effect<void, never, never>
}

const SCOPE_ORDER: Record<ExtensionKind, number> = { builtin: 0, user: 1, project: 2 }

const INTERCEPTOR_KEYS = new Set<string>([
  "prompt.system",
  "agent.resolve",
  "tools.visible",
  "tool.execute",
  "provider.request",
  "permission.check",
])

/**
 * Compile hooks from loaded extensions into a CompiledHookMap.
 *
 * Interceptor chain: builtin → user → project (inner to outer via left fold).
 * Observers: same order, errors isolated per observer.
 */
export const compileHooks = (extensions: ReadonlyArray<LoadedExtension>): CompiledHookMap => {
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_ORDER[a.kind] - SCOPE_ORDER[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

  const interceptorChains = new Map<string, Array<Interceptor<unknown, unknown, never, never>>>()
  const observerLists = new Map<string, Array<Observer<unknown, never, never>>>()

  for (const ext of sorted) {
    const hooks = ext.setup.hooks
    if (hooks === undefined) continue

    for (const [key, hook] of Object.entries(hooks)) {
      if (hook === undefined) continue
      if (INTERCEPTOR_KEYS.has(key)) {
        const chain = interceptorChains.get(key) ?? []
        chain.push(hook as Interceptor<unknown, unknown, never, never>)
        interceptorChains.set(key, chain)
      } else {
        const list = observerLists.get(key) ?? []
        list.push(hook as Observer<unknown, never, never>)
        observerLists.set(key, list)
      }
    }
  }

  const runInterceptor = <K extends keyof ExtensionHookMap>(
    key: K,
    input: Parameters<ExtensionHookMap[K]>[0],
    base: (input: Parameters<ExtensionHookMap[K]>[0]) => ReturnType<ExtensionHookMap[K]>,
  ): ReturnType<ExtensionHookMap[K]> => {
    const chain = interceptorChains.get(key)
    if (chain === undefined || chain.length === 0) return base(input)
    // Left fold: builtin wraps base, project wraps that → project outermost
    let composed = base as (i: unknown) => Effect.Effect<unknown, never, never>
    for (const interceptor of chain) {
      const prev = composed
      composed = (i: unknown) => interceptor(i, prev) as Effect.Effect<unknown, never, never>
    }
    return composed(input) as ReturnType<ExtensionHookMap[K]>
  }

  const notifyObservers = <K extends keyof ExtensionHookMap>(
    key: K,
    event: Parameters<ExtensionHookMap[K]>[0],
  ): Effect.Effect<void, never, never> => {
    const list = observerLists.get(key)
    if (list === undefined || list.length === 0) return Effect.void
    return Effect.forEach(
      list,
      (observer) => observer(event).pipe(Effect.catchDefect(() => Effect.void)),
      { discard: true },
    )
  }

  return { runInterceptor, notifyObservers }
}
