import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Context, Effect, Layer } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PermissionRule } from "@gent/core/domain/permission"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import { Session } from "@gent/core/domain/message"
import { ConfigService } from "@gent/core/runtime/config-service"
import { DriverRegistry } from "@gent/core/runtime/extensions/driver-registry"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { MachineEngine } from "@gent/core/runtime/extensions/resource-host/machine-engine"
import {
  resolveSessionRuntimeContext,
  type SessionRuntimeContextDefaults,
} from "@gent/core/runtime/session-runtime-context"
import { makeAmbientExtensionHostContextDeps } from "@gent/core/runtime/make-extension-host-context"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import {
  SessionProfileCache,
  type SessionProfile,
  type SessionProfileCacheService,
} from "@gent/core/runtime/session-profile"
import { Storage } from "@gent/core/storage/sqlite-storage"

const emptyRegistryLayer = ExtensionRegistry.fromResolved(resolveExtensions([]))

describe("resolveSessionRuntimeContext", () => {
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
    }).pipe(Layer.provide(Layer.merge(BunServices.layer, configServiceLive)))
    const testLayer = Layer.mergeAll(
      BunServices.layer,
      Storage.Test(),
      MachineEngine.Test(),
      emptyRegistryLayer,
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
              id: SessionId.of("session-runtime-context-profile"),
              cwd: secondary,
              createdAt: now,
              updatedAt: now,
            }),
          )

          const ctx = yield* resolveSessionRuntimeContext({
            sessionId: SessionId.of("session-runtime-context-profile"),
            branchId: BranchId.of("branch-runtime-context-profile"),
            storage,
            profileCache,
            hostDeps: yield* makeAmbientExtensionHostContextDeps({
              storage,
              extensionRegistry,
              extensionStateRuntime,
              overrides: { platform },
            }),
          })

          expect(ctx.sessionCwd).toBe(secondary)
          expect(ctx.hostCtx.cwd).toBe(secondary)
          expect(ctx.profile).toBeDefined()
          expect(yield* ctx.permission?.check("bash", { command: "ls -la" })).toBe("allowed")
        }).pipe(Effect.provide(testLayer)),
      )
    } finally {
      rmSync(launch, { recursive: true, force: true })
      rmSync(secondary, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
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
    const defaults: SessionRuntimeContextDefaults = {
      permission: defaultPermission,
      baseSections: [{ id: "default", content: "Default", priority: 1 }],
    }
    const testLayer = Layer.mergeAll(
      Storage.Test(),
      MachineEngine.Test(),
      emptyRegistryLayer,
      runtimePlatformLayer,
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const storage = yield* Storage
        const extensionRegistry = yield* ExtensionRegistry
        const extensionStateRuntime = yield* MachineEngine
        const platform = yield* RuntimePlatform

        const ctx = yield* resolveSessionRuntimeContext({
          sessionId: SessionId.of("missing-session"),
          branchId: BranchId.of("missing-branch"),
          storage,
          hostDeps: yield* makeAmbientExtensionHostContextDeps({
            storage,
            extensionRegistry,
            extensionStateRuntime,
            overrides: { platform },
          }),
          defaults,
        })

        expect(ctx.session).toBeUndefined()
        expect(ctx.sessionCwd).toBeUndefined()
        expect(ctx.hostCtx.cwd).toBe("/tmp/runtime-context-default")
        expect(yield* ctx.permission?.check("bash", { command: "ls -la" })).toBe("denied")
        expect(ctx.baseSections).toEqual([{ id: "default", content: "Default", priority: 1 }])
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
      Storage.Test(),
      MachineEngine.Test(),
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
            id: SessionId.of("session-runtime-context-driver"),
            cwd: "/tmp/profile-driver-scope",
            createdAt: now,
            updatedAt: now,
          }),
        )

        const fakeProfile: SessionProfile = {
          cwd: "/tmp/profile-driver-scope",
          extensions: [],
          resolved: resolveExtensions([]),
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
        }
        const fakeProfileCache: SessionProfileCacheService = {
          resolve: () => Effect.succeed(fakeProfile),
        }

        const ctx = yield* resolveSessionRuntimeContext({
          sessionId: SessionId.of("session-runtime-context-driver"),
          branchId: BranchId.of("branch-runtime-context-driver"),
          storage,
          profileCache: fakeProfileCache,
          hostDeps: yield* makeAmbientExtensionHostContextDeps({
            storage,
            extensionRegistry,
            extensionStateRuntime,
            overrides: { platform },
          }),
          defaults: {
            driverRegistry: defaultDriverRegistry,
          },
        })

        const fromProfile = yield* ctx.driverRegistry?.getExternal("profile-driver")
        const fromDefault = yield* defaultDriverRegistry.getExternal("profile-driver")

        expect(ctx.profile?.cwd).toBe("/tmp/profile-driver-scope")
        expect(fromProfile?.id).toBe("profile-driver")
        expect(fromDefault).toBeUndefined()
      }).pipe(Effect.provide(testLayer)),
    )
  })
})
