import { BunHttpServer, BunRuntime, BunFileSystem, BunContext } from "@effect/platform-bun"
import {
  HttpApiBuilder,
  HttpApiScalar,
  HttpLayerRouter,
  HttpServerResponse,
  OpenApi,
} from "@effect/platform"
import { Effect, Layer, Stream } from "effect"
import { GentApi } from "@gent/api"
import {
  Session,
  Branch,
  Message,
  TextPart,
  EventBus,
  ToolRegistry,
  Permission,
} from "@gent/core"
import { Storage } from "@gent/storage"
import { Provider } from "@gent/providers"
import { AgentLoop } from "@gent/runtime"
import { AllTools } from "@gent/tools"

// Sessions API Handlers

const SessionsApiLive = HttpApiBuilder.group(GentApi, "sessions", (handlers) =>
  Effect.gen(function* () {
    const storage = yield* Storage
    return handlers
      .handle("create", ({ payload }) =>
        Effect.gen(function* () {
          const sessionId = crypto.randomUUID()
          const branchId = crypto.randomUUID()
          const now = new Date()

          const session = new Session({
            id: sessionId,
            name: payload.name,
            createdAt: now,
            updatedAt: now,
          })

          const branch = new Branch({
            id: branchId,
            sessionId,
            createdAt: now,
          })

          yield* storage.createSession(session)
          yield* storage.createBranch(branch)

          return { sessionId, branchId }
        }).pipe(Effect.orDie)
      )
      .handle("list", () =>
        Effect.gen(function* () {
          const sessions = yield* storage.listSessions()
          return sessions.map((s) => ({
            id: s.id,
            name: s.name,
            createdAt: s.createdAt.getTime(),
            updatedAt: s.updatedAt.getTime(),
          }))
        }).pipe(Effect.orDie)
      )
      .handle("get", ({ path }) =>
        Effect.gen(function* () {
          const session = yield* storage.getSession(path.sessionId)
          if (!session) {
            return yield* Effect.die(new Error("Session not found"))
          }
          return {
            id: session.id,
            name: session.name,
            createdAt: session.createdAt.getTime(),
            updatedAt: session.updatedAt.getTime(),
          }
        }).pipe(Effect.orDie)
      )
      .handle("delete", ({ path }) =>
        storage.deleteSession(path.sessionId).pipe(Effect.orDie)
      )
  })
)

// Messages API Handlers

const MessagesApiLive = HttpApiBuilder.group(GentApi, "messages", (handlers) =>
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop
    const storage = yield* Storage
    return handlers
      .handle("send", ({ payload }) =>
        Effect.gen(function* () {
          const message = new Message({
            id: crypto.randomUUID(),
            sessionId: payload.sessionId,
            branchId: payload.branchId,
            role: "user",
            parts: [new TextPart({ text: payload.content })],
            createdAt: new Date(),
          })

          // Run in background - don't wait for completion
          yield* Effect.fork(agentLoop.run(message))
        }).pipe(Effect.orDie)
      )
      .handle("list", ({ path }) =>
        Effect.gen(function* () {
          const messages = yield* storage.listMessages(path.branchId)
          return messages.map((m) => ({
            id: m.id,
            sessionId: m.sessionId,
            branchId: m.branchId,
            role: m.role,
            parts: m.parts as unknown[],
            createdAt: m.createdAt.getTime(),
          }))
        }).pipe(Effect.orDie)
      )
      .handle("steer", ({ payload }) =>
        agentLoop.steer(payload).pipe(Effect.orDie)
      )
  })
)

// Events API Handlers (SSE)

const EventsApiLive = HttpApiBuilder.group(GentApi, "events", (handlers) =>
  Effect.gen(function* () {
    const eventBus = yield* EventBus
    return handlers.handle("subscribe", ({ path }) =>
      Effect.gen(function* () {
        const events = eventBus.subscribe()

        // Filter events for this session and format as SSE
        const sseStream = events.pipe(
          Stream.filter((e) => {
            if ("sessionId" in e) {
              return (e as { sessionId: string }).sessionId === path.sessionId
            }
            return false
          }),
          Stream.map((e) => `data: ${JSON.stringify(e)}\n\n`)
        )

        // Return SSE stream as string (simplified - real impl would use HttpServerResponse.stream)
        const chunks: string[] = []
        yield* Stream.runForEach(Stream.take(sseStream, 100), (chunk) =>
          Effect.sync(() => chunks.push(chunk))
        )
        return chunks.join("")
      }).pipe(Effect.orDie)
    )
  })
)

// Services Layer

const PlatformLayer = Layer.merge(BunFileSystem.layer, BunContext.layer)
const StorageLive = Storage.Live(".gent/data.db").pipe(Layer.provide(PlatformLayer))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BaseServicesLive = Layer.mergeAll(
  StorageLive,
  Provider.Live,
  ToolRegistry.Live(AllTools as any),
  EventBus.Live,
  Permission.Live()
)

const AgentLoopLive = AgentLoop.Live({
  systemPrompt: "You are a helpful AI assistant.",
  defaultModel: "anthropic/claude-sonnet-4-20250514",
})

// AgentLoop depends on BaseServices, merge both outputs
const ServicesLive = Layer.merge(
  BaseServicesLive,
  Layer.provide(AgentLoopLive, BaseServicesLive)
)

// API Groups Layer - merge all group implementations and provide services
const HttpGroupsLive = Layer.mergeAll(
  SessionsApiLive,
  MessagesApiLive,
  EventsApiLive
).pipe(Layer.provide(ServicesLive))

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
const ServerLive = HttpLayerRouter.serve(AllRoutes).pipe(
  Layer.provide(BunHttpServer.layer({ port: 3000 })),
  Layer.provide(ServicesLive)
)

// Main
console.log("Gent server starting on http://localhost:3000")
console.log("Swagger UI: http://localhost:3000/docs")
BunRuntime.runMain(Layer.launch(ServerLive))
