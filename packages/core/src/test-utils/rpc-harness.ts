/**
 * RPC acceptance harness — exercises the full per-request scope path that
 * production uses (`Gent.test → RpcServer → registry dispatch → handler`).
 *
 * Use this for new extension RPC tests instead of hand-composing
 * `Gent.test(createE2ELayer({...}))` + a session-create call. Direct-runtime
 * tests via `makeActorRuntimeLayer` bypass the per-request scope boundary
 * production uses; this harness asserts that boundary.
 *
 * The harness is intentionally thin: it folds the four lines every RPC test
 * already writes (build E2E layer → Gent.test → session.create → return
 * client + ids) into a single yield. Pass `cwd` to override the default
 * `/tmp` working directory.
 *
 * The harness lives in `@gent/core/test-utils` so it can be imported from
 * any test file. Because `core` cannot reach into `@gent/extensions`, the
 * caller passes pre-loaded extensions and an agents bucket — the same
 * fragments callers already pass to `createE2ELayer`.
 *
 * @module
 */
import { Effect } from "effect"
import { Gent } from "@gent/sdk"
import { createE2ELayer, type E2ELayerConfig } from "./e2e-layer.js"

export interface RpcHarnessConfig extends Pick<
  E2ELayerConfig,
  | "providerLayer"
  | "extensions"
  | "agents"
  | "extensionInputs"
  | "subagentRunner"
  | "approvalLayer"
  | "sessionProfileCacheLayer"
  | "extraLayers"
  | "authStoreLayer"
  | "configServiceLayer"
  | "layerOverrides"
> {
  /** Working directory passed to the seeded session.create call. Defaults to `/tmp`. */
  readonly cwd?: string
}

/**
 * Build an in-process RPC client + seeded session in one yield.
 *
 * ```typescript
 * const { client, sessionId, branchId } = yield* createRpcHarness({
 *   ...e2ePreset,
 *   providerLayer,
 *   extensions: [taskExt],
 * })
 * yield* client.extension.request({ sessionId, branchId, ... })
 * ```
 */
export const createRpcHarness = (config: RpcHarnessConfig) =>
  Effect.gen(function* () {
    const { cwd, ...layerConfig } = config
    const layer = createE2ELayer({
      ...layerConfig,
      agents: layerConfig.agents ?? [],
      extensionInputs: layerConfig.extensionInputs ?? [],
    })
    const { client, runtime } = yield* Gent.test(layer)
    const { sessionId, branchId } = yield* client.session.create({
      cwd: cwd ?? "/tmp",
    })
    return { client, runtime, sessionId, branchId }
  })
