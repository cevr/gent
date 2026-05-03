import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { BunPlatformLive } from "@gent/core/runtime/gent-platform-bun"
import { Cause, Context, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect"
import { PermissionRule } from "@gent/core/domain/permission"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { dateFromMillis, Session } from "@gent/core/domain/message"
import { ConfigService } from "../../src/runtime/config-service"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import {
  AllowAllPermission,
  resolveSessionEnvironment,
  resolveSessionEnvironmentOrFail,
  type SessionEnvironmentDefaults,
} from "../../src/runtime/session-runtime-context"
import { makeAmbientExtensionHostContextDeps } from "../../src/runtime/make-extension-host-context"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import {
  SessionProfileCache,
  type SessionProfile,
  type SessionProfileCacheService,
} from "../../src/runtime/session-profile"
import { SqliteStorage, StorageError } from "@gent/core/storage/sqlite-storage"
import { SessionStorage, type SessionStorageService } from "@gent/core/storage/session-storage"
import type { ExternalDriverContribution } from "@gent/core/domain/driver"
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const emptyRegistryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
const emptyDriverRegistryLayer = DriverRegistry.fromResolved({
  modelDrivers: new Map(),
  externalDrivers: new Map(),
})
describe("resolveSessionEnvironment", () => {
  it.scopedLive(
    "uses the stored session cwd to resolve profile-scoped permission and host context",
    () =>
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
        yield* writeProjectConfig(secondary, [{ tool: "bash", action: "allow" }])
        const runtimePlatformLive = RuntimePlatform.Live({
          cwd: launch,
          home,
          platform: "darwin",
        })
        const configServiceLive = ConfigService.Live.pipe(
          Layer.provide(Layer.merge(BunServices.layer, runtimePlatformLive)),
        )
        const sessionProfileCacheLive = SessionProfileCache.Live({
          home,
          platform: "darwin",
          extensions: [],
        }).pipe(
          Layer.provide(
            Layer.mergeAll(BunServices.layer, configServiceLive, SqliteStorage.MemoryWithSql()),
          ),
        )
        const testLayer = Layer.mergeAll(
          BunServices.layer,
          SqliteStorage.MemoryWithSql(),
          emptyRegistryLayer,
          emptyDriverRegistryLayer,
          runtimePlatformLive,
          sessionProfileCacheLive,
        )
        yield* Effect.gen(function* () {
          const sessionStorage = yield* SessionStorage
          const extensionRegistry = yield* ExtensionRegistry
          const platform = yield* RuntimePlatform
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
          const resolved = yield* resolveSessionEnvironment({
            sessionId: SessionId.make("session-runtime-context-profile"),
            branchId: BranchId.make("branch-runtime-context-profile"),
            sessionStorage,
            profileCache,
            hostDeps: yield* makeAmbientExtensionHostContextDeps({
              extensionRegistry,
              overrides: { platform },
            }),
            defaults: {
              driverRegistry: yield* DriverRegistry,
              permission: AllowAllPermission,
              baseSections: [],
            },
          })
          expect(resolved.session).toBeDefined()
          expect(resolved.environment.cwd).toBe(secondary)
          expect(resolved.environment.hostCtx.cwd).toBe(secondary)
          expect(yield* resolved.environment.permission.check("bash", { command: "ls -la" })).toBe(
            "allowed",
          )
        }).pipe(Effect.provide(testLayer), Effect.scoped)
      }).pipe(Effect.provide(BunPlatformLive)),
  )
  it.live("falls back to host deps and defaults when no session profile is available", () =>
    Effect.gen(function* () {
      const runtimePlatformLayer = RuntimePlatform.Test({
        cwd: "/tmp/runtime-context-default",
        home: "/tmp/runtime-context-home",
        platform: "test",
      })
      const defaultPermission = {
        check: () => Effect.succeed("denied" as const),
        addRule: () => Effect.void,
        removeRule: () => Effect.void,
        getRules: () =>
          Effect.succeed([
            new PermissionRule({
              tool: "bash",
              action: "deny",
            }),
          ]),
      }
      const driverRegistryContext = yield* Layer.build(
        DriverRegistry.fromResolved({
          modelDrivers: new Map(),
          externalDrivers: new Map(),
        }),
      ).pipe(Effect.scoped)
      const defaults: SessionEnvironmentDefaults = {
        driverRegistry: Context.get(driverRegistryContext, DriverRegistry),
        permission: defaultPermission,
        baseSections: [{ id: "default", content: "Default", priority: 1 }],
      }
      const testLayer = Layer.mergeAll(
        SqliteStorage.MemoryWithSql(),
        emptyRegistryLayer,
        runtimePlatformLayer,
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const extensionRegistry = yield* ExtensionRegistry
        const platform = yield* RuntimePlatform
        const resolved = yield* resolveSessionEnvironment({
          sessionId: SessionId.make("missing-session"),
          branchId: BranchId.make("missing-branch"),
          sessionStorage,
          hostDeps: yield* makeAmbientExtensionHostContextDeps({
            extensionRegistry,
            overrides: { platform },
          }),
          defaults,
        })
        expect(resolved.session).toBeUndefined()
        expect(resolved.environment.cwd).toBe("/tmp/runtime-context-default")
        expect(resolved.environment.hostCtx.cwd).toBe("/tmp/runtime-context-default")
        expect(yield* resolved.environment.permission.check("bash", { command: "ls -la" })).toBe(
          "denied",
        )
        expect(resolved.environment.baseSections).toEqual([
          { id: "default", content: "Default", priority: 1 },
        ])
      }).pipe(Effect.provide(testLayer))
    }),
  )
  it.live("preserves storage lookup failures when fallback is disabled", () =>
    Effect.gen(function* () {
      const runtimePlatformLayer = RuntimePlatform.Test({
        cwd: "/tmp/runtime-context-fail",
        home: "/tmp/runtime-context-home",
        platform: "test",
      })
      const testLayer = Layer.mergeAll(
        SqliteStorage.MemoryWithSql(),
        emptyRegistryLayer,
        emptyDriverRegistryLayer,
        runtimePlatformLayer,
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const extensionRegistry = yield* ExtensionRegistry
        const platform = yield* RuntimePlatform
        const failingSessionStorage: SessionStorageService = {
          ...sessionStorage,
          getSession: () => Effect.fail(new StorageError({ message: "lookup failed" })),
        }
        const exit = yield* Effect.exit(
          resolveSessionEnvironment({
            sessionId: SessionId.make("session-runtime-context-storage-failure"),
            branchId: BranchId.make("branch-runtime-context-storage-failure"),
            sessionStorage: failingSessionStorage,
            hostDeps: yield* makeAmbientExtensionHostContextDeps({
              extensionRegistry,
              overrides: { platform },
            }),
            defaults: {
              driverRegistry: yield* DriverRegistry,
              permission: AllowAllPermission,
              baseSections: [],
            },
          }),
        )
        expect(exit._tag).toBe("Success")
        if (exit._tag === "Success") {
          expect(exit.value.session).toBeUndefined()
        }
        const strict = yield* Effect.exit(
          resolveSessionEnvironmentOrFail({
            sessionId: SessionId.make("session-runtime-context-storage-failure"),
            branchId: BranchId.make("branch-runtime-context-storage-failure"),
            sessionStorage: failingSessionStorage,
            hostDeps: yield* makeAmbientExtensionHostContextDeps({
              extensionRegistry,
              overrides: { platform },
            }),
            defaults: {
              driverRegistry: yield* DriverRegistry,
              permission: AllowAllPermission,
              baseSections: [],
            },
          }),
        )
        expect(strict._tag).toBe("Failure")
        if (strict._tag === "Failure") {
          const error = Cause.findErrorOption(strict.cause)
          expect(Option.isSome(error)).toBe(true)
          if (Option.isSome(error)) {
            expect(Schema.is(StorageError)(error.value)).toBe(true)
            expect(Schema.is(StorageError)(error.value) ? error.value.message : undefined).toBe(
              "lookup failed",
            )
          }
        }
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
              invalidate: () => Effect.void,
            },
          ],
        ]),
      })
      const runtimePlatformLayer = RuntimePlatform.Test({
        cwd: "/tmp/runtime-context-default",
        home: "/tmp/runtime-context-home",
        platform: "test",
      })
      const testLayer = Layer.mergeAll(
        SqliteStorage.MemoryWithSql(),
        emptyRegistryLayer,
        defaultDriverRegistryLayer,
        runtimePlatformLayer,
      )
      yield* Effect.gen(function* () {
        const sessionStorage = yield* SessionStorage
        const extensionRegistry = yield* ExtensionRegistry
        const platform = yield* RuntimePlatform
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
          extensions: [],
          resolved: resolveExtensions([]),
          layerContext: Context.empty(),
          permissionService: {
            check: () => Effect.succeed("allowed" as const),
            addRule: () => Effect.void,
            removeRule: () => Effect.void,
            getRules: () => Effect.succeed([]),
          },
          registryService: extensionRegistry,
          driverRegistryService: profileDriverRegistry,
          baseSections: [],
          instructions: "",
        }
        const fakeProfileCache: SessionProfileCacheService = {
          resolve: () => Effect.succeed(fakeProfile),
        }
        const resolved = yield* resolveSessionEnvironment({
          sessionId: SessionId.make("session-runtime-context-driver"),
          branchId: BranchId.make("branch-runtime-context-driver"),
          sessionStorage,
          profileCache: fakeProfileCache,
          hostDeps: yield* makeAmbientExtensionHostContextDeps({
            extensionRegistry,
            overrides: { platform },
          }),
          defaults: {
            driverRegistry: defaultDriverRegistry,
            permission: AllowAllPermission,
            baseSections: [],
          },
        })
        const fromProfile = yield* resolved.environment.driverRegistry.getExternal("profile-driver")
        const fromDefault = yield* defaultDriverRegistry.getExternal("profile-driver")
        expect(resolved.session).toBeDefined()
        expect(resolved.environment.cwd).toBe("/tmp/profile-driver-scope")
        expect(fromProfile?.id).toBe("profile-driver")
        expect(fromDefault).toBeUndefined()
      }).pipe(Effect.provide(testLayer))
    }),
  )
})
