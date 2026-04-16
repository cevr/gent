/**
 * ACP Session Manager — subprocess lifecycle + session caching.
 *
 * One ACP subprocess per gent session, reused across turns.
 * Lifecycle: spawn → initialize → newSession → cache → reuse.
 *
 * @module
 */
import { Effect, Exit, Scope } from "effect"
import type { AcpAgentConfig } from "./config.js"
import { makeAcpConnection, type AcpConnection, type AcpError } from "./protocol.js"
import type { AcpManagedSession, AcpSessionManager } from "./executor.js"

interface AcpProcess {
  readonly conn: AcpConnection
  readonly acpSessionId: string
  readonly proc: { kill: () => void }
  readonly scope: Scope.Closeable
}

export const createAcpSessionManager = (): AcpSessionManager => {
  const sessions = new Map<string, AcpProcess>()

  const getOrCreate = (
    gentSessionId: string,
    config: AcpAgentConfig,
    cwd: string,
    mcpUrl?: string,
  ): Effect.Effect<AcpManagedSession, AcpError> =>
    Effect.gen(function* () {
      const existing = sessions.get(gentSessionId)
      if (existing !== undefined) {
        return { conn: existing.conn, acpSessionId: existing.acpSessionId }
      }

      // Spawn subprocess
      const proc = Bun.spawn([config.command, ...config.args], {
        stdio: ["pipe", "pipe", "inherit"],
      })

      // Create a long-lived scope for the connection's fibers
      const scope = yield* Scope.make()

      // Create ACP connection over stdio (within the session scope)
      const conn = yield* makeAcpConnection({
        stdin: {
          write: (data: string) => {
            proc.stdin.write(data)
          },
        },
        stdout: proc.stdout,
      }).pipe(Effect.provideService(Scope.Scope, scope))

      // Initialize — decline all capabilities (tools go through codemode MCP)
      yield* conn.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "gent", version: "0.0.0" },
      })

      // Create session with cwd and optional MCP server
      const mcpServers: unknown[] =
        mcpUrl !== undefined ? [{ type: "http", name: "gent", url: mcpUrl }] : []
      const sessionResponse = yield* conn.newSession({ cwd, mcpServers })

      const entry: AcpProcess = {
        conn,
        acpSessionId: sessionResponse.sessionId,
        proc: { kill: () => proc.kill() },
        scope,
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
        sessions.delete(id)
      }
    })

  return { getOrCreate, get, disposeAll }
}
