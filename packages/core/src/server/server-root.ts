import { Effect, Layer } from "effect"
import type { Context, Scope } from "effect"
import type { FileSystem } from "effect/FileSystem"
import {
  buildServerRoutes,
  createDependencies,
  type DependenciesConfig,
  RpcHandlersLive,
  type ServerIdentityApi,
} from "./server.js"

import type { BunPlatformLive } from "../runtime/gent-platform-bun.js"

type BuiltRpcHandlers = Layer.Success<typeof RpcHandlersLive>
type DependenciesLayer = ReturnType<typeof createDependencies>
type DependencyError = Layer.Error<DependenciesLayer>
type ServerRootServices = Layer.Success<DependenciesLayer>

interface ServerRootConfig {
  readonly dependencies: DependenciesConfig
  /** Logger, log level, and tracer for this root; the composition root owns the vendor wiring. */
  readonly observability: Layer.Layer<never, never, FileSystem>
  readonly identity: ServerIdentityApi
}

interface BuiltServerRoot {
  readonly coreServices: Context.Context<ServerRootServices>
  readonly coreServicesLive: Layer.Layer<ServerRootServices>
  readonly httpRoutes: ReturnType<typeof buildServerRoutes<ServerRootServices>>
  readonly rpcHandlersContext: Context.Context<BuiltRpcHandlers>
}

/**
 * A root runs inside one `BunPlatformLive`, provided around `buildServerRoot`
 * and anything else it builds, so one server owns one `GentPlatform`.
 */
type ServerRootPlatform = Layer.Success<typeof BunPlatformLive>

export const buildServerRoot = (
  config: ServerRootConfig,
): Effect.Effect<BuiltServerRoot, DependencyError, Scope.Scope | ServerRootPlatform> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const depsLive = createDependencies(config.dependencies).pipe(
      Layer.provide(config.observability),
    )
    const allServices = yield* Layer.buildWithScope(depsLive, scope)
    const coreServicesLive = Layer.succeedContext(allServices)
    const httpRoutes = buildServerRoutes(coreServicesLive, { identity: config.identity })
    const rpcHandlersContext = yield* Layer.buildWithScope(
      Layer.provide(RpcHandlersLive, coreServicesLive),
      scope,
    )

    return {
      coreServices: allServices,
      coreServicesLive,
      httpRoutes,
      rpcHandlersContext,
    }
  })
