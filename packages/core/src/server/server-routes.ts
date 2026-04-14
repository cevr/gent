/**
 * Reusable HTTP route assembly for gent servers.
 *
 * Used by both the standalone server (apps/server/src/main.ts) and
 * the SDK's owned-server path (Gent.server with in-process HTTP listener).
 */

import { HttpApiBuilder, HttpApiScalar, OpenApi } from "effect/unstable/httpapi"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { RpcServer, RpcSerialization } from "effect/unstable/rpc"
import { Effect, Layer, Schema } from "effect"
import { GentApi } from "./http-api.js"
import { GentRpcs } from "./rpcs.js"
import { RpcHandlersLive } from "./rpc-handlers.js"
import { SessionQueries } from "./session-queries.js"
import { SessionCommands } from "./session-commands.js"
import { SteerCommand } from "../runtime/agent/agent-loop.js"
import { wsTracingLayer } from "./ws-tracing.js"

// ── REST API Group Handlers ──

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

const MessagesApiLive = HttpApiBuilder.group(GentApi, "messages", (handlers) =>
  Effect.gen(function* () {
    const queries = yield* SessionQueries
    const commands = yield* SessionCommands
    return handlers
      .handle("send", ({ payload }) => commands.sendMessage(payload).pipe(Effect.orDie))
      .handle("list", ({ params }) => queries.listMessages(params.branchId).pipe(Effect.orDie))
      .handle("steer", ({ payload }) =>
        Effect.gen(function* () {
          const command = yield* Schema.decodeEffect(SteerCommand)(payload)
          yield* commands.steer(command)
        }).pipe(Effect.orDie),
      )
  }),
)

// ── Route Assembly ──

export interface ServerRoutesConfig {
  readonly identity: {
    readonly serverId: string
    readonly pid: number
    readonly hostname: string
    readonly dbPath: string
    readonly buildFingerprint: string
  }
}

/**
 * Build the full HTTP route layer for a gent server.
 *
 * Includes: RPC-over-WS, REST API, Swagger docs, identity route, CORS.
 * Caller provides `coreServicesLive` containing all service dependencies.
 */
export const buildServerRoutes = <A>(
  coreServicesLive: Layer.Layer<A>,
  config: ServerRoutesConfig,
) => {
  // RPC-over-WebSocket route
  const RpcRoutes = RpcServer.layerHttp({
    group: GentRpcs,
    path: "/rpc",
  }).pipe(
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(RpcHandlersLive),
    Layer.provide(coreServicesLive),
  )

  // REST API groups
  const HttpGroupsLive = Layer.provideMerge(SessionsApiLive, MessagesApiLive).pipe(
    Layer.provide(coreServicesLive),
  )
  const HttpApiRoutes = HttpApiBuilder.layer(GentApi).pipe(Layer.provide(HttpGroupsLive))

  // Swagger docs
  const DocsRoute = HttpApiScalar.layer(GentApi, { path: "/docs" })

  // Identity route — used by registry validation
  const IdentityRoute = HttpRouter.add(
    "GET",
    "/_gent/identity",
    HttpServerResponse.json(config.identity),
  )

  // OpenAPI JSON
  const OpenApiJsonRoute = HttpRouter.add(
    "GET",
    "/docs/openapi.json",
    HttpServerResponse.json(OpenApi.fromApi(GentApi)),
  )

  // Merge all routes
  return Layer.mergeAll(RpcRoutes, HttpApiRoutes, DocsRoute, OpenApiJsonRoute, IdentityRoute).pipe(
    Layer.provide(wsTracingLayer.pipe(Layer.provide(coreServicesLive))),
    Layer.provide(HttpRouter.cors()),
  )
}
