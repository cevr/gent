/**
 * DriverRegistry — unified lookup over both model and external drivers.
 *
 * Replaces the dual-path dispatch through `ExtensionRegistry.getProvider` +
 * `ExtensionRegistry.getTurnExecutor` with one capability-shaped registry
 * keyed by `DriverRef`. The agent loop reads `agent.driver: DriverRef` and
 * routes through this single seam regardless of whether the underlying
 * implementation is a model provider or an external turn executor —
 * `composability-not-flags`.
 *
 * The contributing extensions still register through their respective
 * contribution kinds (`model-driver` or `external-driver`); this registry
 * is the read side. Auth flow integration (OAuth + API key resolution)
 * stays in `providers/provider.ts` because it belongs to model drivers
 * specifically — `DriverRegistry.resolveModel` consults `getModel(id)`,
 * then runs the existing auth pipeline.
 *
 * @module
 */
import { Context, Effect, Layer } from "effect"
import type {
  ExternalDriverContribution,
  ModelDriverContribution,
  ProviderAuthInfo,
  TurnExecutor,
} from "../../domain/driver.js"
import { DriverError } from "../../domain/driver.js"

// ── Resolved driver state (one map per kind, lookup by id) ──

export interface ResolvedDrivers {
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly externalDrivers: ReadonlyMap<string, ExternalDriverContribution>
}

// ── Service interface ──

export interface DriverRegistryService {
  /** Resolve a model driver by id (the `provider` segment of `provider/model`). */
  readonly getModel: (id: string) => Effect.Effect<ModelDriverContribution | undefined>
  /** Resolve an external driver by id (the runner id, e.g. `acp-claude-code`). */
  readonly getExternal: (id: string) => Effect.Effect<ExternalDriverContribution | undefined>
  /** Direct accessor for an external driver's executor — convenience for the agent loop. */
  readonly getExternalExecutor: (id: string) => Effect.Effect<TurnExecutor | undefined>
  /** All registered model drivers in registration order. */
  readonly listModels: () => Effect.Effect<ReadonlyArray<ModelDriverContribution>>
  /** All registered external drivers in registration order. */
  readonly listExternal: () => Effect.Effect<ReadonlyArray<ExternalDriverContribution>>
  /** Run a base catalog through every model driver's `listModels` filter. */
  readonly filterModelCatalog: (
    baseCatalog: ReadonlyArray<unknown>,
    resolveAuth?: (driverId: string) => Effect.Effect<ProviderAuthInfo | undefined>,
  ) => Effect.Effect<ReadonlyArray<unknown>>
  /** Require a model driver — fail with `DriverError` when missing. */
  readonly requireModel: (id: string) => Effect.Effect<ModelDriverContribution, DriverError>
  /** Require an external driver — fail with `DriverError` when missing. */
  readonly requireExternal: (id: string) => Effect.Effect<ExternalDriverContribution, DriverError>
}

export class DriverRegistry extends Context.Service<DriverRegistry, DriverRegistryService>()(
  "@gent/core/src/runtime/extensions/driver-registry/DriverRegistry",
) {
  static fromResolved = (resolved: ResolvedDrivers): Layer.Layer<DriverRegistry> =>
    Layer.succeed(DriverRegistry, {
      getModel: (id) => Effect.succeed(resolved.modelDrivers.get(id)),
      getExternal: (id) => Effect.succeed(resolved.externalDrivers.get(id)),
      getExternalExecutor: (id) =>
        Effect.succeed(resolved.externalDrivers.get(id)?.executor ?? undefined),
      listModels: () => Effect.succeed([...resolved.modelDrivers.values()]),
      listExternal: () => Effect.succeed([...resolved.externalDrivers.values()]),
      filterModelCatalog: (baseCatalog, resolveAuth) =>
        Effect.gen(function* () {
          let catalog = baseCatalog
          for (const driver of resolved.modelDrivers.values()) {
            if (driver.listModels === undefined) continue
            const auth = resolveAuth !== undefined ? yield* resolveAuth(driver.id) : undefined
            catalog = driver.listModels(catalog, auth)
          }
          return catalog
        }),
      requireModel: (id) =>
        Effect.gen(function* () {
          const found = resolved.modelDrivers.get(id)
          if (found === undefined) {
            return yield* new DriverError({
              kind: "model",
              id,
              reason: `No model driver registered for id "${id}"`,
            })
          }
          return found
        }),
      requireExternal: (id) =>
        Effect.gen(function* () {
          const found = resolved.externalDrivers.get(id)
          if (found === undefined) {
            return yield* new DriverError({
              kind: "external",
              id,
              reason: `No external driver registered for id "${id}"`,
            })
          }
          return found
        }),
    })
}
