/**
 * `auth.listProviders` RPC acceptance tests.
 *
 * The handler resolves project config from the session's cwd, not the
 * launch cwd. A bug here (regression to `configService.get()`) would
 * silently re-block external-routed sessions on launch-cwd model auth.
 * The unit-level AuthGuard tests at `auth-guard.test.ts:181` prove the
 * `driverOverrides` short-circuit works; this test proves the *RPC
 * handler* threads `sessionId` → `session.cwd` →
 * `configService.get(cwd)` → `driverOverrides`.
 */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { textStep } from "@gent/core/debug/provider"
import { Provider } from "@gent/core/providers/provider"
import { AuthMethod } from "@gent/core/domain/auth-method"
import { AuthStore, AuthStoreError } from "@gent/core/domain/auth-store"
import { AuthStorage, AuthStorageError } from "@gent/core/domain/auth-storage"
import { ExternalDriverRef } from "@gent/core/domain/agent"
import { Gent } from "@gent/sdk"
import { createE2ELayer } from "@gent/core/test-utils/e2e-layer"
import { ConfigService } from "../../src/runtime/config-service.js"
import { RuntimePlatform } from "../../src/runtime/runtime-platform.js"
import { e2ePreset } from "../extensions/helpers/test-preset"
import type { ModelDriverContribution } from "../../src/domain/driver.js"
import type { LoadedExtension } from "../../src/domain/extension.js"

const failingAuthStoreLayer = Layer.succeed(
  AuthStore,
  AuthStore.of({
    get: () => Effect.succeed(undefined),
    set: () => Effect.fail(new AuthStoreError({ message: "write failed" })),
    remove: () => Effect.fail(new AuthStoreError({ message: "delete failed" })),
    list: () => Effect.succeed([]),
    listInfo: () => Effect.succeed({}),
  }),
)

const failingReadAuthStoreLayer = Layer.succeed(
  AuthStorage,
  AuthStorage.of({
    get: () => Effect.fail(new AuthStorageError({ message: "read failed" })),
    set: () => Effect.void,
    delete: () => Effect.void,
    list: () => Effect.succeed([]),
  }),
).pipe((storageLayer) => Layer.provide(AuthStore.Live, storageLayer))

const makePersistingExtensions = (): ReadonlyArray<LoadedExtension> => {
  const pendingCallbacks = new Map<string, (code?: string) => string>()
  const oauthProvider: ModelDriverContribution = {
    id: "persisting-oauth",
    name: "Persisting OAuth",
    resolveModel: () => ({}),
    auth: {
      methods: [AuthMethod.make({ type: "oauth", label: "OAuth" })],
      authorize: (ctx) =>
        Effect.sync(() => {
          pendingCallbacks.set(ctx.authorizationId, (code) => code ?? "")
          return {
            url: "http://example.com/auth",
            method: "code" as const,
          }
        }),
      callback: (ctx) =>
        Effect.gen(function* () {
          const code = pendingCallbacks.get(ctx.authorizationId)?.(ctx.code) ?? ""
          yield* ctx.persist({ type: "api", key: code })
        }),
    },
  }
  const authorizePersistProvider: ModelDriverContribution = {
    id: "persisting-authorize",
    name: "Persisting Authorize",
    resolveModel: () => ({}),
    auth: {
      methods: [AuthMethod.make({ type: "oauth", label: "Done" })],
      authorize: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.persist({ type: "api", key: "sk-authorize" })
          return {
            url: "",
            method: "done" as const,
          }
        }),
    },
  }
  return [
    {
      manifest: { id: "test-auth-providers" },
      scope: "builtin",
      sourcePath: "test",
      contributions: { modelDrivers: [oauthProvider, authorizePersistProvider] },
    },
  ]
}

describe("auth.listProviders", () => {
  it.live("returns providers without sessionId (back-compat with launch-cwd default)", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
        const providers = yield* client.auth.listProviders({})
        expect(providers.length).toBeGreaterThan(0)
      }),
    ),
  )

  it.live(
    "driver override written at session cwd is honored by auth.listProviders(sessionId) through ConfigService.Live",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // Three distinct dirs so we can prove the handler resolves config
          // from the *session's* cwd, not the server's launch cwd. Writing
          // the override into the session cwd's project config (and NOT
          // into the launch cwd or user config) means a launch-cwd-only
          // regression would return required=true here.
          const launch = mkdtempSync(join(tmpdir(), "gent-authrpc-launch-"))
          const sessionCwd = mkdtempSync(join(tmpdir(), "gent-authrpc-session-"))
          const home = mkdtempSync(join(tmpdir(), "gent-authrpc-home-"))

          // Seed the session cwd's project config with a driver override
          // for `cowork`. The id points at the acp-claude-code external
          // driver that the ACP extension registers under e2ePreset.
          mkdirSync(join(sessionCwd, ".gent"), { recursive: true })
          writeFileSync(
            join(sessionCwd, ".gent", "config.json"),
            JSON.stringify({
              driverOverrides: { cowork: { _tag: "external", id: "acp-claude-code" } },
            }),
          )

          const runtimePlatformLive = RuntimePlatform.Live({
            cwd: launch,
            home,
            platform: "darwin",
          })
          const configServiceLive = ConfigService.Live.pipe(
            Layer.provide(Layer.merge(BunServices.layer, runtimePlatformLive)),
          )

          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              configServiceLayer: configServiceLive,
            }),
          )

          try {
            // Launch cwd has no override → cowork (anthropic-modeled)
            // requires anthropic. Proves the override is NOT in user config.
            const launchSession = yield* client.session.create({ cwd: launch })
            const launchList = yield* client.auth.listProviders({
              agentName: "cowork",
              sessionId: launchSession.sessionId,
            })
            expect(launchList.find((p) => p.provider === "anthropic")?.required).toBe(true)

            // Session cwd has the project override → anthropic is NOT
            // required because the agent is externally routed.
            const overriddenSession = yield* client.session.create({ cwd: sessionCwd })
            const overriddenList = yield* client.auth.listProviders({
              agentName: "cowork",
              sessionId: overriddenSession.sessionId,
            })
            expect(overriddenList.find((p) => p.provider === "anthropic")?.required).toBe(false)
          } finally {
            rmSync(launch, { recursive: true, force: true })
            rmSync(sessionCwd, { recursive: true, force: true })
            rmSync(home, { recursive: true, force: true })
          }
        }),
      ),
  )

  it.live(
    "legacy RPC path: driver.set followed by no-sessionId listProviders honors override",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
          const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))
          const drivers = (yield* client.driver.list()).drivers
          const externalDriver = drivers.find((d) => d._tag === "external")
          if (externalDriver === undefined) return
          yield* client.driver.set({
            agentName: "cowork",
            driver: ExternalDriverRef.make({ id: externalDriver.id }),
          })
          // No sessionId → launch cwd path. Under ConfigService.Test this
          // still works because driver.set writes to the in-memory user
          // ref that `get(undefined)` also reads.
          const list = yield* client.auth.listProviders({ agentName: "cowork" })
          expect(list.find((p) => p.provider === "anthropic")?.required).toBe(false)
        }),
      ),
  )

  it.live("rejects auth provider listing for a deleted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(createE2ELayer({ ...e2ePreset, providerLayer }))

        const session = yield* client.session.create({})
        yield* client.session.delete({ sessionId: session.sessionId })

        const exit = yield* Effect.exit(
          client.auth.listProviders({
            agentName: "cowork",
            sessionId: session.sessionId,
          }),
        )
        expect(exit._tag).toBe("Failure")
        expect(exit.cause.toString()).toContain("Session not found")
      }),
    ),
  )
})

describe("auth persistence RPC failures", () => {
  it.live("auth.listProviders surfaces auth read failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            authStoreLayer: failingReadAuthStoreLayer,
          }),
        )

        const exit = yield* Effect.exit(client.auth.listProviders({}))
        expect(exit._tag).toBe("Failure")
        expect(exit.cause.toString()).toContain("read failed")
      }),
    ),
  )

  it.live("auth.setKey surfaces write failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            authStoreLayer: failingAuthStoreLayer,
          }),
        )

        const exit = yield* Effect.exit(client.auth.setKey({ provider: "openai", key: "sk-test" }))
        expect(exit._tag).toBe("Failure")
        expect(exit.cause.toString()).toContain("Failed to set auth")
      }),
    ),
  )

  it.live("auth.deleteKey surfaces delete failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            authStoreLayer: failingAuthStoreLayer,
          }),
        )

        const exit = yield* Effect.exit(client.auth.deleteKey({ provider: "openai" }))
        expect(exit._tag).toBe("Failure")
        expect(exit.cause.toString()).toContain("Failed to delete auth")
      }),
    ),
  )

  it.live("auth.authorize surfaces credentials persisted during authorize", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensions: makePersistingExtensions(),
            authStoreLayer: failingAuthStoreLayer,
          }),
        )

        const exit = yield* Effect.exit(
          client.auth.authorize({
            sessionId: "auth-rpc-session",
            provider: "persisting-authorize",
            method: 0,
          }),
        )
        expect(exit._tag).toBe("Failure")
        expect(exit.cause.toString()).toContain("Failed to persist auth")
      }),
    ),
  )

  it.live("auth.callback surfaces callback credential persistence failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* Provider.Sequence([textStep("ok")])
        const { client } = yield* Gent.test(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensions: makePersistingExtensions(),
            authStoreLayer: failingAuthStoreLayer,
          }),
        )

        const authorization = yield* client.auth.authorize({
          sessionId: "auth-rpc-session",
          provider: "persisting-oauth",
          method: 0,
        })
        if (authorization === null) return yield* Effect.dieMessage("auth setup failed")

        const exit = yield* Effect.exit(
          client.auth.callback({
            sessionId: "auth-rpc-session",
            provider: "persisting-oauth",
            method: 0,
            authorizationId: authorization.authorizationId,
            code: "sk-callback",
          }),
        )
        expect(exit._tag).toBe("Failure")
        expect(exit.cause.toString()).toContain("Failed to persist auth")
      }),
    ),
  )
})
