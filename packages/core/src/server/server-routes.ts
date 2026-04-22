/**
 * Reusable HTTP route assembly for gent servers.
 *
 * Used by both the standalone server (apps/server/src/main.ts) and
 * the SDK's owned-server path (Gent.server with in-process HTTP listener).
 */

import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { RpcServer, RpcSerialization } from "effect/unstable/rpc"
import { Layer } from "effect"
import { GentRpcs } from "./rpcs.js"
import { RpcHandlersLive } from "./rpc-handlers.js"
import { wsTracingLayer } from "./ws-tracing.js"

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
