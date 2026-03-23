import { BunHttpServer, BunRuntime, BunFileSystem, BunServices } from "@effect/platform-bun"
import { GentTracerLive } from "@gent/core/runtime/tracer.js"
import { GentLogger, GentLogLevel } from "@gent/core/runtime/logger.js"
import { SteerCommand } from "@gent/core/runtime/agent/agent-loop.js"
import { HttpApiBuilder, HttpApiScalar, OpenApi } from "effect/unstable/httpapi"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { RpcServer, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer, Schema } from "effect"
import * as os from "node:os"
import { GentApi } from "@gent/core/server/http-api.js"
import { SessionQueries } from "@gent/core/server/session-queries.js"
import { SessionCommands } from "@gent/core/server/session-commands.js"
import { GentRpcs } from "@gent/core/server/rpcs.js"
import { RpcHandlersLive } from "@gent/core/server/rpc-handlers.js"
import { createDependencies } from "@gent/core/server/dependencies.js"
import { AppServicesLive } from "@gent/core/server/index.js"

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

// Dependencies layer
const DepsLive = createDependencies({
  cwd: process.cwd(),
  home: os.homedir(),
  platform: process.platform,
  dbPath: ".gent/data.db",
}).pipe(
  Layer.provide(PlatformLayer),
  Layer.provide(GentLogger),
  Layer.provide(GentLogLevel),
  Layer.provide(GentTracerLive),
)

// Combined layer for RPC handlers
const CoreWithDeps = Layer.merge(AppServicesLive, DepsLive)

// RPC-over-HTTP routes with ndjson for streaming
const RpcRoutes = RpcServer.layerHttp({
  group: GentRpcs,
  path: "/rpc",
  protocol: "http",
}).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(RpcHandlersLive),
  Layer.provide(CoreWithDeps),
)

// API Groups Layer (REST endpoints)
const HttpGroupsLive = Layer.provideMerge(SessionsApiLive, MessagesApiLive).pipe(
  Layer.provide(AppServicesLive),
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
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.provide(AppServicesLive),
  Layer.provide(DepsLive),
  Layer.provide(BunFileSystem.layer),
)

// Main
console.log("Gent server starting on http://localhost:3000")
console.log("Swagger UI: http://localhost:3000/docs")
BunRuntime.runMain(Effect.scoped(Layer.launch(HttpServerLive)))
