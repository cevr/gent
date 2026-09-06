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
 * stays with model resolution because it belongs to model drivers
 * specifically.
 *
 * @module
 */
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import type {
  ExternalDriverContribution,
  ModelDriverContribution,
  ProviderAuthError,
  ProviderAuthInfo,
} from "../../domain/driver.js"
import { DriverError, DriverFailureId, DriverFailureRef } from "../../domain/driver.js"
import { Model } from "../../domain/model.js"

const decodeModelCatalog = Schema.decodeUnknownOption(Schema.Array(Model))

// ── Resolved driver state (one map per kind, lookup by id) ──

export interface ResolvedDrivers {
  readonly modelDrivers: ReadonlyMap<string, ModelDriverContribution>
  readonly externalDrivers: ReadonlyMap<string, ExternalDriverContribution>
}

// ── Service interface ──

export interface DriverRegistryService {
  /** Resolve a model driver by id (the `provider` segment of `provider/model`). */
  // oxlint-disable-next-line effect/noNullish -- Driver lookup preserves an absent-driver result at this internal boundary.
  readonly getModel: (id: string) => Effect.Effect<ModelDriverContribution | undefined>
  /** Resolve an external driver by id (the runner id, e.g. `acp-claude-code`). */
  // oxlint-disable-next-line effect/noNullish -- Driver lookup preserves an absent-driver result at this internal boundary.
  readonly getExternal: (id: string) => Effect.Effect<ExternalDriverContribution | undefined>
  /** All registered model drivers in registration order. */
  readonly listModels: Effect.Effect<ReadonlyArray<ModelDriverContribution>>
  /** All registered external drivers in registration order. */
  readonly listExternal: Effect.Effect<ReadonlyArray<ExternalDriverContribution>>
  /** Run a base catalog through every model driver's `listModels` filter. */
  readonly filterModelCatalog: (
    baseCatalog: ReadonlyArray<Model>,
    resolveAuth?: (
      driverId: string,
      // oxlint-disable-next-line effect/noNullish -- Driver auth callbacks may have no auth result.
    ) => Effect.Effect<ProviderAuthInfo | undefined, ProviderAuthError>,
  ) => Effect.Effect<ReadonlyArray<Model>, DriverError | ProviderAuthError>
}

export class DriverRegistry extends Context.Service<DriverRegistry, DriverRegistryService>()(
  "@gent/core/src/runtime/extensions/driver-registry/DriverRegistry",
) {
  static fromResolved = (resolved: ResolvedDrivers): Layer.Layer<DriverRegistry> =>
    Layer.succeed(
      DriverRegistry,
      DriverRegistry.of({
        getModel: (id) => Effect.succeed(resolved.modelDrivers.get(id)),
        getExternal: (id) => Effect.succeed(resolved.externalDrivers.get(id)),
        listModels: Effect.succeed([...resolved.modelDrivers.values()]),
        listExternal: Effect.succeed([...resolved.externalDrivers.values()]),
        filterModelCatalog: Effect.fn("DriverRegistry.filterModelCatalog")(function* (
          baseCatalog: ReadonlyArray<Model>,
          resolveAuth?: (
            driverId: string,
            // oxlint-disable-next-line effect/noNullish -- Driver auth callbacks may have no auth result.
          ) => Effect.Effect<ProviderAuthInfo | undefined, ProviderAuthError>,
        ) {
          let catalog = baseCatalog
          for (const driver of resolved.modelDrivers.values()) {
            if (Predicate.isUndefined(driver.listModels)) continue
            let auth = Option.none<ProviderAuthInfo>()
            if (!Predicate.isUndefined(resolveAuth)) {
              auth = yield* resolveAuth(driver.id).pipe(Effect.map(Option.fromUndefinedOr))
            }
            const nextCatalog = driver.listModels(catalog, Option.getOrUndefined(auth))
            const decoded = decodeModelCatalog(nextCatalog)
            if (decoded._tag === "None") {
              return yield* new DriverError({
                driver: DriverFailureRef.cases.model.make({ id: DriverFailureId.make(driver.id) }),
                reason: `Model driver "${driver.id}" returned an invalid model catalog`,
              })
            }
            catalog = decoded.value
          }
          return catalog
        }),
      }),
    )
}
