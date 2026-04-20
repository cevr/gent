/**
 * ACP Session Manager — subprocess lifecycle + session caching for
 * ACP-protocol agents (opencode / gemini-cli). Claude Code lives on the
 * SDK path; see `claude-code-executor.ts`.
 *
 * One ACP subprocess per (driverId, gentSessionId, branchId), reused
 * across turns. Branch + driver are part of the key because two
 * branches of the same gent session run logically separate
 * conversations and a driver swap mid-session must not reuse the prior
 * driver's subprocess (codex HIGH #2 / #3).
 *
 * Lifecycle: spawn → start codemode MCP → initialize → newSession (with
 * `_meta.systemPrompt`) → cache → reuse.
 *
 * @module
 */
import { Effect, Exit, Scope } from "effect"
import type { AcpProtocolAgentConfig } from "./config.js"
import {
  makeAcpConnection,
  type AcpClosedError,
  type AcpConnection,
  type AcpError,
} from "./protocol.js"
import type { AcpManagedSession, AcpSessionManager, ExternalSessionKey } from "./executor.js"
import { startCodemodeServer, type CodemodeServer, type CodemodeConfig } from "./mcp-codemode.js"

interface AcpProcess {
  readonly conn: AcpConnection
  readonly acpSessionId: string
  readonly proc: { kill: () => void }
  readonly scope: Scope.Closeable
  readonly codemode?: CodemodeServer
  readonly fingerprint: string
}

const cacheKey = (k: ExternalSessionKey): string => `${k.driverId}::${k.sessionId}::${k.branchId}`

/**
 * Fingerprint covers every session-defining input passed to ACP
 * `newSession` plus the spawn config. Stale-cache hits otherwise let
 * a runtime driver override or extension change silently keep serving
 * the wrong cwd / prompt / tool surface.
 */
const fingerprintSession = (
  config: AcpProtocolAgentConfig,
  cwd: string,
  systemPrompt: string,
  codemodeConfig: CodemodeConfig | undefined,
): string => {
  const toolNames =
    codemodeConfig === undefined
      ? []
      : codemodeConfig.tools
          .map((t) => t.name)
          .slice()
          .sort()
  return JSON.stringify({
    command: config.command,
    args: config.args,
    cwd,
    systemPrompt,
    tools: toolNames,
  })
}

export const createAcpSessionManager = (): AcpSessionManager => {
  const sessions = new Map<string, AcpProcess>()
  const byDriver = new Map<string, Set<string>>()

  const removeFromDriverIndex = (driverId: string, k: string) => {
    const set = byDriver.get(driverId)
    if (set === undefined) return
    set.delete(k)
    if (set.size === 0) byDriver.delete(driverId)
  }

  const tearDown = (k: string, entry: AcpProcess): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* entry.conn.close("driver invalidated").pipe(Effect.ignore)
      yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore)
      entry.proc.kill()
      entry.codemode?.stop()
      sessions.delete(k)
    })

  const getOrCreate = (
    key: ExternalSessionKey,
    config: AcpProtocolAgentConfig,
    cwd: string,
    systemPrompt: string,
    codemodeConfig?: CodemodeConfig,
  ): Effect.Effect<AcpManagedSession, AcpError | AcpClosedError> =>
    Effect.gen(function* () {
      const k = cacheKey(key)
      const fingerprint = fingerprintSession(config, cwd, systemPrompt, codemodeConfig)
      const existing = sessions.get(k)
      if (existing !== undefined) {
        if (existing.fingerprint === fingerprint) {
          return {
            conn: existing.conn,
            acpSessionId: existing.acpSessionId,
            created: false,
          }
        }
        removeFromDriverIndex(key.driverId, k)
        yield* tearDown(k, existing).pipe(Effect.ignore)
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

      // Create session with cwd, codemode MCP server, and system prompt via
      // ACP's `_meta` channel. The wire format is open per agent — the
      // claude-agent-acp reference impl recognises `_meta.systemPrompt`
      // (string = replace, `{append}` = append). Agents that don't
      // recognise it ignore the field.
      const mcpServers: unknown[] =
        codemode !== undefined ? [{ type: "http", name: "gent", url: `${codemode.url}/mcp` }] : []
      const sessionResponse = yield* conn
        .newSession({
          cwd,
          mcpServers,
          _meta: { systemPrompt },
        })
        .pipe(Effect.tapError(() => cleanup))

      const entry: AcpProcess = {
        conn,
        acpSessionId: sessionResponse.sessionId,
        proc: { kill: () => proc.kill() },
        scope,
        codemode,
        fingerprint,
      }
      sessions.set(k, entry)
      const driverSet = byDriver.get(key.driverId) ?? new Set<string>()
      driverSet.add(k)
      byDriver.set(key.driverId, driverSet)

      return { conn, acpSessionId: sessionResponse.sessionId, created: true }
    })

  const invalidate = (key: ExternalSessionKey): Effect.Effect<void> =>
    Effect.gen(function* () {
      const k = cacheKey(key)
      const entry = sessions.get(k)
      if (entry === undefined) return
      removeFromDriverIndex(key.driverId, k)
      yield* tearDown(k, entry)
    })

  const invalidateDriver = (driverId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const keys = byDriver.get(driverId)
      if (keys === undefined) return
      const keysArr = [...keys]
      byDriver.delete(driverId)
      for (const k of keysArr) {
        const entry = sessions.get(k)
        if (entry !== undefined) yield* tearDown(k, entry).pipe(Effect.ignore)
      }
    })

  const disposeAll = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const [k, entry] of sessions) {
        yield* tearDown(k, entry)
      }
      byDriver.clear()
    })

  return { getOrCreate, invalidate, invalidateDriver, disposeAll }
}
