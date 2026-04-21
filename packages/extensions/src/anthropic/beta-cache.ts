/**
 * AnthropicBetaCache — cross-request learning cache for "betas the
 * server rejected for this model".
 *
 * This isn't just per-request retry state — it's session-level memory
 * so that turn N+1 doesn't include a beta turn N already learned the
 * server hates. Was module-global state in `oauth.ts` (deleted in
 * Commit 4). Now a service so it composes through Layer instead of
 * import-time mutable state, and so tests don't have to thread
 * `initAnthropicKeychainEnv` to reset between runs.
 *
 * Two implicit clear conditions, both ported verbatim:
 *   1. `betaFlags` env changes — user toggled flags, prior learning
 *      may no longer apply.
 *   2. `modelId` changes — different model, different beta surface.
 *
 * `getExcluded` takes `currentBetaFlags` as a parameter (not yielded
 * from a hidden module). Production wiring passes `_env.betaFlags` from
 * `oauth.ts`; tests can pass anything they want. No global mutation.
 */

import { Context, Effect, Layer, Ref } from "effect"

// ── Internal cache cell ──

export interface BetaCacheCell {
  readonly map: ReadonlyMap<string, ReadonlySet<string>>
  readonly lastBetaFlags: string | undefined
  readonly lastModelId: string | undefined
}

export const EMPTY_BETA_CELL: BetaCacheCell = {
  map: new Map(),
  lastBetaFlags: undefined,
  lastModelId: undefined,
}

const cellAfterMaybeClear = (
  cell: BetaCacheCell,
  currentBetaFlags: string | undefined,
  modelId: string,
): BetaCacheCell => {
  // Env betaFlags changed → clear everything. (Note: prior shape
  // tracked `lastBetaFlagsEnv` separately; here it's part of the cell.)
  if (cell.lastBetaFlags !== currentBetaFlags) {
    return { map: new Map(), lastBetaFlags: currentBetaFlags, lastModelId: modelId }
  }
  // Model changed → clear (prior shape only cleared when lastModelId
  // was already set, but the result is identical because the very
  // first request also has nothing to clear).
  if (cell.lastModelId !== undefined && cell.lastModelId !== modelId) {
    return { map: new Map(), lastBetaFlags: currentBetaFlags, lastModelId: modelId }
  }
  return { ...cell, lastModelId: modelId }
}

// ── Service interface ──

export interface AnthropicBetaCacheShape {
  /**
   * Get the set of betas previously learned to be rejected for `modelId`
   * under the current `betaFlags` env. Auto-clears the entire cache if
   * either the env flags or the model differs from the last call.
   */
  readonly getExcluded: (
    modelId: string,
    currentBetaFlags: string | undefined,
  ) => Effect.Effect<ReadonlySet<string>>
  /**
   * Record that `beta` was rejected for `modelId` under the current
   * `betaFlags` env. Runs the same env/model-change clear logic as
   * `getExcluded` so the call is standalone-safe (no hidden ordering
   * contract).
   */
  readonly recordExcluded: (
    modelId: string,
    beta: string,
    currentBetaFlags: string | undefined,
  ) => Effect.Effect<void>
}

// ── Service tag ──

export class AnthropicBetaCache extends Context.Service<
  AnthropicBetaCache,
  AnthropicBetaCacheShape
>()("@gent/extensions/anthropic/BetaCache") {
  static layer: Layer.Layer<AnthropicBetaCache> = Layer.effect(
    AnthropicBetaCache,
    Effect.gen(function* () {
      const cellRef = yield* Ref.make<BetaCacheCell>(EMPTY_BETA_CELL)
      return AnthropicBetaCache.buildShape(cellRef)
    }),
  )

  /**
   * Counsel C3 fix: cell Ref provided externally so the cache can live
   * for the extension lifetime instead of being rebuilt for every
   * `resolveModel` call. Without this, cross-request beta learning is
   * lost — a beta the server rejected on turn N would still appear on
   * turn N+1 because the rebuild zeros the map.
   */
  static layerFromRef = (cellRef: Ref.Ref<BetaCacheCell>): Layer.Layer<AnthropicBetaCache> =>
    Layer.succeed(AnthropicBetaCache, AnthropicBetaCache.buildShape(cellRef))

  private static buildShape = (cellRef: Ref.Ref<BetaCacheCell>): AnthropicBetaCacheShape => {
    const getExcluded = (
      modelId: string,
      currentBetaFlags: string | undefined,
    ): Effect.Effect<ReadonlySet<string>> =>
      Ref.modify(cellRef, (cell) => {
        const next = cellAfterMaybeClear(cell, currentBetaFlags, modelId)
        const excluded = next.map.get(modelId) ?? new Set<string>()
        return [excluded, next] as const
      })

    const recordExcluded = (
      modelId: string,
      beta: string,
      currentBetaFlags: string | undefined,
    ): Effect.Effect<void> =>
      Ref.update(cellRef, (cell) => {
        // Apply the same clear/seed transition as getExcluded so the
        // call is standalone-safe — no hidden contract that
        // recordExcluded must follow a getExcluded.
        const seeded = cellAfterMaybeClear(cell, currentBetaFlags, modelId)
        const existing = seeded.map.get(modelId) ?? new Set<string>()
        const updated = new Set(existing)
        updated.add(beta)
        const nextMap = new Map(seeded.map)
        nextMap.set(modelId, updated)
        return { ...seeded, map: nextMap }
      })

    return AnthropicBetaCache.of({ getExcluded, recordExcluded })
  }
}
