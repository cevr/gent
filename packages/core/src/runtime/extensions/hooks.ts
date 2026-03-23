import { Effect } from "effect"
import type {
  ExtensionHooks,
  ExtensionInterceptorMap,
  ExtensionKind,
  ExtensionObserverMap,
  LoadedExtension,
} from "../../domain/extension.js"

export interface CompiledHookMap {
  readonly runInterceptor: <K extends keyof ExtensionInterceptorMap>(
    key: K,
    input: Parameters<ExtensionInterceptorMap[K]>[0],
    base: (
      input: Parameters<ExtensionInterceptorMap[K]>[0],
    ) => ReturnType<ExtensionInterceptorMap[K]>,
  ) => ReturnType<ExtensionInterceptorMap[K]>

  readonly notifyObservers: <K extends keyof ExtensionObserverMap>(
    key: K,
    event: Parameters<ExtensionObserverMap[K]>[0],
  ) => Effect.Effect<void, never, never>
}

const SCOPE_ORDER: Record<ExtensionKind, number> = { builtin: 0, user: 1, project: 2 }

const INTERCEPTOR_KEYS = [
  "prompt.system",
  "agent.resolve",
  "tools.visible",
  "tool.execute",
  "provider.request",
  "permission.check",
] as const satisfies ReadonlyArray<keyof ExtensionInterceptorMap>

const OBSERVER_KEYS = [
  "session.start",
  "session.end",
  "handoff.before",
  "handoff.after",
  "agent.switch",
  "stream.start",
  "stream.end",
  "turn.end",
  "tool.call",
  "tool.succeeded",
  "tool.failed",
  "message.received",
] as const satisfies ReadonlyArray<keyof ExtensionObserverMap>

const emptyInterceptors = (): {
  [K in keyof ExtensionInterceptorMap]: Array<ExtensionInterceptorMap[K]>
} => ({
  "prompt.system": [],
  "agent.resolve": [],
  "tools.visible": [],
  "tool.execute": [],
  "provider.request": [],
  "permission.check": [],
})

const emptyObservers = (): {
  [K in keyof ExtensionObserverMap]: Array<ExtensionObserverMap[K]>
} => ({
  "session.start": [],
  "session.end": [],
  "handoff.before": [],
  "handoff.after": [],
  "agent.switch": [],
  "stream.start": [],
  "stream.end": [],
  "turn.end": [],
  "tool.call": [],
  "tool.succeeded": [],
  "tool.failed": [],
  "message.received": [],
})

const appendHooks = (
  hooks: ExtensionHooks | undefined,
  interceptors: ReturnType<typeof emptyInterceptors>,
  observers: ReturnType<typeof emptyObservers>,
) => {
  const interceptorMap = hooks?.interceptors
  if (interceptorMap !== undefined) {
    for (const key of INTERCEPTOR_KEYS) {
      const hook = interceptorMap[key]
      if (hook !== undefined) addInterceptor(interceptors, key, hook)
    }
  }

  const observerMap = hooks?.observers
  if (observerMap !== undefined) {
    for (const key of OBSERVER_KEYS) {
      const hook = observerMap[key]
      if (hook !== undefined) addObserver(observers, key, hook)
    }
  }
}

const addInterceptor = <K extends keyof ExtensionInterceptorMap>(
  interceptors: ReturnType<typeof emptyInterceptors>,
  key: K,
  hook: ExtensionInterceptorMap[K],
) => {
  interceptors[key].push(hook)
}

const addObserver = <K extends keyof ExtensionObserverMap>(
  observers: ReturnType<typeof emptyObservers>,
  key: K,
  hook: ExtensionObserverMap[K],
) => {
  observers[key].push(hook)
}

const composeInterceptors = <K extends keyof ExtensionInterceptorMap>(
  chain: Array<ExtensionInterceptorMap[K]>,
  base: (
    input: Parameters<ExtensionInterceptorMap[K]>[0],
  ) => ReturnType<ExtensionInterceptorMap[K]>,
) => {
  let composed: (
    input: Parameters<ExtensionInterceptorMap[K]>[0],
  ) => ReturnType<ExtensionInterceptorMap[K]> = base
  for (const interceptor of chain) {
    const prev = composed
    composed = ((nextInput) =>
      interceptor(nextInput as never, prev as never) as ReturnType<
        ExtensionInterceptorMap[K]
      >) as typeof composed
  }
  return composed
}

const notifyObserverList = <K extends keyof ExtensionObserverMap>(
  list: Array<ExtensionObserverMap[K]>,
  event: Parameters<ExtensionObserverMap[K]>[0],
) =>
  Effect.forEach(
    list as Array<
      (input: Parameters<ExtensionObserverMap[K]>[0]) => Effect.Effect<void, never, never>
    >,
    (observer) => observer(event).pipe(Effect.catchDefect(() => Effect.void)),
    { discard: true },
  )

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

  const interceptorChains = emptyInterceptors()
  const observerLists = emptyObservers()

  for (const ext of sorted) {
    appendHooks(ext.setup.hooks, interceptorChains, observerLists)
  }

  const runInterceptor = <K extends keyof ExtensionInterceptorMap>(
    key: K,
    input: Parameters<ExtensionInterceptorMap[K]>[0],
    base: (
      input: Parameters<ExtensionInterceptorMap[K]>[0],
    ) => ReturnType<ExtensionInterceptorMap[K]>,
  ): ReturnType<ExtensionInterceptorMap[K]> => {
    const chain = interceptorChains[key] as Array<ExtensionInterceptorMap[K]>
    if (chain.length === 0) return base(input)
    return composeInterceptors(chain, base)(input)
  }

  const notifyObservers = <K extends keyof ExtensionObserverMap>(
    key: K,
    event: Parameters<ExtensionObserverMap[K]>[0],
  ): Effect.Effect<void, never, never> => {
    const list = observerLists[key] as Array<ExtensionObserverMap[K]>
    if (list.length === 0) return Effect.void
    return notifyObserverList(list, event)
  }

  return { runInterceptor, notifyObservers }
}
