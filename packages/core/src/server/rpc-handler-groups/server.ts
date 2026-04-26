import { Clock, Effect } from "effect"
import type { RpcHandlerDeps } from "./shared.js"

export const buildServerRpcHandlers = (deps: RpcHandlerDeps) => ({
  "server.status": () =>
    Effect.gen(function* () {
      const connectionCount =
        deps.connectionTracker !== undefined ? yield* deps.connectionTracker.count() : 0
      return {
        serverId: deps.serverIdentity.serverId,
        pid: deps.serverIdentity.pid,
        hostname: deps.serverIdentity.hostname,
        uptime: (yield* Clock.currentTimeMillis) - deps.serverIdentity.startedAt,
        connectionCount,
        dbPath: deps.serverIdentity.dbPath,
        buildFingerprint: deps.serverIdentity.buildFingerprint,
      }
    }),
})
