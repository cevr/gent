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

  /** Deterministic identity for tests; values are stable so snapshots don't drift. */
  static Test = (overrides: Partial<ServerIdentityShape> = {}): Layer.Layer<ServerIdentity> =>
    Layer.succeed(ServerIdentity, {
      serverId: "test-server",
      pid: 0,
      hostname: "test-host",
      dbPath: ":memory:",
      buildFingerprint: "test-fingerprint",
      startedAt: 0,
      ...overrides,
    })
}
