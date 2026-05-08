/**
 * ExecutorSidecar — scoped Effect service for managing the Executor runtime.
 *
 * Ported from pi-executor sidecar.ts + connection.ts + settings.ts.
 * Handles binary resolution, port scanning, spawn, health polling,
 * PID registry, and graceful shutdown via Effect.addFinalizer.
 */

import {
  Clock,
  Config,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { isRecord, type ExtensionHostPlatform } from "@gent/core/extensions/api"
import { FetchHttpClient, HttpClient, HttpIncomingMessage } from "effect/unstable/http"
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process"
import { fileURLToPath } from "node:url"
import { ExecutorPlatform } from "./platform-adapter.js"
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

/**
 * Two valid sidecar configurations:
 * - `owned`: gent spawned the process; we hold the handle + handleScope
 *   for graceful shutdown. The remote `ScopeInfo` is filled in after the
 *   first successful health probe.
 * - `external`: gent discovered an already-running sidecar via port scan.
 *   No process control — we only know the URL and its self-reported scope.
 *
 * Discriminating on `_tag` makes the impossible states (handle without
 * handleScope, external with pid, etc.) unrepresentable.
 */
const ChildProcessHandleSchema = Schema.declare<ChildProcessSpawner.ChildProcessHandle>(
  (u): u is ChildProcessSpawner.ChildProcessHandle =>
    isRecord(u) && "kill" in u && "isRunning" in u && "unref" in u,
  { identifier: "ExecutorChildProcessHandle" },
)
const CloseableScopeSchema = Schema.declare<Scope.Closeable>(
  (u): u is Scope.Closeable => isRecord(u),
  { identifier: "ExecutorCloseableScope" },
)

const SidecarRecord = Schema.Union([
  Schema.TaggedStruct("owned", {
    cwd: Schema.String,
    port: Schema.Number,
    baseUrl: Schema.String,
    pid: Schema.Number,
    handle: ChildProcessHandleSchema,
    handleScope: CloseableScopeSchema,
    scope: Schema.optional(ScopeInfo),
  }),
  Schema.TaggedStruct("external", {
    cwd: Schema.String,
    port: Schema.Number,
    baseUrl: Schema.String,
    scope: ScopeInfo,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
type SidecarRecord = Schema.Schema.Type<typeof SidecarRecord>

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

const PortProbe = Schema.Union([
  Schema.TaggedStruct("free", {
    port: Schema.Number,
  }),
  Schema.TaggedStruct("reusable", {
    port: Schema.Number,
    scope: ScopeInfo,
  }),
  Schema.TaggedStruct("occupied", {
    port: Schema.Number,
  }),
]).pipe(Schema.toTaggedUnion("_tag"))
type PortProbe = Schema.Schema.Type<typeof PortProbe>

// ── Service interface ──

export interface ExecutorSidecarService {
  readonly resolveEndpoint: (
    cwd: string,
  ) => Effect.Effect<
    ExecutorEndpoint,
    ExecutorSidecarError,
    ChildProcessSpawner.ChildProcessSpawner
  >
  readonly stop: (cwd: string) => Effect.Effect<"stopped" | "missing", ExecutorSidecarError>
  readonly find: (cwd: string) => Effect.Effect<ExecutorEndpoint | undefined>
  readonly resolveSettings: (cwd: string) => Effect.Effect<ResolvedExecutorSettings>
}

export class ExecutorSidecar extends Context.Service<ExecutorSidecar, ExecutorSidecarService>()(
  "@gent/extensions/src/executor/sidecar/ExecutorSidecar",
) {
  static Live = (home: string, host: ExtensionHostPlatform) =>
    Layer.effect(
      ExecutorSidecar,
      Effect.gen(function* () {
        const path = yield* Path.Path
        const fs = yield* FileSystem.FileSystem
        const platform = yield* ExecutorPlatform
        const sidecarsByCwd = new Map<string, SidecarRecord>()
        const spawnMutex = yield* Semaphore.make(1)

        // ── Settings ──

        const parseSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
        const decodeSettings = (input: unknown) =>
          Schema.decodeUnknownEffect(ExecutorSettings)(input).pipe(
            Effect.mapError(
              () =>
                new ExecutorSidecarError({
                  code: "STARTUP_TIMEOUT",
                  message: "Invalid settings JSON",
                }),
            ),
          )

        const readSettingsFile = (filePath: string) =>
          fs.readFileString(filePath).pipe(
            Effect.flatMap((raw) =>
              parseSettingsJson(raw).pipe(
                Effect.mapError(
                  () =>
                    new ExecutorSidecarError({
                      code: "STARTUP_TIMEOUT",
                      message: "Invalid settings JSON",
                    }),
                ),
              ),
            ),
            Effect.flatMap((json) => {
              if (!isRecord(json)) return decodeSettings({})
              const section = json["gentExecutor"]
              return decodeSettings(section && typeof section === "object" ? section : {})
            }),
            Effect.orElseSucceed(() => ({})),
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

        const probePort = (cwd: string, port: number): Effect.Effect<PortProbe> => {
          const baseUrl = `http://127.0.0.1:${port}`
          return fetchScope(baseUrl).pipe(
            Effect.map(
              (scope): PortProbe =>
                scope.dir === cwd
                  ? PortProbe.cases.reusable.make({ port, scope })
                  : PortProbe.cases.occupied.make({ port }),
            ),
            Effect.catchEager(() =>
              platform
                .isPortFree(port)
                .pipe(
                  Effect.map(
                    (free): PortProbe =>
                      free
                        ? PortProbe.cases.free.make({ port })
                        : PortProbe.cases.occupied.make({ port }),
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
            const reusable = probes.find(PortProbe.guards.reusable)
            if (reusable) return { reusable, freePort: undefined } as const
            const free = probes.find(PortProbe.guards.free)
            return { reusable: undefined, freePort: free?.port } as const
          })

        // ── PID registry ──

        const registryPath = path.join(home, ".gent", "executor-sidecars.json")
        const emptyRegistry: SidecarRegistryFile = { version: 1, sidecars: {} }

        const parseRegistry = (raw: unknown): SidecarRegistryFile => {
          if (!isRecord(raw)) return emptyRegistry
          const sidecars = raw["sidecars"]
          if (!isRecord(sidecars)) return emptyRegistry
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- extension adapter narrows foreign SDK payload at boundary
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
            if (record._tag === "external") return
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

        // Resolve a command on `$PATH` by directory walk. Replaces the
        // legacy `platform.which` shim. Returns the absolute path of the
        // first matching entry, or `undefined` if none exists.
        const whichOnPath = (
          command: string,
        ): Effect.Effect<string | undefined, PlatformError.PlatformError> =>
          Effect.gen(function* () {
            // `Config.option` still surfaces `ConfigError` on parse failure
            // even when the var is missing. Treat any failure as "no PATH".
            const pathEnv = yield* Config.option(Config.string("PATH"))
              .asEffect()
              .pipe(Effect.catch(() => Effect.succeed(Option.none<string>())))
            const dirs = Option.match(pathEnv, {
              onNone: () => [] as ReadonlyArray<string>,
              onSome: (raw) => raw.split(platform.pathListSeparator).filter((d) => d.length > 0),
            })
            const candidates = platform.commandCandidates(command)
            for (const dir of dirs) {
              for (const name of candidates) {
                const candidate = path.join(dir, name)
                const exists = yield* fs.exists(candidate)
                if (exists) return candidate
              }
            }
            return undefined
          })

        const resolveBinary = Effect.gen(function* () {
          // Try PATH first
          const fromPath = yield* whichOnPath("executor")
          if (fromPath !== undefined) return fromPath

          // Fallback: package resolution → bootstrap if needed
          const pkgPath = yield* Effect.try({
            try: () => fileURLToPath(import.meta.resolve("executor/package.json")),
            catch: (e) =>
              new ExecutorSidecarError({
                code: "PACKAGE_RESOLUTION_FAILED",
                message: `Could not resolve executor: ${e instanceof Error ? e.message : String(e)}`,
              }),
          })
          const pkgRoot = path.dirname(pkgPath)
          const runtimePath = path.join(pkgRoot, "bin", "runtime", platform.binaryName)

          const exists = yield* fs.exists(runtimePath)
          if (!exists) {
            // Run postinstall to bootstrap
            const installerPath = path.join(pkgRoot, "postinstall.cjs")
            const result = yield* platform
              .runProcess(platform.execPath, [installerPath], {
                cwd: pkgRoot,
              })
              .pipe(
                Effect.catchTag("ExtensionHostProcessError", (e) =>
                  Effect.fail(
                    new ExecutorSidecarError({
                      code: "BOOTSTRAP_FAILED",
                      message: `Bootstrap failed: ${e.message}`,
                    }),
                  ),
                ),
              )
            if (result.exitCode !== 0) {
              return yield* new ExecutorSidecarError({
                code: "BOOTSTRAP_FAILED",
                message: `Bootstrap failed with exit code ${result.exitCode}`,
              })
            }
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
            const handleScope = yield* Scope.make()
            const handle = yield* ChildProcess.make(binary, ["web", "--port", String(port)], {
              cwd,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            })
              .asEffect()
              .pipe(
                Scope.provide(handleScope),
                Effect.catchTag("PlatformError", (e) =>
                  Effect.fail(
                    new ExecutorSidecarError({
                      code: "BOOTSTRAP_FAILED",
                      message: `Failed to spawn executor: ${e.message}`,
                    }),
                  ),
                ),
                Effect.tapError(() => Scope.close(handleScope, Exit.void)),
              )
            yield* handle.unref.pipe(Effect.ignore)

            return SidecarRecord.cases.owned.make({
              cwd,
              port,
              baseUrl: `http://127.0.0.1:${port}`,
              pid: Number(handle.pid),
              handle,
              handleScope,
              scope: undefined,
            })
          })

        // Sidecar boots an HTTP server in a separate process; there is no
        // IPC channel back to this Effect runtime. The poll is a genuine
        // network-side time wait, not a state-transition wait — so
        // Effect.sleep here is appropriate (and TestClock-friendly).
        const pollHealth = (baseUrl: string, cwd: string, timeoutMs: number) =>
          Effect.gen(function* () {
            const deadline = (yield* Clock.currentTimeMillis) + timeoutMs
            while ((yield* Clock.currentTimeMillis) < deadline) {
              const result = yield* fetchScope(baseUrl, HEALTH_TIMEOUT_MS).pipe(
                Effect.map((scope) => (scope.dir === cwd ? scope : undefined)),
                Effect.orElseSucceed(() => undefined),
              )
              if (result) return result
              yield* Effect.sleep(Duration.millis(100))
            }
            return yield* new ExecutorSidecarError({
              code: "STARTUP_TIMEOUT",
              message: `Sidecar at ${baseUrl} did not become healthy within ${timeoutMs}ms`,
            })
          })

        // ── Graceful shutdown ──

        // OS-level grace period between SIGTERM and SIGKILL. The kernel
        // delivers the signal asynchronously and we have no in-process
        // signal back from the foreign pid, so the timed sleep is the
        // right primitive here.
        const terminatePid = (pid: number) =>
          Effect.gen(function* () {
            if (!(yield* platform.isPidAlive(pid))) return
            yield* platform.signalPid(pid, "SIGTERM")
            yield* Effect.sleep(Duration.millis(SHUTDOWN_TIMEOUT_MS))
            if (yield* platform.isPidAlive(pid)) {
              yield* platform.signalPid(pid, "SIGKILL")
            }
          })

        const killRecord = (record: SidecarRecord) =>
          Effect.gen(function* () {
            if (record._tag === "external") return // not ours to kill
            const running = yield* record.handle.isRunning.pipe(Effect.orElseSucceed(() => false))
            if (running) {
              yield* record.handle
                .kill({
                  killSignal: "SIGTERM",
                  forceKillAfter: Duration.millis(SHUTDOWN_TIMEOUT_MS),
                })
                .pipe(Effect.ignore)
            }
            yield* Scope.close(record.handleScope, Exit.void).pipe(Effect.ignore)
            yield* unregisterSidecar(record.cwd, record.pid)
          })

        // Register finalizer to shut down owned sidecars (respects stopLocalOnShutdown)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const owned = Array.from(sidecarsByCwd.values()).filter(SidecarRecord.guards.owned)
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
              const record = SidecarRecord.cases.external.make({
                cwd: normalized,
                port: scan.reusable.port,
                baseUrl: `http://127.0.0.1:${scan.reusable.port}`,
                scope: scan.reusable.scope,
              })
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

              const updated = SidecarRecord.cases.owned.make({
                cwd: record.cwd,
                port: record.port,
                baseUrl: record.baseUrl,
                pid: record.pid,
                handle: record.handle,
                handleScope: record.handleScope,
                scope,
              })
              sidecarsByCwd.set(normalized, updated)
              yield* registerSidecar(updated)
              return updated
            }),
          )

        const toEndpoint = (record: SidecarRecord): ExecutorEndpoint => ({
          mode: "local",
          baseUrl: record.baseUrl,
          ownedByGent: record._tag === "owned",
          scope:
            record._tag === "external"
              ? record.scope
              : (record.scope ?? { id: "", name: "", dir: record.cwd }),
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

              if (!(yield* platform.isPidAlive(registered.pid))) {
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
    ).pipe(Layer.provide(Layer.merge(FetchHttpClient.layer, ExecutorPlatform.Live(host))))

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
