import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Cause, Context, Effect, Layer, Option, Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionRule } from "@gent/core/domain/permission"
import { defineResource } from "@gent/core/domain/resource"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { Session } from "@gent/core/domain/message"
import type { CapabilityRef } from "@gent/core/domain/capability"
import type { LoadedExtension } from "../../src/domain/extension"
import { ConfigService } from "../../src/runtime/config-service"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { MachineEngine } from "../../src/runtime/extensions/resource-host/machine-engine"
import { ActorEngine } from "../../src/runtime/extensions/actor-engine"
import { Receptionist } from "../../src/runtime/extensions/receptionist"
import {
  AllowAllPermission,
  resolveSessionEnvironment,
  resolveSessionEnvironmentOrFail,
  type SessionEnvironmentDefaults,
} from "../../src/runtime/session-runtime-context"
import { makeAmbientExtensionHostContextDeps } from "../../src/runtime/make-extension-host-context"
import { RuntimePlatform } from "../../src/runtime/runtime-platform"
import {
  buildPulseIndex,
  SessionProfileCache,
  type SessionProfile,
  type SessionProfileCacheService,
} from "../../src/runtime/session-profile"
import { Storage, StorageError, type StorageService } from "@gent/core/storage/sqlite-storage"
import { buildExtensionLayers } from "../../src/runtime/profile"

const emptyRegistryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
const emptyDriverRegistryLayer = DriverRegistry.fromResolved({
  modelDrivers: new Map(),
  externalDrivers: new Map(),
})

class ProfileToken extends Context.Service<
  ProfileToken,
  { readonly read: () => Effect.Effect<string> }
>()("@test/ProfileToken") {}

describe("resolveSessionEnvironment", () => {
  test("uses the stored session cwd to resolve profile-scoped permission and host context", async () => {
    const launch = mkdtempSync(join(tmpdir(), "gent-session-runtime-context-launch-"))
    const secondary = mkdtempSync(join(tmpdir(), "gent-session-runtime-context-secondary-"))
    const home = mkdtempSync(join(tmpdir(), "gent-session-runtime-context-home-"))

    const writeProjectConfig = (
      cwd: string,
      permissions: ReadonlyArray<Record<string, string>>,
    ) => {
      mkdirSync(join(cwd, ".gent"), { recursive: true })
      writeFileSync(join(cwd, ".gent", "config.json"), JSON.stringify({ permissions }))
    }

    writeProjectConfig(launch, [{ tool: "bash", action: "deny" }])
    writeProjectConfig(secondary, [{ tool: "bash", action: "allow" }])

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
      Layer.provide(Layer.mergeAll(BunServices.layer, configServiceLive, Storage.MemoryWithSql())),
    )
    const testLayer = Layer.mergeAll(
      BunServices.layer,
      Storage.MemoryWithSql(),
      MachineEngine.Test(),
      ActorEngine.Live,
      emptyRegistryLayer,
      emptyDriverRegistryLayer,
      runtimePlatformLive,
      sessionProfileCacheLive,
    )

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const extensionRegistry = yield* ExtensionRegistry
          const extensionStateRuntime = yield* MachineEngine
          const platform = yield* RuntimePlatform
          const profileCache = yield* SessionProfileCache
          const now = new Date()

          yield* storage.createSession(
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
            storage,
            profileCache,
            hostDeps: yield* makeAmbientExtensionHostContextDeps({
              storage,
              extensionRegistry,
              extensionStateRuntime,
              actorEngine: yield* ActorEngine,
              receptionist: yield* Receptionist,
              overrides: { platform },
            }),
            defaults: {
              driverRegistry: yield* DriverRegistry,
              permission: AllowAllPermission,
              baseSections: [],
            },
          })

          expect(resolved._tag).toBe("SessionFound")
          expect(resolved.environment.cwd).toBe(secondary)
          expect(resolved.environment.hostCtx.cwd).toBe(secondary)
          expect(yield* resolved.environment.permission.check("bash", { command: "ls -la" })).toBe(
            "allowed",
          )
        }).pipe(Effect.provide(testLayer)),
      )
    } finally {
      rmSync(launch, { recursive: true, force: true })
      rmSync(secondary, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("uses the stored session cwd for nested capability requests", async () => {
    const launch = mkdtempSync(join(tmpdir(), "gent-session-request-context-launch-"))
    const secondary = mkdtempSync(join(tmpdir(), "gent-session-request-context-secondary-"))
    const seenCwd: string[] = []
    const ref: CapabilityRef<string, string> = {
      extensionId: "@test/session-request-context",
      capabilityId: "echo-cwd",
      intent: "read",
      input: Schema.String,
      output: Schema.String,
    }
    const extension: LoadedExtension = {
      manifest: { id: "@test/session-request-context" },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        capabilities: [
          {
            id: "echo-cwd",
            audiences: ["agent-protocol"],
            intent: "read",
            input: Schema.String,
            output: Schema.String,
            effect: (_input, ctx) =>
              Effect.sync(() => {
                seenCwd.push(ctx.cwd)
                return ctx.cwd
              }),
          },
        ],
      },
    }
    const resolvedExtensions = resolveExtensions([extension])
    const extensionRegistryLayer = ExtensionRegistry.fromResolved(resolvedExtensions)
    const driverRegistryLayer = DriverRegistry.fromResolved({
      modelDrivers: resolvedExtensions.modelDrivers,
      externalDrivers: resolvedExtensions.externalDrivers,
    })
    const runtimePlatformLayer = RuntimePlatform.Test({
      cwd: launch,
      home: launch,
      platform: "test",
    })
    const testLayer = Layer.mergeAll(
      Storage.MemoryWithSql(),
      MachineEngine.Test(),
      ActorEngine.Live,
      extensionRegistryLayer,
      driverRegistryLayer,
      runtimePlatformLayer,
    )

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const extensionRegistry = yield* ExtensionRegistry
          const extensionStateRuntime = yield* MachineEngine
          const platform = yield* RuntimePlatform
          const now = new Date()

          yield* storage.createSession(
            new Session({
              id: SessionId.make("session-runtime-context-request"),
              cwd: secondary,
              createdAt: now,
              updatedAt: now,
            }),
          )

          const resolved = yield* resolveSessionEnvironment({
            sessionId: SessionId.make("session-runtime-context-request"),
            branchId: BranchId.make("branch-runtime-context-request"),
            storage,
            hostDeps: yield* makeAmbientExtensionHostContextDeps({
              storage,
              extensionRegistry,
              extensionStateRuntime,
              actorEngine: yield* ActorEngine,
              receptionist: yield* Receptionist,
              overrides: { platform },
            }),
            defaults: {
              driverRegistry: yield* DriverRegistry,
              permission: AllowAllPermission,
              baseSections: [],
            },
          })

          expect(resolved._tag).toBe("SessionFound")
          const result = yield* resolved.environment.hostCtx.extension.request(ref, "cwd")
          expect(result).toBe(secondary)
          expect(seenCwd).toEqual([secondary])
        }).pipe(Effect.provide(testLayer)),
      )
    } finally {
      rmSync(launch, { recursive: true, force: true })
      rmSync(secondary, { recursive: true, force: true })
    }
  })

  test("provides profile resource services to nested capability requests", async () => {
    const launch = mkdtempSync(join(tmpdir(), "gent-session-resource-context-launch-"))
    const profileCwd = mkdtempSync(join(tmpdir(), "gent-session-resource-context-profile-"))
    const ref: CapabilityRef<string, string> = {
      extensionId: "@test/profile-resource-context",
      capabilityId: "read-profile-token",
      intent: "read",
      input: Schema.String,
      output: Schema.String,
    }
    const extension: LoadedExtension = {
      manifest: { id: "@test/profile-resource-context" },
      scope: "builtin",
      sourcePath: "test",
      contributions: {
        resources: [
          defineResource({
            tag: ProfileToken,
            scope: "process",
            layer: Layer.succeed(ProfileToken, {
              read: () => Effect.succeed("profile-token"),
            }),
          }),
        ],
        capabilities: [
          {
            id: "read-profile-token",
            audiences: ["agent-protocol"],
            intent: "read",
            input: Schema.String,
            output: Schema.String,
            effect: () =>
              Effect.gen(function* () {
                const token = yield* ProfileToken
                return yield* token.read()
              }),
          },
        ],
      },
    }
    const resolvedExtensions = resolveExtensions([extension])
    const extensionRegistryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))
    const driverRegistryLayer = DriverRegistry.fromResolved({
      modelDrivers: new Map(),
      externalDrivers: new Map(),
    })
    const runtimePlatformLayer = RuntimePlatform.Test({
      cwd: launch,
      home: launch,
      platform: "test",
    })
    const testLayer = Layer.mergeAll(
      Storage.MemoryWithSql(),
      MachineEngine.Test(),
      ActorEngine.Live,
      extensionRegistryLayer,
      driverRegistryLayer,
      runtimePlatformLayer,
    )

    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const storage = yield* Storage
            const extensionRegistry = yield* ExtensionRegistry
            const extensionStateRuntime = yield* MachineEngine
            const platform = yield* RuntimePlatform
            const now = new Date()
            const layerContext = yield* Layer.build(buildExtensionLayers(resolvedExtensions))
            const profile: SessionProfile = {
              cwd: profileCwd,
              extensions: resolvedExtensions.extensions,
              resolved: resolvedExtensions,
              layerContext,
              permissionService: AllowAllPermission,
              registryService: Context.get(layerContext, ExtensionRegistry),
              driverRegistryService: Context.get(layerContext, DriverRegistry),
              extensionStateRuntime: Context.get(layerContext, MachineEngine),
              subscriptionEngine: undefined,
              baseSections: [],
              instructions: "",
              pulseByTag: buildPulseIndex(Context.get(layerContext, ExtensionRegistry)),
            }
            const profileCache: SessionProfileCacheService = {
              resolve: () => Effect.succeed(profile),
            }

            yield* storage.createSession(
              new Session({
                id: SessionId.make("session-runtime-context-resource"),
                cwd: profileCwd,
                createdAt: now,
                updatedAt: now,
              }),
            )

            const resolved = yield* resolveSessionEnvironment({
              sessionId: SessionId.make("session-runtime-context-resource"),
              branchId: BranchId.make("branch-runtime-context-resource"),
              storage,
              profileCache,
              hostDeps: yield* makeAmbientExtensionHostContextDeps({
                storage,
                extensionRegistry,
                extensionStateRuntime,
                actorEngine: yield* ActorEngine,
                receptionist: yield* Receptionist,
                overrides: { platform },
              }),
              defaults: {
                driverRegistry: yield* DriverRegistry,
                permission: AllowAllPermission,
                baseSections: [],
              },
            })

            expect(resolved._tag).toBe("SessionFound")
            expect(yield* resolved.environment.hostCtx.extension.request(ref, "token")).toBe(
              "profile-token",
            )
          }).pipe(Effect.provide(testLayer)),
        ),
      )
    } finally {
      rmSync(launch, { recursive: true, force: true })
      rmSync(profileCwd, { recursive: true, force: true })
    }
  })

  test("falls back to host deps and defaults when no session profile is available", async () => {
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
    const defaults: SessionEnvironmentDefaults = {
      driverRegistry: Context.get(
        Effect.runSync(
          Layer.build(
            DriverRegistry.fromResolved({
              modelDrivers: new Map(),
              externalDrivers: new Map(),
            }),
          ).pipe(Effect.scoped),
        ),
        DriverRegistry,
      ),
      permission: defaultPermission,
      baseSections: [{ id: "default", content: "Default", priority: 1 }],
    }
    const testLayer = Layer.mergeAll(
      Storage.MemoryWithSql(),
      MachineEngine.Test(),
      ActorEngine.Live,
      emptyRegistryLayer,
      runtimePlatformLayer,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const extensionRegistry = yield* ExtensionRegistry
        const extensionStateRuntime = yield* MachineEngine
        const platform = yield* RuntimePlatform

        const resolved = yield* resolveSessionEnvironment({
          sessionId: SessionId.make("missing-session"),
          branchId: BranchId.make("missing-branch"),
          storage,
          hostDeps: yield* makeAmbientExtensionHostContextDeps({
            storage,
            extensionRegistry,
            extensionStateRuntime,
            actorEngine: yield* ActorEngine,
            receptionist: yield* Receptionist,
            overrides: { platform },
          }),
          defaults,
        })

        expect(resolved._tag).toBe("SessionMissing")
        expect(resolved.environment.cwd).toBe("/tmp/runtime-context-default")
        expect(resolved.environment.hostCtx.cwd).toBe("/tmp/runtime-context-default")
        expect(yield* resolved.environment.permission.check("bash", { command: "ls -la" })).toBe(
          "denied",
        )
        expect(resolved.environment.baseSections).toEqual([
          { id: "default", content: "Default", priority: 1 },
        ])
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("preserves storage lookup failures when fallback is disabled", async () => {
    const runtimePlatformLayer = RuntimePlatform.Test({
      cwd: "/tmp/runtime-context-fail",
      home: "/tmp/runtime-context-home",
      platform: "test",
    })
    const testLayer = Layer.mergeAll(
      Storage.MemoryWithSql(),
      MachineEngine.Test(),
      ActorEngine.Live,
      emptyRegistryLayer,
      emptyDriverRegistryLayer,
      runtimePlatformLayer,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const extensionRegistry = yield* ExtensionRegistry
        const extensionStateRuntime = yield* MachineEngine
        const platform = yield* RuntimePlatform
        const failingStorage: StorageService = {
          ...storage,
          getSession: () => Effect.fail(new StorageError({ message: "lookup failed" })),
        }

        const exit = yield* Effect.exit(
          resolveSessionEnvironment({
            sessionId: SessionId.make("session-runtime-context-storage-failure"),
            branchId: BranchId.make("branch-runtime-context-storage-failure"),
            storage: failingStorage,
            hostDeps: yield* makeAmbientExtensionHostContextDeps({
              storage: failingStorage,
              extensionRegistry,
              extensionStateRuntime,
              actorEngine: yield* ActorEngine,
              receptionist: yield* Receptionist,
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
          expect(exit.value._tag).toBe("SessionMissing")
        }
        const strict = yield* Effect.exit(
          resolveSessionEnvironmentOrFail({
            sessionId: SessionId.make("session-runtime-context-storage-failure"),
            branchId: BranchId.make("branch-runtime-context-storage-failure"),
            storage: failingStorage,
            hostDeps: yield* makeAmbientExtensionHostContextDeps({
              storage: failingStorage,
              extensionRegistry,
              extensionStateRuntime,
              actorEngine: yield* ActorEngine,
              receptionist: yield* Receptionist,
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
            expect(error.value).toBeInstanceOf(StorageError)
            expect(error.value instanceof StorageError ? error.value.message : undefined).toBe(
              "lookup failed",
            )
          }
        }
      }).pipe(Effect.provide(testLayer)),
    )
  })

  test("prefers the profile-backed driver registry over fallback defaults", async () => {
    const defaultDriverRegistryLayer = DriverRegistry.fromResolved({
      modelDrivers: new Map(),
      externalDrivers: new Map(),
    })
    const profileDriverRegistryLayer = DriverRegistry.fromResolved({
      modelDrivers: new Map(),
      externalDrivers: new Map([
        [
          "profile-driver",
          {
            id: "profile-driver",
            name: "Profile Driver",
            executor: {
              executeTurn: () => Effect.die("unused in test"),
            },
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
      Storage.MemoryWithSql(),
      MachineEngine.Test(),
      ActorEngine.Live,
      emptyRegistryLayer,
      defaultDriverRegistryLayer,
      runtimePlatformLayer,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const extensionRegistry = yield* ExtensionRegistry
        const extensionStateRuntime = yield* MachineEngine
        const platform = yield* RuntimePlatform
        const defaultDriverRegistry = yield* DriverRegistry
        const profileDriverRegistry = yield* Layer.build(profileDriverRegistryLayer).pipe(
          Effect.map((ctx) => Context.get(ctx, DriverRegistry)),
          Effect.scoped,
        )
        const now = new Date()

        yield* storage.createSession(
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
          extensionStateRuntime,
          subscriptionEngine: undefined,
          baseSections: [],
          instructions: "",
          pulseByTag: new Map(),
        }
        const fakeProfileCache: SessionProfileCacheService = {
          resolve: () => Effect.succeed(fakeProfile),
        }

        const resolved = yield* resolveSessionEnvironment({
          sessionId: SessionId.make("session-runtime-context-driver"),
          branchId: BranchId.make("branch-runtime-context-driver"),
          storage,
          profileCache: fakeProfileCache,
          hostDeps: yield* makeAmbientExtensionHostContextDeps({
            storage,
            extensionRegistry,
            extensionStateRuntime,
            actorEngine: yield* ActorEngine,
            receptionist: yield* Receptionist,
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

        expect(resolved._tag).toBe("SessionFound")
        expect(resolved.environment.cwd).toBe("/tmp/profile-driver-scope")
        expect(fromProfile?.id).toBe("profile-driver")
        expect(fromDefault).toBeUndefined()
      }).pipe(Effect.provide(testLayer)),
    )
  })
})
