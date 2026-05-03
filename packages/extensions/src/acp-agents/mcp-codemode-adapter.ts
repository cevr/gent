/**
 * MCP codemode adapter — wraps the `Bun.*` calls used by the codemode MCP
 * server so the surrounding extension code stays runtime-agnostic.
 *
 * Two thin wrappers:
 * - `inspectValue`: stringifies a JS value for the `execute` tool's text reply.
 * - `startCodemodeServer`: starts a stateless HTTP listener with a per-request
 *   fetch handler and returns the listener's port and a `stop` callback.
 *
 * The `no-bun-outside-adapter` lint rule restricts `Bun.*` usage to files
 * matching the `*-adapter.ts` suffix; this module owns the codemode server
 * platform boundary.
 */

export interface CodemodeListener {
  readonly port: number
  readonly stop: () => void
}

export interface CodemodeListenerOptions {
  readonly fetch: (request: Request) => Response | Promise<Response>
}

/** Stringify an arbitrary value for the codemode `execute` tool reply. */
export const inspectValue = (value: unknown): string => Bun.inspect(value)

/**
 * Start the codemode HTTP listener. Binds an ephemeral port and dispatches
 * each request through `options.fetch`.
 */
export const startCodemodeListener = (options: CodemodeListenerOptions): CodemodeListener => {
  const bunServer = Bun.serve({
    port: 0,
    fetch: options.fetch,
  })

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- port is always defined when Bun.serve succeeds
  const port = bunServer.port as number

  return {
    port,
    stop: () => {
      bunServer.stop()
    },
  }
}
