import { BunFileSystem, BunServices } from "@effect/platform-bun"
import { Clock, Context, Effect, Layer } from "effect"
import type { Scope } from "effect"
import type { FileSystem } from "effect/FileSystem"
import { createDependencies, type DependenciesConfig } from "./dependencies.js"
import { AppServicesLive } from "./index.js"
import { ConnectionTracker, type ConnectionTrackerService } from "./connection-tracker.js"
import { ServerIdentity, type ServerIdentityShape } from "./server-identity.js"
import { buildServerRoutes } from "./server-routes.js"
import { RpcHandlersLive } from "./rpc-handlers.js"
import { GentLogger, GentLogLevel } from "../runtime/logger.js"
import { GentTracerLive } from "../runtime/tracer.js"
import { BunCronRuntimeLive, BunGentPlatformLive } from "../runtime/gent-platform-bun.js"

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Layer output helper intentionally ignores empty error/context channels
type LayerOutput<T> = T extends Layer.Layer<infer A, infer _E, infer _R> ? A : never
type BuiltRpcHandlers = LayerOutput<typeof RpcHandlersLive>
type DependenciesLayer = ReturnType<typeof createDependencies>
type DependencyError = Layer.Error<DependenciesLayer>
type ServerRootServices =
  | Layer.Success<DependenciesLayer>
  | Layer.Success<typeof AppServicesLive>
  | Layer.Success<typeof ConnectionTracker.Live>
  | ServerIdentity

export interface ServerRootConfig {
  readonly dependencies: DependenciesConfig
  readonly identity: Omit<ServerIdentityShape, "startedAt"> & {
    readonly startedAt?: number
  }
}

export interface BuiltServerRoot {
  readonly connectionTracker: ConnectionTrackerService
  readonly coreServices: Context.Context<ServerRootServices>
  readonly coreServicesLive: Layer.Layer<ServerRootServices>
  readonly httpRoutes: ReturnType<typeof buildServerRoutes<ServerRootServices>>
  readonly rpcHandlersContext: Context.Context<BuiltRpcHandlers>
}

const ServerRootPlatformLayer = Layer.mergeAll(
  BunFileSystem.layer,
  BunServices.layer,
  BunCronRuntimeLive,
  BunGentPlatformLive,
)

export const buildServerRoot = (
  config: ServerRootConfig,
): Effect.Effect<BuiltServerRoot, DependencyError, Scope.Scope | FileSystem> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const depsLive = createDependencies(config.dependencies).pipe(
      Layer.provide(ServerRootPlatformLayer),
      Layer.provide(GentLogger),
      Layer.provide(GentLogLevel),
      Layer.provide(GentTracerLive),
    )
    const startedAt = config.identity.startedAt ?? (yield* Clock.currentTimeMillis)
    const identity = {
      ...config.identity,
      startedAt,
    }

    const connectionTrackerCtx = yield* Layer.buildWithScope(ConnectionTracker.Live, scope)
    const connectionTracker = Context.get(connectionTrackerCtx, ConnectionTracker)
    const depsServices = yield* Layer.buildWithScope(depsLive, scope)
    const appServices = yield* Layer.buildWithScope(
      AppServicesLive.pipe(Layer.provide(Layer.succeedContext(depsServices))),
      scope,
    )
    const serverIdentityCtx = yield* Layer.buildWithScope(ServerIdentity.Live(identity), scope)
    const allServices = Context.merge(
      Context.merge(Context.merge(depsServices, appServices), connectionTrackerCtx),
      serverIdentityCtx,
    )
    const coreServicesLive = Layer.succeedContext(allServices)
    const httpRoutes = buildServerRoutes(coreServicesLive, {
      identity: {
        serverId: identity.serverId,
        pid: identity.pid,
        hostname: identity.hostname,
        dbPath: identity.dbPath,
        buildFingerprint: identity.buildFingerprint,
      },
    })
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

export const makeServerRootLayer = (
  config: ServerRootConfig,
): Layer.Layer<ServerRootServices, DependencyError, FileSystem> =>
  Layer.unwrap(buildServerRoot(config).pipe(Effect.map((root) => root.coreServicesLive)))
