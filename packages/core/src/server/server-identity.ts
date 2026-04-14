/**
 * ServerIdentity — provides server identity info for status/identity routes.
 * Populated by the server app at startup.
 */

import { Context, Layer } from "effect"

export interface ServerIdentityShape {
  readonly serverId: string
  readonly pid: number
  readonly hostname: string
  readonly dbPath: string
  readonly buildFingerprint: string
  readonly startedAt: number
}

export class ServerIdentity extends Context.Service<ServerIdentity, ServerIdentityShape>()(
  "@gent/core/src/server/server-identity/ServerIdentity",
) {
  static Live = (config: ServerIdentityShape): Layer.Layer<ServerIdentity> =>
    Layer.succeed(ServerIdentity, config)
}
