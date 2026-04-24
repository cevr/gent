/**
 * AuthGuard tests
 */

import { describe, it, expect } from "effect-bun-test"
import { test as bunTest } from "bun:test"
import { AuthGuard, ListAuthProvidersPayload } from "@gent/core/domain/auth-guard"
import { AuthApi, AuthStore } from "@gent/core/domain/auth-store"
import { AuthStorage } from "@gent/core/domain/auth-storage"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type { ModelDriverContribution } from "@gent/core/domain/driver"
import { AgentDefinition, ExternalDriverRef } from "@gent/core/domain/agent"
import { Effect, Layer, Schema } from "effect"

const testProviders: ModelDriverContribution[] = [
  { id: "anthropic", name: "Anthropic", resolveModel: () => ({}) },
  { id: "openai", name: "OpenAI", resolveModel: () => ({}) },
  { id: "bedrock", name: "AWS Bedrock", resolveModel: () => ({}) },
  { id: "google", name: "Google", resolveModel: () => ({}) },
  { id: "mistral", name: "Mistral", resolveModel: () => ({}) },
]

const testAgents = [
  AgentDefinition.make({
    name: "cowork" as never,
    model: "anthropic/claude-opus-4-6" as never,
  }),
  AgentDefinition.make({
    name: "deepwork" as never,
    model: "openai/gpt-5.4" as never,
  }),
]

const testResolved = resolveExtensions([
  {
    manifest: { id: "test-providers" },
    scope: "builtin",
    sourcePath: "test",
    contributions: {
      modelDrivers: testProviders,
      agents: testAgents,
    },
  } satisfies LoadedExtension,
])
const testRegistryLayer = Layer.merge(
  ExtensionRegistry.fromResolved(testResolved),
  DriverRegistry.fromResolved({
    modelDrivers: testResolved.modelDrivers,
    externalDrivers: testResolved.externalDrivers,
  }),
)

const helperResolved = resolveExtensions([
  {
    manifest: { id: "test-providers" },
    scope: "builtin",
    sourcePath: "test",
    contributions: {
      modelDrivers: testProviders,
      agents: [
        ...testAgents,
        AgentDefinition.make({
          name: "helper:google" as never,
          model: "google/gemini-2.5-flash" as never,
        }),
      ],
    },
  } satisfies LoadedExtension,
])
const helperAgentRegistryLayer = Layer.merge(
  ExtensionRegistry.fromResolved(helperResolved),
  DriverRegistry.fromResolved({
    modelDrivers: helperResolved.modelDrivers,
    externalDrivers: helperResolved.externalDrivers,
  }),
)

describe("AuthGuard", () => {
  it.live("requiredProviders include cowork + deepwork providers", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(AuthStore.Live),
      Layer.provide(AuthStorage.Test()),
      Layer.provide(testRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.requiredProviders()
      expect(result).toContain("anthropic")
      expect(result).toContain("openai")
    }).pipe(Effect.provide(layer))
  })

  it.live("missingRequiredProviders returns missing when no keys", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(AuthStore.Live),
      Layer.provide(AuthStorage.Test()),
      Layer.provide(testRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.missingRequiredProviders()
      expect(result).toContain("anthropic")
      expect(result).toContain("openai")
    }).pipe(Effect.provide(layer))
  })

  it.live("missingRequiredProviders clears when keys are present", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(AuthStore.Live),
      Layer.provide(AuthStorage.Test({ openai: "sk-openai", anthropic: "sk-anthropic" })),
      Layer.provide(testRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.missingRequiredProviders()
      expect(result).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.live("listProviders uses get even when listInfo fails", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(
        Layer.succeed(AuthStore, {
          get: (provider: string) =>
            provider === "anthropic"
              ? Effect.succeed(new AuthApi({ type: "api", key: "sk-test" }))
              : Effect.succeed(undefined),
          set: () => Effect.void,
          remove: () => Effect.void,
          list: () => Effect.fail(new Error("list failed")),
          listInfo: () => Effect.fail(new Error("listInfo failed")),
        }),
      ),
      Layer.provide(testRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.listProviders()

      const anthropic = result.find((p) => p.provider === "anthropic")
      const openai = result.find((p) => p.provider === "openai")
      expect(anthropic?.hasKey).toBe(true)
      expect(openai?.hasKey).toBe(false)
    }).pipe(Effect.provide(layer))
  })

  it.live(
    "helper-only modeled agents do not widen required providers beyond the runtime pair",
    () => {
      const layer = AuthGuard.Live.pipe(
        Layer.provide(AuthStore.Live),
        Layer.provide(AuthStorage.Test()),
        Layer.provide(helperAgentRegistryLayer),
      )
      return Effect.gen(function* () {
        const guard = yield* AuthGuard
        const result = yield* guard.requiredProviders()
        expect(result).toContain("anthropic")
        expect(result).toContain("openai")
        expect(result).not.toContain("google")
      }).pipe(Effect.provide(layer))
    },
  )

  it.live("selected agent widens required providers to match the actual runtime agent", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(AuthStore.Live),
      Layer.provide(AuthStorage.Test()),
      Layer.provide(helperAgentRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.requiredProviders({ agentName: "helper:google" })
      expect(result).toContain("anthropic")
      expect(result).toContain("openai")
      expect(result).toContain("google")
    }).pipe(Effect.provide(layer))
  })

  it.live("agent routed externally via driverOverrides skips model auth requirements", () => {
    const layer = AuthGuard.Live.pipe(
      Layer.provide(AuthStore.Live),
      Layer.provide(AuthStorage.Test()),
      Layer.provide(testRegistryLayer),
    )
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      // cowork is an anthropic-modeled agent, but config-routes through
      // an external driver (e.g. Claude Code SDK). The external driver
      // owns its own auth, so model providers should not be required.
      const result = yield* guard.requiredProviders({
        agentName: "cowork",
        driverOverrides: {
          cowork: ExternalDriverRef.make({ id: "acp-claude-code" }),
        },
      })
      expect(result).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})

describe("ListAuthProvidersPayload schema", () => {
  // The RPC handler resolves project config from the session's cwd,
  // not the launch cwd. The wire payload must carry sessionId so the
  // TUI can opt into per-session resolution. Notably it does NOT
  // carry `driverOverrides` — the server re-derives those from
  // session-cwd config so a wire caller can't smuggle in an override
  // that bypasses model auth.
  //
  // Plain `bunTest` here: these are pure schema decode checks with
  // no Effect context, so the `effect-bun-test` `it.live`/`it.effect`
  // ceremony isn't needed (and the bare `it` from that lib is an
  // object, not a function).
  const decode = Schema.decodeUnknownSync(ListAuthProvidersPayload)

  bunTest("accepts a sessionId field", () => {
    const query = decode({ sessionId: "019d-test-session-id" })
    expect(query.sessionId).toBe("019d-test-session-id")
  })

  bunTest("accepts agentName + sessionId together", () => {
    const query = decode({ agentName: "cowork", sessionId: "019d-test-session-id" })
    expect(query.agentName).toBe("cowork")
    expect(query.sessionId).toBe("019d-test-session-id")
  })

  bunTest("accepts neither (back-compat with launch-cwd default)", () => {
    const query = decode({})
    expect(query.agentName).toBeUndefined()
    expect(query.sessionId).toBeUndefined()
  })

  bunTest("rejects driverOverrides — those are server-derived, not wire-supplied", () => {
    // Schema is closed-by-default? No — Schema.Struct is open by default.
    // The point of the split is that consumers see a type without
    // driverOverrides; runtime decode of an unknown field is a no-op.
    // This test documents intent: callers shouldn't include driverOverrides.
    const query = decode({
      sessionId: "019d-test-session-id",
      driverOverrides: { cowork: { _tag: "external", id: "evil" } },
    } as Record<string, unknown>)
    expect(query.sessionId).toBe("019d-test-session-id")
    // The decoded type intentionally has no `driverOverrides` field.
    expect((query as Record<string, unknown>).driverOverrides).toBeUndefined()
  })
})
