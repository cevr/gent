import { BunHttpServer, BunRuntime, BunFileSystem, BunContext } from "@effect/platform-bun"
import {
  HttpApiBuilder,
  HttpApiScalar,
  HttpLayerRouter,
  HttpServerResponse,
  OpenApi,
} from "@effect/platform"
import { Effect, Layer, Stream, Schema } from "effect"
import {
  GentApi,
  GentCore,
  createDependencies,
  SteerCommand,
  DEFAULT_SYSTEM_PROMPT,
} from "@gent/server"
import { DEFAULT_MODEL_ID } from "@gent/core"

// Sessions API Handlers
const SessionsApiLive = HttpApiBuilder.group(GentApi, "sessions", (handlers) =>
  Effect.gen(function* () {
    const core = yield* GentCore
    return handlers
      .handle("create", ({ payload }) =>
        core.createSession({ name: payload.name ?? "New Session" }).pipe(Effect.orDie)
      )
      .handle("list", () => core.listSessions().pipe(Effect.orDie))
      .handle("get", ({ path }) =>
        core.getSession(path.sessionId).pipe(
          Effect.flatMap((s) =>
            s ? Effect.succeed(s) : Effect.die(new Error("Session not found"))
          ),
          Effect.orDie
        )
      )
      .handle("delete", ({ path }) =>
        core.deleteSession(path.sessionId).pipe(Effect.orDie)
      )
  })
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
          .pipe(Effect.orDie)
      )
      .handle("list", ({ path }) =>
        core.listMessages(path.branchId).pipe(Effect.orDie)
      )
      .handle("steer", ({ payload }) =>
        Effect.gen(function* () {
          const command = yield* Schema.decode(SteerCommand)(payload)
          yield* core.steer(command)
        }).pipe(Effect.orDie)
      )
  })
)

// Events API Handlers (SSE)
const EventsApiLive = HttpApiBuilder.group(GentApi, "events", (handlers) =>
  Effect.gen(function* () {
    const core = yield* GentCore
    return handlers.handle("subscribe", ({ path }) =>
      Effect.gen(function* () {
        const events = core.subscribeEvents(path.sessionId)

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

// Dependencies layer
const DepsLive = createDependencies({
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  defaultModel: DEFAULT_MODEL_ID,
  dbPath: ".gent/data.db",
}).pipe(Layer.provide(PlatformLayer))

// GentCore layer
const GentCoreLive = GentCore.Live.pipe(Layer.provide(DepsLive))

// API Groups Layer
const HttpGroupsLive = Layer.provideMerge(
  Layer.provideMerge(SessionsApiLive, MessagesApiLive),
  EventsApiLive
).pipe(Layer.provide(GentCoreLive))

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
  Layer.provide(GentCoreLive)
)

// Main
console.log("Gent server starting on http://localhost:3000")
console.log("Swagger UI: http://localhost:3000/docs")
BunRuntime.runMain(Layer.launch(HttpServerLive))
