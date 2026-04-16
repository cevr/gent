/**
 * ACP Session Manager — subprocess lifecycle + session caching.
 *
 * One ACP subprocess per gent session, reused across turns.
 * Lifecycle: spawn → start codemode MCP → initialize → newSession → cache → reuse.
 *
 * @module
 */
import { Effect, Exit, Scope } from "effect"
import type { AcpAgentConfig } from "./config.js"
import { makeAcpConnection, type AcpConnection, type AcpError } from "./protocol.js"
import type { AcpManagedSession, AcpSessionManager } from "./executor.js"
import { startCodemodeServer, type CodemodeServer, type CodemodeConfig } from "./mcp-codemode.js"

interface AcpProcess {
  readonly conn: AcpConnection
  readonly acpSessionId: string
  readonly proc: { kill: () => void }
  readonly scope: Scope.Closeable
  readonly codemode?: CodemodeServer
}

export const createAcpSessionManager = (): AcpSessionManager => {
  const sessions = new Map<string, AcpProcess>()

  const getOrCreate = (
    gentSessionId: string,
    config: AcpAgentConfig,
    cwd: string,
    codemodeConfig?: CodemodeConfig,
  ): Effect.Effect<AcpManagedSession, AcpError> =>
    Effect.gen(function* () {
      const existing = sessions.get(gentSessionId)
      if (existing !== undefined) {
        return { conn: existing.conn, acpSessionId: existing.acpSessionId }
      }

      // Spawn subprocess first — if the binary is missing, fail fast before
      // starting the codemode server (avoids leaking an HTTP server)
      const proc = Bun.spawn([config.command, ...config.args], {
        stdio: ["pipe", "pipe", "inherit"],
      })

      // Start codemode MCP server if tools are available
      let codemode: CodemodeServer | undefined
      if (codemodeConfig !== undefined && codemodeConfig.tools.length > 0) {
        codemode = yield* startCodemodeServer(codemodeConfig)
      }

      // Create a long-lived scope for the connection's fibers
      const scope = yield* Scope.make()

      // Cleanup helper — kill process + close scope + stop codemode on failure
      const cleanup = Effect.gen(function* () {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
        proc.kill()
        codemode?.stop()
      })

      // Create ACP connection over stdio (within the session scope)
      const conn = yield* makeAcpConnection({
        stdin: {
          write: (data: string) => {
            proc.stdin.write(data)
          },
        },
        stdout: proc.stdout,
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.tapError(() => cleanup),
      )

      // Initialize — decline all capabilities (tools go through codemode MCP)
      yield* conn
        .initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "gent", version: "0.0.0" },
        })
        .pipe(Effect.tapError(() => cleanup))

      // Create session with cwd and codemode MCP server
      const mcpServers: unknown[] =
        codemode !== undefined ? [{ type: "http", name: "gent", url: `${codemode.url}/mcp` }] : []
      const sessionResponse = yield* conn
        .newSession({ cwd, mcpServers })
        .pipe(Effect.tapError(() => cleanup))

      const entry: AcpProcess = {
        conn,
        acpSessionId: sessionResponse.sessionId,
        proc: { kill: () => proc.kill() },
        scope,
        codemode,
      }
      sessions.set(gentSessionId, entry)

      return { conn, acpSessionId: sessionResponse.sessionId }
    })

  const get = (gentSessionId: string): AcpManagedSession | undefined => {
    const entry = sessions.get(gentSessionId)
    if (entry === undefined) return undefined
    return { conn: entry.conn, acpSessionId: entry.acpSessionId }
  }

  const disposeAll = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const [id, entry] of sessions) {
        yield* entry.conn.close.pipe(Effect.ignore)
        yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore)
        entry.proc.kill()
        entry.codemode?.stop()
        sessions.delete(id)
      }
    })

  return { getOrCreate, get, disposeAll }
}
