import { BunHttpServer, BunRuntime, BunFileSystem, BunContext } from "@effect/platform-bun"
import {
  HttpApiBuilder,
  HttpApiScalar,
  HttpLayerRouter,
  HttpServerResponse,
  OpenApi,
} from "@effect/platform"
import { Effect, Layer, Stream, Schema } from "effect"
import { GentApi } from "@gent/api"
import { GentServer, SteerCommand } from "@gent/server"

// Sessions API Handlers
const SessionsApiLive = HttpApiBuilder.group(GentApi, "sessions", (handlers) =>
  Effect.gen(function* () {
    const server = yield* GentServer
    return handlers
      .handle("create", ({ payload }) =>
        server.createSession({ name: payload.name ?? "New Session" }).pipe(Effect.orDie)
      )
      .handle("list", () => server.listSessions().pipe(Effect.orDie))
      .handle("get", ({ path }) =>
        server.getSession(path.sessionId).pipe(
          Effect.flatMap((s) =>
            s ? Effect.succeed(s) : Effect.die(new Error("Session not found"))
          ),
          Effect.orDie
        )
      )
      .handle("delete", ({ path }) =>
        server.deleteSession(path.sessionId).pipe(Effect.orDie)
      )
  })
)

// Messages API Handlers
const MessagesApiLive = HttpApiBuilder.group(GentApi, "messages", (handlers) =>
  Effect.gen(function* () {
    const server = yield* GentServer
    return handlers
      .handle("send", ({ payload }) =>
        server
          .sendMessage({
            sessionId: payload.sessionId,
            branchId: payload.branchId,
            content: payload.content,
          })
          .pipe(Effect.orDie)
      )
      .handle("list", ({ path }) =>
        server.listMessages(path.branchId).pipe(Effect.orDie)
      )
      .handle("steer", ({ payload }) =>
        Effect.gen(function* () {
          const command = yield* Schema.decode(SteerCommand)(payload)
          yield* server.steer(command)
        }).pipe(Effect.orDie)
      )
  })
)

// Events API Handlers (SSE)
const EventsApiLive = HttpApiBuilder.group(GentApi, "events", (handlers) =>
  Effect.gen(function* () {
    const server = yield* GentServer
    return handlers.handle("subscribe", ({ path }) =>
      Effect.gen(function* () {
        const events = server.subscribeEvents(path.sessionId)

        // Format as SSE
        const sseStream = events.pipe(
          Stream.map((e) => `data: ${JSON.stringify(e)}\n\n`)
        )

        // Return SSE stream as string (simplified)
        const chunks: string[] = []
        yield* Stream.runForEach(Stream.take(sseStream, 100), (chunk) =>
          Effect.sync(() => chunks.push(chunk))
        )
        return chunks.join("")
      }).pipe(Effect.orDie)
    )
  })
)

// Platform layer for Storage
const PlatformLayer = Layer.merge(BunFileSystem.layer, BunContext.layer)

// Server service
const ServerLive = GentServer.Live({
  systemPrompt: "You are a helpful AI assistant.",
  defaultModel: "anthropic/claude-sonnet-4-20250514",
  dbPath: ".gent/data.db",
}).pipe(Layer.provide(PlatformLayer))

// API Groups Layer
const HttpGroupsLive = Layer.provideMerge(
  Layer.provideMerge(SessionsApiLive, MessagesApiLive),
  EventsApiLive
).pipe(Layer.provide(ServerLive))

// API Routes
const HttpApiRoutes = HttpLayerRouter.addHttpApi(GentApi).pipe(
  Layer.provide(HttpGroupsLive)
)

// Swagger docs at /docs
const DocsRoute = HttpApiScalar.layerHttpLayerRouter({
  api: GentApi,
  path: "/docs",
})

// OpenAPI JSON
const OpenApiJsonRoute = HttpLayerRouter.add(
  "GET",
  "/docs/openapi.json",
  HttpServerResponse.json(OpenApi.fromApi(GentApi))
).pipe(Layer.provide(HttpLayerRouter.layer))

// Merge all routes
const AllRoutes = Layer.mergeAll(HttpApiRoutes, DocsRoute, OpenApiJsonRoute).pipe(
  Layer.provide(HttpLayerRouter.cors())
)

// Server
const HttpServerLive = HttpLayerRouter.serve(AllRoutes).pipe(
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.provide(ServerLive)
)

// Main
console.log("Gent server starting on http://localhost:3000")
console.log("Swagger UI: http://localhost:3000/docs")
BunRuntime.runMain(Layer.launch(HttpServerLive))
