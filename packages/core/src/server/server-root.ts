import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Clock, Context, Effect, Layer } from "effect"
import type { Scope } from "effect"
import type { FileSystem } from "effect/FileSystem"
import {
  buildServerRoutes,
  ConnectionTracker,
  type ConnectionTrackerService,
  createDependencies,
  type DependenciesConfig,
  RpcHandlersLive,
  ServerIdentity,
  type ServerIdentityApi,
} from "./server.js"

/**
 * A root names where its state lives when it names the root. Re-exported here
 * so a server entrypoint takes both from `server-root` and never reaches into
 * the dependency graph directly.
 */
export { StateLocation } from "./server.js"

import { BunGentPlatformLive } from "../runtime/gent-platform-bun.js"

type BuiltRpcHandlers = Layer.Success<typeof RpcHandlersLive>
type DependenciesLayer = ReturnType<typeof createDependencies>
type DependencyError = Layer.Error<DependenciesLayer>
type ServerRootServices =
  | Layer.Success<DependenciesLayer>
  | Layer.Success<typeof ConnectionTracker.Live>
  | ServerIdentity

interface ServerRootConfig {
  readonly dependencies: DependenciesConfig
  /** Logger, log level, and tracer for this root; the composition root owns the vendor wiring. */
  readonly observability: Layer.Layer<never, never, FileSystem>
  readonly identity: Omit<ServerIdentityApi, "startedAt">
}

interface BuiltServerRoot {
  readonly connectionTracker: ConnectionTrackerService
  readonly coreServices: Context.Context<ServerRootServices>
  readonly coreServicesLive: Layer.Layer<ServerRootServices>
  readonly httpRoutes: ReturnType<typeof buildServerRoutes<ServerRootServices>>
  readonly rpcHandlersContext: Context.Context<BuiltRpcHandlers>
}

/**
 * The Bun platform a root provides once, around `buildServerRoot` and anything
 * else it builds, so one server owns one `GentPlatform`.
 */
export const ServerRootPlatformLayer = Layer.mergeAll(
  BunFileSystem.layer,
  BunServices.layer,
  BunGentPlatformLive,
)

type ServerRootPlatform = Layer.Success<typeof ServerRootPlatformLayer>

export const buildServerRoot = (
  config: ServerRootConfig,
): Effect.Effect<BuiltServerRoot, DependencyError, Scope.Scope | ServerRootPlatform> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const depsLive = createDependencies(config.dependencies).pipe(
      Layer.provide(config.observability),
    )
    // `startedAt` varies per restart, so the identity route serves only the
    // stable half, which registry validation compares.
    const stableIdentity = config.identity
    const identity = { ...stableIdentity, startedAt: yield* Clock.currentTimeMillis }

    const connectionTrackerCtx = yield* Layer.buildWithScope(ConnectionTracker.Live, scope)
    const connectionTracker = Context.get(connectionTrackerCtx, ConnectionTracker)
    const depsServices = yield* Layer.buildWithScope(depsLive, scope)
    const serverIdentityCtx = yield* Layer.buildWithScope(ServerIdentity.Live(identity), scope)
    const allServices = Context.merge(
      Context.merge(depsServices, connectionTrackerCtx),
      serverIdentityCtx,
    )
    const coreServicesLive = Layer.succeedContext(allServices)
    const httpRoutes = buildServerRoutes(coreServicesLive, { identity: stableIdentity })
    const rpcHandlersContext = yield* Layer.buildWithScope(
      Layer.provide(RpcHandlersLive, coreServicesLive),
      scope,
    )

    return {
      connectionTracker,
      coreServices: allServices,
      coreServicesLive,
      httpRoutes,
      rpcHandlersContext,
    }
  })
