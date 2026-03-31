import { Effect } from "effect"
import type {
  ExtensionHooks,
  ExtensionInterceptorDescriptor,
  ExtensionInterceptorKey,
  ExtensionInterceptorMap,
  ExtensionKind,
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
}

const SCOPE_ORDER: Record<ExtensionKind, number> = { builtin: 0, user: 1, project: 2 }

type InterceptorChains = {
  [K in ExtensionInterceptorKey]: Array<ExtensionInterceptorMap[K]>
}

type InterceptorInput<K extends ExtensionInterceptorKey> = Parameters<ExtensionInterceptorMap[K]>[0]
type InterceptorOutput<K extends ExtensionInterceptorKey> = ReturnType<ExtensionInterceptorMap[K]>

const emptyInterceptors = (): InterceptorChains => ({
  "prompt.system": [],
  "tool.execute": [],
  "permission.check": [],
  "context.messages": [],
  "turn.after": [],
  "tool.result": [],
})

const appendHooks = (hooks: ExtensionHooks | undefined, interceptors: InterceptorChains) => {
  for (const descriptor of hooks?.interceptors ?? []) {
    addInterceptor(interceptors, descriptor)
  }
}

const addInterceptor = <K extends keyof ExtensionInterceptorMap>(
  interceptors: InterceptorChains,
  descriptor: ExtensionInterceptorDescriptor<K>,
) => {
  interceptors[descriptor.key].push(descriptor.run)
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
    next = (input) =>
      Effect.suspend(() => run(input, previous) as Effect.Effect<unknown>).pipe(
        Effect.catchDefect((defect) =>
          Effect.logWarning("extension.interceptor.defect").pipe(
            Effect.annotateLogs({ defect: String(defect) }),
            Effect.andThen(previous(input)),
          ),
        ),
      ) as InterceptorOutput<K>
  }
  return next
}

/**
 * Compile hooks from loaded extensions into a CompiledHookMap.
 *
 * Interceptor chain: builtin → user → project (inner to outer via left fold).
 */
export const compileHooks = (extensions: ReadonlyArray<LoadedExtension>): CompiledHookMap => {
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_ORDER[a.kind] - SCOPE_ORDER[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

  const interceptorChains = emptyInterceptors()

  for (const ext of sorted) {
    appendHooks(ext.setup.hooks, interceptorChains)
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

  return { runInterceptor }
}
