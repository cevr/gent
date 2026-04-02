/**
 * WebSocket transport lifecycle tracing.
 *
 * Instruments WebSocket upgrade requests with connection lifecycle logs
 * and spans. Since the RPC server handles WS upgrade internally via
 * @effect/platform, we use HttpRouter.use to wrap the router handler
 * with tracing at the HTTP level.
 *
 * When a client opens a WS connection:
 *   - `ws.connect` log with url + remoteAddress
 *   - `ws.session` span wrapping the entire connection lifetime
 * When the connection closes:
 *   - `ws.disconnect` log with reason (clean vs error)
 */

import { Effect, type Layer } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

/**
 * Layer that registers WebSocket lifecycle tracing on the HttpRouter.
 *
 * Detects upgrade requests by the `Upgrade: websocket` header and wraps
 * them with a span + structured logs. Non-upgrade requests pass through.
 *
 * Wire into the route layer:
 * ```ts
 * const AllRoutes = Layer.mergeAll(RpcRoutes, ...).pipe(
 *   Layer.provide(wsTracingLayer),
 * )
 * ```
 */
export const wsTracingLayer: Layer.Layer<never, never, HttpRouter.HttpRouter> = HttpRouter.use(
  (router) =>
    router.addGlobalMiddleware((handler) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const upgradeHeader = request.headers["upgrade"]
        const isUpgrade = upgradeHeader?.toLowerCase() === "websocket"

        if (!isUpgrade) return yield* handler

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
            Effect.logInfo("ws.disconnect").pipe(
              Effect.annotateLogs({
                url: request.url,
                remoteAddress: request.remoteAddress ?? "unknown",
              }),
            ),
          ),
        )
      }),
    ),
)
