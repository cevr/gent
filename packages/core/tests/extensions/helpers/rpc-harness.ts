/**
 * RPC acceptance harness — exercises real extension actors through per-request
 * RPC scopes, matching production lifetime behavior.
 *
 * Backed by createE2ELayer + Gent.test. Each RPC call creates a fresh Scope
 * that closes when the call returns (via RpcServer internals), so actor lifetime
 * bugs that only manifest across request boundaries are caught here.
 */
import type { Effect, Layer, Scope } from "effect"
import type { Provider } from "@gent/core/providers/provider"
import { Gent, type GentClientBundle } from "@gent/sdk"
import { createE2ELayer, type E2ELayerConfig } from "@gent/core/test-utils/e2e-layer"

export interface RpcHarnessConfig extends Omit<E2ELayerConfig, "providerLayer"> {
  readonly providerLayer: Layer.Layer<Provider>
}

/**
 * Build an in-process RPC client backed by the full E2E layer.
 *
 * Usage with createSequenceProvider:
 * ```ts
 * const { layer: providerLayer } = yield* createSequenceProvider([textStep("hi")])
 * const { client } = yield* createRpcHarness({ providerLayer })
 * const session = yield* client.session.create({ cwd: "/tmp" })
 * ```
 */
export const createRpcHarness = (
  config: RpcHarnessConfig,
): Effect.Effect<GentClientBundle, never, Scope.Scope> => Gent.test(createE2ELayer(config))
