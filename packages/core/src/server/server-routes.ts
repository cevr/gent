/**
 * Reusable HTTP route assembly for gent servers.
 *
 * Used by both the standalone server (apps/server/src/main.ts) and
 * the SDK's owned-server path (Gent.server with in-process HTTP listener).
 */

import { Effect, Layer, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { ConnectionTracker } from "./connection-tracker.js"
import { RpcHandlersLive } from "./rpc-handlers.js"
import { GentRpcs } from "./rpcs.js"

// ── WebSocket lifecycle tracing ──

/**
 * Layer that registers WebSocket lifecycle tracing on the HttpRouter.
 *
 * Detects upgrade requests by the `Upgrade: websocket` header and wraps
 * them with a span + structured logs. Non-upgrade requests pass through.
 *
 * Emits:
 *   - `ws.connect` log with url + remoteAddress on open
 *   - `ws.session` span wrapping the connection lifetime
 *   - `ws.disconnect` log on close
 *
 * Also increments/decrements `ConnectionTracker` when present, so the
 * server can shut down on idle.
 */
const wsTracingLayer: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.use((router) =>
  router.addGlobalMiddleware((handler) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const upgradeHeader = request.headers["upgrade"]
      const isUpgrade = upgradeHeader?.toLowerCase() === "websocket"

      if (!isUpgrade) return yield* handler

      const trackerOpt = yield* Effect.serviceOption(ConnectionTracker)
      if (Option.isSome(trackerOpt)) yield* trackerOpt.value.increment()

      yield* Effect.logInfo("ws.connect").pipe(
        Effect.annotateLogs({
          url: request.url,
          remoteAddress: request.remoteAddress ?? "unknown",
        }),
      )

      return yield* handler.pipe(
        Effect.withSpan("ws.session", {
          attributes: {
            "ws.url": request.url,
            "ws.remoteAddress": request.remoteAddress ?? "unknown",
          },
        }),
        Effect.ensuring(
          Effect.gen(function* () {
            if (Option.isSome(trackerOpt)) yield* trackerOpt.value.decrement()
            yield* Effect.logInfo("ws.disconnect").pipe(
              Effect.annotateLogs({
                url: request.url,
                remoteAddress: request.remoteAddress ?? "unknown",
              }),
            )
          }),
        ),
      )
    }),
  ),
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
 * Includes: RPC-over-WS, identity route, CORS.
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

  // Identity route — used by registry validation
  const IdentityRoute = HttpRouter.add(
    "GET",
    "/_gent/identity",
    HttpServerResponse.json(config.identity),
  )

  return Layer.mergeAll(RpcRoutes, IdentityRoute).pipe(
    Layer.provide(wsTracingLayer.pipe(Layer.provide(coreServicesLive))),
    Layer.provide(HttpRouter.cors()),
  )
}
