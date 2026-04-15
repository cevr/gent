/**
 * ExecutorSidecar — scoped Effect service for managing the Executor runtime.
 *
 * Ported from pi-executor sidecar.ts + connection.ts + settings.ts.
 * Handles binary resolution, port scanning, spawn, health polling,
 * PID registry, and graceful shutdown via Effect.addFinalizer.
 */

import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Path,
  Schema,
  Semaphore,
} from "effect"
import { FetchHttpClient, HttpClient, HttpIncomingMessage } from "effect/unstable/http"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import {
  type ExecutorEndpoint,
  type ResolvedExecutorSettings,
  ScopeInfo,
  ExecutorSettings,
  ExecutorSettingsDefaults,
  ExecutorSidecarError,
  resolveSettings,
  DEFAULT_PORT_SEED,
  PORT_SCAN_LIMIT,
  HEALTH_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
} from "./domain.js"

// ── Internal types ──

interface SidecarRecord {
  readonly cwd: string
  readonly port: number
  readonly baseUrl: string
  readonly pid: number | undefined
  readonly ownedByGent: boolean
  readonly scope: ScopeInfo | undefined
  readonly subprocess: Subprocess | undefined
}

type Subprocess = ReturnType<typeof Bun.spawn>

interface RegisteredSidecar {
  readonly cwd: string
  readonly pid: number
  readonly port: number
  readonly baseUrl: string
  readonly startedAt: string
}

interface SidecarRegistryFile {
  readonly version: number
  readonly sidecars: Record<string, RegisteredSidecar>
}

type PortProbe =
  | { readonly port: number; readonly kind: "free" }
  | { readonly port: number; readonly kind: "reusable"; readonly scope: ScopeInfo }
  | { readonly port: number; readonly kind: "occupied" }

// ── Service interface ──

export interface ExecutorSidecarService {
  readonly resolveEndpoint: (cwd: string) => Effect.Effect<ExecutorEndpoint, ExecutorSidecarError>
  readonly stop: (cwd: string) => Effect.Effect<"stopped" | "missing", ExecutorSidecarError>
  readonly find: (cwd: string) => Effect.Effect<ExecutorEndpoint | undefined>
  readonly resolveSettings: (cwd: string) => Effect.Effect<ResolvedExecutorSettings>
}

export class ExecutorSidecar extends Context.Service<ExecutorSidecar, ExecutorSidecarService>()(
  "@gent/core/src/extensions/executor/sidecar/ExecutorSidecar",
) {
  static Live = (home: string) =>
    Layer.effect(
      ExecutorSidecar,
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fs = yield* FileSystem.FileSystem
        const require_ = createRequire(import.meta.url)
        const sidecarsByCwd = new Map<string, SidecarRecord>()
        const spawnMutex = yield* Semaphore.make(1)

        // ── Settings ──

        // @effect-diagnostics preferSchemaOverJson:off — parsing external settings files
        const readSettingsFile = (filePath: string) =>
          fs.readFileString(filePath).pipe(
            Effect.flatMap((raw) =>
              Effect.try({
                try: () => {
                  const json = JSON.parse(raw) as Record<string, unknown>
                  const section = json["gentExecutor"]
                  return section && typeof section === "object"
                    ? Schema.decodeUnknownSync(ExecutorSettings)(section)
                    : ({} as typeof ExecutorSettings.Type)
                },
                catch: () =>
                  new ExecutorSidecarError({
                    code: "STARTUP_TIMEOUT",
                    message: "Invalid settings JSON",
                  }),
              }),
            ),
            Effect.orElseSucceed(() => ({}) as typeof ExecutorSettings.Type),
          )

        const loadSettings = (cwd: string) =>
          Effect.gen(function* () {
            const globalPath = path.join(home, ".gent", "executor", "settings.json")
            const projectPath = path.join(path.resolve(cwd), ".gent", "executor", "settings.json")
            const [globalSettings, projectSettings] = yield* Effect.all([
              readSettingsFile(globalPath),
              readSettingsFile(projectPath),
            ])
            return resolveSettings(globalSettings, projectSettings)
          })

        // ── HTTP helpers ──

        const http = yield* HttpClient.HttpClient

        const fetchScope = (baseUrl: string, timeoutMs = HEALTH_TIMEOUT_MS) =>
          http.get(`${baseUrl}/api/scope`).pipe(
            Effect.timeout(Duration.millis(timeoutMs)),
            Effect.flatMap(HttpIncomingMessage.schemaBodyJson(ScopeInfo)),
            Effect.catchEager((e) =>
              Effect.fail(
                new ExecutorSidecarError({
                  code: "STARTUP_TIMEOUT",
                  message: `Failed to reach ${baseUrl}/api/scope: ${e instanceof Error ? e.message : String(e)}`,
                }),
              ),
            ),
          )

        // ── Port scanning ──

        const isPortFree = (port: number) =>
          Effect.callback<boolean>((resume) => {
            const server = createServer()
            server.once("error", () => {
              server.close()
              resume(Effect.succeed(false))
            })
            server.listen(port, "127.0.0.1", () => {
              server.close(() => resume(Effect.succeed(true)))
            })
          })

        const probePort = (cwd: string, port: number): Effect.Effect<PortProbe> => {
          const baseUrl = `http://127.0.0.1:${port}`
          return fetchScope(baseUrl).pipe(
            Effect.map(
              (scope): PortProbe =>
                scope.dir === cwd ? { port, kind: "reusable", scope } : { port, kind: "occupied" },
            ),
            Effect.catchEager(() =>
              isPortFree(port).pipe(
                Effect.map(
                  (free): PortProbe => (free ? { port, kind: "free" } : { port, kind: "occupied" }),
                ),
              ),
            ),
          )
        }

        const scanPorts = (cwd: string) =>
          Effect.gen(function* () {
            const probes: PortProbe[] = []
            for (let offset = 0; offset < PORT_SCAN_LIMIT; offset++) {
              probes.push(yield* probePort(cwd, DEFAULT_PORT_SEED + offset))
            }
            const reusable = probes.find(
              (p): p is PortProbe & { kind: "reusable" } => p.kind === "reusable",
            )
            if (reusable) return { reusable, freePort: undefined } as const
            const free = probes.find((p) => p.kind === "free")
            return { reusable: undefined, freePort: free?.port } as const
          })

        // ── PID registry ──

        const registryPath = path.join(home, ".gent", "executor-sidecars.json")
        const emptyRegistry: SidecarRegistryFile = { version: 1, sidecars: {} }

        const parseRegistry = (raw: unknown): SidecarRegistryFile => {
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyRegistry
          const obj = raw as Record<string, unknown>
          const sidecars = obj["sidecars"]
          if (typeof sidecars !== "object" || sidecars === null || Array.isArray(sidecars))
            return emptyRegistry
          return { version: 1, sidecars: sidecars as Record<string, RegisteredSidecar> }
        }

        // @effect-diagnostics preferSchemaOverJson:off — parsing sidecar registry file
        const readRegistry = fs.readFileString(registryPath).pipe(
          Effect.flatMap((raw) =>
            Effect.try({
              try: () => parseRegistry(JSON.parse(raw)),
              catch: () =>
                new ExecutorSidecarError({
                  code: "STARTUP_TIMEOUT",
                  message: "Invalid registry JSON",
                }),
            }),
          ),
          Effect.orElseSucceed(() => emptyRegistry),
        )

        const writeRegistry = (registry: SidecarRegistryFile) =>
          fs.makeDirectory(path.dirname(registryPath), { recursive: true }).pipe(
            Effect.andThen(
              fs.writeFileString(registryPath, JSON.stringify(registry, null, 2) + "\n"),
            ),
            Effect.orElseSucceed(() => {}),
          )

        const registerSidecar = (record: SidecarRecord) =>
          Effect.gen(function* () {
            if (record.pid === undefined) return
            const registry = yield* readRegistry
            registry.sidecars[record.cwd] = {
              cwd: record.cwd,
              pid: record.pid,
              port: record.port,
              baseUrl: record.baseUrl,
              startedAt: DateTime.formatIso(yield* DateTime.now),
            }
            yield* writeRegistry(registry)
          })

        const unregisterSidecar = (cwd: string, pid?: number) =>
          Effect.gen(function* () {
            const registry = yield* readRegistry
            const existing = registry.sidecars[cwd]
            if (!existing) return
            if (pid !== undefined && existing.pid !== pid) return
            delete registry.sidecars[cwd]
            yield* writeRegistry(registry)
          })

        const getRegisteredSidecar = (cwd: string) =>
          readRegistry.pipe(Effect.map((r) => r.sidecars[cwd]))

        // ── Binary resolution ──

        const resolveBinary = Effect.gen(function* () {
          // Try PATH first
          const fromPath = yield* Effect.sync(() => Bun.which("executor"))
          if (fromPath) return fromPath

          // Fallback: require.resolve → bootstrap if needed
          const pkgPath = yield* Effect.try({
            try: () => require_.resolve("executor/package.json"),
            catch: (e) =>
              new ExecutorSidecarError({
                code: "PACKAGE_RESOLUTION_FAILED",
                message: `Could not resolve executor: ${e instanceof Error ? e.message : String(e)}`,
              }),
          })
          const pkgRoot = path.dirname(pkgPath)
          const binaryName = process.platform === "win32" ? "executor.exe" : "executor"
          const runtimePath = path.join(pkgRoot, "bin", "runtime", binaryName)

          const exists = yield* fs.exists(runtimePath)
          if (!exists) {
            // Run postinstall to bootstrap
            const installerPath = path.join(pkgRoot, "postinstall.cjs")
            yield* Effect.tryPromise({
              try: async () => {
                const proc = Bun.spawn([process.execPath, installerPath], { cwd: pkgRoot })
                await proc.exited
                if (proc.exitCode !== 0) {
                  throw new Error(`Bootstrap failed with exit code ${proc.exitCode}`)
                }
              },
              catch: (e) =>
                new ExecutorSidecarError({
                  code: "BOOTSTRAP_FAILED",
                  message: `Bootstrap failed: ${e instanceof Error ? e.message : String(e)}`,
                }),
            })
            // Verify after bootstrap
            const existsAfter = yield* fs.exists(runtimePath)
            if (!existsAfter) {
              return yield* new ExecutorSidecarError({
                code: "PACKAGE_RESOLUTION_FAILED",
                message: `Runtime missing after bootstrap at ${runtimePath}`,
              })
            }
          }
          return runtimePath
        }).pipe(
          Effect.catchTag("PlatformError", (e) =>
            Effect.fail(
              new ExecutorSidecarError({
                code: "PACKAGE_RESOLUTION_FAILED",
                message: `File system error: ${e.message}`,
              }),
            ),
          ),
        )

        // ── Spawn + health poll ──

        const spawnSidecar = (cwd: string, port: number) =>
          Effect.gen(function* () {
            const binary = yield* resolveBinary
            const subprocess = yield* Effect.try({
              try: () => {
                const child = Bun.spawn([binary, "web", "--port", String(port)], {
                  cwd,
                  stdio: ["ignore", "ignore", "ignore"],
                })
                child.unref()
                return child
              },
              catch: (e) =>
                new ExecutorSidecarError({
                  code: "BOOTSTRAP_FAILED",
                  message: `Failed to spawn executor: ${e instanceof Error ? e.message : String(e)}`,
                }),
            })

            return {
              cwd,
              port,
              baseUrl: `http://127.0.0.1:${port}`,
              pid: subprocess.pid,
              ownedByGent: true,
              scope: undefined,
              subprocess,
            } satisfies SidecarRecord
          })

        const pollHealth = (baseUrl: string, cwd: string, timeoutMs: number) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
            while ((yield* Clock.currentTimeMillis) < deadline) {
              const result = yield* fetchScope(baseUrl, HEALTH_TIMEOUT_MS).pipe(
                Effect.map((scope) => (scope.dir === cwd ? scope : undefined)),
                Effect.orElseSucceed(() => undefined),
              )
              if (result) return result
              yield* Effect.promise(() => new Promise<void>((r) => setTimeout(r, 100)))
            }
            return yield* new ExecutorSidecarError({
              code: "STARTUP_TIMEOUT",
              message: `Sidecar at ${baseUrl} did not become healthy within ${timeoutMs}ms`,
            })
          })

        // ── Graceful shutdown ──

        const isPidAlive = (pid: number) =>
          Effect.sync(() => {
            try {
              process.kill(pid, 0)
              return true
            } catch {
              return false
            }
          })

        const terminatePid = (pid: number) =>
          Effect.gen(function* () {
            if (!(yield* isPidAlive(pid))) return
            yield* Effect.sync(() => process.kill(pid, "SIGTERM"))
            yield* Effect.promise(
              () => new Promise<void>((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS)),
            )
            if (yield* isPidAlive(pid)) {
              yield* Effect.sync(() => process.kill(pid, "SIGKILL"))
            }
          })

        const killRecord = (record: SidecarRecord) =>
          Effect.gen(function* () {
            if (record.subprocess && !record.subprocess.killed) {
              record.subprocess.kill(15 /* SIGTERM */)
              yield* Effect.promise(
                () => new Promise<void>((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS)),
              )
              if (!record.subprocess.killed) {
                record.subprocess.kill(9 /* SIGKILL */)
              }
            } else if (record.pid !== undefined) {
              yield* terminatePid(record.pid)
            }
            if (record.pid !== undefined) {
              yield* unregisterSidecar(record.cwd, record.pid)
            }
          })

        // Register finalizer to shut down owned sidecars (respects stopLocalOnShutdown)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const owned = Array.from(sidecarsByCwd.values()).filter((r) => r.ownedByGent)
            yield* Effect.all(
              owned.map((record) =>
                Effect.gen(function* () {
                  const settings = yield* loadSettings(record.cwd).pipe(
                    Effect.catchEager(() => Effect.succeed(ExecutorSettingsDefaults)),
                  )
                  if (settings.stopLocalOnShutdown) {
                    yield* killRecord(record)
                  }
                }),
              ),
              { concurrency: "unbounded" },
            )
          }).pipe(Effect.catchCause(() => Effect.void)),
        )

        // ── Core operations ──

        const findRunning = (cwd: string) =>
          Effect.gen(function* () {
            const normalized = path.resolve(cwd)
            const cached = sidecarsByCwd.get(normalized)
            if (cached) {
              const health = yield* fetchScope(cached.baseUrl).pipe(
                Effect.map((scope) => (scope.dir === normalized ? scope : undefined)),
                Effect.orElseSucceed(() => undefined),
              )
              if (health) return cached
              sidecarsByCwd.delete(normalized)
            }

            // Scan for a reusable sidecar on known ports
            const scan = yield* scanPorts(normalized)
            if (scan.reusable) {
              const record: SidecarRecord = {
                cwd: normalized,
                port: scan.reusable.port,
                baseUrl: `http://127.0.0.1:${scan.reusable.port}`,
                pid: undefined,
                ownedByGent: false,
                scope: scan.reusable.scope,
                subprocess: undefined,
              }
              sidecarsByCwd.set(normalized, record)
              return record
            }

            return undefined
          })

        const ensureSidecar = (cwd: string) =>
          spawnMutex.withPermits(1)(
            Effect.gen(function* () {
              const normalized = path.resolve(cwd)

              const running = yield* findRunning(normalized)
              if (running) return running

              const scan = yield* scanPorts(normalized)
              if (scan.freePort === undefined) {
                return yield* new ExecutorSidecarError({
                  code: "PORT_EXHAUSTED",
                  message: `No free port in ${DEFAULT_PORT_SEED}-${DEFAULT_PORT_SEED + PORT_SCAN_LIMIT - 1}`,
                })
              }

              const record = yield* spawnSidecar(normalized, scan.freePort)
              sidecarsByCwd.set(normalized, record)

              const scope = yield* pollHealth(record.baseUrl, normalized, STARTUP_TIMEOUT_MS).pipe(
                Effect.catchEager((e: ExecutorSidecarError) =>
                  killRecord(record).pipe(Effect.andThen(Effect.fail(e))),
                ),
              )

              if (scope.dir !== normalized) {
                yield* killRecord(record)
                return yield* new ExecutorSidecarError({
                  code: "SCOPE_MISMATCH",
                  message: `Sidecar scope dir ${scope.dir} doesn't match ${normalized}`,
                })
              }

              const updated: SidecarRecord = { ...record, scope }
              sidecarsByCwd.set(normalized, updated)
              yield* registerSidecar(updated)
              return updated
            }),
          )

        const toEndpoint = (record: SidecarRecord): ExecutorEndpoint => ({
          mode: "local",
          baseUrl: record.baseUrl,
          ownedByGent: record.ownedByGent,
          scope: record.scope ?? { id: "", name: "", dir: record.cwd },
        })

        // ── Service implementation ──

        return ExecutorSidecar.of({
          resolveEndpoint: (cwd) =>
            Effect.gen(function* () {
              const settings = yield* loadSettings(cwd)
              if (settings.mode === "remote") {
                const remoteUrl = settings.remoteUrl.trim().replace(/\/+$/, "")
                if (remoteUrl.length === 0) {
                  return yield* new ExecutorSidecarError({
                    code: "STARTUP_TIMEOUT",
                    message: "remoteUrl is required when mode is 'remote'",
                  })
                }
                const scope = yield* fetchScope(remoteUrl)
                return {
                  mode: "remote" as const,
                  baseUrl: remoteUrl,
                  ownedByGent: false,
                  scope,
                } satisfies ExecutorEndpoint
              }
              const record = yield* ensureSidecar(cwd)
              return toEndpoint(record)
            }),

          stop: (cwd) =>
            Effect.gen(function* () {
              const normalized = path.resolve(cwd)
              const running = yield* findRunning(normalized)
              if (running) {
                yield* killRecord(running)
                sidecarsByCwd.delete(normalized)
                return "stopped" as const
              }

              const registered = yield* getRegisteredSidecar(normalized)
              if (!registered) return "missing" as const

              if (!(yield* isPidAlive(registered.pid))) {
                yield* unregisterSidecar(normalized, registered.pid)
                return "missing" as const
              }

              yield* terminatePid(registered.pid)
              yield* unregisterSidecar(normalized, registered.pid)
              return "stopped" as const
            }),

          find: (cwd) => findRunning(cwd).pipe(Effect.map((r) => (r ? toEndpoint(r) : undefined))),

          resolveSettings: (cwd) => loadSettings(cwd),
        })
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer))

  static Test = (mock: Partial<ExecutorSidecarService> = {}): Layer.Layer<ExecutorSidecar> =>
    Layer.succeed(
      ExecutorSidecar,
      ExecutorSidecar.of({
        resolveEndpoint: mock.resolveEndpoint ?? (() => Effect.die("not mocked")),
        stop: mock.stop ?? (() => Effect.die("not mocked")),
        find: mock.find ?? (() => Effect.die("not mocked")),
        resolveSettings: mock.resolveSettings ?? (() => Effect.die("not mocked")),
      }),
    )
}
