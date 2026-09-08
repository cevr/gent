/**
 * AuthGuard tests
 */

import { describe, it, expect } from "effect-bun-test"
import { test as bunTest } from "bun:test"
import {
  Auth,
  AuthApi,
  AuthGuard,
  type AuthInfo,
  ListAuthProvidersPayload,
} from "@gent/core-internal/domain/auth"
import { ExtensionRegistry, resolveExtensions } from "../../src/runtime/extensions/registry"
import { DriverRegistry } from "../../src/runtime/extensions/driver-registry"
import type { LoadedExtension } from "../../src/domain/extension.js"
import type { ModelDriverContribution } from "@gent/core-internal/domain/driver"
import {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  ExternalDriverRef,
} from "@gent/core-internal/domain/agent"
import { Effect, Layer, Schema } from "effect"
import { LanguageModel, Model as AiModel } from "effect/unstable/ai"
import { ExtensionId, SessionId } from "@gent/core-internal/domain/ids"
import { ModelId, ProviderId } from "@gent/core-internal/domain/model"
import { failingLanguageModel } from "../helpers/failing-language-model"

const stubModel = AiModel.make(
  "test",
  "model",
  Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel),
)

const testProviders: ModelDriverContribution[] = [
  { id: "anthropic", name: "Anthropic", resolveModel: () => Effect.succeed(stubModel) },
  { id: "openai", name: "OpenAI", resolveModel: () => Effect.succeed(stubModel) },
  { id: "google", name: "Google", resolveModel: () => Effect.succeed(stubModel) },
  { id: "mistral", name: "Mistral", resolveModel: () => Effect.succeed(stubModel) },
]

const testAgents = [
  AgentDefinition.make({
    name: DEFAULT_AGENT_NAME,
    model: ModelId.make("anthropic/claude-opus-4-6"),
  }),
]

const testResolved = resolveExtensions([
  {
    manifest: { id: ExtensionId.make("test-providers") },
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
    manifest: { id: ExtensionId.make("test-providers") },
    scope: "builtin",
    sourcePath: "test",
    contributions: {
      modelDrivers: testProviders,
      agents: [
        ...testAgents,
        AgentDefinition.make({
          name: AgentName.make("helper:google"),
          model: ModelId.make("google/gemini-2.5-flash"),
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
  const apiInfo = (key: string): AuthInfo => AuthApi.make({ type: "api", key })

  const guardLayerWithSeed = (
    seed: Record<string, AuthInfo>,
    registryLayer: Layer.Layer<ExtensionRegistry | DriverRegistry>,
  ) => AuthGuard.Live.pipe(Layer.provide(Auth.Test(seed)), Layer.provide(registryLayer))

  it.live("requiredProviders is exactly the provider of the main agent's model", () => {
    const layer = guardLayerWithSeed({}, testRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.requiredProviders()
      expect(result).toEqual([ProviderId.make("anthropic")])
    }).pipe(Effect.provide(layer))
  })

  it.live("missingRequiredProviders returns the main agent's provider when no keys", () => {
    const layer = guardLayerWithSeed({}, testRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.missingRequiredProviders()
      expect(result).toEqual([ProviderId.make("anthropic")])
    }).pipe(Effect.provide(layer))
  })

  it.live("missingRequiredProviders clears when keys are present", () => {
    const layer = guardLayerWithSeed({ anthropic: apiInfo("sk-anthropic") }, testRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.missingRequiredProviders()
      expect(result).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  it.live("listProviders reports per-provider hasKey via Auth.get", () => {
    const layer = guardLayerWithSeed({ anthropic: apiInfo("sk-test") }, testRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.listProviders()
      const anthropic = result.find((p) => p.provider === "anthropic")
      const openai = result.find((p) => p.provider === "openai")
      expect(anthropic?.hasKey).toBe(true)
      expect(openai?.hasKey).toBe(false)
    }).pipe(Effect.provide(layer))
  })

  it.live("unselected helper agents do not widen required providers beyond main", () => {
    const layer = guardLayerWithSeed({}, helperAgentRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.requiredProviders()
      expect(result).toEqual([ProviderId.make("anthropic")])
    }).pipe(Effect.provide(layer))
  })

  it.live("selected agent with a different provider widens required providers", () => {
    const layer = guardLayerWithSeed({}, helperAgentRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      const result = yield* guard.requiredProviders({ agentName: AgentName.make("helper:google") })
      expect(result).toContain(ProviderId.make("anthropic"))
      expect(result).toContain(ProviderId.make("google"))
      expect(result).not.toContain(ProviderId.make("openai"))
    }).pipe(Effect.provide(layer))
  })

  it.live("agent routed externally via driverOverrides skips model auth requirements", () => {
    const layer = guardLayerWithSeed({}, testRegistryLayer)
    return Effect.gen(function* () {
      const guard = yield* AuthGuard
      // main is an anthropic-modeled agent, but config-routes through
      // an external driver (e.g. Claude Code SDK). The external driver
      // owns its own auth, so model providers should not be required.
      const result = yield* guard.requiredProviders({
        agentName: DEFAULT_AGENT_NAME,
        driverOverrides: {
          [DEFAULT_AGENT_NAME]: ExternalDriverRef.make({ id: "acp-claude-code" }),
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
    const query = decode({ sessionId: SessionId.make("019d-test-session-id") })
    expect(query.sessionId).toBe(SessionId.make("019d-test-session-id"))
  })

  bunTest("accepts agentName + sessionId together", () => {
    const query = decode({
      agentName: DEFAULT_AGENT_NAME,
      sessionId: SessionId.make("019d-test-session-id"),
    })
    expect(query.agentName).toBe(DEFAULT_AGENT_NAME)
    expect(query.sessionId).toBe(SessionId.make("019d-test-session-id"))
  })

  bunTest("accepts omitted filters for launch-cwd defaults", () => {
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
      sessionId: SessionId.make("019d-test-session-id"),
      driverOverrides: { [DEFAULT_AGENT_NAME]: { _tag: "external", id: "evil" } },
    })
    expect(query.sessionId).toBe(SessionId.make("019d-test-session-id"))
    // The decoded type intentionally has no `driverOverrides` field.
    expect("driverOverrides" in query).toBe(false)
  })
})
