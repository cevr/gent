import { BunHttpServer, BunRuntime, BunFileSystem, BunContext } from "@effect/platform-bun"
import {
  HttpApiBuilder,
  HttpApiScalar,
  HttpLayerRouter,
  HttpServerResponse,
  OpenApi,
} from "@effect/platform"
import { RpcServer, RpcSerialization } from "@effect/rpc"
import { Effect, Layer, Schema } from "effect"
import {
  GentApi,
  GentCore,
  GentRpcs,
  RpcHandlersLive,
  createDependencies,
  SteerCommand,
} from "@gent/server"
import { DEFAULT_MODEL_ID } from "@gent/core"

// Sessions API Handlers
const SessionsApiLive = HttpApiBuilder.group(GentApi, "sessions", (handlers) =>
  Effect.gen(function* () {
    const core = yield* GentCore
    return handlers
      .handle("create", ({ payload }) =>
        core
          .createSession({
            name: payload.name ?? "New Session",
            ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
            ...(payload.bypass !== undefined ? { bypass: payload.bypass } : {}),
          })
          .pipe(Effect.orDie),
      )
      .handle("list", () => core.listSessions().pipe(Effect.orDie))
      .handle("get", ({ path }) =>
        core.getSession(path.sessionId).pipe(
          Effect.flatMap((s) =>
            s !== null ? Effect.succeed(s) : Effect.die(new Error("Session not found")),
          ),
          Effect.orDie,
        ),
      )
      .handle("delete", ({ path }) => core.deleteSession(path.sessionId).pipe(Effect.orDie))
  }),
)

// Messages API Handlers
const MessagesApiLive = HttpApiBuilder.group(GentApi, "messages", (handlers) =>
  Effect.gen(function* () {
    const core = yield* GentCore
    return handlers
      .handle("send", ({ payload }) =>
        core
          .sendMessage({
            sessionId: payload.sessionId,
            branchId: payload.branchId,
            content: payload.content,
          })
          .pipe(Effect.orDie),
      )
      .handle("list", ({ path }) => core.listMessages(path.branchId).pipe(Effect.orDie))
      .handle("steer", ({ payload }) =>
        Effect.gen(function* () {
          const command = yield* Schema.decode(SteerCommand)(payload)
          yield* core.steer(command)
        }).pipe(Effect.orDie),
      )
  }),
)

// Platform layer for Storage
const PlatformLayer = Layer.merge(BunFileSystem.layer, BunContext.layer)

// Dependencies layer
const DepsLive = createDependencies({
  cwd: process.cwd(),
  defaultModel: DEFAULT_MODEL_ID,
  dbPath: ".gent/data.db",
}).pipe(Layer.provide(PlatformLayer))

// GentCore layer
const GentCoreLive = GentCore.Live.pipe(Layer.provide(DepsLive))

// Combined layer for RPC handlers
const CoreWithDeps = Layer.merge(GentCoreLive, DepsLive)

// RPC-over-HTTP routes with ndjson for streaming
const RpcRoutes = RpcServer.layerHttpRouter({
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
  Layer.provide(GentCoreLive),
)

// API Routes
const HttpApiRoutes = HttpLayerRouter.addHttpApi(GentApi).pipe(Layer.provide(HttpGroupsLive))

// Swagger docs at /docs
const DocsRoute = HttpApiScalar.layerHttpLayerRouter({
  api: GentApi,
  path: "/docs",
})

// OpenAPI JSON
const OpenApiJsonRoute = HttpLayerRouter.add(
  "GET",
  "/docs/openapi.json",
  HttpServerResponse.json(OpenApi.fromApi(GentApi)),
).pipe(Layer.provide(HttpLayerRouter.layer))

// Merge all routes (REST API + RPC + docs)
const AllRoutes = Layer.mergeAll(RpcRoutes, HttpApiRoutes, DocsRoute, OpenApiJsonRoute).pipe(
  Layer.provide(HttpLayerRouter.cors()),
)

// Server
const HttpServerLive = HttpLayerRouter.serve(AllRoutes).pipe(
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.provide(GentCoreLive),
)

// Main
console.log("Gent server starting on http://localhost:3000")
console.log("Swagger UI: http://localhost:3000/docs")
BunRuntime.runMain(Layer.launch(HttpServerLive))
