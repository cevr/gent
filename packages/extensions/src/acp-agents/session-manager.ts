/**
 * ACP Session Manager — subprocess lifecycle + session caching for
 * ACP-protocol agents (opencode / gemini-cli). Claude Code lives on the
 * SDK path; see `claude-code-executor.ts`.
 *
 * One ACP subprocess per (driverId, gentSessionId, branchId), reused
 * across turns. Branch + driver are part of the key because two
 * branches of the same gent session run logically separate
 * conversations and a driver swap mid-session must not reuse the prior
 * driver's subprocess.
 *
 * Lifecycle: spawn → initialize → newSession (with
 * `_meta.systemPrompt`) → cache → reuse.
 *
 * @module
 */
import { Context, Duration, Effect, Exit, HashMap, HashSet, Scope, Schema, TxRef } from "effect"
import { ChildProcess } from "effect/unstable/process"
// `ChildProcessSpawner` re-exported from `effect/unstable/process` is a
// namespace — for the runtime tag value we need the deep module path.
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { AcpProtocolAgentConfig } from "./config.js"
import { AcpError, makeAcpConnection, type AcpClosedError, type AcpConnection } from "./protocol.js"
import type { AcpManagedSession, AcpSessionManager, ExternalSessionKey } from "./executor.js"

const ACP_KILL_GRACE_MS = 5_000

interface AcpProcess {
  readonly conn: AcpConnection
  readonly acpSessionId: string
  readonly killProc: Effect.Effect<void>
  readonly scope: Scope.Closeable
  readonly procScope: Scope.Closeable
  readonly fingerprint: string
}

const cacheKey = (k: ExternalSessionKey): string => `${k.driverId}::${k.sessionId}::${k.branchId}`

const Fingerprint = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  systemPrompt: Schema.String,
})
const encodeFingerprint = Schema.encodeSync(Schema.fromJsonString(Fingerprint))

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
): string =>
  encodeFingerprint({
    command: config.command,
    args: config.args,
    cwd,
    systemPrompt,
  })

/**
 * Yield `ChildProcessSpawner` once at construction and capture it as a
 * one-tag context. Per-turn `getOrCreate` then provides the captured
 * spawner to its inner spawn calls so its public Effect has no service
 * requirement. `TurnExecutor.executeTurn` returns a Stream with no
 * context channel, so pinning the spawner here keeps that contract
 * honest without re-providing `BunServices.layer` per turn.
 */
export const createAcpSessionManager: Effect.Effect<AcpSessionManager, never, ChildProcessSpawner> =
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const spawnerContext = Context.make(ChildProcessSpawner, spawner)
    const sessionsRef = yield* TxRef.make(HashMap.empty<string, AcpProcess>())
    const byDriverRef = yield* TxRef.make(HashMap.empty<string, HashSet.HashSet<string>>())

    const removeFromDriverIndex = (driverId: string, k: string) =>
      TxRef.update(byDriverRef, (current) => {
        const found = HashMap.get(current, driverId)
        if (found._tag === "None") return current
        const next = HashSet.remove(found.value, k)
        if (HashSet.size(next) === 0) return HashMap.remove(current, driverId)
        return HashMap.set(current, driverId, next)
      })

    // Close all resources owned by an entry. State refs are NOT touched here
    // so callers can compose the corresponding sessions/driver-index updates
    // inside one Effect.tx transaction.
    const closeEntry = (entry: AcpProcess): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* entry.conn.close("driver invalidated").pipe(Effect.ignore)
        yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore)
        yield* entry.killProc
        yield* Scope.close(entry.procScope, Exit.void).pipe(Effect.ignore)
      })

    const tearDown = (k: string, entry: AcpProcess): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* closeEntry(entry)
        yield* TxRef.update(sessionsRef, (current) => HashMap.remove(current, k))
      })

    const getOrCreate = (
      key: ExternalSessionKey,
      config: AcpProtocolAgentConfig,
      cwd: string,
      systemPrompt: string,
    ): Effect.Effect<AcpManagedSession, AcpError | AcpClosedError> =>
      Effect.gen(function* () {
        const k = cacheKey(key)
        const fingerprint = fingerprintSession(config, cwd, systemPrompt)
        const existingOpt = HashMap.get(yield* TxRef.get(sessionsRef), k)
        if (existingOpt._tag === "Some") {
          const existing = existingOpt.value
          if (existing.fingerprint === fingerprint) {
            return {
              conn: existing.conn,
              acpSessionId: existing.acpSessionId,
              created: false,
            }
          }
          // Atomic eviction: drop from both refs in one transaction so a
          // concurrent invalidateDriver cannot see the entry without the
          // driver-index membership. Resource closes happen outside the tx
          // because side effects on Scope cannot participate in STM retry.
          yield* closeEntry(existing).pipe(Effect.ignore)
          yield* Effect.tx(
            Effect.gen(function* () {
              yield* removeFromDriverIndex(key.driverId, k)
              yield* TxRef.update(sessionsRef, (current) => HashMap.remove(current, k))
            }),
          )
        }

        // The process lives in `procScope` so the parent scope is not bound to
        // a long-lived child; the process survives across turns and is
        // explicitly killed on tearDown.
        const procScope = yield* Scope.make()
        const handle = yield* ChildProcess.make(config.command, [...config.args], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
        }).pipe(
          Scope.provide(procScope),
          Effect.catchTag("PlatformError", (e) =>
            Effect.fail(
              new AcpError({
                message: `failed to spawn ACP agent: ${e.message}`,
              }),
            ),
          ),
          Effect.tapError(() => Scope.close(procScope, Exit.void)),
        )

        const killProc = handle
          .kill({
            killSignal: "SIGTERM",
            forceKillAfter: Duration.millis(ACP_KILL_GRACE_MS),
          })
          .pipe(Effect.ignore)

        const scope = yield* Scope.make()

        const cleanup = Effect.gen(function* () {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
          yield* killProc
          yield* Scope.close(procScope, Exit.void).pipe(Effect.ignore)
        })

        const conn = yield* makeAcpConnection({
          stdin: handle.stdin,
          stdout: handle.stdout,
        }).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.tapError(() => cleanup),
        )

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

        // Create session with cwd and system prompt via ACP's `_meta` channel.
        // The wire format is open per agent — the claude-agent-acp reference
        // impl recognises `_meta.systemPrompt` (string = replace, `{append}`
        // = append). Agents that don't recognise it ignore the field.
        const sessionResponse = yield* conn
          .newSession({
            cwd,
            mcpServers: [],
            _meta: { systemPrompt },
          })
          .pipe(Effect.tapError(() => cleanup))

        const entry: AcpProcess = {
          conn,
          acpSessionId: sessionResponse.sessionId,
          killProc,
          scope,
          procScope,
          fingerprint,
        }
        // Install entry + driver-index update inside a single transaction so
        // a concurrent invalidateDriver cannot observe one ref's mutation
        // without the other's. Without Effect.tx the two TxRef.update calls
        // would commit independently, allowing a yield between them.
        yield* Effect.tx(
          Effect.gen(function* () {
            yield* TxRef.update(sessionsRef, (current) => HashMap.set(current, k, entry))
            yield* TxRef.update(byDriverRef, (current) => {
              const existing = HashMap.get(current, key.driverId)
              let set = HashSet.make(k)
              if (existing._tag === "Some") set = HashSet.add(existing.value, k)
              return HashMap.set(current, key.driverId, set)
            })
          }),
        )

        return { conn, acpSessionId: sessionResponse.sessionId, created: true }
      }).pipe(Effect.provide(spawnerContext))

    const invalidate = (key: ExternalSessionKey): Effect.Effect<void> =>
      Effect.gen(function* () {
        const k = cacheKey(key)
        const entryOpt = HashMap.get(yield* TxRef.get(sessionsRef), k)
        if (entryOpt._tag === "None") return
        yield* closeEntry(entryOpt.value)
        yield* Effect.tx(
          Effect.gen(function* () {
            yield* removeFromDriverIndex(key.driverId, k)
            yield* TxRef.update(sessionsRef, (current) => HashMap.remove(current, k))
          }),
        )
      })

    const invalidateDriver = (driverId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const driverKeys = yield* TxRef.modify(byDriverRef, (current) => {
          const found = HashMap.get(current, driverId)
          if (found._tag === "None") return [HashSet.empty<string>(), current]
          return [found.value, HashMap.remove(current, driverId)]
        })
        const keysArr = Array.from(driverKeys)
        const snapshot = yield* TxRef.get(sessionsRef)
        // Tear down in parallel — each kill may wait up to ACP_KILL_GRACE_MS
        // for forceKillAfter, so N stuck processes serialize to N × grace.
        yield* Effect.forEach(
          keysArr,
          (k) => {
            const entry = HashMap.get(snapshot, k)
            if (entry._tag === "None") return Effect.void
            return tearDown(k, entry.value).pipe(Effect.ignore)
          },
          { concurrency: 16, discard: true },
        )
      })

    const disposeAll: Effect.Effect<void> = Effect.gen(function* () {
      // Same parallelism rationale as invalidateDriver — server shutdown
      // shouldn't be N × ACP_KILL_GRACE_MS.
      const snapshot = yield* TxRef.get(sessionsRef)
      const entries = Array.from(HashMap.entries(snapshot))
      yield* Effect.forEach(entries, ([k, entry]) => tearDown(k, entry).pipe(Effect.ignore), {
        concurrency: 16,
        discard: true,
      })
      yield* TxRef.set(byDriverRef, HashMap.empty<string, HashSet.HashSet<string>>())
    })

    return { getOrCreate, invalidate, invalidateDriver, disposeAll }
  })
