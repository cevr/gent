/**
 * PipelineHost — compile `PipelineContribution[]` into per-key transforming
 * chains. Replaces the transforming half of the legacy `interceptor-registry`.
 *
 * Sister host: `subscription-host.ts` for void observers.
 *
 * Composition: scope-ordered (builtin → user → project, then id-stable),
 * left-fold over each key's chain, with defect isolation around every
 * pipeline body — a defect in one handler logs a warning and falls through
 * to the previous `next`. Behavior preserved from the legacy host.
 *
 * @module
 */
import { Effect } from "effect"
import type { LoadedExtension, ExtensionKind } from "../../domain/extension.js"
import type { ExtensionHostContext } from "../../domain/extension-host-context.js"
import type {
  AnyPipelineContribution,
  PipelineHandler,
  PipelineInput,
  PipelineKey,
  PipelineOutput,
} from "../../domain/pipeline.js"

export interface CompiledPipelines {
  readonly runPipeline: <K extends PipelineKey>(
    key: K,
    input: PipelineInput<K>,
    base: (input: PipelineInput<K>) => Effect.Effect<PipelineOutput<K>>,
    ctx: ExtensionHostContext,
  ) => Effect.Effect<PipelineOutput<K>>
}

const SCOPE_ORDER: Record<ExtensionKind, number> = { builtin: 0, user: 1, project: 2 }

type PipelineChains = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in PipelineKey]: Array<PipelineHandler<K, any, any>>
}

const emptyChains = (): PipelineChains => ({
  "prompt.system": [],
  "tool.execute": [],
  "permission.check": [],
  "context.messages": [],
  "tool.result": [],
  "message.input": [],
})

const composeChain = <K extends PipelineKey>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chain: ReadonlyArray<PipelineHandler<K, any, any>>,
  base: (input: PipelineInput<K>) => Effect.Effect<PipelineOutput<K>>,
  ctx: ExtensionHostContext,
): ((input: PipelineInput<K>) => Effect.Effect<PipelineOutput<K>>) => {
  let next: (input: PipelineInput<K>) => Effect.Effect<PipelineOutput<K>> = base
  for (const handler of chain) {
    const previous = next
    next = (input) =>
      // @effect-diagnostics-next-line anyUnknownInErrorContext:off — pipeline R/E erased at host boundary; resource layer provides R at composition time
      Effect.suspend(
        () =>
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
          handler(input, previous, ctx) as Effect.Effect<PipelineOutput<K>>,
      ).pipe(
        Effect.catchDefect((defect) =>
          Effect.logWarning("extension.pipeline.defect").pipe(
            Effect.annotateLogs({ hook: String(handler.name ?? "anon"), defect: String(defect) }),
            Effect.andThen(previous(input)),
          ),
        ),
      )
  }
  return next
}

export const compilePipelines = (extensions: ReadonlyArray<LoadedExtension>): CompiledPipelines => {
  const sorted = [...extensions].sort((a, b) => {
    const scopeDiff = SCOPE_ORDER[a.kind] - SCOPE_ORDER[b.kind]
    if (scopeDiff !== 0) return scopeDiff
    return a.manifest.id.localeCompare(b.manifest.id)
  })

  const chains = emptyChains()
  for (const ext of sorted) {
    for (const contribution of ext.contributions.pipelines ?? []) {
      const c = contribution as AnyPipelineContribution
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      ;(chains[c.hook] as Array<unknown>).push(c.handler as unknown)
    }
  }

  const runPipeline = <K extends PipelineKey>(
    key: K,
    input: PipelineInput<K>,
    base: (input: PipelineInput<K>) => Effect.Effect<PipelineOutput<K>>,
    ctx: ExtensionHostContext,
  ): Effect.Effect<PipelineOutput<K>> => {
    const chain = chains[key]
    if (chain.length === 0) return base(input)
    return composeChain(chain, base, ctx)(input)
  }

  return { runPipeline }
}
