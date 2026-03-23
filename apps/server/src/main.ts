import { BunHttpServer, BunRuntime, BunFileSystem, BunServices } from "@effect/platform-bun"
import { GentTracerLive } from "@gent/core/runtime/tracer.js"
import { GentLogger, GentLogLevel } from "@gent/core/runtime/logger.js"
import { SteerCommand } from "@gent/core/runtime/agent/agent-loop.js"
import { HttpApiBuilder, HttpApiScalar, OpenApi } from "effect/unstable/httpapi"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { RpcServer, RpcSerialization } from "effect/unstable/rpc"
import { Config, Effect, Layer, Option, Schema, ServiceMap } from "effect"
import * as os from "node:os"
import { GentApi } from "@gent/core/server/http-api.js"
import { seedDebugSession } from "@gent/core/debug/session.js"
import { startDebugScenario } from "@gent/core/debug/scenario.js"
import { SessionQueries } from "@gent/core/server/session-queries.js"
import { SessionCommands } from "@gent/core/server/session-commands.js"
import { GentRpcs } from "@gent/core/server/rpcs.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import { createDependencies } from "@gent/core/server/dependencies.js"
import { AppServicesLive } from "@gent/core/server/index.js"

const joinPath = (...parts: readonly string[]) => parts.join("/").replace(/\/+/g, "/")

const resolveRuntimeConfig = Effect.gen(function* () {
  const portRaw = yield* Config.option(Config.string("GENT_PORT"))
  const cwdOpt = yield* Config.option(Config.string("GENT_CWD"))
  const homeOpt = yield* Config.option(Config.string("HOME"))
  const dataDirOpt = yield* Config.option(Config.string("GENT_DATA_DIR"))
  const dbPathOpt = yield* Config.option(Config.string("GENT_DB_PATH"))
  const authFilePathOpt = yield* Config.option(Config.string("GENT_AUTH_FILE_PATH"))
  const authKeyPathOpt = yield* Config.option(Config.string("GENT_AUTH_KEY_PATH"))
  const persistenceOpt = yield* Config.option(Config.string("GENT_PERSISTENCE_MODE"))
  const providerOpt = yield* Config.option(Config.string("GENT_PROVIDER_MODE"))
  const serverModeOpt = yield* Config.option(Config.string("GENT_SERVER_MODE"))
  const debugModeOpt = yield* Config.option(Config.string("GENT_DEBUG_MODE"))

  const home = Option.getOrElse(homeOpt, () => os.homedir())
  const dataDir = Option.getOrElse(dataDirOpt, () => joinPath(home, ".gent"))
  const parsedPort = Number(Option.getOrElse(portRaw, () => "3000"))

  return {
    port: Number.isFinite(parsedPort) ? parsedPort : 3000,
    cwd: Option.getOrElse(cwdOpt, () => process.cwd()),
    home,
    dataDir,
    dbPath: Option.getOrElse(dbPathOpt, () => joinPath(dataDir, "data.db")),
    authFilePath: Option.getOrUndefined(authFilePathOpt),
    authKeyPath: Option.getOrUndefined(authKeyPathOpt),
    persistenceMode:
      Option.getOrUndefined(persistenceOpt) === "memory" ? ("memory" as const) : ("disk" as const),
    providerMode:
      Option.getOrUndefined(providerOpt) === "debug-scripted"
        ? ("debug-scripted" as const)
        : ("live" as const),
    isWorker: Option.getOrUndefined(serverModeOpt) === "worker",
    isDebug: Option.getOrUndefined(debugModeOpt) === "1",
  }
})

// Sessions API Handlers
const SessionsApiLive = HttpApiBuilder.group(GentApi, "sessions", (handlers) =>
  Effect.gen(function* () {
    const queries = yield* SessionQueries
    const commands = yield* SessionCommands
    return handlers
      .handle("create", ({ payload }) =>
        commands
          .createSession({
            name: payload.name ?? "New Session",
            ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
            ...(payload.bypass !== undefined ? { bypass: payload.bypass } : {}),
          })
          .pipe(Effect.orDie),
      )
      .handle("list", () => queries.listSessions().pipe(Effect.orDie))
      .handle("get", ({ params }) =>
        queries.getSession(params.sessionId).pipe(
          Effect.flatMap((s) =>
            s !== null ? Effect.succeed(s) : Effect.die(new Error("Session not found")),
          ),
          Effect.orDie,
        ),
      )
      .handle("delete", ({ params }) => commands.deleteSession(params.sessionId).pipe(Effect.orDie))
  }),
)

// Messages API Handlers
const MessagesApiLive = HttpApiBuilder.group(GentApi, "messages", (handlers) =>
  Effect.gen(function* () {
    const queries = yield* SessionQueries
    const commands = yield* SessionCommands
    return handlers
      .handle("send", ({ payload }) =>
        commands
          .sendMessage({
            sessionId: payload.sessionId,
            branchId: payload.branchId,
            content: payload.content,
          })
          .pipe(Effect.orDie),
      )
      .handle("list", ({ params }) => queries.listMessages(params.branchId).pipe(Effect.orDie))
      .handle("steer", ({ payload }) =>
        Effect.gen(function* () {
          const command = yield* Schema.decodeEffect(SteerCommand)(payload)
          yield* commands.steer(command)
        }).pipe(Effect.orDie),
      )
  }),
)

// Platform layer for Storage
const PlatformLayer = Layer.merge(BunFileSystem.layer, BunServices.layer)

const program = Effect.scoped(
  Effect.gen(function* () {
    const scope = yield* Effect.scope
    const config = yield* resolveRuntimeConfig

    // Dependencies layer
    const depsLive = createDependencies({
      cwd: config.cwd,
      home: config.home,
      platform: process.platform,
      dbPath: config.dbPath,
      authFilePath: config.authFilePath,
      authKeyPath: config.authKeyPath,
      persistenceMode: config.persistenceMode,
      providerMode: config.providerMode,
      actorRuntime: "cluster" as const,
      clusterDbPath:
        config.persistenceMode === "memory" ? ":memory:" : joinPath(config.dataDir, "cluster.db"),
      clusterStorage: config.persistenceMode === "memory" ? ("memory" as const) : ("sql" as const),
    }).pipe(
      Layer.provide(PlatformLayer),
      Layer.provide(GentLogger),
      Layer.provide(GentLogLevel),
      Layer.provide(GentTracerLive),
    )

    const depsServices = yield* Layer.buildWithScope(depsLive, scope)
    const appServices = yield* Layer.buildWithScope(
      AppServicesLive.pipe(Layer.provide(Layer.succeedServices(depsServices))),
      scope,
    )
    const coreServices = ServiceMap.merge(depsServices, appServices)
    const coreServicesLive = Layer.succeedServices(coreServices)

    // RPC-over-HTTP routes with ndjson for streaming
    const RpcRoutes = RpcServer.layerHttp({
      group: GentRpcs,
      path: "/rpc",
      protocol: "http",
    }).pipe(
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(RpcHandlersLive),
      Layer.provide(coreServicesLive),
    )

    // API Groups Layer (REST endpoints)
    const HttpGroupsLive = Layer.provideMerge(SessionsApiLive, MessagesApiLive).pipe(
      Layer.provide(coreServicesLive),
    )

    // API Routes
    const HttpApiRoutes = HttpApiBuilder.layer(GentApi).pipe(Layer.provide(HttpGroupsLive))

    // Swagger docs at /docs
    const DocsRoute = HttpApiScalar.layer(GentApi, {
      path: "/docs",
    })

    // OpenAPI JSON
    const OpenApiJsonRoute = HttpRouter.add(
      "GET",
      "/docs/openapi.json",
      HttpServerResponse.json(OpenApi.fromApi(GentApi)),
    )

    // Merge all routes (REST API + RPC + docs)
    const AllRoutes = Layer.mergeAll(RpcRoutes, HttpApiRoutes, DocsRoute, OpenApiJsonRoute).pipe(
      Layer.provide(HttpRouter.cors()),
    )

    // Server
    const HttpServerLive = HttpRouter.serve(AllRoutes).pipe(
      Layer.provide(BunHttpServer.layer({ port: config.port })),
      Layer.provide(coreServicesLive),
      Layer.provide(BunFileSystem.layer),
    )

    const baseUrl = `http://localhost:${config.port}`
    if (config.isWorker && config.isDebug) {
      const seeded = yield* seedDebugSession(config.cwd).pipe(Effect.provide(coreServices))
      yield* Effect.forkDetach(
        startDebugScenario({
          sessionId: seeded.sessionId,
          branchId: seeded.branchId,
          cwd: config.cwd,
        }).pipe(Effect.provide(coreServices)),
      )
    }
    if (config.isWorker) {
      console.error(`Gent worker starting on ${baseUrl}`)
    } else {
      console.log(`Gent server starting on ${baseUrl}`)
      console.log(`Swagger UI: ${baseUrl}/docs`)
    }

    return yield* Layer.launch(HttpServerLive)
  }),
)

const MainLayer = Layer.effectDiscard(program).pipe(Layer.provide(BunFileSystem.layer))

BunRuntime.runMain(Effect.scoped(Layer.launch(MainLayer)))
