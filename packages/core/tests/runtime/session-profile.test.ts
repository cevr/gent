import { describe, it, expect } from "effect-bun-test"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import {
  ExtensionHost,
  defineExtension,
  defineResource,
  type GentExtension,
} from "@gent/core/extensions/api"
import {
  SessionProfileCache,
  SessionProfileUnavailableError,
} from "../../src/runtime/session-profile"
import { ConfigService } from "../../src/runtime/config-service"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import { SqliteStorage } from "../../src/storage/sqlite-storage"
import { ProcessRunnerLive } from "../../src/utils/run-process"
import { CurrentWorkspaceId, WorkspaceId } from "../../src/server/workspace-rpc"
import { ResourceLeaseStaleGenerationError } from "../../src/runtime/extensions/resource-host/resource-leases"
import { waitFor } from "../../src/test-utils/fixtures"

const processRunnerLive = ProcessRunnerLive.pipe(Layer.provide(BunServices.layer))

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

class SessionProfileResourceMarker extends Context.Service<
  SessionProfileResourceMarker,
  { readonly value: string }
>()("@gent/core/tests/runtime/session-profile.test/SessionProfileResourceMarker") {}

const makeCacheLayer = (params: {
  readonly cwd: string
  readonly home: string
  readonly extensions: ReadonlyArray<GentExtension>
}) => {
  const runtimeEnvironmentLive = RuntimeEnvironment.Live({
    cwd: params.cwd,
    home: params.home,
    platform: "darwin",
  })
  const configServiceLive = ConfigService.Live.pipe(
    Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
  )
  return SessionProfileCache.Live({
    home: params.home,
    platform: "darwin",
    extensions: params.extensions,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        BunServices.layer,
        processRunnerLive,
        configServiceLive,
        SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
      ),
    ),
  )
}

describe("session profile resolution", () => {
  it.scopedLive("isolates the live publication by workspace and supports refresh", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const workspaceA = WorkspaceId.make("a".repeat(64))
      const workspaceB = WorkspaceId.make("b".repeat(64))
      const configPath = path.join(home, ".gent", "config.json")
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
      yield* fs.writeFileString(configPath, encodeJson({ permissions: [] }))
      const runtimeEnvironmentLive = RuntimeEnvironment.Live({
        cwd: launch,
        home,
        platform: "darwin",
      })
      const configServiceLive = ConfigService.Live.pipe(
        Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
      )
      const sessionProfileCacheLive = SessionProfileCache.Live({
        home,
        platform: "darwin",
        extensions: [],
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            BunServices.layer,
            processRunnerLive,
            configServiceLive,
            SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
          ),
        ),
      )

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const profileA = yield* cache
          .resolve(path.join(launch, "."))
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
        const profileB = yield* cache
          .resolve(path.join(launch, "."))
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))

        expect(profileA).not.toBe(profileB)
        expect(profileA.publication?.generationId).not.toBe(profileB.publication?.generationId)

        yield* fs.writeFileString(
          configPath,
          encodeJson({ permissions: [{ tool: "bash", action: "deny" }] }),
        )
        const refreshed = yield* cache
          .refresh(launch)
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
        const permission = yield* refreshed.permissionService.check("bash", { command: "ls -la" })
        expect(permission).toBe("denied")

        yield* fs.writeFileString(configPath, "{ malformed")
        const invalidRefresh = yield* cache
          .refresh(launch)
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA), Effect.exit)
        expect(Exit.isFailure(invalidRefresh)).toBe(true)
        const currentA = yield* cache
          .current(launch)
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
        expect(Option.isSome(currentA)).toBe(true)
        const retainedPermission = yield* Option.getOrThrow(currentA).permissionService.check(
          "bash",
          { command: "ls -la" },
        )
        expect(retainedPermission).toBe("denied")

        const currentB = yield* cache
          .current(launch)
          .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB))
        expect(Option.isSome(currentB)).toBe(true)
        expect(Option.getOrThrow(currentB).publication?.generationId).toBe(
          profileB.publication?.generationId,
        )
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(sessionProfileCacheLive))
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("keeps permission rules scoped to the session cwd instead of the launch cwd", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const secondary = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()

      const writeProjectConfig = (
        cwd: string,
        permissions: ReadonlyArray<Record<string, string>>,
      ) =>
        Effect.gen(function* () {
          const configDir = path.join(cwd, ".gent")
          yield* fs.makeDirectory(configDir, { recursive: true })
          yield* fs.writeFileString(
            path.join(configDir, "config.json"),
            encodeJson({ permissions }),
          )
        })

      yield* writeProjectConfig(launch, [{ tool: "bash", action: "deny" }])
      yield* writeProjectConfig(secondary, [])

      const runtimeEnvironmentLive = RuntimeEnvironment.Live({
        cwd: launch,
        home,
        platform: "darwin",
      })
      const configServiceLive = ConfigService.Live.pipe(
        Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
      )
      const sessionProfileCacheLive = SessionProfileCache.Live({
        home,
        platform: "darwin",
        extensions: [],
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            BunServices.layer,
            processRunnerLive,
            configServiceLive,
            SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
          ),
        ),
      )

      yield* Effect.gen(function* () {
        const cache = yield* SessionProfileCache
        const launchProfile = yield* cache.resolve(launch)
        const secondaryProfile = yield* cache.resolve(secondary)

        const launchPermission = yield* launchProfile.permissionService.check("bash", {
          command: "ls -la",
        })
        const secondaryPermission = yield* secondaryProfile.permissionService.check("bash", {
          command: "ls -la",
        })

        expect(launchPermission).toBe("denied")
        expect(secondaryPermission).toBe("allowed")
      }).pipe(
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
        Effect.provide(sessionProfileCacheLive),
        Effect.provideService(CurrentWorkspaceId, WorkspaceId.make("c".repeat(64))),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive(
    "restages catalogs without rebuilding retained resources and replaces revisions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const launch = yield* fs.makeTempDirectoryScoped()
        const home = yield* fs.makeTempDirectoryScoped()
        const workspace = WorkspaceId.make("d".repeat(64))
        const configPath = path.join(home, ".gent", "config.json")
        yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
        yield* fs.writeFileString(configPath, encodeJson({ permissions: [] }))

        let resourceRevision = "1"
        let starts = 0
        let stops = 0
        const resourceExtension = defineExtension({
          id: "@gent/test-session-profile/resource-replacement",
          // Setup re-runs on every refresh, so the declaration value is rebuilt each time.
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              defineResource({
                id: "test/session-profile/resource-replacement",
                revision: resourceRevision,
                scope: "process",
                // This layer is rebuilt as a declaration value on every refresh.
                // The host must use the resource revision, not Layer identity.
                layer: Layer.succeed(
                  SessionProfileResourceMarker,
                  SessionProfileResourceMarker.of({ value: resourceRevision }),
                ),
                start: Effect.sync(() => {
                  starts += 1
                }),
                stop: Effect.sync(() => {
                  stops += 1
                }),
              }),
            )
          }),
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const cache = yield* SessionProfileCache
            const first = yield* cache
              .resolve(launch)
              .pipe(Effect.provideService(CurrentWorkspaceId, workspace))
            expect(starts).toBe(1)

            const unchanged = yield* cache
              .refresh(launch)
              .pipe(Effect.provideService(CurrentWorkspaceId, workspace))
            expect(unchanged.publication?.generationId).toBe(first.publication?.generationId)
            expect(starts).toBe(1)
            expect(stops).toBe(0)

            yield* fs.writeFileString(
              configPath,
              encodeJson({ permissions: [{ tool: "bash", action: "deny" }] }),
            )
            const catalogOnly = yield* cache
              .refresh(launch)
              .pipe(Effect.provideService(CurrentWorkspaceId, workspace))
            expect(catalogOnly.publication?.generationId).not.toBe(first.publication?.generationId)
            expect(starts).toBe(1)
            expect(stops).toBe(0)

            resourceRevision = "2"
            const replaced = yield* cache
              .refresh(launch)
              .pipe(Effect.provideService(CurrentWorkspaceId, workspace))
            expect(replaced.publication?.generationId).not.toBe(
              catalogOnly.publication?.generationId,
            )
            expect(starts).toBe(2)
            expect(stops).toBe(1)

            const stalePublication = Option.fromUndefinedOr(first.publication)
            expect(Option.isSome(stalePublication)).toBe(true)
            if (Option.isSome(stalePublication)) {
              const staleUse = yield* stalePublication.value
                .run(Effect.succeed("stale"))
                .pipe(Effect.exit)
              expect(Exit.isFailure(staleUse)).toBe(true)
              if (Exit.isFailure(staleUse)) {
                expect(
                  Schema.is(ResourceLeaseStaleGenerationError)(Cause.squash(staleUse.cause)),
                ).toBe(true)
              }
            }

            const current = yield* cache
              .requireCurrent(launch)
              .pipe(Effect.provideService(CurrentWorkspaceId, workspace))
            expect(current.publication?.generationId).toBe(replaced.publication?.generationId)
          }).pipe(
            // oxlint-disable-next-line effect/noInlineProvide -- This focused test owns one isolated live cache layer.
            Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [resourceExtension] })),
          ),
        )
        expect(stops).toBe(2)
      }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("does not block an unrelated workspace while one publication drains", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const workspaceA = WorkspaceId.make("e".repeat(64))
      const workspaceB = WorkspaceId.make("f".repeat(64))
      const configPath = path.join(home, ".gent", "config.json")
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
      yield* fs.writeFileString(configPath, encodeJson({ permissions: [] }))

      const resourceExtension = defineExtension({
        id: "@gent/test-session-profile/drain-isolation",
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "test/session-profile/drain-isolation",
              scope: "process",
              layer: Layer.succeed(
                SessionProfileResourceMarker,
                SessionProfileResourceMarker.of({ value: "drain-isolation" }),
              ),
            }),
          )
        }),
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const cache = yield* SessionProfileCache
          const first = yield* cache
            .resolve(launch)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA))
          const firstPublication = Option.getOrThrow(Option.fromUndefinedOr(first.publication))
          const activeEntered = yield* Deferred.make<void>()
          const releaseActive = yield* Deferred.make<void>()
          const active = yield* firstPublication
            .run(
              Effect.gen(function* () {
                yield* Deferred.succeed(activeEntered, void 0)
                yield* Deferred.await(releaseActive)
              }),
            )
            .pipe(Effect.forkChild)
          yield* Deferred.await(activeEntered)

          yield* fs.writeFileString(
            configPath,
            encodeJson({ permissions: [{ tool: "bash", action: "deny" }] }),
          )
          const refreshing = yield* cache
            .refresh(launch)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceA), Effect.forkChild)

          const admissionAttempt = yield* waitFor(
            firstPublication.run(Effect.succeed("late")).pipe(Effect.exit),
            Exit.isFailure,
            1_000,
            "publication admission closes",
          )
          expect(Exit.isFailure(admissionAttempt)).toBe(true)

          const unrelated = yield* cache
            .resolve(launch)
            .pipe(Effect.provideService(CurrentWorkspaceId, workspaceB), Effect.forkChild)
          const unrelatedExit = yield* Fiber.await(unrelated).pipe(
            Effect.timeoutOption("250 millis"),
          )
          expect(Option.isSome(unrelatedExit)).toBe(true)
          if (Option.isSome(unrelatedExit)) expect(Exit.isSuccess(unrelatedExit.value)).toBe(true)

          yield* Deferred.succeed(releaseActive, void 0)
          expect(Exit.isSuccess(yield* Fiber.await(active))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(refreshing))).toBe(true)
        }).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- This focused test owns one isolated live cache layer.
          Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [resourceExtension] })),
        ),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )

  it.scopedLive("does not retain an interrupted initial publication", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const launch = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const workspace = WorkspaceId.make("1".repeat(64))
      const startEntered = yield* Deferred.make<void>()
      const releaseStart = yield* Deferred.make<void>()
      const resourceExtension = defineExtension({
        id: "@gent/test-session-profile/interrupted-start",
        setup: Effect.gen(function* () {
          yield* Deferred.succeed(startEntered, void 0)
          yield* Deferred.await(releaseStart)
        }),
      })

      yield* Effect.ensuring(
        Effect.scoped(
          Effect.gen(function* () {
            const cache = yield* SessionProfileCache
            const resolving = yield* cache
              .resolve(launch)
              .pipe(Effect.provideService(CurrentWorkspaceId, workspace), Effect.forkChild)
            yield* Deferred.await(startEntered)
            yield* Fiber.interrupt(resolving)
            expect(Exit.isFailure(yield* Fiber.await(resolving))).toBe(true)
            const current = yield* cache
              .current(launch)
              .pipe(Effect.provideService(CurrentWorkspaceId, workspace))
            expect(Option.isNone(current)).toBe(true)
            const unavailable = yield* cache
              .requireCurrent(launch)
              .pipe(Effect.provideService(CurrentWorkspaceId, workspace), Effect.exit)
            expect(Exit.isFailure(unavailable)).toBe(true)
            if (Exit.isFailure(unavailable)) {
              const error = Cause.findErrorOption(unavailable.cause)
              expect(Option.isSome(error)).toBe(true)
              if (Option.isSome(error)) {
                expect(error.value).toBeInstanceOf(SessionProfileUnavailableError)
              }
            }
          }).pipe(
            // oxlint-disable-next-line effect/noInlineProvide -- This focused interruption test owns one isolated live cache layer.
            Effect.provide(makeCacheLayer({ cwd: launch, home, extensions: [resourceExtension] })),
          ),
        ),
        Deferred.succeed(releaseStart, void 0).pipe(Effect.asVoid),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )
})
