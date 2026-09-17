import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { Context, Effect, FileSystem, Layer, Path, Schema, Stream } from "effect"
import { BranchId, SessionId } from "../../src/domain/ids"
import { ProcessGenerationId } from "../../src/domain/process-generation"
import { dateFromMillis, Session } from "../../src/domain/message"
import { ConfigService } from "../../src/runtime/config-service"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import {
  resolveTurnProfile,
  type TurnProfileDefaults,
} from "../../src/runtime/session-runtime-context"
import {
  ExtensionHostContextProvider,
  makeExtensionHostContextProvider,
} from "../../src/runtime/make-extension-host-context"
import { RuntimeEnvironment } from "../../src/runtime/runtime-environment"
import {
  SessionProfileCache,
  type SessionProfile,
  type SessionProfileCacheService,
} from "../../src/runtime/session-profile"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { SqliteStorage, StorageError } from "../../src/storage/sqlite-storage"
import { SessionStorage, type SessionStorageService } from "../../src/storage/session-storage"
import type { ExternalDriverContribution } from "../../src/domain/driver"
import { testHostFacts } from "../../src/test-utils"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const emptyRegistryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
const emptyDriverRegistryLayer = DriverRegistry.fromResolved({
  modelDrivers: new Map(),
  externalDrivers: new Map(),
})
describe("resolveTurnProfile", () => {
  it.scopedLive("uses the stored session cwd to resolve the profile-scoped host context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const launch = yield* fs.makeTempDirectoryScoped()
      const secondary = yield* fs.makeTempDirectoryScoped()
      const home = yield* fs.makeTempDirectoryScoped()
      const writeProjectConfig = (cwd: string) =>
        Effect.gen(function* () {
          const configDir = path.join(cwd, ".gent")
          yield* fs.makeDirectory(configDir, { recursive: true })
          yield* fs.writeFileString(path.join(configDir, "config.json"), encodeJson({}))
        })
      yield* writeProjectConfig(launch)
      yield* writeProjectConfig(secondary)
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
            configServiceLive,
            SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
          ),
        ),
      )
      const testLayer = Layer.mergeAll(
        BunServices.layer,
        SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(BunPlatformLive)),
        emptyRegistryLayer,
        emptyDriverRegistryLayer,
        runtimeEnvironmentLive,
        sessionProfileCacheLive,
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const extensionRegistry = yield* ExtensionRegistry
        const profileCache = yield* SessionProfileCache
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessionStorage.createSession(
          new Session({
            id: SessionId.make("session-runtime-context-profile"),
            cwd: secondary,
            createdAt: now,
            updatedAt: now,
          }),
        )
        const hostProvider = yield* makeExtensionHostContextProvider({
          host: testHostFacts().host,
          extensionRegistry,
        })
        const resolved = yield* resolveTurnProfile({
          sessionId: SessionId.make("session-runtime-context-profile"),
          branchId: BranchId.make("branch-runtime-context-profile"),
          profileCache,
          defaults: {
            driverRegistry: yield* DriverRegistry,
            baseSections: [],
          },
        }).pipe(Effect.provideService(ExtensionHostContextProvider, hostProvider))
        expect(resolved.turnHostCtx.cwd).toBe(secondary)
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(testLayer), Effect.scoped)
    }).pipe(Effect.provide(BunPlatformLive)),
  )
  it.live("falls back to host deps and defaults when no session profile is available", () =>
    Effect.gen(function* () {
      const runtimeEnvironmentLayer = RuntimeEnvironment.Live({
        cwd: "/tmp/runtime-context-default",
        home: "/tmp/runtime-context-home",
        platform: "test",
      })
      const driverRegistryContext = yield* Layer.build(
        DriverRegistry.fromResolved({
          modelDrivers: new Map(),
          externalDrivers: new Map(),
        }),
      ).pipe(Effect.scoped)
      const defaults: TurnProfileDefaults = {
        driverRegistry: Context.get(driverRegistryContext, DriverRegistry),
        baseSections: [{ id: "default", content: "Default", priority: 1 }],
      }
      const testLayer = Layer.mergeAll(
        SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(GentPlatform.Test())),
        emptyRegistryLayer,
        runtimeEnvironmentLayer,
      )
      yield* Effect.gen(function* () {
        const extensionRegistry = yield* ExtensionRegistry
        const hostProvider = yield* makeExtensionHostContextProvider({
          host: testHostFacts().host,
          extensionRegistry,
        })
        const resolved = yield* resolveTurnProfile({
          sessionId: SessionId.make("missing-session"),
          branchId: BranchId.make("missing-branch"),
          defaults,
        }).pipe(Effect.provideService(ExtensionHostContextProvider, hostProvider))
        expect(resolved.turnHostCtx.cwd).toBe("/tmp/runtime-context-default")
        expect(resolved.turnBaseSections).toEqual([
          { id: "default", content: "Default", priority: 1 },
        ])
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(testLayer))
    }),
  )
  it.live("preserves storage lookup failures when fallback is disabled", () =>
    Effect.gen(function* () {
      const runtimeEnvironmentLayer = RuntimeEnvironment.Live({
        cwd: "/tmp/runtime-context-fail",
        home: "/tmp/runtime-context-home",
        platform: "test",
      })
      const testLayer = Layer.mergeAll(
        SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(GentPlatform.Test())),
        emptyRegistryLayer,
        emptyDriverRegistryLayer,
        runtimeEnvironmentLayer,
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const extensionRegistry = yield* ExtensionRegistry
        const failingSessionStorage: SessionStorageService = {
          ...sessionStorage,
          getSession: () => Effect.fail(new StorageError({ message: "lookup failed" })),
        }
        const hostProvider = yield* makeExtensionHostContextProvider({
          host: testHostFacts().host,
          extensionRegistry,
        })
        const exit = yield* Effect.exit(
          resolveTurnProfile({
            sessionId: SessionId.make("session-runtime-context-storage-failure"),
            branchId: BranchId.make("branch-runtime-context-storage-failure"),
            defaults: {
              driverRegistry: yield* DriverRegistry,
              baseSections: [],
            },
          }).pipe(
            Effect.provideService(ExtensionHostContextProvider, hostProvider),
            Effect.provideService(SessionStorage, failingSessionStorage),
          ),
        )
        expect(exit._tag).toBe("Success")
        if (exit._tag === "Success") {
          expect(exit.value.turnHostCtx.cwd).toBe("/tmp/runtime-context-fail")
        }
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(testLayer))
    }),
  )
  it.live("prefers the profile-backed driver registry over fallback defaults", () =>
    Effect.gen(function* () {
      const defaultDriverRegistryLayer = DriverRegistry.fromResolved({
        modelDrivers: new Map(),
        externalDrivers: new Map(),
      })
      const profileDriverRegistryLayer = DriverRegistry.fromResolved({
        modelDrivers: new Map(),
        externalDrivers: new Map<string, ExternalDriverContribution>([
          [
            "profile-driver",
            {
              id: "profile-driver",
              executor: {
                executeTurn: () => Stream.die("unused in test"),
              },
              invalidate: Effect.void,
            },
          ],
        ]),
      })
      const runtimeEnvironmentLayer = RuntimeEnvironment.Live({
        cwd: "/tmp/runtime-context-default",
        home: "/tmp/runtime-context-home",
        platform: "test",
      })
      const testLayer = Layer.mergeAll(
        SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(Layer.provide(GentPlatform.Test())),
        emptyRegistryLayer,
        defaultDriverRegistryLayer,
        runtimeEnvironmentLayer,
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const extensionRegistry = yield* ExtensionRegistry
        const defaultDriverRegistry = yield* DriverRegistry
        const profileDriverRegistry = yield* Layer.build(profileDriverRegistryLayer).pipe(
          Effect.map((ctx) => Context.get(ctx, DriverRegistry)),
          Effect.scoped,
        )
        const now = dateFromMillis(1_767_225_600_000)
        yield* sessionStorage.createSession(
          new Session({
            id: SessionId.make("session-runtime-context-driver"),
            cwd: "/tmp/profile-driver-scope",
            createdAt: now,
            updatedAt: now,
          }),
        )
        const fakeProfile: SessionProfile = {
          cwd: "/tmp/profile-driver-scope",
          resolved: resolveExtensions([]),
          layerContext: Context.makeUnsafe(new Map<string, unknown>()),
          registryService: extensionRegistry,
          driverRegistryService: profileDriverRegistry,
          baseSections: [],
          generationId: ProcessGenerationId.make("test"),
        }
        const fakeProfileCache: SessionProfileCacheService = {
          resolve: () => Effect.succeed(fakeProfile),
        }
        const hostProvider = yield* makeExtensionHostContextProvider({
          host: testHostFacts().host,
          extensionRegistry,
        })
        const resolved = yield* resolveTurnProfile({
          sessionId: SessionId.make("session-runtime-context-driver"),
          branchId: BranchId.make("branch-runtime-context-driver"),
          profileCache: fakeProfileCache,
          defaults: {
            driverRegistry: defaultDriverRegistry,
            baseSections: [],
          },
        }).pipe(Effect.provideService(ExtensionHostContextProvider, hostProvider))
        const fromProfile = yield* resolved.turnDriverRegistry.getExternal("profile-driver")
        const fromDefault = yield* defaultDriverRegistry.getExternal("profile-driver")
        expect(resolved.turnHostCtx.cwd).toBe("/tmp/profile-driver-scope")
        expect(fromProfile?.id).toBe("profile-driver")
        expect(fromDefault).toBeUndefined()
        // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      }).pipe(Effect.provide(testLayer))
    }),
  )
})
