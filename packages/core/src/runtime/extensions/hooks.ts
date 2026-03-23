import { Effect } from "effect"
import type {
  ExtensionHooks,
  ExtensionInterceptorDescriptor,
  ExtensionInterceptorKey,
  ExtensionInterceptorMap,
  ExtensionKind,
  ExtensionObserverDescriptor,
  ExtensionObserverKey,
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

type InterceptorChains = {
  [K in ExtensionInterceptorKey]: Array<ExtensionInterceptorMap[K]>
}

type ObserverLists = {
  [K in ExtensionObserverKey]: Array<ExtensionObserverMap[K]>
}

type InterceptorInput<K extends ExtensionInterceptorKey> = Parameters<ExtensionInterceptorMap[K]>[0]
type InterceptorOutput<K extends ExtensionInterceptorKey> = ReturnType<ExtensionInterceptorMap[K]>
type ObserverEvent<K extends ExtensionObserverKey> = Parameters<ExtensionObserverMap[K]>[0]

const emptyInterceptors = (): InterceptorChains => ({
  "prompt.system": [],
  "agent.resolve": [],
  "tools.visible": [],
  "tool.execute": [],
  "provider.request": [],
  "permission.check": [],
})

const emptyObservers = (): ObserverLists => ({
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
  interceptors: InterceptorChains,
  observers: ObserverLists,
) => {
  for (const descriptor of hooks?.interceptors ?? []) {
    addInterceptor(interceptors, descriptor)
  }

  for (const descriptor of hooks?.observers ?? []) {
    addObserver(observers, descriptor)
  }
}

const addInterceptor = <K extends keyof ExtensionInterceptorMap>(
  interceptors: InterceptorChains,
  descriptor: ExtensionInterceptorDescriptor<K>,
) => {
  interceptors[descriptor.key].push(descriptor.run)
}

const addObserver = <K extends keyof ExtensionObserverMap>(
  observers: ObserverLists,
  descriptor: ExtensionObserverDescriptor<K>,
) => {
  observers[descriptor.key].push(descriptor.run)
}

const composeInterceptors = <K extends keyof ExtensionInterceptorMap>(
  chain: ReadonlyArray<ExtensionInterceptorMap[K]>,
  base: (input: InterceptorInput<K>) => InterceptorOutput<K>,
) => {
  let next: (input: InterceptorInput<K>) => InterceptorOutput<K> = base
  for (const interceptor of chain) {
    const previous = next
    const run = interceptor as unknown as (
      input: InterceptorInput<K>,
      next: (input: InterceptorInput<K>) => InterceptorOutput<K>,
    ) => InterceptorOutput<K>
    next = (input) => run(input, previous)
  }
  return next
}

const notifyObserverList = <K extends keyof ExtensionObserverMap>(
  list: ReadonlyArray<ExtensionObserverMap[K]>,
  event: ObserverEvent<K>,
) =>
  Effect.gen(function* () {
    for (const observer of list) {
      const run = observer as (event: ObserverEvent<K>) => Effect.Effect<void, never, never>
      yield* run(event).pipe(Effect.catchDefect(() => Effect.void))
    }
  })

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
