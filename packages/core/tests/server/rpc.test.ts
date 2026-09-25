import { test } from "bun:test"
import {
  Cause,
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  MutableRef,
  Option,
  Path,
  Predicate,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  DriverListResult,
  ExtensionProtocolError,
  type GentNamespacedClient,
  type GentRpcClient,
  GentRpcs,
  makeNamespacedClient,
  SlashCommandInfo,
} from "../../src/server/rpc"
import {
  WorkspaceRpcMiddleware,
  CurrentWorkspaceId,
  WORKSPACE_ID_HEADER,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
  WorkspaceId,
} from "../../src/server/workspace-rpc"
import { describe, expect, it } from "effect-bun-test"
import { RpcClient } from "effect/unstable/rpc"
import { SqlClient } from "effect/unstable/sql"
import {
  finishPart,
  textDeltaPart,
  Auth,
  AuthError,
  AuthMethod,
  serializeAuthStore,
} from "../../src/runtime/provider"
import {
  LanguageModelLayers,
  makeTempDirectoryScoped,
  multiToolCallStep,
  textStep,
  toolCallStep,
  waitFor,
} from "../../src/test-utils/language-model"
import {
  AgentDefinition,
  AgentName,
  DEFAULT_AGENT_NAME,
  Model,
  ModelId,
  ProviderId,
} from "../../src/domain/agent"
import {
  createE2ELayer,
  createRpcClient,
  createRpcHarness,
  testTurnExtension,
} from "../../src/test-utils/harness"
import { e2ePreset, testAgent } from "../helpers/test-preset"
import {
  BranchId,
  ExtensionId,
  InteractionRequestId,
  ProcessGenerationId,
  RequestId,
  SessionId,
} from "../../src/domain/ids"
import { Model as AiModel, LanguageModel } from "effect/unstable/ai"
import { BunServices } from "@effect/platform-bun"
import type { ModelDriverContribution } from "../../src/domain/driver.js"
import { type ExtensionHealthSnapshot, SetDriverOverrideInput } from "../../src/server/rpc.js"
import {
  defineResource,
  ExtensionLoadError,
  type GentExtension,
  LoadedArtifactIdentity,
  type LoadedExtension,
  registerContributions,
} from "../../src/domain/extension.js"
import { failingLanguageModel } from "../helpers/failing-language-model"
import * as ExtensionApi from "@gent/core/extensions/api"
import {
  CapabilityError,
  ExtensionContext,
  type ExtensionContextService,
  ExtensionHost,
  request,
  tool,
} from "@gent/core/extensions/api"
import {
  ApprovalService,
  buildResourceLayer,
  ExtensionRegistry,
  resolveExtensions,
  type SessionProfile,
  SessionProfileCache,
} from "../../src/runtime/extension-host"
import { InteractionStorage, MessageStorage, SqliteStorage } from "../../src/storage/storage"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { CurrentInteractionOwner, encodeInteractionDecision } from "../../src/domain/interaction.js"
import { EventStoreError } from "../../src/domain/event"
import { MinimumLogLevel } from "effect/References"
import { Message, messagePartsText } from "../../src/domain/message"
import { ConfigService, RuntimeEnvironment } from "../../src/runtime/config"
import { type LogEvent, WideEventLogger } from "effect-wide-event"

// ── rpc contract schemas ────────────────────────────────────────────────────

const decodeSuccess = (key: string, value: Readonly<Record<string, string>>): unknown => {
  const rpc = GentRpcs.requests.get(key)
  if (Predicate.isUndefined(rpc)) return Effect.runSync(Effect.die(new Error(`Missing RPC ${key}`)))
  return Schema.decodeSync(rpc.successSchema)(value)
}

describe("RPC contract schemas", () => {
  test("decode inlined session success payloads", () => {
    expect(
      decodeSuccess("session.create", {
        sessionId: "session-1",
        branchId: "branch-1",
        name: "Session",
      }),
    ).toEqual({
      sessionId: "session-1",
      branchId: "branch-1",
      name: "Session",
    })

    expect(
      decodeSuccess("session.updateSettings", {
        modelId: "anthropic/claude-sonnet-5",
        reasoningLevel: "medium",
      }),
    ).toEqual({ modelId: "anthropic/claude-sonnet-5", reasoningLevel: "medium" })
  })

  test("decode inlined branch success payloads", () => {
    expect(decodeSuccess("branch.create", { branchId: "branch-1" })).toEqual({
      branchId: "branch-1",
    })
    expect(decodeSuccess("branch.fork", { branchId: "branch-2" })).toEqual({
      branchId: "branch-2",
    })
  })

  test("all RPCs require workspace header middleware", () => {
    for (const rpc of GentRpcs.requests.values()) {
      expect(rpc.middlewares.has(WorkspaceRpcMiddleware)).toBe(true)
    }
  })
})

// ── extension rpcs ──────────────────────────────────────────────────────────

/**
 * Driver routing RPCs — `driver.list` / `driver.set` / `driver.clear`
 * acceptance tests.
 *
 * Drives the full transport boundary (createRpcClient → RpcServer → handler →
 * ConfigService + ExtensionRegistry) so the tests catch wiring bugs the
 * unit tests on `ConfigService.setDriverOverride` don't cover.
 */

describe("ExtensionRpcs", () => {
  /** A client over a config the test can read: `driver.set` and `driver.clear` write it. */
  const clientWithConfig = Effect.gen(function* () {
    const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
    const configContext = yield* Layer.build(ConfigService.Test())
    const { client } = yield* createRpcClient(
      createE2ELayer({
        ...e2ePreset,
        providerLayer,
        configServiceLayer: Layer.succeedContext(configContext),
      }),
    )
    const driverOverrides = Context.get(configContext, ConfigService)
      .get()
      .pipe(Effect.map((config) => config.driverOverrides ?? {}))
    return { client, driverOverrides }
  })

  it.live("driver.list returns the registered drivers and agents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* clientWithConfig
        const before = yield* client.driver.list({})
        expect(before).toBeInstanceOf(DriverListResult)
        // Built-in agents extension contributes the "anthropic" model driver
        // (and friends); the registered list is non-empty.
        expect(before.drivers.length).toBeGreaterThan(0)
        expect(before.agents.map((agent) => agent.name)).toContain(DEFAULT_AGENT_NAME)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.set persists an override in the config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, driverOverrides } = yield* clientWithConfig
        const someModel = (yield* client.driver.list({})).drivers[0]
        if (Predicate.isUndefined(someModel)) {
          return yield* Effect.die(new Error("no model driver registered in test layer"))
        }
        yield* client.driver.set({
          agentName: DEFAULT_AGENT_NAME,
          driver: { id: someModel.id },
        })
        expect((yield* driverOverrides)[DEFAULT_AGENT_NAME]?.id).toBe(someModel.id)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  test("driver.set names a driver; a ref with no id is not a second way to clear", () => {
    const decode = Schema.decodeUnknownExit(SetDriverOverrideInput)
    expect(Exit.isFailure(decode({ agentName: "main", driver: { _tag: "Model" } }))).toBe(true)
    expect(
      Exit.isSuccess(decode({ agentName: "main", driver: { _tag: "Model", id: "anthropic" } })),
    ).toBe(true)
  })

  it.live("driver.set rejects unknown driver id with NotFoundError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = yield* clientWithConfig
        const result = yield* client.driver
          .set({
            agentName: DEFAULT_AGENT_NAME,
            driver: { id: "definitely-not-registered" },
          })
          .pipe(Effect.flip)
        expect(result._tag).toBe("NotFoundError")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.clear removes an existing override", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, driverOverrides } = yield* clientWithConfig
        const someModel = (yield* client.driver.list({})).drivers[0]
        if (Predicate.isUndefined(someModel)) {
          return yield* Effect.die(new Error("no model driver registered in test layer"))
        }
        yield* client.driver.set({
          agentName: DEFAULT_AGENT_NAME,
          driver: { id: someModel.id },
        })
        yield* client.driver.clear({ agentName: DEFAULT_AGENT_NAME })
        expect(yield* driverOverrides).toEqual({})
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.clear is a no-op for an unknown agent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, driverOverrides } = yield* clientWithConfig
        yield* client.driver.clear({ agentName: AgentName.make("does-not-exist") })
        expect(yield* driverOverrides).toEqual({})
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

// ── model context ───────────────────────────────────────────────────────────

describe("model context RPC boundary", () => {
  it.scopedLive(
    "settles an oversized turn as a visible failure before provider dispatch",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let providerCalls = 0
          const providerLayer = LanguageModelLayers.testStream(() => {
            providerCalls += 1
            return Effect.succeed(
              Stream.fromIterable([
                textDeltaPart("recovered"),
                finishPart({ finishReason: "stop" }),
              ]),
            )
          })
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
          })
          const errorEventFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "ErrorOccurred"),
            Stream.runHead,
            Effect.forkScoped,
          )
          const requestId = RequestId.make("model-context-rpc")
          const marker = "rpc-oversized-context-marker"
          const result = yield* Effect.exit(
            client.message.send({
              sessionId,
              branchId,
              content: `${marker} ${"x".repeat(520_000)}`,
              requestId,
            }),
          )

          expect(result._tag).toBe("Failure")
          expect(providerCalls).toBe(0)
          const errorEvent = yield* Fiber.join(errorEventFiber)
          expect(Option.isSome(errorEvent)).toBe(true)
          if (Option.isNone(errorEvent)) return yield* Effect.die("turn error event missing")
          if (errorEvent.value.event._tag !== "ErrorOccurred") {
            return yield* Effect.die("unexpected event in error stream")
          }
          // The user reads the error's own message, not its class tag.
          expect(errorEvent.value.event.error).toContain("BudgetExceeded projecting the context")
          expect(errorEvent.value.event.error).not.toContain("ModelContextProjectionError")
          // The transcript prints this text; stack frames belong in the log.
          expect(errorEvent.value.event.error).not.toContain("\n    at ")
          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "runtime idle after model context failure",
          )
          expect(
            snapshot.messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text.includes(marker)),
            ),
          ).toBe(true)

          yield* client.message.send({
            sessionId,
            branchId,
            content: "recover after context failure",
            requestId: RequestId.make("model-context-rpc-recovery"),
          })
          const recovered = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "runtime idle after recovery turn",
          )
          // The oversized message is clipped in the summary input, so the
          // handoff summarizes it (one model call) before the recovery turn.
          expect(providerCalls).toBe(2)
          expect(
            recovered.messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "recovered"),
            ),
          ).toBe(true)
          expect(
            recovered.messages.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text.includes("Summary:\nrecovered"),
              ),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    12_000,
  )
})

// ── branch fork ─────────────────────────────────────────────────────────────

const EchoProbeExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("@test/echo-probe") },
  scope: "builtin",
  sourcePath: "test",
  artifactIdentity: LoadedArtifactIdentity.make("@test/echo-probe@artifact-1"),
  contributions: {
    tools: [
      tool({
        id: "echo_probe",
        description: "Return the text",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        execute: (params) => Effect.succeed({ text: params.text }),
      }),
    ],
  },
}

const hasText = (messages: ReadonlyArray<Message>, text: string) =>
  messages.some((message) =>
    message.parts.some((part) => part.type === "text" && part.text === text),
  )

describe("branch.fork", () => {
  it.scopedLive(
    "a fork at an assistant tool-call message can run a turn",
    () =>
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("echo_probe", { text: "ping" }),
          textStep("first done"),
          textStep("fork done"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensions: [EchoProbeExtension],
        })
        yield* client.message.send({ sessionId, branchId, content: "call echo" })
        const settled = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (current) => current.runtime._tag === "Idle" && hasText(current.messages, "first done"),
          5_000,
          "first turn settles",
        )
        const callMessage = settled.messages.find((message) =>
          message.parts.some((part) => part.type === "tool-call"),
        )
        if (Predicate.isUndefined(callMessage)) return yield* Effect.die("tool call missing")

        const fork = yield* client.branch.fork({
          sessionId,
          fromBranchId: branchId,
          atMessageId: callMessage.id,
          name: "at tool call",
        })
        yield* client.message.send({ sessionId, branchId: fork.branchId, content: "go on" })
        const forked = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId: fork.branchId }),
          (current) => current.runtime._tag === "Idle" && hasText(current.messages, "fork done"),
          5_000,
          "fork turn settles",
        )
        // The copied prefix keeps no call without its result.
        expect(
          forked.messages.some((message) =>
            message.parts.some((part) => part.type === "tool-call"),
          ),
        ).toBe(false)
      }).pipe(Effect.timeout("10 seconds")),
    12_000,
  )
})

// ── auth rpcs ───────────────────────────────────────────────────────────────

/**
 * `auth.listProviders` RPC acceptance tests.
 *
 * An unknown session fails the listing; otherwise the selected agent's
 * model decides which providers need auth.
 */

const failingAuthStoreLayer = Layer.succeed(
  Auth,
  Auth.of(
    serializeAuthStore({
      get: () => Effect.as(Effect.void, void 0),
      set: () => Effect.fail(new AuthError({ message: "write failed" })),
      remove: () => Effect.fail(new AuthError({ message: "delete failed" })),
    }),
  ),
)
const failingReadAuthStoreLayer = Layer.succeed(
  Auth,
  Auth.of(
    serializeAuthStore({
      get: () => Effect.fail(new AuthError({ message: "read failed" })),
      set: () => Effect.void,
      remove: () => Effect.void,
    }),
  ),
)
const stubModel = AiModel.make(
  "test",
  "model",
  Layer.succeed(LanguageModel.LanguageModel, failingLanguageModel),
)
const makePersistingExtensions = (): ReadonlyArray<LoadedExtension> => {
  const pendingCallbacks = new Map<string, (code?: string) => string>()
  const oauthProvider: ModelDriverContribution = {
    id: "persisting-oauth",
    name: "Persisting OAuth",
    resolveModel: () => Effect.succeed(stubModel),
    auth: {
      methods: [AuthMethod.make({ type: "oauth", label: "OAuth" })],
      authorize: (ctx) =>
        Effect.sync(() => {
          pendingCallbacks.set(ctx.authorizationId, (code) => code ?? "")
          return Option.some({
            url: "http://example.com/auth",
            method: "code",
          })
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
    resolveModel: () => Effect.succeed(stubModel),
    auth: {
      methods: [AuthMethod.make({ type: "oauth", label: "Done" })],
      authorize: (ctx) =>
        Effect.gen(function* () {
          yield* ctx.persist({ type: "api", key: "sk-authorize" })
          return Option.some({
            url: "",
            method: "done",
          })
        }),
    },
  }
  return [
    {
      manifest: { id: ExtensionId.make("test-auth-providers") },
      scope: "builtin",
      sourcePath: "test",
      contributions: { modelDrivers: [oauthProvider, authorizePersistProvider] },
    },
  ]
}
const authDriversExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("@test/auth-drivers") },
  scope: "builtin",
  sourcePath: "test",
  contributions: {
    modelDrivers: [
      { id: "anthropic", name: "Anthropic", resolveModel: () => Effect.succeed(stubModel) },
      { id: "otherprov", name: "Other", resolveModel: () => Effect.succeed(stubModel) },
    ],
    agents: [
      AgentDefinition.make({
        name: AgentName.make("helper"),
        model: ModelId.make("otherprov/helper-model"),
      }),
    ],
  },
}

describe("auth.listProviders", () => {
  it.live("a session's model override decides the required provider", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({ ...e2ePreset, providerLayer, extensions: [authDriversExtension] }),
        )
        const session = yield* client.session.create({ cwd: process.cwd() })
        const required = (providers: ReadonlyArray<{ provider: string; required: boolean }>) =>
          providers.filter((entry) => entry.required).map((entry) => entry.provider)
        expect(
          required(yield* client.auth.listProviders({ sessionId: session.sessionId })),
        ).toEqual(["anthropic"])
        yield* client.session.updateSettings({
          sessionId: session.sessionId,
          modelId: Option.some(ModelId.make("otherprov/model")),
          reasoningLevel: Option.none(),
        })
        expect(
          required(yield* client.auth.listProviders({ sessionId: session.sessionId })),
        ).toEqual(["otherprov"])
        // Without a session the launch default still decides.
        expect(required(yield* client.auth.listProviders({}))).toEqual(["anthropic"])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("a named agent adds its model's provider; other agents do not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({ ...e2ePreset, providerLayer, extensions: [authDriversExtension] }),
        )
        const required = (providers: ReadonlyArray<{ provider: string; required: boolean }>) =>
          providers.filter((entry) => entry.required).map((entry) => entry.provider)
        expect(required(yield* client.auth.listProviders({}))).toEqual(["anthropic"])
        expect(
          required(yield* client.auth.listProviders({ agentName: AgentName.make("helper") })),
        ).toEqual(["anthropic", "otherprov"])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("a driver override decides the required driver, not the model prefix", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const configContext = yield* Layer.build(ConfigService.Test())
        const { client } = yield* createRpcClient(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensions: [authDriversExtension],
            configServiceLayer: Layer.succeedContext(configContext),
          }),
        )
        const session = yield* client.session.create({ cwd: process.cwd() })
        // The model stays `anthropic/…`; the turn routes through `otherprov`.
        yield* client.driver.set({ agentName: DEFAULT_AGENT_NAME, driver: { id: "otherprov" } })
        yield* client.auth.setKey({ provider: "otherprov", key: "sk-other" })
        const providers = yield* client.auth.listProviders({ sessionId: session.sessionId })
        expect(
          providers.filter((entry) => entry.required).map((entry) => String(entry.provider)),
        ).toEqual(["otherprov"])
        expect(providers.filter((entry) => entry.required && !entry.hasKey)).toEqual([])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("a driver whose env credential is set reports the key from env", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const envName = "ANTHROPIC_API_KEY"
        // The server reads env through the ConfigProvider; this one holds only the key.
        const envLayer = ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { [envName]: "sk-from-env" } }),
        )
        const envDrivers: LoadedExtension = {
          manifest: { id: ExtensionId.make("@test/env-drivers") },
          scope: "builtin",
          sourcePath: "test",
          contributions: {
            modelDrivers: [
              {
                id: "anthropic",
                name: "Anthropic",
                envCredential: envName,
                resolveModel: () => Effect.succeed(stubModel),
              },
              {
                id: "otherprov",
                name: "Other",
                envCredential: "OTHERPROV_API_KEY",
                resolveModel: () => Effect.succeed(stubModel),
              },
            ],
          },
        }
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({ ...e2ePreset, providerLayer, extensions: [envDrivers] }).pipe(
            Layer.provide(envLayer),
          ),
        )
        const providers = yield* client.auth.listProviders({})
        const anthropic = providers.find((entry) => entry.provider === "anthropic")
        expect(anthropic?.hasKey).toBe(true)
        expect(anthropic?.source).toBe("env")
        expect(anthropic?.required).toBe(true)
        const other = providers.find((entry) => entry.provider === "otherprov")
        expect(other?.hasKey).toBe(false)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("returns launch-cwd providers without sessionId", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const providers = yield* client.auth.listProviders({})
        expect(providers.length).toBeGreaterThan(0)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("rejects auth provider listing for a deleted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const session = yield* client.session.create({})
        yield* client.session.delete({ sessionId: session.sessionId })
        const exit = yield* Effect.exit(
          client.auth.listProviders({
            agentName: DEFAULT_AGENT_NAME,
            sessionId: session.sessionId,
          }),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(exit.cause.toString()).toContain("Session not found")
        }
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})
describe("auth persistence RPC failures", () => {
  it.live("auth.listProviders surfaces auth read failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            authLayer: failingReadAuthStoreLayer,
          }),
        )
        const exit = yield* Effect.exit(client.auth.listProviders({}))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(exit.cause.toString()).toContain("read failed")
        }
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("auth.setKey surfaces write failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            authLayer: failingAuthStoreLayer,
          }),
        )
        const exit = yield* Effect.exit(client.auth.setKey({ provider: "openai", key: "sk-test" }))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(exit.cause.toString()).toContain("Failed to set auth")
        }
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("auth.deleteKey surfaces delete failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            authLayer: failingAuthStoreLayer,
          }),
        )
        const exit = yield* Effect.exit(client.auth.deleteKey({ provider: "openai" }))
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(exit.cause.toString()).toContain("Failed to delete auth")
        }
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("auth.authorize surfaces credentials persisted during authorize", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensions: makePersistingExtensions(),
            authLayer: failingAuthStoreLayer,
          }),
        )
        const exit = yield* Effect.exit(
          client.auth.authorize({
            sessionId: SessionId.make("auth-rpc-session"),
            provider: "persisting-authorize",
            method: 0,
          }),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(exit.cause.toString()).toContain("Failed to persist auth")
        }
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("auth.callback surfaces callback credential persistence failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensions: makePersistingExtensions(),
            authLayer: failingAuthStoreLayer,
          }),
        )
        const authorization = yield* client.auth.authorize({
          sessionId: SessionId.make("auth-rpc-session"),
          provider: "persisting-oauth",
          method: 0,
        })
        if (Predicate.isNull(authorization)) return yield* Effect.die("auth setup failed")
        const exit = yield* Effect.exit(
          client.auth.callback({
            sessionId: SessionId.make("auth-rpc-session"),
            provider: "persisting-oauth",
            method: 0,
            authorizationId: authorization.authorizationId,
            code: "sk-callback",
          }),
        )
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(exit.cause.toString()).toContain("Failed to persist auth")
        }
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

// ── interaction commands ────────────────────────────────────────────────────

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

const InteractionProbeExtension: LoadedExtension = {
  manifest: { id: ExtensionId.make("@test/interaction-probe") },
  scope: "builtin",
  sourcePath: "test",
  artifactIdentity: LoadedArtifactIdentity.make("@test/interaction-probe@artifact-1"),
  contributions: {
    tools: [
      tool({
        id: "approval_probe",
        description: "Request approval and report the result",
        params: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({
          approved: Schema.Boolean,
          notes: Schema.String,
        }),
        execute: Effect.fn("approval_probe")(function* (params) {
          const ctx = yield* ExtensionContext
          const decision = yield* ctx.Interaction.approve({ text: params.text })
          return {
            approved: decision.approved,
            notes: decision.notes ?? "",
          }
        }),
      }),
    ],
  },
}

// The same derivation the server and its clients use; a third copy here
// would be a third thing to keep in step.
const currentTestWorkspaceId = () => workspaceIdForCwd(process.cwd())

// ── owner-keyed interaction fixtures ────────────────────────────────────────

const OrderedApprovalParams = Schema.Struct({ label: Schema.String, text: Schema.String })
type OrderedApprovalParams = typeof OrderedApprovalParams.Type

/**
 * One tool, `ordered_approval`, whose body the test scripts per label and per
 * run. The run number lets a call act differently when its step runs again.
 */
const orderedApprovalExtension = <E>(
  run: (
    params: OrderedApprovalParams,
    attempt: number,
  ) => Effect.Effect<string, E, ExtensionContext>,
): LoadedExtension => {
  const attempts = new Map<string, number>()
  const nextAttempt = (label: string) =>
    Effect.sync(() => {
      const attempt = Option.getOrElse(Option.fromUndefinedOr(attempts.get(label)), () => 0) + 1
      attempts.set(label, attempt)
      return attempt
    })
  return {
    manifest: { id: ExtensionId.make("@test/ordered-approval") },
    scope: "builtin",
    sourcePath: "test",
    artifactIdentity: LoadedArtifactIdentity.make("@test/ordered-approval@artifact-1"),
    contributions: {
      tools: [
        tool({
          id: "ordered_approval",
          description: "Ask approval in a scripted order",
          params: OrderedApprovalParams,
          output: Schema.Struct({ answer: Schema.String }),
          execute: Effect.fn("ordered_approval")(function* (params) {
            const attempt = yield* nextAttempt(params.label)
            return { answer: yield* run(params, attempt) }
          }),
        }),
      ],
    },
  }
}

/** Ask through the extension facet and name the answer after the asking call. */
const approveAs = (params: OrderedApprovalParams) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const decision = yield* ctx.Interaction.approve({ text: params.text })
    return `${params.label}=${String(decision.notes)}`
  })

/**
 * Ask as a dispatching tool's inner call would, through an owner that rejects
 * the request (a cell whose receipt refuses it). Reports the refusal.
 */
const approveThroughRejectingOwner = (params: OrderedApprovalParams) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const owner = {
      sessionId: ctx.sessionId,
      branchId: ctx.branchId,
      persist: () => Effect.fail(new EventStoreError({ message: "the owner refused the request" })),
      resumeRequestId: Effect.succeedNone,
      take: () => Effect.void,
    }
    const exit = yield* Effect.exit(
      ctx.Interaction.approve({ text: params.text }).pipe(
        Effect.provideService(CurrentInteractionOwner, owner),
      ),
    )
    if (Exit.isSuccess(exit)) return `${params.label}=${String(exit.value.notes)}`
    return `${params.label}=rejected`
  })

/** How a dialog closed: dismissed with its turn, or the user's decision. */
const resolvedAs = (event: { readonly approved: boolean; readonly dismissed?: true }) => {
  if (event.dismissed === true) return "dismissed"
  return String(event.approved)
}

/** The text of every tool result in a snapshot. */
const toolResultTexts = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type === "tool-result") return [encodeJson(part.result)]
      return []
    }),
  )

/**
 * Answer each presented dialog in order, once the branch has parked on it.
 * The n-th answer carries `answers[n]` as its notes. `presented` completes on
 * the first dialog, so a script can hold a call until one request is open.
 */
const answerInOrder = (params: {
  readonly client: GentNamespacedClient
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly answers: ReadonlyArray<string>
  readonly presented: Deferred.Deferred<void>
  /** Read events after this id, to skip what an earlier server published. */
  readonly after?: number
}) =>
  params.client.session
    .events({ sessionId: params.sessionId, branchId: params.branchId, after: params.after })
    .pipe(
      Stream.filterMap((envelope) => {
        if (envelope.event._tag === "InteractionPresented") return Result.succeed(envelope.event)
        return Result.failVoid
      }),
      Stream.take(params.answers.length),
      Stream.zipWithIndex,
      Stream.mapEffect(([presented, index]) =>
        Effect.gen(function* () {
          yield* Deferred.completeWith(params.presented, Effect.void)
          yield* waitFor(
            params.client.session.getSnapshot({
              sessionId: params.sessionId,
              branchId: params.branchId,
            }),
            (current) => current.runtime._tag === "WaitingForInteraction",
            5_000,
            `parked on dialog ${index}`,
          )
          yield* params.client.interaction.respondInteraction({
            sessionId: params.sessionId,
            branchId: params.branchId,
            requestId: presented.requestId,
            approved: true,
            notes: params.answers[index],
          })
          return presented.text
        }),
      ),
      Stream.runCollect,
    )

/** The snapshot once the turn has replied `reply` and the loop is idle. */
const waitForReply = (params: {
  readonly client: GentNamespacedClient
  readonly sessionId: SessionId
  readonly branchId: BranchId
  readonly reply: string
}) =>
  waitFor(
    params.client.session.getSnapshot({ sessionId: params.sessionId, branchId: params.branchId }),
    (current) =>
      current.runtime._tag === "Idle" &&
      current.messages.some(
        (message) =>
          message.role === "assistant" &&
          message.parts.some((part) => part.type === "text" && part.text === params.reply),
      ),
    5_000,
    `reply ${params.reply}`,
  )

// ── turn-origin fixtures ────────────────────────────────────────────────────

const originProbeId = ExtensionId.make("@test/interaction-origin")

/** A nudge lands on its own run's branch unless it names another. */
const NudgeInput = Schema.Struct({
  label: Schema.String,
  sessionId: Schema.optional(SessionId),
  branchId: Schema.optional(BranchId),
  /** Marks the sender claims beside the client origin. */
  customType: Schema.optional(Schema.String),
  joinedTurn: Schema.optional(Schema.Boolean),
  /** Steer the message into the branch instead of queueing it. */
  steer: Schema.optional(Schema.Boolean),
  /** The steer's request id; a repeat is a no-op. */
  requestId: Schema.optional(RequestId),
})

/**
 * An extension whose `nudge` request queues a waking message, the way a wake,
 * a monitor, a child's completion and every workflow slash command reach a
 * branch. The message claims the client origin, which only the server grants.
 * `arm` keeps the context of the request that ran it, so a later call can
 * send through it after that request ended. `handoff_probe` is an
 * interactive tool, like `handoff`: a turn no user watches does not see it.
 */
const makeOriginProbe = () => {
  const armed = MutableRef.make(Option.none<ExtensionContextService>())
  const nudgeWith = (ctx: ExtensionContextService, input: typeof NudgeInput.Type) => {
    const fields = {
      content: input.label,
      metadata: {
        fromClient: true,
        ...(Predicate.isNotUndefined(input.customType) && { customType: input.customType }),
        ...(Predicate.isNotUndefined(input.joinedTurn) && { joinedTurn: input.joinedTurn }),
      },
      wake: true,
      sessionId: input.sessionId,
      branchId: input.branchId,
    }
    if (input.steer === true) {
      return ctx.Session.send({
        delivery: "steer",
        ...fields,
        ...(Predicate.isNotUndefined(input.requestId) && { requestId: input.requestId }),
      })
    }
    return ctx.Session.send({ delivery: "queue", sourceId: `nudge:${input.label}`, ...fields })
  }
  const extension: LoadedExtension = {
    ...InteractionProbeExtension,
    manifest: { id: originProbeId },
    artifactIdentity: LoadedArtifactIdentity.make("@test/interaction-origin@artifact-1"),
    contributions: {
      tools: [
        ...(InteractionProbeExtension.contributions.tools ?? []),
        tool({
          id: "handoff_probe",
          interactive: true,
          description: "Ask to hand off, like the handoff tool",
          params: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ approved: Schema.Boolean }),
          execute: Effect.fn("handoff_probe")(function* (params) {
            const ctx = yield* ExtensionContext
            const decision = yield* ctx.Interaction.approve({ text: params.text })
            return { approved: decision.approved }
          }),
        }),
      ],
      requests: [
        request({
          id: "nudge",
          input: NudgeInput,
          output: Schema.Void,
          execute: Effect.fn("nudge")(function* (input) {
            yield* nudgeWith(yield* ExtensionContext, input)
          }),
        }),
        request({
          id: "arm",
          input: Schema.Struct({}),
          output: Schema.Void,
          execute: Effect.fn("arm")(function* () {
            MutableRef.set(armed, Option.some(yield* ExtensionContext))
          }),
        }),
        request({
          id: "fire",
          input: NudgeInput,
          output: Schema.Void,
          execute: Effect.fn("fire")(function* (input) {
            const ctx = MutableRef.get(armed)
            if (Option.isNone(ctx)) return yield* Effect.die("fire before arm")
            yield* nudgeWith(ctx.value, input)
          }),
        }),
      ],
    },
  }
  return extension
}

/** Client helpers over the origin probe. */
const originClient = (client: GentNamespacedClient) => {
  const call = (
    capabilityId: "nudge" | "arm" | "fire",
    at: { readonly sessionId: SessionId; readonly branchId: BranchId },
    input: typeof NudgeInput.Type | Record<string, never>,
  ) =>
    client.extension.request({
      sessionId: at.sessionId,
      branchId: at.branchId,
      extensionId: originProbeId,
      capabilityId,
      input,
    })
  /** Start `trigger`, answer the dialog it opens, and wait for `reply`. */
  const approves = <E>(
    target: { readonly sessionId: SessionId; readonly branchId: BranchId },
    trigger: Effect.Effect<unknown, E>,
    question: string,
    reply: string,
  ) =>
    Effect.gen(function* () {
      const presented = yield* client.session.events(target).pipe(
        Stream.filterMap((envelope) => {
          if (envelope.event._tag === "InteractionPresented") return Result.succeed(envelope.event)
          return Result.failVoid
        }),
        Stream.filter((event) => event.text === question),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      )
      yield* trigger
      const dialog = Array.from(yield* Fiber.join(presented))[0]
      if (Predicate.isUndefined(dialog)) return yield* Effect.die("no dialog")
      yield* client.interaction.respondInteraction({
        ...target,
        requestId: dialog.requestId,
        approved: true,
      })
      yield* waitForReply({ client, ...target, reply })
    })
  /** Run `trigger` and wait until the branch replies `reply` with no dialog; returns its messages. */
  const declines = <E>(
    target: { readonly sessionId: SessionId; readonly branchId: BranchId },
    trigger: Effect.Effect<unknown, E>,
    reply: string,
  ) =>
    Effect.gen(function* () {
      yield* trigger
      const snapshot = yield* waitForReply({ client, ...target, reply })
      return snapshot.messages
    })
  return { call, approves, declines }
}

describe("interaction.respondInteraction", () => {
  it.scopedLive(
    "rehydrates one pending interaction after restart and accepts response before explicit actor wake",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-interaction-")
        const dbPath = `${tempDir}/gent.db`
        const finalReply = "approval resumed after restart"
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("approval_probe", { text: "approve deploy?" }),
        ])
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: firstProvider.layer,
                extensions: [InteractionProbeExtension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            const interactionFiber = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

            yield* client.message.send({
              sessionId,
              branchId,
              content: "run approval probe",
            })

            const interactions = Array.from(yield* Fiber.join(interactionFiber))
            const presented = interactions[0]
            expect(presented?.event._tag).toBe("InteractionPresented")
            if (presented?.event._tag !== "InteractionPresented") {
              return yield* Effect.die(new Error("interaction was not presented"))
            }

            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (current) => current.runtime._tag === "WaitingForInteraction",
              5_000,
              "waiting interaction runtime state before restart",
            )
            const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
            return {
              sessionId,
              branchId,
              requestId: presented.event.requestId,
              lastEventId: snapshot.lastEventId ?? 0,
            }
          }).pipe(Effect.timeout("8 seconds")),
        )

        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: secondProvider.layer,
                extensions: [InteractionProbeExtension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )
            const rehydrated = Array.from(
              yield* client.session
                .events({
                  sessionId: first.sessionId,
                  branchId: first.branchId,
                  after: first.lastEventId,
                })
                .pipe(
                  Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
                  Stream.take(1),
                  Stream.runCollect,
                ),
            )
            expect(rehydrated.length).toBe(1)
            expect(rehydrated[0]?.event._tag).toBe("InteractionPresented")
            if (rehydrated[0]?.event._tag === "InteractionPresented") {
              expect(rehydrated[0].event.requestId).toBe(first.requestId)
            }
            yield* client.interaction.respondInteraction({
              sessionId: first.sessionId,
              branchId: first.branchId,
              requestId: first.requestId,
              approved: true,
              notes: "after restart",
            })

            const snapshot = yield* waitFor(
              client.session.getSnapshot({
                sessionId: first.sessionId,
                branchId: first.branchId,
              }),
              (current) =>
                current.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.parts.some((part) => part.type === "text" && part.text === finalReply),
                ),
              5_000,
              "assistant reply after restarted interaction response",
            )

            expect(
              snapshot.messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.parts.some(
                    (part) =>
                      part.type === "tool-result" &&
                      encodeJson(part.result).includes("after restart"),
                  ),
              ),
            ).toBe(true)
          }).pipe(Effect.timeout("8 seconds")),
        )
      }),
    12_000,
  )

  it.scopedLive(
    "recovers a stored decision after restart before actor wake",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-interaction-")
        const dbPath = `${tempDir}/gent-decision.db`
        const storageLayer = SqliteStorage.LiveWithSql(dbPath, () => Layer.empty, {}).pipe(
          Layer.provide(BunPlatformLive),
        )
        const finalReply = "approval resumed from stored decision"
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("approval_probe", { text: "approve deploy?" }),
        ])
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: firstProvider.layer,
                extensions: [InteractionProbeExtension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            const interactionFiber = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )

            yield* client.message.send({
              sessionId,
              branchId,
              content: "run approval probe",
            })

            const interactions = Array.from(yield* Fiber.join(interactionFiber))
            const presented = interactions[0]?.event
            expect(presented?._tag).toBe("InteractionPresented")
            if (presented?._tag !== "InteractionPresented") {
              return yield* Effect.die(new Error("interaction was not presented"))
            }

            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (current) => current.runtime._tag === "WaitingForInteraction",
              5_000,
              "waiting interaction runtime state before stored decision",
            )
            return {
              sessionId,
              branchId,
              requestId: presented.requestId,
            }
          }).pipe(Effect.timeout("8 seconds")),
        )
        yield* Effect.gen(function* () {
          const storage = yield* InteractionStorage
          const decisionJson = yield* encodeInteractionDecision({
            approved: true,
            notes: "stored before wake",
          })
          yield* storage.decide(first, first.requestId, decisionJson)
        }).pipe(
          Effect.provide(storageLayer),
          Effect.provideService(CurrentWorkspaceId, currentTestWorkspaceId()),
        )

        const secondProvider = yield* LanguageModelLayers.sequence([textStep(finalReply)])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: secondProvider.layer,
                extensions: [InteractionProbeExtension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )

            const snapshot = yield* waitFor(
              client.session.getSnapshot({
                sessionId: first.sessionId,
                branchId: first.branchId,
              }),
              (current) =>
                current.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.parts.some((part) => part.type === "text" && part.text === finalReply),
                ),
              5_000,
              "assistant reply after stored interaction decision recovery",
            )

            expect(
              snapshot.messages.some(
                (message) =>
                  message.role === "tool" &&
                  message.parts.some(
                    (part) =>
                      part.type === "tool-result" &&
                      encodeJson(part.result).includes("stored before wake"),
                  ),
              ),
            ).toBe(true)
          }).pipe(Effect.timeout("8 seconds")),
        )
      }),
    12_000,
  )

  it.live(
    "rejects stale request ids without consuming the pending interaction",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const finalReply = "approval resumed after stale response"
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("approval_probe", { text: "approve deploy?" }),
            textStep(finalReply),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [InteractionProbeExtension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const interactionFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )

          yield* client.message.send({
            sessionId,
            branchId,
            content: "run approval probe",
          })

          const interactions = Array.from(yield* Fiber.join(interactionFiber))
          const presented = interactions[0]?.event
          expect(presented?._tag).toBe("InteractionPresented")
          if (presented?._tag !== "InteractionPresented") return

          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "WaitingForInteraction",
            5_000,
            "waiting interaction runtime state before stale response",
          )

          const staleExit = yield* Effect.exit(
            client.interaction.respondInteraction({
              sessionId,
              branchId,
              requestId: InteractionRequestId.make("req-stale-rpc-1"),
              approved: false,
              notes: "wrong dialog",
            }),
          )
          expect(staleExit._tag).toBe("Failure")
          if (staleExit._tag === "Failure") {
            expect(Cause.pretty(staleExit.cause)).toContain("InteractionRequestMismatchError")
          }

          const parked = yield* client.session.getSnapshot({ sessionId, branchId })
          expect(parked.runtime._tag).toBe("WaitingForInteraction")

          yield* client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: presented.requestId,
            approved: true,
            notes: "real approval",
          })

          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === finalReply),
              ),
            5_000,
            "assistant reply after correct interaction response",
          )

          expect(
            snapshot.messages.some(
              (message) =>
                message.role === "tool" &&
                message.parts.some(
                  (part) =>
                    part.type === "tool-result" &&
                    encodeJson(part.result).includes("real approval"),
                ),
            ),
          ).toBe(true)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "an extension's turn asks in a top-level session and declines in a spawned child; a client's turn and slash command in the child ask, and no client or extension forges the origin",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("approval_probe", { text: "approve in the top-level session?" }),
            textStep("top-level wake done"),
            toolCallStep("approval_probe", { text: "approve from the parent's nudge?" }),
            textStep("child nudge done"),
            toolCallStep("approval_probe", { text: "approve from the child's slash command?" }),
            textStep("child command done"),
            toolCallStep("approval_probe", { text: "approve from a request that ended?" }),
            textStep("late send done"),
            toolCallStep("approval_probe", { text: "approve from the client's steer?" }),
            textStep("child steer done"),
            toolCallStep("approval_probe", { text: "approve from the child's user?" }),
            textStep("child user done"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [makeOriginProbe()],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const origin = originClient(client)
          const top = yield* client.session.create({ cwd: "/tmp" })
          const child = yield* client.session.create({
            cwd: "/tmp",
            parentSessionId: top.sessionId,
            parentBranchId: top.branchId,
          })
          const opening = (messages: ReadonlyArray<Message>, label: string) =>
            messages.find((message) =>
              message.parts.some((part) => part.type === "text" && part.text === label),
            )

          // A top-level session's user watches its extension turns: a wake
          // or a child's completion there asks.
          yield* origin.approves(
            top,
            origin.call("nudge", child, { label: "wake the parent", ...top }),
            "approve in the top-level session?",
            "top-level wake done",
          )

          // In the spawned child, an extension turn declines at once. The
          // parent's request sends into another session, so its claimed
          // client origin is removed.
          const nudged = yield* origin.declines(
            child,
            origin.call("nudge", top, { label: "the parent's nudge", ...child }),
            "child nudge done",
          )
          expect(opening(nudged, "the parent's nudge")?.metadata?.extensionId).toBe(originProbeId)
          expect(opening(nudged, "the parent's nudge")?.metadata?.fromClient).toBeUndefined()
          expect(toolResultTexts(nudged).at(-1)).toContain("no user started this turn")

          // A slash command the user runs in the child sends to the child's
          // own branch as that user: its turn asks.
          yield* origin.approves(
            child,
            origin.call("nudge", child, { label: "/plan in the child" }),
            "approve from the child's slash command?",
            "child command done",
          )
          const commanded = opening(
            (yield* client.session.getSnapshot(child)).messages,
            "/plan in the child",
          )
          expect(commanded?.metadata).toMatchObject({
            fromClient: true,
            extensionId: originProbeId,
          })

          // The grant ends with the request: a context kept past it sends to
          // the same branch as an extension, and the turn declines.
          yield* origin.call("arm", child, {})
          const late = yield* origin.declines(
            child,
            origin.call("fire", top, { label: "a send after the request ended" }),
            "late send done",
          )
          expect(
            opening(late, "a send after the request ended")?.metadata?.fromClient,
          ).toBeUndefined()
          expect(toolResultTexts(late).at(-1)).toContain("no user started this turn")

          // A client's steer that claims an extension author and denies its
          // own origin still carries the server's client origin: it asks.
          yield* origin.approves(
            child,
            client.steer.command({
              command: {
                _tag: "Interject",
                ...child,
                requestId: RequestId.make("forged-origin"),
                message: "steer the child",
                metadata: { extensionId: originProbeId, fromClient: false },
                wake: true,
              },
            }),
            "approve from the client's steer?",
            "child steer done",
          )
          const steered = opening(
            (yield* client.session.getSnapshot(child)).messages,
            "steer the child",
          )
          expect(steered?.metadata).toMatchObject({ fromClient: true })
          expect(steered?.metadata?.extensionId).toBeUndefined()

          // A user's prompt in the child asks.
          yield* origin.approves(
            child,
            client.message.send({ ...child, content: "run the probe" }),
            "approve from the child's user?",
            "child user done",
          )
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a slash command's steer in a spawned child asks while the request runs; a steer from a context kept past it declines",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("approval_probe", { text: "approve from the child's slash steer?" }),
            textStep("child steer command done"),
            toolCallStep("approval_probe", { text: "approve from a steer that outlived it?" }),
            textStep("late steer done"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [makeOriginProbe()],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const origin = originClient(client)
          const top = yield* client.session.create({ cwd: "/tmp" })
          const child = yield* client.session.create({
            cwd: "/tmp",
            parentSessionId: top.sessionId,
            parentBranchId: top.branchId,
          })
          const opening = (messages: ReadonlyArray<Message>, label: string) =>
            messages.find((message) =>
              message.parts.some((part) => part.type === "text" && part.text === label),
            )

          // The steer is admitted before the request ends, so it keeps the
          // client origin of the user who typed the command.
          yield* origin.approves(
            child,
            origin.call("nudge", child, {
              label: "/steer in the child",
              steer: true,
              requestId: RequestId.make("slash-steer"),
            }),
            "approve from the child's slash steer?",
            "child steer command done",
          )
          const commanded = opening(
            (yield* client.session.getSnapshot(child)).messages,
            "/steer in the child",
          )
          expect(commanded?.metadata).toMatchObject({
            fromClient: true,
            extensionId: originProbeId,
          })

          // The same request id again is a no-op: the steer already ran.
          yield* origin.call("nudge", child, {
            label: "/steer in the child",
            steer: true,
            requestId: RequestId.make("slash-steer"),
          })
          const repeated = yield* client.session.getSnapshot(child)
          expect(
            repeated.messages.filter((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text === "/steer in the child",
              ),
            ),
          ).toHaveLength(1)
          expect(repeated.runtime._tag).toBe("Idle")

          // A context kept past its request steers as an extension.
          yield* origin.call("arm", child, {})
          const late = yield* origin.declines(
            child,
            origin.call("fire", top, { label: "a steer after the request ended", steer: true }),
            "late steer done",
          )
          expect(
            opening(late, "a steer after the request ended")?.metadata?.fromClient,
          ).toBeUndefined()
          expect(toolResultTexts(late).at(-1)).toContain("no user started this turn")
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a handoff session's extension and slash-command turns ask and keep interactive tools, and so do a second handoff's",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("handoff_probe", { text: "hand off again from the wake?" }),
            textStep("handoff wake done"),
            toolCallStep("handoff_probe", { text: "hand off again from the command?" }),
            textStep("handoff command done"),
            toolCallStep("approval_probe", { text: "approve in the second handoff?" }),
            textStep("second handoff wake done"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [makeOriginProbe()],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const origin = originClient(client)
          const top = yield* client.session.create({ cwd: "/tmp" })
          const handoff = yield* client.session.create({
            cwd: "/tmp",
            parentSessionId: top.sessionId,
            parentBranchId: top.branchId,
            continueThread: true,
          })
          // A wake, a monitor or a child's completion reaches the handoff
          // from outside any request a client made to it.
          yield* origin.approves(
            handoff,
            origin.call("nudge", top, { label: "wake the handoff", ...handoff }),
            "hand off again from the wake?",
            "handoff wake done",
          )
          // A workflow slash command runs as a request on the handoff itself.
          yield* origin.approves(
            handoff,
            origin.call("nudge", handoff, { label: "/handoff in the handoff" }),
            "hand off again from the command?",
            "handoff command done",
          )
          // A handoff of a handoff is still the user's own conversation.
          const second = yield* client.session.create({
            cwd: "/tmp",
            parentSessionId: handoff.sessionId,
            parentBranchId: handoff.branchId,
            continueThread: true,
          })
          yield* origin.approves(
            second,
            origin.call("nudge", top, { label: "wake the second handoff", ...second }),
            "approve in the second handoff?",
            "second handoff wake done",
          )
        }).pipe(Effect.timeout("12 seconds")),
      ),
    15_000,
  )

  it.live(
    "a client or an extension cannot mark its message as the loop's: joinedTurn and a runtime custom type are removed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            textStep("steer answered"),
            textStep("runtime-typed nudge answered"),
            textStep("custom nudge answered"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [makeOriginProbe()] }),
          )
          const origin = originClient(client)
          const top = yield* client.session.create({ cwd: "/tmp" })
          const stored = (label: string) =>
            client.session
              .getSnapshot(top)
              .pipe(
                Effect.map((snapshot) =>
                  snapshot.messages.find((message) =>
                    message.parts.some((part) => part.type === "text" && part.text === label),
                  ),
                ),
              )

          // A client owns neither mark.
          yield* client.steer.command({
            command: {
              _tag: "Interject",
              ...top,
              requestId: RequestId.make("forged-marks"),
              message: "a steer marked as the loop's",
              metadata: { joinedTurn: true, customType: "continuation" },
              wake: true,
            },
          })
          yield* waitForReply({ client, ...top, reply: "steer answered" })
          const steered = yield* stored("a steer marked as the loop's")
          expect(steered?.metadata?.fromClient).toBe(true)
          expect(steered?.metadata?.joinedTurn).toBeUndefined()
          expect(steered?.metadata?.customType).toBeUndefined()

          // An extension owns its custom types, never the loop's marks.
          yield* origin.call("nudge", top, {
            label: "a nudge marked as the loop's",
            joinedTurn: true,
            customType: "continuation",
          })
          yield* waitForReply({ client, ...top, reply: "runtime-typed nudge answered" })
          const runtimeTyped = yield* stored("a nudge marked as the loop's")
          expect(runtimeTyped?.metadata?.extensionId).toBe(originProbeId)
          expect(runtimeTyped?.metadata?.joinedTurn).toBeUndefined()
          expect(runtimeTyped?.metadata?.customType).toBeUndefined()

          yield* origin.call("nudge", top, { label: "a custom nudge", customType: "probe-row" })
          yield* waitForReply({ client, ...top, reply: "custom nudge answered" })
          expect((yield* stored("a custom nudge"))?.metadata?.customType).toBe("probe-row")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a child turn stored before the client origin existed declines its approval on recovery",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("approval_probe", { text: "approve after the upgrade?" }),
            textStep("recovered child done"),
          ])
          const context = yield* Layer.build(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [InteractionProbeExtension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { client } = yield* createRpcClient(Layer.succeedContext(context))
          const top = yield* client.session.create({ cwd: "/tmp" })
          const child = yield* client.session.create({
            cwd: "/tmp",
            parentSessionId: top.sessionId,
            parentBranchId: top.branchId,
          })
          // What an older build left for the child: its prompt stored with no
          // origin, and the queue row holding it in flight beside the retired
          // `interactive: false`.
          const legacyMessage = {
            _tag: "regular",
            id: "legacy-in-flight",
            sessionId: child.sessionId,
            branchId: child.branchId,
            role: "user",
            parts: [{ options: {}, type: "text", text: "run the probe" }],
            createdAt: 1767225600000,
          }
          const legacyQueueJson = encodeJson({
            steering: [],
            followUp: [],
            inFlight: { message: legacyMessage, interactive: false },
          })
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            const rows = yield* sql<{
              readonly workspace_id: string
            }>`SELECT workspace_id FROM sessions WHERE id = ${child.sessionId}`
            const workspaceId = WorkspaceId.make(rows[0]?.workspace_id ?? "")
            yield* (yield* MessageStorage)
              .createMessage(yield* Schema.decodeUnknownEffect(Message)(legacyMessage))
              .pipe(Effect.provideService(CurrentWorkspaceId, workspaceId))
            yield* sql`INSERT INTO agent_loop_queues (workspace_id, session_id, branch_id, queue_json, updated_at) VALUES (${workspaceId}, ${child.sessionId}, ${child.branchId}, ${legacyQueueJson}, ${1767225600000})`
          }).pipe(Effect.provideContext(context))
          // Opening the loop recovers the turn; its approval declines at once.
          const recovered = yield* waitFor(
            client.session.getSnapshot(child),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some((message) =>
                message.parts.some(
                  (part) => part.type === "text" && part.text === "recovered child done",
                ),
              ),
            5_000,
            "the recovered child turn ended without a dialog",
          )
          const [declined] = toolResultTexts(recovered.messages)
          expect(declined).toContain('"approved":false')
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a retried reply after the call took its answer succeeds; a changed one conflicts",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const finalReply = "approval taken before the retry"
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("approval_probe", { text: "approve deploy?" }),
            textStep(finalReply),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [InteractionProbeExtension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const presented = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* client.message.send({ sessionId, branchId, content: "run approval probe" })
          const event = Array.from(yield* Fiber.join(presented))[0]?.event
          if (event?._tag !== "InteractionPresented") return yield* Effect.die("no dialog")
          const reply = { sessionId, branchId, requestId: event.requestId, approved: true }
          yield* client.interaction.respondInteraction(reply)
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === finalReply),
              ),
            5_000,
            "the call took the answer and the turn ended",
          )
          // A client that resends its reply is told it landed.
          yield* client.interaction.respondInteraction(reply)
          const changed = yield* Effect.flip(
            client.interaction.respondInteraction({ ...reply, approved: false }),
          )
          expect(changed._tag).toBe("InteractionDecisionConflictError")
          // The same reply named on another branch is not a retry: that branch never asked.
          const other = yield* client.session.create({ cwd: "/tmp" })
          const misaddressed = yield* Effect.flip(
            client.interaction.respondInteraction({ ...reply, ...other }),
          )
          expect(misaddressed._tag).toBe("InteractionRequestMismatchError")
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "a retried reply whose first attempt stored the answer but never woke the loop finishes the turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const finalReply = "approval reached the loop on the retry"
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("approval_probe", { text: "approve deploy?" }),
            textStep(finalReply),
          ])
          // The first reply stores its answer, then fails before the handler
          // wakes the loop or publishes the resolution: a dropped socket or a
          // failed actor send leaves exactly this state.
          const failAfterFirstStore = Layer.effect(
            ApprovalService,
            Effect.gen(function* () {
              const live = yield* ApprovalService
              const failed = MutableRef.make(false)
              return ApprovalService.of({
                ...live,
                storeResolution: (branch, requestId, decision) =>
                  live.storeResolution(branch, requestId, decision).pipe(
                    Effect.tap(() => {
                      if (MutableRef.get(failed)) return Effect.void
                      MutableRef.set(failed, true)
                      return Effect.fail(new EventStoreError({ message: "reply lost after store" }))
                    }),
                  ),
              })
            }),
          ).pipe(Layer.provide(ApprovalService.Live))
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [InteractionProbeExtension],
              approvalLayer: failAfterFirstStore,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const isDialogEvent = Predicate.or(
            Predicate.isTagged("InteractionPresented"),
            Predicate.isTagged("InteractionResolved"),
          )
          const dialog = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => isDialogEvent(envelope.event)),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkScoped,
          )
          const presented = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* client.message.send({ sessionId, branchId, content: "run approval probe" })
          const event = Array.from(yield* Fiber.join(presented))[0]?.event
          if (event?._tag !== "InteractionPresented") return yield* Effect.die("no dialog")
          const reply = { sessionId, branchId, requestId: event.requestId, approved: true }
          const lost = yield* Effect.exit(client.interaction.respondInteraction(reply))
          expect(lost._tag).toBe("Failure")
          // The client retries the same reply; it must do the work the first one missed.
          yield* client.interaction.respondInteraction(reply)
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some((part) => part.type === "text" && part.text === finalReply),
              ),
            5_000,
            "the retried reply woke the loop and the turn ended",
          )
          // The dialog closes for every client.
          const tags = Array.from(yield* Fiber.join(dialog)).map((envelope) => envelope.event._tag)
          expect(tags).toEqual(["InteractionPresented", "InteractionResolved"])
        }).pipe(Effect.timeout("8 seconds")),
      ),
    10_000,
  )

  it.live(
    "two guarded calls in one step ask one at a time and each gets its own answer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const EchoApprovalExtension: LoadedExtension = {
            manifest: { id: ExtensionId.make("@test/echo-approval") },
            scope: "builtin",
            sourcePath: "test",
            artifactIdentity: LoadedArtifactIdentity.make("@test/echo-approval@artifact-1"),
            contributions: {
              tools: [
                tool({
                  id: "echo_approval",
                  description: "Ask approval and echo the question with its answer",
                  params: Schema.Struct({ text: Schema.String }),
                  output: Schema.Struct({ answer: Schema.String }),
                  execute: Effect.fn("echo_approval")(function* (params) {
                    const ctx = yield* ExtensionContext
                    const decision = yield* ctx.Interaction.approve({ text: params.text })
                    return { answer: `${params.text}=${String(decision.notes)}` }
                  }),
                }),
              ],
            },
          }
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            multiToolCallStep(
              { toolName: "echo_approval", input: { text: "FIRST" } },
              { toolName: "echo_approval", input: { text: "SECOND" } },
            ),
            textStep("both answered"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [EchoApprovalExtension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const presentedFiber = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filterMap((envelope) => {
              if (envelope.event._tag === "InteractionPresented")
                return Result.succeed(envelope.event)
              return Result.failVoid
            }),
            Stream.take(2),
            // Each dialog is answered only after it shows; the second waits for the first.
            Stream.mapEffect((presented) =>
              Effect.gen(function* () {
                yield* waitFor(
                  client.session.getSnapshot({ sessionId, branchId }),
                  (current) => current.runtime._tag === "WaitingForInteraction",
                  5_000,
                  `parked on ${presented.text}`,
                )
                yield* client.interaction.respondInteraction({
                  sessionId,
                  branchId,
                  requestId: presented.requestId,
                  approved: true,
                  notes: `answer-${presented.text}`,
                })
                return presented.text
              }),
            ),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* client.message.send({ sessionId, branchId, content: "ask twice" })
          const seen = Array.from(yield* Fiber.join(presentedFiber))
          expect([...seen].sort()).toEqual(["FIRST", "SECOND"])

          const snapshot = yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) =>
              current.runtime._tag === "Idle" &&
              current.messages.some(
                (message) =>
                  message.role === "assistant" &&
                  message.parts.some(
                    (part) => part.type === "text" && part.text === "both answered",
                  ),
              ),
            5_000,
            "turn completes after both answers",
          )
          const results = snapshot.messages.flatMap((message) =>
            message.parts.flatMap((part) => {
              if (part.type === "tool-result") return [encodeJson(part.result)]
              return []
            }),
          )
          expect(results.some((result) => result.includes("FIRST=answer-FIRST"))).toBe(true)
          expect(results.some((result) => result.includes("SECOND=answer-SECOND"))).toBe(true)
          expect(results.some((result) => result.includes("Failed to persist"))).toBe(false)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a call that skips approval when its step runs again does not hold the call queued behind it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const aPresented = yield* Deferred.make<void>()
          const extension = orderedApprovalExtension((params, attempt) =>
            Effect.gen(function* () {
              if (params.label === "A" && attempt > 1) return "A=skipped"
              if (params.label === "B" && attempt === 1) yield* Deferred.await(aPresented)
              return yield* approveAs(params)
            }),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            multiToolCallStep(
              { toolName: "ordered_approval", input: { label: "A", text: "Deploy A?" } },
              { toolName: "ordered_approval", input: { label: "B", text: "Deploy B?" } },
            ),
            textStep("both settled"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [extension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const answered = yield* answerInOrder({
            client,
            sessionId,
            branchId,
            answers: ["one", "two"],
            presented: aPresented,
          }).pipe(Effect.forkScoped)
          yield* client.message.send({ sessionId, branchId, content: "ask twice" })
          expect(Array.from(yield* Fiber.join(answered))).toEqual(["Deploy A?", "Deploy B?"])
          const snapshot = yield* waitForReply({
            client,
            sessionId,
            branchId,
            reply: "both settled",
          })
          const results = toolResultTexts(snapshot.messages)
          expect(results.some((result) => result.includes("A=skipped"))).toBe(true)
          expect(results.some((result) => result.includes("B=two"))).toBe(true)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "two calls asking the same question each get their own answer when the second asks again first",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const aPresented = yield* Deferred.make<void>()
          const bAskedAgain = yield* Deferred.make<void>()
          const extension = orderedApprovalExtension((params, attempt) =>
            Effect.gen(function* () {
              if (params.label === "A" && attempt === 2) {
                // B asks first when the step runs again.
                yield* Deferred.await(bAskedAgain)
                yield* Effect.yieldNow
                yield* Effect.yieldNow
              }
              if (params.label === "B" && attempt === 1) yield* Deferred.await(aPresented)
              if (params.label === "B" && attempt === 2)
                yield* Deferred.completeWith(bAskedAgain, Effect.void)
              return yield* approveAs(params)
            }),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            multiToolCallStep(
              { toolName: "ordered_approval", input: { label: "A", text: "Proceed?" } },
              { toolName: "ordered_approval", input: { label: "B", text: "Proceed?" } },
            ),
            textStep("both answered"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [extension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const answered = yield* answerInOrder({
            client,
            sessionId,
            branchId,
            answers: ["one", "two"],
            presented: aPresented,
          }).pipe(Effect.forkScoped)
          yield* client.message.send({ sessionId, branchId, content: "ask the same twice" })
          yield* Fiber.join(answered)
          const snapshot = yield* waitForReply({
            client,
            sessionId,
            branchId,
            reply: "both answered",
          })
          const results = toolResultTexts(snapshot.messages)
          expect(results.some((result) => result.includes("A=one"))).toBe(true)
          expect(results.some((result) => result.includes("B=two"))).toBe(true)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a request its owner rejects leaves the open request answerable",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const aPresented = yield* Deferred.make<void>()
          const extension = orderedApprovalExtension((params) =>
            Effect.gen(function* () {
              if (params.label === "A") return yield* approveAs(params)
              yield* Deferred.await(aPresented)
              return yield* approveThroughRejectingOwner(params)
            }),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            multiToolCallStep(
              { toolName: "ordered_approval", input: { label: "A", text: "Deploy?" } },
              { toolName: "ordered_approval", input: { label: "C", text: "Also deploy?" } },
            ),
            textStep("native answered"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [extension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const answered = yield* answerInOrder({
            client,
            sessionId,
            branchId,
            answers: ["yes"],
            presented: aPresented,
          }).pipe(Effect.forkScoped)
          yield* client.message.send({ sessionId, branchId, content: "ask natively and owned" })
          expect(Array.from(yield* Fiber.join(answered))).toEqual(["Deploy?"])
          const snapshot = yield* waitForReply({
            client,
            sessionId,
            branchId,
            reply: "native answered",
          })
          const results = toolResultTexts(snapshot.messages)
          expect(results.some((result) => result.includes("A=yes"))).toBe(true)
          expect(results.some((result) => result.includes("C=rejected"))).toBe(true)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.scopedLive(
    "after a restart a request its owner rejects leaves the recovered request answerable",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-interaction-")
        const dbPath = `${tempDir}/gent-owner.db`
        const aPresented = yield* Deferred.make<void>()
        const extension = orderedApprovalExtension((params, attempt) =>
          Effect.gen(function* () {
            // After the restart, C's inner call waits for the slot while A,
            // which still runs, takes its answer; C's owner then refuses its
            // request, and A's answer is not touched.
            if (params.label === "A") return yield* approveAs(params)
            if (attempt === 1) {
              yield* Deferred.await(aPresented)
              return yield* approveAs(params)
            }
            return yield* approveThroughRejectingOwner(params)
          }),
        )
        const firstProvider = yield* LanguageModelLayers.sequence([
          multiToolCallStep(
            { toolName: "ordered_approval", input: { label: "A", text: "Deploy?" } },
            { toolName: "ordered_approval", input: { label: "C", text: "Also deploy?" } },
          ),
        ])
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: firstProvider.layer,
                extensions: [extension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            const presentedFiber = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.filterMap((envelope) => {
                if (envelope.event._tag === "InteractionPresented")
                  return Result.succeed(envelope.event)
                return Result.failVoid
              }),
              Stream.take(1),
              Stream.tap(() => Deferred.completeWith(aPresented, Effect.void)),
              Stream.runCollect,
              Effect.forkScoped,
            )
            yield* client.message.send({ sessionId, branchId, content: "ask natively twice" })
            const presented = Array.from(yield* Fiber.join(presentedFiber))
            expect(presented.map((event) => event.text)).toEqual(["Deploy?"])
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (current) => current.runtime._tag === "WaitingForInteraction",
              5_000,
              "parked on the first request before restart",
            )
            const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
            return {
              sessionId,
              branchId,
              requestId: presented[0]!.requestId,
              lastEventId: snapshot.lastEventId ?? 0,
            }
          }).pipe(Effect.timeout("8 seconds")),
        )

        const secondProvider = yield* LanguageModelLayers.sequence([
          textStep("recovered request answered"),
        ])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: secondProvider.layer,
                extensions: [extension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )
            const rehydrated = Array.from(
              yield* client.session
                .events({
                  sessionId: first.sessionId,
                  branchId: first.branchId,
                  after: first.lastEventId,
                })
                .pipe(
                  Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
                  Stream.take(1),
                  Stream.runCollect,
                ),
            )
            expect(rehydrated.length).toBe(1)
            yield* client.interaction.respondInteraction({
              sessionId: first.sessionId,
              branchId: first.branchId,
              requestId: first.requestId,
              approved: true,
              notes: "after restart",
            })
            const snapshot = yield* waitForReply({
              client,
              sessionId: first.sessionId,
              branchId: first.branchId,
              reply: "recovered request answered",
            })
            const results = toolResultTexts(snapshot.messages)
            expect(results.some((result) => result.includes("A=after restart"))).toBe(true)
            expect(results.some((result) => result.includes("C=rejected"))).toBe(true)
          }).pipe(Effect.timeout("8 seconds")),
        )
      }),
    20_000,
  )

  it.live(
    "calls queued behind an open request ask in the order they queued",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const aPresented = yield* Deferred.make<void>()
          const cParked = yield* Deferred.make<void>()
          const bAskedAgain = yield* Deferred.make<void>()
          const extension = orderedApprovalExtension((params, attempt) =>
            Effect.gen(function* () {
              if (params.label === "C" && attempt === 1) {
                yield* Deferred.await(aPresented)
                return yield* approveAs(params).pipe(
                  Effect.ensuring(Deferred.completeWith(cParked, Effect.void)),
                )
              }
              if (params.label === "C" && attempt === 2) {
                // B looks for its turn first when the step runs again.
                yield* Deferred.await(bAskedAgain)
                yield* Effect.yieldNow
                yield* Effect.yieldNow
              }
              if (params.label === "B" && attempt === 1) yield* Deferred.await(cParked)
              if (params.label === "B" && attempt === 2)
                yield* Deferred.completeWith(bAskedAgain, Effect.void)
              return yield* approveAs(params)
            }),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            multiToolCallStep(
              { toolName: "ordered_approval", input: { label: "A", text: "Deploy A?" } },
              { toolName: "ordered_approval", input: { label: "B", text: "Deploy B?" } },
              { toolName: "ordered_approval", input: { label: "C", text: "Deploy C?" } },
            ),
            textStep("all answered"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [extension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const answered = yield* answerInOrder({
            client,
            sessionId,
            branchId,
            answers: ["one", "two", "three"],
            presented: aPresented,
          }).pipe(Effect.forkScoped)
          yield* client.message.send({ sessionId, branchId, content: "ask three times" })
          expect(Array.from(yield* Fiber.join(answered))).toEqual([
            "Deploy A?",
            "Deploy C?",
            "Deploy B?",
          ])
          const snapshot = yield* waitForReply({
            client,
            sessionId,
            branchId,
            reply: "all answered",
          })
          const results = toolResultTexts(snapshot.messages)
          expect(results.some((result) => result.includes("A=one"))).toBe(true)
          expect(results.some((result) => result.includes("C=two"))).toBe(true)
          expect(results.some((result) => result.includes("B=three"))).toBe(true)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.scopedLive(
    "an answer its call does not take is settled when the call ends",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-interaction-")
        const dbPath = `${tempDir}/gent-untaken.db`
        const presented = yield* Deferred.make<void>()
        const extension = orderedApprovalExtension((params, attempt) => {
          if (attempt > 1) return Effect.succeed(`${params.label}=skipped`)
          return approveAs(params)
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("ordered_approval", { label: "A", text: "Deploy?" }),
          textStep("skipped"),
        ])
        const session = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer,
                extensions: [extension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            const answered = yield* answerInOrder({
              client,
              sessionId,
              branchId,
              answers: ["yes"],
              presented,
            }).pipe(Effect.forkScoped)
            yield* client.message.send({ sessionId, branchId, content: "ask once" })
            yield* Fiber.join(answered)
            const snapshot = yield* waitForReply({ client, sessionId, branchId, reply: "skipped" })
            expect(
              toolResultTexts(snapshot.messages).some((result) => result.includes("A=skipped")),
            ).toBe(true)
            return { sessionId, branchId }
          }).pipe(Effect.timeout("8 seconds")),
        )
        const pending = yield* Effect.gen(function* () {
          return yield* (yield* InteractionStorage).listOpen(session)
        }).pipe(
          Effect.provide(
            SqliteStorage.LiveWithSql(dbPath, () => Layer.empty, {}).pipe(
              Layer.provide(BunPlatformLive),
            ),
          ),
          Effect.provideService(CurrentWorkspaceId, currentTestWorkspaceId()),
        )
        expect(pending).toEqual([])
      }),
    12_000,
  )

  it.scopedLive(
    "after a restart an answer goes to the call that asked, not to one asking the same question",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-interaction-")
        const dbPath = `${tempDir}/gent-same-question.db`
        const aPresented = yield* Deferred.make<void>()
        const extension = orderedApprovalExtension((params, attempt) =>
          Effect.gen(function* () {
            // A no longer asks once its step runs again; B asks the same question.
            if (params.label === "A" && attempt > 1) return "A=skipped"
            if (params.label === "B" && attempt === 1) yield* Deferred.await(aPresented)
            return yield* approveAs(params)
          }),
        )
        const firstProvider = yield* LanguageModelLayers.sequence([
          multiToolCallStep(
            { toolName: "ordered_approval", input: { label: "A", text: "Proceed?" } },
            { toolName: "ordered_approval", input: { label: "B", text: "Proceed?" } },
          ),
        ])
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: firstProvider.layer,
                extensions: [extension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            const presentedFiber = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
              Stream.take(1),
              Stream.tap(() => Deferred.completeWith(aPresented, Effect.void)),
              Stream.runCollect,
              Effect.forkScoped,
            )
            yield* client.message.send({ sessionId, branchId, content: "ask the same twice" })
            yield* Fiber.join(presentedFiber)
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (current) => current.runtime._tag === "WaitingForInteraction",
              5_000,
              "parked on the first request before restart",
            )
            const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
            return { sessionId, branchId, lastEventId: snapshot.lastEventId ?? 0 }
          }).pipe(Effect.timeout("8 seconds")),
        )

        const secondProvider = yield* LanguageModelLayers.sequence([textStep("both answered")])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(
              createE2ELayer({
                ...e2ePreset,
                providerLayer: secondProvider.layer,
                extensions: [extension],
                durableApproval: true,
                storagePath: dbPath,
              }),
            )
            const answered = yield* answerInOrder({
              client,
              sessionId: first.sessionId,
              branchId: first.branchId,
              answers: ["one", "two"],
              presented: aPresented,
              after: first.lastEventId,
            }).pipe(Effect.forkScoped)
            yield* Fiber.join(answered)
            const snapshot = yield* waitForReply({
              client,
              sessionId: first.sessionId,
              branchId: first.branchId,
              reply: "both answered",
            })
            const results = toolResultTexts(snapshot.messages)
            expect(results.some((result) => result.includes("A=skipped"))).toBe(true)
            expect(results.some((result) => result.includes("B=two"))).toBe(true)
          }).pipe(Effect.timeout("8 seconds")),
        )
      }),
    20_000,
  )

  it.live(
    "an answer sent while a sibling call still runs resumes the turn",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const answered = yield* Deferred.make<void>()
          // The sibling runs until the answer is in, so the step is still
          // running when the answer arrives, as it is in headless mode.
          const extension = orderedApprovalExtension((params) =>
            Effect.gen(function* () {
              if (params.label === "slow") {
                yield* Deferred.await(answered)
                return "slow=done"
              }
              return yield* approveAs(params)
            }),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            multiToolCallStep(
              { toolName: "ordered_approval", input: { label: "ask", text: "Proceed?" } },
              { toolName: "ordered_approval", input: { label: "slow", text: "unused" } },
            ),
            textStep("sibling done"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [extension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          // Answer the moment the dialog shows, before the branch parks.
          yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filterMap((envelope) => {
              if (envelope.event._tag === "InteractionPresented")
                return Result.succeed(envelope.event)
              return Result.failVoid
            }),
            Stream.take(1),
            Stream.runForEach((presented) =>
              client.interaction
                .respondInteraction({
                  sessionId,
                  branchId,
                  requestId: presented.requestId,
                  approved: true,
                  notes: "early",
                })
                .pipe(Effect.andThen(Deferred.completeWith(answered, Effect.void))),
            ),
            Effect.forkScoped,
          )
          yield* client.message.send({ sessionId, branchId, content: "ask beside slow work" })
          const snapshot = yield* waitForReply({
            client,
            sessionId,
            branchId,
            reply: "sibling done",
          }).pipe(Effect.timeout("5 seconds"))
          const results = toolResultTexts(snapshot.messages)
          expect(results.some((result) => result.includes("ask=early"))).toBe(true)
          expect(results.some((result) => result.includes("slow=done"))).toBe(true)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    12_000,
  )

  it.live(
    "the first answer wins: a different second reply is refused and the call gets the first",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The resumed call waits before it asks again, so both replies
          // land while the request is still open with its first answer.
          const resumeGate = yield* Deferred.make<void>()
          const extension = orderedApprovalExtension((params, attempt) =>
            Effect.gen(function* () {
              if (attempt > 1) yield* Deferred.await(resumeGate)
              const ctx = yield* ExtensionContext
              const decision = yield* ctx.Interaction.approve({ text: params.text })
              return `approved=${String(decision.approved)}`
            }),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("ordered_approval", { label: "X", text: "Run it?" }),
            textStep("answered once"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [extension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const presented = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filterMap((envelope) => {
              if (envelope.event._tag === "InteractionPresented")
                return Result.succeed(envelope.event)
              return Result.failVoid
            }),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          )
          yield* client.message.send({ sessionId, branchId, content: "ask once" })
          const request = Array.from(yield* Fiber.join(presented))[0]
          if (Predicate.isUndefined(request)) return yield* Effect.die("Missing dialog")
          const reply = (approved: boolean) =>
            client.interaction.respondInteraction({
              sessionId,
              branchId,
              requestId: request.requestId,
              approved,
            })
          yield* reply(false)
          const conflict = yield* Effect.flip(reply(true))
          expect(conflict._tag).toBe("InteractionDecisionConflictError")
          // A retried reply with the same answer is accepted.
          yield* reply(false)
          yield* Deferred.completeWith(resumeGate, Effect.void)
          const snapshot = yield* waitForReply({
            client,
            sessionId,
            branchId,
            reply: "answered once",
          }).pipe(Effect.timeout("5 seconds"))
          const results = toolResultTexts(snapshot.messages)
          expect(results.some((result) => result.includes("approved=false"))).toBe(true)
          expect(results.some((result) => result.includes("approved=true"))).toBe(false)
          const resolved = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.takeUntil((envelope) => envelope.event._tag === "TurnCompleted"),
            Stream.filterMap((envelope) => {
              if (envelope.event._tag === "InteractionResolved")
                return Result.succeed(envelope.event)
              return Result.failVoid
            }),
            Stream.runCollect,
          )
          // The retry came while the answer was untaken, so it published the
          // resolution again; every copy carries the first answer.
          expect(Array.from(resolved).map((event) => [event.requestId, event.approved])).toEqual([
            [request.requestId, false],
            [request.requestId, false],
          ])
        }).pipe(Effect.timeout("8 seconds")),
      ),
    12_000,
  )

  it.live(
    "a sibling that asks after the first answer came leaves that answer to its call",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstAnswered = yield* Deferred.make<void>()
          // `late` asks only after the answer to `early` is in, while the step
          // still runs. `early` parked on its question and no longer runs.
          const extension = orderedApprovalExtension((params) =>
            Effect.gen(function* () {
              if (params.label === "late") yield* Deferred.await(firstAnswered)
              return yield* approveAs(params)
            }),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            multiToolCallStep(
              { toolName: "ordered_approval", input: { label: "early", text: "First?" } },
              { toolName: "ordered_approval", input: { label: "late", text: "Second?" } },
            ),
            textStep("both answered"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [extension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          // Answer each dialog the moment it shows, without waiting for a park.
          const answers = new Map([
            ["First?", "one"],
            ["Second?", "two"],
          ])
          yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filterMap((envelope) => {
              if (envelope.event._tag === "InteractionPresented")
                return Result.succeed(envelope.event)
              return Result.failVoid
            }),
            Stream.runForEach((presented) =>
              client.interaction
                .respondInteraction({
                  sessionId,
                  branchId,
                  requestId: presented.requestId,
                  approved: true,
                  notes: Option.getOrElse(
                    Option.fromUndefinedOr(answers.get(presented.text)),
                    () => "unexpected",
                  ),
                })
                .pipe(Effect.andThen(Deferred.completeWith(firstAnswered, Effect.void))),
            ),
            Effect.forkScoped,
          )
          yield* client.message.send({ sessionId, branchId, content: "two calls ask" })
          const snapshot = yield* waitForReply({
            client,
            sessionId,
            branchId,
            reply: "both answered",
          }).pipe(Effect.timeout("5 seconds"))
          const results = toolResultTexts(snapshot.messages)
          expect(results.some((result) => result.includes("early=one"))).toBe(true)
          expect(results.some((result) => result.includes("late=two"))).toBe(true)
        }).pipe(Effect.timeout("8 seconds")),
      ),
    12_000,
  )

  it.live(
    "a call that asks two questions gets both answers",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const extension = orderedApprovalExtension((params) =>
            Effect.gen(function* () {
              const first = yield* approveAs({ label: "Q1", text: `${params.text} one?` })
              const second = yield* approveAs({ label: "Q2", text: `${params.text} two?` })
              return `${first},${second}`
            }),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("ordered_approval", { label: "X", text: "Proceed" }),
            textStep("asked twice"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [extension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const answering = yield* answerInOrder({
            client,
            sessionId,
            branchId,
            answers: ["one", "two"],
            presented: yield* Deferred.make<void>(),
          }).pipe(Effect.forkScoped)
          yield* client.message.send({ sessionId, branchId, content: "ask two questions" })
          const seen = Array.from(yield* Fiber.join(answering))
          expect(seen).toEqual(["Proceed one?", "Proceed two?"])
          const snapshot = yield* waitForReply({
            client,
            sessionId,
            branchId,
            reply: "asked twice",
          }).pipe(Effect.timeout("5 seconds"))
          const results = toolResultTexts(snapshot.messages)
          expect(results.some((result) => result.includes("Q1=one,Q2=two"))).toBe(true)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  it.live(
    "a cancelled turn dismisses its open question, and the next turn asks its own",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
            toolCallStep("approval_probe", { text: "OLD" }),
            toolCallStep("approval_probe", { text: "NEW" }),
            textStep("new answered"),
          ])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              extensions: [InteractionProbeExtension],
              approvalLayer: ApprovalService.Live,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const seen = MutableRef.make<
            ReadonlyArray<{ kind: string; text: string; id: InteractionRequestId }>
          >([])
          yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.runForEach((envelope) =>
              Effect.sync(() => {
                const event = envelope.event
                if (event._tag === "InteractionPresented")
                  MutableRef.update(seen, (all) => [
                    ...all,
                    { kind: "presented", text: event.text, id: event.requestId },
                  ])
                if (event._tag === "InteractionResolved")
                  MutableRef.update(seen, (all) => [
                    ...all,
                    { kind: "resolved", text: resolvedAs(event), id: event.requestId },
                  ])
              }),
            ),
            Effect.forkScoped,
          )
          const presented = (text: string) =>
            waitFor(
              Effect.sync(() => MutableRef.get(seen)),
              (all) => all.some((entry) => entry.kind === "presented" && entry.text === text),
              5_000,
              `presented ${text}`,
            ).pipe(
              Effect.map(
                (all) => all.find((entry) => entry.kind === "presented" && entry.text === text)!.id,
              ),
            )
          yield* client.message.send({ sessionId, branchId, content: "one" })
          const oldId = yield* presented("OLD")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "WaitingForInteraction",
            5_000,
            "parked on OLD",
          )
          yield* client.steer.command({
            command: { _tag: "Cancel", sessionId, branchId, requestId: "req-cancel-old" },
          })
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "Idle",
            5_000,
            "idle after cancel",
          )
          // The dialog of the cancelled turn closes.
          yield* waitFor(
            Effect.sync(() => MutableRef.get(seen)),
            (all) => all.some((entry) => entry.kind === "resolved" && entry.id === oldId),
            5_000,
            "OLD dismissed",
          )
          yield* client.message.send({ sessionId, branchId, content: "two" })
          // NEW shows without anyone answering OLD first.
          const newId = yield* presented("NEW")
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "WaitingForInteraction",
            5_000,
            "parked on NEW",
          )
          yield* client.interaction.respondInteraction({
            sessionId,
            branchId,
            requestId: newId,
            approved: true,
            notes: "new-answer",
          })
          const snapshot = yield* waitForReply({
            client,
            sessionId,
            branchId,
            reply: "new answered",
          })
          expect(
            toolResultTexts(snapshot.messages).some((result) => result.includes("new-answer")),
          ).toBe(true)
          expect(MutableRef.get(seen).map((entry) => `${entry.kind}:${entry.text}`)).toEqual([
            "presented:OLD",
            "resolved:dismissed",
            "presented:NEW",
            "resolved:true",
          ])
          // The old question can no longer be answered.
          const stale = yield* client.interaction
            .respondInteraction({
              sessionId,
              branchId,
              requestId: oldId,
              approved: true,
              notes: "too late",
            })
            .pipe(Effect.exit)
          expect(Exit.isFailure(stale)).toBe(true)
        }).pipe(Effect.timeout("10 seconds")),
      ),
    12_000,
  )

  /**
   * A call that asks two questions, stopped by a restart once it parks on Q2.
   * `beforeRestart` runs while no server is up.
   */
  const askTwiceAcrossRestart = <E>(params: {
    readonly dbName: string
    readonly beforeRestart: (first: {
      readonly sessionId: SessionId
      readonly branchId: BranchId
      readonly q2: InteractionRequestId
      readonly dbPath: string
    }) => Effect.Effect<void, E>
    readonly answersAfter: ReadonlyArray<string>
  }) =>
    Effect.gen(function* () {
      const tempDir = yield* makeTempDirectoryScoped("gent-interaction-")
      const dbPath = `${tempDir}/${params.dbName}`
      const extension = orderedApprovalExtension(() =>
        Effect.gen(function* () {
          const first = yield* approveAs({ label: "Q1", text: "Proceed one?" })
          const second = yield* approveAs({ label: "Q2", text: "Proceed two?" })
          return `${first},${second}`
        }),
      )
      const firstProvider = yield* LanguageModelLayers.sequence([
        toolCallStep("ordered_approval", { label: "X", text: "Proceed" }),
      ])
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer: firstProvider.layer,
              extensions: [extension],
              durableApproval: true,
              storagePath: dbPath,
            }),
          )
          const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
          const presented = yield* Deferred.make<void>()
          const answered = yield* answerInOrder({
            client,
            sessionId,
            branchId,
            answers: ["one"],
            presented,
          }).pipe(Effect.forkScoped)
          yield* client.message.send({ sessionId, branchId, content: "ask two questions" })
          yield* Fiber.join(answered)
          const q2 = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filterMap((envelope) => {
              if (
                envelope.event._tag === "InteractionPresented" &&
                envelope.event.text === "Proceed two?"
              )
                return Result.succeed(envelope.event.requestId)
              return Result.failVoid
            }),
            Stream.runHead,
            Effect.flatMap(Effect.fromOption),
          )
          yield* waitFor(
            client.session.getSnapshot({ sessionId, branchId }),
            (current) => current.runtime._tag === "WaitingForInteraction",
            5_000,
            "parked on Q2 before restart",
          )
          const snapshot = yield* client.session.getSnapshot({ sessionId, branchId })
          return { sessionId, branchId, q2, lastEventId: snapshot.lastEventId ?? 0 }
        }).pipe(Effect.timeout("8 seconds")),
      )
      yield* params.beforeRestart({
        sessionId: first.sessionId,
        branchId: first.branchId,
        q2: first.q2,
        dbPath,
      })

      const secondProvider = yield* LanguageModelLayers.sequence([textStep("asked twice")])
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer: secondProvider.layer,
              extensions: [extension],
              durableApproval: true,
              storagePath: dbPath,
            }),
          )
          const shown = MutableRef.make<ReadonlyArray<string>>([])
          yield* client.session
            .events({
              sessionId: first.sessionId,
              branchId: first.branchId,
              after: first.lastEventId,
            })
            .pipe(
              Stream.runForEach((envelope) =>
                Effect.gen(function* () {
                  if (envelope.event._tag !== "InteractionPresented") return
                  const event = envelope.event
                  MutableRef.update(shown, (all) => [...all, event.text])
                  const index = MutableRef.get(shown).length - 1
                  const answer = params.answersAfter[index]
                  if (Predicate.isUndefined(answer)) return
                  yield* waitFor(
                    client.session.getSnapshot({
                      sessionId: first.sessionId,
                      branchId: first.branchId,
                    }),
                    (current) => current.runtime._tag === "WaitingForInteraction",
                    5_000,
                    "parked after restart",
                  )
                  yield* client.interaction.respondInteraction({
                    sessionId: first.sessionId,
                    branchId: first.branchId,
                    requestId: event.requestId,
                    approved: true,
                    notes: answer,
                  })
                }),
              ),
              Effect.forkScoped,
            )
          const snapshot = yield* waitForReply({
            client,
            sessionId: first.sessionId,
            branchId: first.branchId,
            reply: "asked twice",
          })
          return { results: toolResultTexts(snapshot.messages), shown: MutableRef.get(shown) }
        }).pipe(Effect.timeout("8 seconds")),
      )
    })

  it.scopedLive(
    "a call that asks twice keeps its first answer across a restart",
    () =>
      Effect.gen(function* () {
        const outcome = yield* askTwiceAcrossRestart({
          dbName: "gent-ask-twice-restart.db",
          beforeRestart: () => Effect.void,
          answersAfter: ["two"],
        })
        expect(outcome.shown).toEqual(["Proceed two?"])
        expect(outcome.results.some((result) => result.includes("Q1=one,Q2=two"))).toBe(true)
      }),
    20_000,
  )

  it.scopedLive(
    "a call that asks twice takes both answers when the second came before a restart",
    () =>
      Effect.gen(function* () {
        const outcome = yield* askTwiceAcrossRestart({
          dbName: "gent-ask-twice-answered.db",
          beforeRestart: (first) =>
            Effect.gen(function* () {
              const storage = yield* InteractionStorage
              const decisionJson = yield* encodeInteractionDecision({
                approved: true,
                notes: "two",
              })
              yield* storage.decide(first, first.q2, decisionJson)
            }).pipe(
              Effect.provide(
                SqliteStorage.LiveWithSql(first.dbPath, () => Layer.empty, {}).pipe(
                  Layer.provide(BunPlatformLive),
                ),
              ),
              Effect.provideService(CurrentWorkspaceId, currentTestWorkspaceId()),
            ),
          answersAfter: [],
        })
        expect(outcome.shown).toEqual([])
        expect(outcome.results.some((result) => result.includes("Q1=one,Q2=two"))).toBe(true)
      }),
    20_000,
  )
})

// ── extension command rpcs ──────────────────────────────────────────────────

class ProfileToken extends Context.Service<
  ProfileToken,
  {
    readonly read: Effect.Effect<string, never, never>
  }
>()("@gent/core/tests/server/rpc.test/ProfileToken") {}
const expectExtensionProtocolFailure = (cause: Cause.Cause<unknown>, message?: string) => {
  const error = Cause.squash(cause)
  expect(Schema.is(ExtensionProtocolError)(error)).toBe(true)
  if (!Schema.is(ExtensionProtocolError)(error)) return
  expect(error._tag).toBe("ExtensionProtocolError")
  if (!Predicate.isUndefined(message)) expect(error.message).toBe(message)
}
describe("extension command RPCs", () => {
  const invoked: Array<{
    args: string
    sessionId: string
    cwd: string
  }> = []
  // Server-visible slash commands are slash-decorated requests.
  const TestCommandsExtension: GentExtension = {
    manifest: { id: ExtensionId.make("@test/commands") },
    setup: registerContributions({
      requests: [
        request({
          id: "greet",
          slash: { name: "greet", description: "Say hello" },
          description: "Say hello",
          input: Schema.String,
          output: Schema.Void,
          execute: (args) =>
            Effect.gen(function* () {
              const ctx = yield* ExtensionContext
              invoked.push({ args, sessionId: ctx.sessionId, cwd: ctx.cwd })
            }),
        }),
        request({
          id: "noop",
          slash: { name: "noop", description: "noop" },
          description: "noop",
          input: Schema.String,
          output: Schema.Void,
          execute: () => Effect.void,
        }),
      ],
    }),
  }
  const layer = createE2ELayer({
    agents: [],
    providerLayer: LanguageModelLayers.debug(),
    extensionInputs: [TestCommandsExtension],
    toolRunner: "test",
  })
  it.live("extension author API does not export capability authority providers", () =>
    Effect.sync(() => {
      expect("CapabilityAccess" in ExtensionApi).toBe(false)
      expect("provideCapabilityAccessNeeds" in ExtensionApi).toBe(false)
    }),
  )
  const makeProfile = (cwd: string, extensions: ReadonlyArray<LoadedExtension>) =>
    Effect.gen(function* () {
      const resolved = resolveExtensions(extensions)
      const layerContext = yield* Layer.build(
        Layer.provideMerge(
          buildResourceLayer(resolved.extensions, "process"),
          ExtensionRegistry.fromResolved(resolved),
        ),
      )
      return {
        cwd,
        resolved,
        layerContext,
        registryService: Context.get(layerContext, ExtensionRegistry),
        baseSections: [],
        generationId: ProcessGenerationId.make("test"),
      } satisfies SessionProfile
    })
  const makeCommandExtension = (extensionId: string, commandId: string): LoadedExtension => ({
    manifest: { id: ExtensionId.make(extensionId) },
    scope: "builtin",
    sourcePath: "test",
    contributions: {
      requests: [
        request({
          id: commandId,
          slash: { name: commandId, description: commandId },
          input: Schema.String,
          output: Schema.Void,
          execute: () => Effect.void,
        }),
      ],
    },
  })
  it.live("resolved slash commands list registered commands", () =>
    Effect.gen(function* () {
      const registry = yield* ExtensionRegistry
      const cmds = registry.getResolved().slashCommands
      const testCmds = cmds.filter((c) => c.name === "greet" || c.name === "noop")
      expect(testCmds).toHaveLength(2)
      expect(testCmds.find((c) => c.name === "greet")?.description).toBe("Say hello")
      expect(testCmds.find((c) => c.name === "noop")?.description).toBe("noop")
    }).pipe(Effect.provide(layer)),
  )
  it.live("RPC listSlashCommands + request round-trip through the transport boundary", () =>
    Effect.gen(function* () {
      invoked.length = 0
      let createdSessionId = ""
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const wideEvents = MutableRef.make<Array<LogEvent>>([])
          const minimumLogLevel = Layer.effectContext(
            Effect.succeed(Context.make(MinimumLogLevel, "Info")),
          )
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [TestCommandsExtension],
            cwd: "/tmp/gent-extension-request-session",
            extraLayers: [WideEventLogger.Capture(wideEvents), minimumLogLevel],
          })
          createdSessionId = sessionId
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands[0]).toBeInstanceOf(SlashCommandInfo)
          expect(commands.map((command) => command.name)).toEqual(["greet", "noop"])
          const greet = commands.find((command) => command.name === "greet")
          expect(greet?.description).toBe("Say hello")
          expect(greet?.extensionId).toBe(ExtensionId.make("@test/commands"))
          expect(greet?.capabilityId).toBe("greet")
          yield* client.extension.request({
            sessionId,
            extensionId: greet!.extensionId,
            capabilityId: greet!.capabilityId,
            input: "rpc-world",
            branchId,
          })
          const extensionRequestEvent = MutableRef.get(wideEvents).find(
            (event) =>
              event.annotations["service"] === "rpc" &&
              event.annotations["method"] === "extension.request",
          )
          expect(extensionRequestEvent).not.toBeUndefined()
          expect(extensionRequestEvent?.annotations["sessionId"]).toBe(sessionId)
          expect(extensionRequestEvent?.annotations["branchId"]).toBe(branchId)
          expect(extensionRequestEvent?.annotations["extensionId"]).toBe(greet!.extensionId)
          expect(extensionRequestEvent?.annotations["capabilityId"]).toBe(greet!.capabilityId)

          const missingCapabilityId = "missing-greet"
          const failed = yield* client.extension
            .request({
              sessionId,
              extensionId: greet!.extensionId,
              capabilityId: missingCapabilityId,
              input: "rpc-world",
              branchId,
            })
            .pipe(Effect.exit)
          expect(failed._tag).toBe("Failure")

          const failedRequestEvent = MutableRef.get(wideEvents).find(
            (event) =>
              event.annotations["service"] === "rpc" &&
              event.annotations["method"] === "extension.request" &&
              event.annotations["capabilityId"] === missingCapabilityId,
          )
          expect(failedRequestEvent).not.toBeUndefined()
          expect(failedRequestEvent?.annotations["sessionId"]).toBe(sessionId)
          expect(failedRequestEvent?.annotations["branchId"]).toBe(branchId)
          expect(failedRequestEvent?.annotations["extensionId"]).toBe(greet!.extensionId)
        }).pipe(Effect.timeout("4 seconds")),
      )
      expect(invoked).toEqual([
        {
          args: "rpc-world",
          sessionId: createdSessionId,
          cwd: "/tmp/gent-extension-request-session",
        },
      ])
    }),
  )
  it.live("RPC request can queue follow-up through ExtensionContext service", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/queue-follow-up-request")
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          requests: [
            request({
              id: "queue-follow-up",
              input: Schema.String,
              output: Schema.Void,
              execute: (input) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  yield* ctx.Session.send({
                    delivery: "queue",
                    sourceId: "test-rpc-request",
                    content: input,
                  })
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new CapabilityError({
                        extensionId,
                        capabilityId: "queue-follow-up",
                        reason: cause.message,
                      }),
                  ),
                ),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
            cwd: "/tmp/gent-extension-queue-follow-up",
          })
          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "queue-follow-up",
            input: "queued through public rpc",
          })
          const queue = yield* client.queue.get({ sessionId, branchId })
          expect(queue.steering).toEqual([])
          expect(queue.followUp).toEqual([
            expect.objectContaining({
              _tag: "FollowUp",
              content: "queued through public rpc",
            }),
          ])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("the settings wide event records the stored settings, not the change", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const wideEvents = MutableRef.make<Array<LogEvent>>([])
        const minimumLogLevel = Layer.effectContext(
          Effect.succeed(Context.make(MinimumLogLevel, "Info")),
        )
        const { client, sessionId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensionInputs: [],
          cwd: "/tmp/gent-settings-wide-event",
          extraLayers: [WideEventLogger.Capture(wideEvents), minimumLogLevel],
        })
        yield* client.session.updateSettings({
          sessionId,
          modelId: Option.some(ModelId.make("anthropic/kept-model")),
        })
        // This change leaves the model out; the stored model is what the event names.
        yield* client.session.updateSettings({ sessionId, reasoningLevel: Option.some("high") })
        const settingsEvents = MutableRef.get(wideEvents).filter(
          (event) =>
            event.annotations["service"] === "rpc" &&
            event.annotations["method"] === "session.updateSettings",
        )
        expect(settingsEvents).toHaveLength(2)
        const last = settingsEvents[1]?.annotations
        expect(last?.["sessionId"]).toBe(sessionId)
        expect(last?.["modelId"]).toBe("anthropic/kept-model")
        expect(last?.["reasoningLevel"]).toBe("high")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("a turn emits one agent-loop wide event with its session envelope", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("traced reply"),
        ])
        const wideEvents = MutableRef.make<Array<LogEvent>>([])
        const minimumLogLevel = Layer.effectContext(
          Effect.succeed(Context.make(MinimumLogLevel, "Info")),
        )
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          cwd: "/tmp/gent-turn-wide-event",
          extraLayers: [WideEventLogger.Capture(wideEvents), minimumLogLevel],
        })
        yield* client.message.send({ sessionId, branchId, content: "trace me" })
        const turnEvents = yield* waitFor(
          Effect.sync(() =>
            MutableRef.get(wideEvents).filter(
              (event) => event.annotations["service"] === "agent-loop",
            ),
          ),
          (events) => events.length > 0,
          4000,
          "turn wide event",
        )
        expect(turnEvents).toHaveLength(1)
        expect(turnEvents[0]?.annotations).toMatchObject({
          service: "agent-loop",
          method: "turn",
          status: "ok",
          actor: DEFAULT_AGENT_NAME,
          sessionId,
          branchId,
        })
      }),
    ).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
  )
  it.live("RPC event subscriptions mark the move from replay to live", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("synced reply"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensions: [],
          cwd: "/tmp/gent-extension-stream-synchronized",
        })
        const untilMarker = (after: number) =>
          client.session.events({ sessionId, branchId, after }).pipe(
            Stream.takeUntil((env) => env.event._tag === "StreamSynchronized"),
            Stream.runCollect,
          )
        // A fresh branch replays its creation events, then the marker closes the replay.
        const fresh = yield* untilMarker(0)
        expect(fresh.map((env) => env.event._tag)).toEqual(["SessionStarted", "StreamSynchronized"])
        expect(fresh[1]?.id).toBe(fresh[0]?.id)
        yield* client.message.send({ sessionId, branchId, content: "sync" })
        yield* waitFor(
          client.message.list({ branchId }),
          (messages) =>
            messages.some(
              (message) =>
                message.role === "assistant" && messagePartsText(message.parts) === "synced reply",
            ),
          4000,
          "synced reply",
        )
        // After a turn, the marker closes the replay and names the last replayed id.
        const replayed = yield* untilMarker(0)
        const marker = replayed[replayed.length - 1]
        const events = replayed.slice(0, -1)
        expect(marker?.event).toMatchObject({ _tag: "StreamSynchronized", sessionId, branchId })
        expect(events.length).toBeGreaterThan(1)
        expect(events.every((env) => env.event._tag !== "StreamSynchronized")).toBe(true)
        expect(marker?.id).toBe(events[events.length - 1]?.id)
        // Resuming from the marker id replays nothing and synchronizes at once.
        const resumed = yield* untilMarker(Number(marker?.id))
        expect(resumed.map((env) => env.event._tag)).toEqual(["StreamSynchronized"])
      }),
    ).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
  )

  it.live("a child session created through the facade starts its own thread", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/spawn-child")
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          requests: [
            request({
              id: "spawn-child",
              input: Schema.String,
              output: SessionId,
              execute: (name) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  const child = yield* ctx.Session.create({
                    name,
                    parentSessionId: ctx.sessionId,
                    parentBranchId: ctx.branchId,
                  })
                  return child.sessionId
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new CapabilityError({
                        extensionId,
                        capabilityId: "spawn-child",
                        reason: cause.message,
                      }),
                  ),
                ),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
            cwd: "/tmp/gent-child-thread",
          })
          const childId = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "spawn-child",
            input: "side work",
          })
          const child = yield* Schema.decodeUnknownEffect(SessionId)(childId)
          const parentThread = yield* client.session.thread({ sessionId })
          expect(parentThread.map((session) => session.id)).toEqual([sessionId])
          const childThread = yield* client.session.thread({ sessionId: child })
          expect(childThread.map((session) => session.id)).toEqual([child])
          expect(childThread[0]?.parentSessionId).toBe(sessionId)
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )

  it.live("a handoff joins its parent's thread; a plain child starts its own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          cwd: "/tmp/gent-handoff-thread",
        })
        const handoff = yield* client.session.create({
          parentSessionId: sessionId,
          parentBranchId: branchId,
          continueThread: true,
        })
        const plain = yield* client.session.create({
          parentSessionId: sessionId,
          parentBranchId: branchId,
        })
        const thread = yield* client.session.thread({ sessionId: handoff.sessionId })
        expect(thread.map((session) => session.id)).toEqual([sessionId, handoff.sessionId])
        const plainThread = yield* client.session.thread({ sessionId: plain.sessionId })
        expect(plainThread.map((session) => session.id)).toEqual([plain.sessionId])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("RPC request follow-up on a warm idle branch runs the queued turn", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/queue-follow-up-warm")
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          requests: [
            request({
              id: "queue-follow-up",
              input: Schema.String,
              output: Schema.Void,
              execute: (input) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  yield* ctx.Session.send({
                    delivery: "queue",
                    sourceId: "test-warm-request",
                    content: input,
                  })
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new CapabilityError({
                        extensionId,
                        capabilityId: "queue-follow-up",
                        reason: cause.message,
                      }),
                  ),
                ),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
            textStep("first reply"),
            textStep("follow-up reply"),
          ])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
            cwd: "/tmp/gent-extension-queue-follow-up-warm",
          })
          const assistantReplies = (
            messages: ReadonlyArray<{ role: string; parts: Message["parts"] }>,
          ) =>
            messages
              .filter((message) => message.role === "assistant")
              .map((message) => messagePartsText(message.parts))
          yield* client.message.send({ sessionId, branchId, content: "warm the branch" })
          yield* waitFor(
            client.message.list({ branchId }),
            (messages) => assistantReplies(messages).includes("first reply"),
            4000,
            "first reply",
          )
          // The request runs under the loop's side-mutation permit. Admission
          // queues the item; the turn starts once the permit is released.
          yield* client.extension
            .request({
              sessionId,
              branchId,
              extensionId,
              capabilityId: "queue-follow-up",
              input: "queued while idle",
            })
            .pipe(Effect.timeout("4 seconds"))
          const messages = yield* waitFor(
            client.message.list({ branchId }),
            (current) => assistantReplies(current).includes("follow-up reply"),
            4000,
            "follow-up reply",
          )
          expect(
            messages.some(
              (message) =>
                message.role === "user" && messagePartsText(message.parts) === "queued while idle",
            ),
          ).toBe(true)
          yield* controls.assertDone
        }).pipe(Effect.timeout("10 seconds")),
      )
    }),
  )
  it.live("RPC request runs slash request with ExtensionContext service", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/queue-follow-up-slash")
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          requests: [
            request({
              id: "queue-follow-up-slash",
              slash: {
                trigger: "queue-follow-up",
                name: "Queue Follow Up",
                description: "Queue follow-up request",
              },
              description: "Queue follow-up request",
              input: Schema.String,
              output: Schema.Void,
              execute: (input: string) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  yield* ctx.Session.send({
                    delivery: "queue",
                    sourceId: "test-slash-request",
                    content: input,
                  })
                }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new CapabilityError({
                        extensionId,
                        capabilityId: "queue-follow-up-slash",
                        reason: cause.message,
                      }),
                  ),
                ),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
            cwd: "/tmp/gent-extension-queue-follow-up-slash",
          })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual(["queue-follow-up"])
          yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "queue-follow-up-slash",
            input: "queued through slash request",
          })
          const queue = yield* client.queue.get({ sessionId, branchId })
          expect(queue.followUp).toEqual([
            expect.objectContaining({
              _tag: "FollowUp",
              content: "queued through slash request",
            }),
          ])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC request rejects missing sessions instead of using launch cwd", () =>
    Effect.gen(function* () {
      invoked.length = 0
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [TestCommandsExtension],
          })
          const result = yield* Effect.exit(
            client.extension.request({
              sessionId: SessionId.make("missing-extension-request-session"),
              extensionId: ExtensionId.make("@test/commands"),
              capabilityId: "greet",
              input: "should-not-run",
              branchId: BranchId.make("missing-extension-request-branch"),
            }),
          )
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expectExtensionProtocolFailure(
              result.cause,
              "Session not found: missing-extension-request-session",
            )
          }
          expect(invoked).toEqual([])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC request rejects missing branches", () =>
    Effect.gen(function* () {
      invoked.length = 0
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [TestCommandsExtension],
            cwd: "/tmp/gent-extension-request-missing-branch",
          })
          const result = yield* Effect.exit(
            client.extension.request({
              sessionId,
              extensionId: ExtensionId.make("@test/commands"),
              capabilityId: "greet",
              input: "should-not-run",
              branchId: BranchId.make("missing-extension-request-branch"),
            }),
          )
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expectExtensionProtocolFailure(
              result.cause,
              `Branch not found for session: ${sessionId}/missing-extension-request-branch`,
            )
          }
          expect(invoked).toEqual([])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC request rejects branches outside the requested session", () =>
    Effect.gen(function* () {
      invoked.length = 0
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [TestCommandsExtension],
            cwd: "/tmp/gent-extension-request-first",
          })
          const first = { sessionId, branchId }
          const second = yield* client.session.create({
            cwd: "/tmp/gent-extension-request-second",
          })
          const result = yield* Effect.exit(
            client.extension.request({
              sessionId: first.sessionId,
              extensionId: ExtensionId.make("@test/commands"),
              capabilityId: "greet",
              input: "wrong-branch",
              branchId: second.branchId,
            }),
          )
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expectExtensionProtocolFailure(
              result.cause,
              `Branch not found for session: ${first.sessionId}/${second.branchId}`,
            )
          }
          expect(invoked).toEqual([])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  const reviewerAgent = AgentName.make("reviewer")
  const reviewerExtension: LoadedExtension = {
    manifest: { id: ExtensionId.make("@test/reviewer-agent") },
    scope: "project",
    sourcePath: "test",
    contributions: { agents: [AgentDefinition.make({ name: reviewerAgent })] },
  }
  /** A profile cache where `cwd` has the reviewer agent and any other cwd has no agents. */
  const reviewerProfiles = (cwd: string) =>
    Effect.gen(function* () {
      const withReviewer = yield* makeProfile(cwd, [reviewerExtension])
      const empty = yield* makeProfile(cwd, [])
      const layer = Layer.succeed(
        SessionProfileCache,
        SessionProfileCache.of({
          resolve: (resolvedCwd) => {
            if (resolvedCwd === cwd) return Effect.succeed(withReviewer)
            return Effect.succeed(empty)
          },
        }),
      )
      return { layer }
    })

  it.live("a handoff to a project without the parent's agent fails before it is stored", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectCwd = "/tmp/gent-handoff-agent-project"
        const otherCwd = "/tmp/gent-handoff-agent-other"
        const profiles = yield* reviewerProfiles(projectCwd)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensions: [],
          sessionProfileCacheLayer: profiles.layer,
          cwd: projectCwd,
        })
        const parent = yield* client.session.create({
          cwd: projectCwd,
          admission: { agent: reviewerAgent },
        })
        const handoff = { parentSessionId: parent.sessionId, parentBranchId: parent.branchId }
        const before = yield* client.session.list()
        const error = yield* client.session
          .create({ cwd: otherCwd, ...handoff, continueThread: true })
          .pipe(Effect.flip)
        expect(error._tag).toBe("NotFoundError")
        expect(error.message).toBe("Unknown agent: reviewer")
        expect(yield* client.session.list()).toHaveLength(before.length)
        // The same project still has the agent, so the handoff inherits it.
        const same = yield* client.session.create({
          cwd: projectCwd,
          ...handoff,
          continueThread: true,
        })
        const stored = yield* client.session.get({ sessionId: same.sessionId })
        expect(stored?.admission?.agent).toBe(reviewerAgent)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("RPC request provides profile resource services to public capabilities", () =>
    Effect.gen(function* () {
      const profileCwd = "/tmp/gent-extension-request-profile-service"
      const ext: LoadedExtension = {
        manifest: { id: ExtensionId.make("@test/profile-service-request") },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          resources: [
            defineResource({
              id: "test/extension-commands-rpc/profile-token",
              scope: "process",
              layer: Layer.succeed(
                ProfileToken,
                ProfileToken.of({
                  read: Effect.succeed("profile-token"),
                }),
              ),
            }),
          ],
          requests: [
            request({
              id: "read-profile-token",
              input: Schema.String,
              output: Schema.String,
              execute: () =>
                Effect.gen(function* () {
                  const token = yield* ProfileToken
                  return yield* token.read
                }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const profile = yield* makeProfile(profileCwd, [ext])
          const sessionProfileCacheLayer = SessionProfileCache.Test(
            new Map([[profileCwd, profile]]),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer,
            cwd: profileCwd,
          })
          const result = yield* client.extension.request({
            sessionId,
            extensionId: ExtensionId.make("@test/profile-service-request"),
            capabilityId: "read-profile-token",
            input: "token",
            branchId,
          })
          expect(result).toBe("profile-token")
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.scoped("RPC request resolves resources from SessionProfileCache.Live", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const profileCwd = yield* fs.makeTempDirectoryScoped()
      const ext: GentExtension = {
        manifest: { id: ExtensionId.make("@test/live-profile-service-request") },
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "test/extension-commands-rpc/live-profile-token",
              scope: "process",
              layer: Layer.succeed(
                ProfileToken,
                ProfileToken.of({
                  read: Effect.succeed(`live:${host.cwd}`),
                }),
              ),
            }),
          )
          yield* host.register(
            "request",
            request({
              id: "read-live-profile-token",
              input: Schema.String,
              output: Schema.String,
              execute: () =>
                Effect.gen(function* () {
                  const token = yield* ProfileToken
                  return yield* token.read
                }),
            }),
          )
        }),
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sessionProfileCacheLayer = Layer.unwrap(
            Effect.map(Effect.scope, (scope) =>
              SessionProfileCache.Live({
                home,
                failOnExtensionFailure: true,
                platform: "test",
                extensions: [ext],
              }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    BunPlatformLive,
                    ConfigService.Test(),
                    SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(
                      Layer.provide(BunPlatformLive),
                    ),
                  ),
                ),
                Layer.orDie,
                Layer.provide(Layer.succeed(Scope.Scope, scope)),
              ),
            ),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer,
            cwd: profileCwd,
          })
          const result = yield* client.extension.request({
            sessionId,
            extensionId: ExtensionId.make("@test/live-profile-service-request"),
            capabilityId: "read-live-profile-token",
            input: "token",
            branchId,
          })
          expect(result).toBe(`live:${profileCwd}`)
        }).pipe(Effect.timeout("4 seconds")),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )
  it.scoped("a branch resource is built from the session's profile, not the launch registry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const profileCwd = yield* fs.makeTempDirectoryScoped()
      const ext: GentExtension = {
        manifest: { id: ExtensionId.make("@test/branch-profile-token") },
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          yield* host.register(
            "resource",
            defineResource({
              id: "test/extension-commands-rpc/branch-profile-token",
              scope: "branch",
              layer: Layer.succeed(
                ProfileToken,
                ProfileToken.of({ read: Effect.succeed(`branch:${host.cwd}`) }),
              ),
            }),
          )
          yield* host.register(
            "request",
            request({
              id: "read-branch-profile-token",
              input: Schema.String,
              output: Schema.String,
              execute: () =>
                Effect.gen(function* () {
                  const token = yield* ProfileToken
                  return yield* token.read
                }),
            }),
          )
        }),
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sessionProfileCacheLayer = Layer.unwrap(
            Effect.map(Effect.scope, (scope) =>
              SessionProfileCache.Live({
                home,
                failOnExtensionFailure: true,
                platform: "test",
                extensions: [ext],
              }).pipe(
                Layer.provide(
                  Layer.mergeAll(
                    BunPlatformLive,
                    ConfigService.Test(),
                    SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(
                      Layer.provide(BunPlatformLive),
                    ),
                  ),
                ),
                Layer.orDie,
                Layer.provide(Layer.succeed(Scope.Scope, scope)),
              ),
            ),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          // The launch registry does not load the extension: only the
          // profile for the session's cwd knows its branch resource.
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer,
            cwd: profileCwd,
          })
          const result = yield* client.extension.request({
            sessionId,
            extensionId: ExtensionId.make("@test/branch-profile-token"),
            capabilityId: "read-branch-profile-token",
            input: "token",
            branchId,
          })
          expect(result).toBe(`branch:${profileCwd}`)
        }).pipe(Effect.timeout("4 seconds")),
      )
    }).pipe(Effect.provide(BunPlatformLive)),
  )
  it.scopedLive(
    "a user extension whose branch resource fails leaves the others and the turn running",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped()
        const profileCwd = yield* fs.makeTempDirectoryScoped()
        const userDir = path.join(home, ".gent", "extensions")
        yield* fs.makeDirectory(userDir, { recursive: true })
        yield* fs.writeFileString(
          path.join(userDir, "broken-branch.ts"),
          `import { Context, Effect, Layer } from "effect";
import { defineExtension, defineResource, ExtensionHost } from "@gent/core/extensions/api";
class Broken extends Context.Service<Broken, { readonly value: string }>()(
  "@gent/core/tests/server/rpc.test/BrokenBranchResource",
) {}
export default defineExtension({
  id: "@test/broken-branch-resource",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost;
    yield* host.register("resource", defineResource({
      id: "test/broken-branch-resource/resource",
      scope: "branch",
      layer: Layer.effect(Broken, Effect.die("branch resource boom")),
    }));
  }),
});
`,
        )
        const working: GentExtension = {
          manifest: { id: ExtensionId.make("@test/working-branch-resource") },
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              defineResource({
                id: "test/working-branch-resource/token",
                scope: "branch",
                layer: Layer.succeed(
                  ProfileToken,
                  ProfileToken.of({ read: Effect.succeed("working branch resource") }),
                ),
              }),
            )
            yield* host.register(
              "request",
              request({
                id: "read-working-branch-token",
                input: Schema.String,
                output: Schema.String,
                execute: () =>
                  Effect.gen(function* () {
                    const token = yield* ProfileToken
                    return yield* token.read
                  }),
              }),
            )
          }),
        }
        // The profile runs the turn: it needs the agent and the driver too.
        const agents: GentExtension = {
          manifest: { id: ExtensionId.make("@test/branch-resource-agents") },
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("agent", testAgent)
          }),
        }
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sessionProfileCacheLayer = Layer.unwrap(
              Effect.map(Effect.scope, (scope) =>
                SessionProfileCache.Live({
                  home,
                  failOnExtensionFailure: true,
                  platform: "test",
                  extensions: [agents, testTurnExtension, working],
                }).pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      BunPlatformLive,
                      ConfigService.Test(),
                      SqliteStorage.MemoryWithSql(() => Layer.empty, {}).pipe(
                        Layer.provide(BunPlatformLive),
                      ),
                    ),
                  ),
                  Layer.orDie,
                  Layer.provide(Layer.succeed(Scope.Scope, scope)),
                ),
              ),
            )
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
              textStep("the turn ran"),
            ])
            const { client, sessionId, branchId } = yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensions: [],
              sessionProfileCacheLayer,
              cwd: profileCwd,
            })
            yield* client.message.send({ sessionId, branchId, content: "run a turn" })
            yield* waitFor(
              client.session.getSnapshot({ sessionId, branchId }),
              (snapshot) =>
                snapshot.runtime._tag === "Idle" &&
                snapshot.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.parts.some(
                      (part) => part.type === "text" && part.text === "the turn ran",
                    ),
                ),
              5_000,
              "the turn replied",
            )
            // The other extension's branch resource is live on the same branch.
            const token = yield* client.extension.request({
              sessionId,
              extensionId: ExtensionId.make("@test/working-branch-resource"),
              capabilityId: "read-working-branch-token",
              input: "token",
              branchId,
            })
            expect(token).toBe("working branch resource")
            // The failure names its extension once, as a notice.
            const events = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.takeUntil(({ event }) => event._tag === "StreamSynchronized"),
              Stream.map(({ event }) => event),
              Stream.runCollect,
              Effect.map((all) => Array.from(all)),
            )
            const notices = events.filter(
              (event) =>
                event._tag === "ErrorOccurred" &&
                event.error.includes("@test/broken-branch-resource"),
            )
            expect(notices).toHaveLength(1)
            expect(notices[0]).toMatchObject({ notice: true })
            expect(notices[0]?._tag === "ErrorOccurred" && notices[0].error).toContain(
              "branch resource boom",
            )
          }).pipe(Effect.timeout("8 seconds")),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
  )
  it.live("a test root stops at a failed extension and names it", () =>
    Effect.gen(function* () {
      const failingExtension: GentExtension = {
        manifest: { id: ExtensionId.make("@test/failing-load") },
        setup: Effect.fail(
          new ExtensionLoadError({
            extensionId: ExtensionId.make("@test/failing-load"),
            message: "setup boom",
          }),
        ),
      }
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          return yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [failingExtension],
            cwd: "/tmp",
          })
        }).pipe(Effect.timeout("4 seconds")),
      ).pipe(Effect.exit)
      // A defect with the reason, at once; not a later timeout with the extension silently gone.
      expect(Exit.isFailure(exit)).toBe(true)
      const reason = Exit.match(exit, { onSuccess: () => "", onFailure: Cause.pretty })
      expect(reason).toContain("@test/failing-load (builtin, setup): setup boom")
      expect(reason).not.toContain("TimeoutError")
    }),
  )
  it.live("RPC listStatus returns structurally tagged extension health", () =>
    Effect.gen(function* () {
      const failingExtension: GentExtension = {
        manifest: { id: ExtensionId.make("@test/failing-status") },
        setup: Effect.fail(
          new ExtensionLoadError({
            extensionId: ExtensionId.make("@test/failing-status"),
            message: "setup boom",
          }),
        ),
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            agents: [],
            extensionInputs: [failingExtension],
            // This test is about the failure report, so the load must survive it.
            allowFailedExtensions: true,
            cwd: "/tmp",
          })
          const status = yield* client.extension.listStatus({ sessionId })
          expect(status._tag).toBe("Degraded")
          if (status._tag !== "Degraded") return
          expect(status.healthyExtensions).toEqual([])
          expect(status.degradedExtensions).toHaveLength(1)
          expect(status.degradedExtensions[0]?.manifest.id).toBe("@test/failing-status")
          expect(status.degradedExtensions[0]?.issues).toEqual([
            {
              _tag: "ActivationFailed",
              phase: "setup",
              error: "setup boom",
            },
          ])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("a broken config names its file in health and clears once the file is fixed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped()
      const project = yield* fs.makeTempDirectoryScoped()
      const projectConfig = path.join(project, ".gent", "config.json")
      yield* fs.makeDirectory(path.dirname(projectConfig), { recursive: true })
      // A trailing comma: not JSON.
      yield* fs.writeFileString(projectConfig, '{ "disabledExtensions": ["x"], }')
      const configIssues = (status: ExtensionHealthSnapshot) => {
        if (status._tag !== "Degraded") return []
        return status.degradedExtensions
          .filter((extension) => extension.sourcePath === projectConfig)
          .flatMap((extension) => extension.issues)
      }
      yield* Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client, sessionId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          configServiceLayer: ConfigService.Live.pipe(
            Layer.provide(RuntimeEnvironment.Live({ cwd: project, home })),
            Layer.provide(BunPlatformLive),
          ),
          // This test is about the failure report, so the load must survive it.
          allowFailedExtensions: true,
          cwd: project,
        })
        const broken = configIssues(yield* client.extension.listStatus({ sessionId }))
        expect(broken).toHaveLength(1)
        expect(broken[0]).toMatchObject({ _tag: "ActivationFailed", phase: "load" })
        expect(broken[0]?.error).toContain(projectConfig)

        // Fixed on disk, same server: the next read has no config issue.
        yield* fs.writeFileString(projectConfig, '{ "disabledExtensions": ["x"] }')
        expect(configIssues(yield* client.extension.listStatus({ sessionId }))).toEqual([])
      }).pipe(Effect.timeout("4 seconds"))
    }).pipe(Effect.scoped, Effect.provide(BunPlatformLive)),
  )
  it.live("a failing driver catalog leaves model.list working and shows in extension health", () =>
    Effect.gen(function* () {
      const catalogDrivers: LoadedExtension = {
        manifest: { id: ExtensionId.make("@test/catalog-drivers") },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          modelDrivers: [
            {
              id: "local",
              name: "Local server",
              resolveModel: () => Effect.succeed(stubModel),
              listModels: () => Effect.die(new Error("connect ECONNREFUSED 127.0.0.1:11434")),
            },
            {
              id: "working",
              name: "Working",
              resolveModel: () => Effect.succeed(stubModel),
              listModels: () =>
                Effect.succeed([
                  Model.make({
                    id: ModelId.make("working/one"),
                    name: "One",
                    provider: ProviderId.make("working"),
                  }),
                ]),
            },
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client } = yield* createRpcClient(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [catalogDrivers] }),
          )
          const models = yield* client.model.list({})
          expect(models.map((model) => model.id)).toContain(ModelId.make("working/one"))
          const status = yield* client.extension.listStatus({})
          expect(status._tag).toBe("Degraded")
          if (status._tag !== "Degraded") return
          const degraded = status.degradedExtensions.find(
            (extension) => extension.manifest.id === "@test/catalog-drivers",
          )
          expect(degraded?.issues).toEqual([
            {
              _tag: "ModelCatalogFailed",
              driverId: "local",
              error: "connect ECONNREFUSED 127.0.0.1:11434",
            },
          ])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  // Health reads the failures the last catalog run recorded; it does not run
  // every driver's catalog again on each read.
  it.live("extension health reports the last catalog run without listing again", () =>
    Effect.gen(function* () {
      let localCalls = 0
      const catalogDrivers: LoadedExtension = {
        manifest: { id: ExtensionId.make("@test/catalog-count") },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          modelDrivers: [
            {
              id: "local",
              name: "Local server",
              resolveModel: () => Effect.succeed(stubModel),
              listModels: () =>
                Effect.suspend(() => {
                  localCalls += 1
                  return Effect.die(new Error("connect ECONNREFUSED 127.0.0.1:11434"))
                }),
            },
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client } = yield* createRpcClient(
            createE2ELayer({ ...e2ePreset, providerLayer, extensions: [catalogDrivers] }),
          )
          // No run yet: health runs the catalog once, then reads that record.
          const first = yield* client.extension.listStatus({})
          const second = yield* client.extension.listStatus({})
          expect(localCalls).toBe(1)
          yield* client.model.list({})
          expect(localCalls).toBe(2)
          const third = yield* client.extension.listStatus({})
          expect(localCalls).toBe(2)
          for (const status of [first, second, third]) {
            expect(status._tag).toBe("Degraded")
            if (status._tag !== "Degraded") continue
            expect(status.degradedExtensions.flatMap((extension) => extension.issues)).toEqual([
              {
                _tag: "ModelCatalogFailed",
                driverId: "local",
                error: "connect ECONNREFUSED 127.0.0.1:11434",
              },
            ])
          }
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC listSlashCommands lists slash-decorated requests only", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/public-filter")
      const ext: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "test",
        contributions: {
          requests: [
            request({
              id: "visible",
              slash: { name: "visible", description: "visible" },
              input: Schema.String,
              output: Schema.Void,
              execute: () => Effect.void,
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [ext],
            cwd: "/tmp",
          })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual(["visible"])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC handlers receive ExtensionContext authority without intent ceremony", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/read-context")
      const ext: GentExtension = {
        manifest: { id: extensionId },
        setup: registerContributions({
          requests: [
            request({
              id: "inspect",
              input: Schema.Void,
              output: Schema.Struct({
                hasSessionMutations: Schema.Boolean,
                hasAgentRun: Schema.Boolean,
                extensionContextFollowUpQueued: Schema.Boolean,
              }),
              execute: () =>
                Effect.gen(function* () {
                  const extensionCtx = yield* ExtensionContext
                  const followUpExit = yield* Effect.exit(
                    extensionCtx.Session.send({
                      delivery: "queue",
                      sourceId: "rpc",
                      content: "queued",
                    }),
                  )
                  return {
                    hasSessionMutations: false,
                    hasAgentRun: false,
                    extensionContextFollowUpQueued: Exit.isSuccess(followUpExit),
                  }
                }),
            }),
          ],
        }),
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [...e2ePreset.extensionInputs, ext],
            cwd: "/tmp",
          })
          const result = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "inspect",
            // oxlint-disable-next-line effect/noNullish -- Keep the absent field in this schema boundary fixture.
            input: undefined,
          })
          expect(result).toEqual({
            hasSessionMutations: false,
            hasAgentRun: false,
            extensionContextFollowUpQueued: true,
          })
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC request invokes slash-decorated requests through the transport boundary", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/public-shadow")
      const projectExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "project",
        sourcePath: "project",
        contributions: {
          requests: [
            request({
              id: "shadowed",
              slash: { name: "shadowed private", description: "shadowed private" },
              description: "shadowed private",
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: (input: { value: string }) => Effect.succeed({ value: input.value }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [projectExt],
            cwd: "/tmp",
          })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual(["shadowed"])
          const result = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "shadowed",
            input: { value: "hi" },
          })
          expect(result).toEqual({ value: "hi" })
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC listSlashCommands omits lower-scope slash request shadowed by project request", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/public-rpc-shadow")
      const builtinExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "builtin",
        contributions: {
          requests: [
            request({
              id: "shadowed",
              slash: { name: "shadowed", description: "shadowed" },
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: () => Effect.succeed({ value: "builtin" }),
            }),
          ],
        },
      }
      const projectExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "project",
        sourcePath: "project",
        contributions: {
          requests: [
            request({
              id: "shadowed",
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: (input) => Effect.succeed({ value: input.value }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          // The harness loads every input as builtin, so the two scopes go in through a profile.
          const profile = yield* makeProfile("/tmp", [builtinExt, projectExt])
          expect(profile.resolved.failedExtensions).toEqual([])
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer: SessionProfileCache.Test(new Map([["/tmp", profile]])),
            cwd: "/tmp",
          })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual([])
          // The project request answers, not the builtin one it shadows.
          const answer = yield* client.extension.request({
            sessionId,
            branchId,
            extensionId,
            capabilityId: "shadowed",
            input: { value: "project" },
          })
          expect(answer).toEqual({ value: "project" })
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC listSlashCommands omits lower-scope slash request shadowed by project tool", () =>
    Effect.gen(function* () {
      const extensionId = ExtensionId.make("@test/public-tool-shadow")
      const builtinExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "builtin",
        sourcePath: "builtin",
        contributions: {
          requests: [
            request({
              id: "shadowed",
              slash: { name: "shadowed", description: "shadowed" },
              input: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: () => Effect.succeed({ value: "builtin" }),
            }),
          ],
        },
      }
      const projectExt: LoadedExtension = {
        manifest: { id: extensionId },
        scope: "project",
        sourcePath: "project",
        contributions: {
          tools: [
            tool({
              id: "shadowed",
              description: "shadowed tool",
              params: Schema.Struct({ value: Schema.String }),
              output: Schema.Struct({ value: Schema.String }),
              execute: (input) => Effect.succeed({ value: input.value }),
            }),
          ],
        },
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          // The harness loads every input as builtin, so the two scopes go in through a profile.
          const profile = yield* makeProfile("/tmp", [builtinExt, projectExt])
          expect(profile.resolved.failedExtensions).toEqual([])
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer: SessionProfileCache.Test(new Map([["/tmp", profile]])),
            cwd: "/tmp",
          })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual([])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
  it.live("RPC listSlashCommands resolves commands from the requested session profile", () =>
    Effect.gen(function* () {
      const alphaCwd = "/tmp/gent-alpha-profile"
      const betaCwd = "/tmp/gent-beta-profile"
      const alphaExt = makeCommandExtension("@test/alpha-profile", "alpha")
      const betaExt = makeCommandExtension("@test/beta-profile", "beta")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const alphaProfile = yield* makeProfile(alphaCwd, [alphaExt])
          const betaProfile = yield* makeProfile(betaCwd, [betaExt])
          const sessionProfileCacheLayer = SessionProfileCache.Test(
            new Map([
              [alphaCwd, alphaProfile],
              [betaCwd, betaProfile],
            ]),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer,
            cwd: alphaCwd,
          })
          const alpha = { sessionId, branchId }
          const beta = yield* client.session.create({ cwd: betaCwd })
          const alphaCommands = yield* client.extension.listSlashCommands({
            sessionId: alpha.sessionId,
          })
          const betaCommands = yield* client.extension.listSlashCommands({
            sessionId: beta.sessionId,
          })
          expect(alphaCommands.map((command) => command.name)).toEqual(["alpha"])
          expect(betaCommands.map((command) => command.name)).toEqual(["beta"])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )
})

// ── namespaced client ───────────────────────────────────────────────────────

describe("namespaced client", () => {
  test("namespaced client exposes every RPC key from GentRpcs", () => {
    const handlers = new Map<string, () => Effect.Effect<void>>(
      [...GentRpcs.requests.keys()].map((key) => [key, () => Effect.void]),
    )
    const flat: GentRpcClient = new Proxy(Object.create(null), {
      get: (_target, property) => {
        if (!Predicate.isString(property)) return Option.getOrUndefined(Option.none())
        return Option.getOrUndefined(Option.fromNullishOr(handlers.get(property)))
      },
    })
    const namespaced = makeNamespacedClient(flat)
    expect(namespaced.session).toBe(namespaced.session)

    for (const key of GentRpcs.requests.keys()) {
      const separator = key.indexOf(".")
      expect(separator, `RPC key is not namespaced: ${key}`).not.toBe(-1)
      if (separator === -1) return
      const namespace = key.slice(0, separator)
      const method = key.slice(separator + 1)
      // oxlint-disable-next-line effect/noAs -- this test verifies the dynamic RPC namespace boundary
      const namespaceClient = namespaced[namespace as keyof typeof namespaced]
      expect(namespaceClient).toBeDefined()
      expect(namespace in namespaced).toBe(true)
      expect(method in namespaceClient).toBe(true)
      // oxlint-disable-next-line effect/noAs, effect/noUnsafeDictionaryType -- this test verifies the dynamic RPC method boundary
      const methodClient = (namespaceClient as Readonly<Record<string, unknown>>)[method]
      expect(methodClient).toBeDefined()
      expect(methodClient).toBe(handlers.get(key))
    }
  })

  it.live("namespaced client attaches workspace header to RPC effects", () =>
    Effect.gen(function* () {
      let observed = Option.none<string>()
      const flat: GentRpcClient = new Proxy(Object.create(null), {
        get: (_target, property) => {
          if (property !== "session.list") return Option.getOrUndefined(Option.none())
          return () =>
            Effect.gen(function* () {
              const headers = yield* RpcClient.CurrentHeaders
              observed = Option.fromNullishOr(headers[WORKSPACE_ID_HEADER])
              return []
            })
        },
      })
      const client = makeNamespacedClient(flat, workspaceHeadersForCwd("/tmp/gent"))
      yield* client.session.list()
      expect(observed).toEqual(Option.some(workspaceIdForCwd("/tmp/gent")))
    }),
  )

  it.live("namespaced client attaches workspace header to RPC streams", () =>
    Effect.gen(function* () {
      let observed = Option.none<string>()
      const flat: GentRpcClient = new Proxy(Object.create(null), {
        get: (_target, property) => {
          if (property !== "session.watchRuntime") return Option.getOrUndefined(Option.none())
          return () =>
            Stream.fromEffect(
              Effect.gen(function* () {
                const headers = yield* RpcClient.CurrentHeaders
                observed = Option.fromNullishOr(headers[WORKSPACE_ID_HEADER])
              }),
            )
        },
      })
      const client = makeNamespacedClient(flat, workspaceHeadersForCwd("/tmp/gent"))
      yield* Stream.runDrain(
        client.session.watchRuntime({
          sessionId: SessionId.make("session-stream-header"),
          branchId: BranchId.make("branch-stream-header"),
        }),
      )
      expect(observed).toEqual(Option.some(workspaceIdForCwd("/tmp/gent")))
    }),
  )
})

describe("a resumed call that had taken its answer", () => {
  it.scopedLive(
    "is reported as interrupted after a restart, not run again past its approval",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-taken-restart-")
        const dbPath = `${tempDir}/gent.db`
        const approvedRuns = MutableRef.make(0)
        const running = yield* Deferred.make<void>()
        // Asks first; once approved, the first run holds until the process stops.
        const extension: LoadedExtension = {
          manifest: { id: ExtensionId.make("@test/approved-work") },
          scope: "builtin",
          sourcePath: "test",
          artifactIdentity: LoadedArtifactIdentity.make("@test/approved-work@artifact-1"),
          contributions: {
            tools: [
              tool({
                id: "approved_work",
                description: "Ask, then do work that must not happen twice",
                params: Schema.Struct({}),
                output: Schema.String,
                execute: Effect.fn("approved_work")(function* () {
                  const ctx = yield* ExtensionContext
                  const decision = yield* ctx.Interaction.approve({ text: "do the work?" })
                  if (!decision.approved) return "declined"
                  MutableRef.update(approvedRuns, (n) => n + 1)
                  if (MutableRef.get(approvedRuns) > 1) return "worked again"
                  yield* Deferred.succeed(running, void 0)
                  return yield* Effect.never
                }),
              }),
            ],
          },
        }
        const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensions: [extension],
            durableApproval: true,
            storagePath: dbPath,
          })

        // First process: the call parks, the answer comes, the approved work
        // starts, and the process stops while it runs.
        const firstProvider = yield* LanguageModelLayers.sequence([
          toolCallStep("approved_work", {}),
        ])
        const target = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(layerFor(firstProvider.layer))
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            const presented = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.filterMap((envelope) => {
                if (envelope.event._tag === "InteractionPresented")
                  return Result.succeed(envelope.event)
                return Result.failVoid
              }),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )
            yield* client.message.send({ sessionId, branchId, content: "do the work" })
            const dialog = Array.from(yield* Fiber.join(presented))[0]
            if (Predicate.isUndefined(dialog)) return yield* Effect.die("no dialog")
            yield* client.interaction.respondInteraction({
              sessionId,
              branchId,
              requestId: dialog.requestId,
              approved: true,
            })
            yield* Deferred.await(running)
            return { sessionId, branchId }
          }).pipe(Effect.timeout("8 seconds")),
        )

        // Second process: the turn resumes and the model reads the interruption.
        const secondProvider = yield* LanguageModelLayers.sequence([textStep("work was cut short")])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(layerFor(secondProvider.layer))
            const snapshot = yield* waitFor(
              client.session.getSnapshot(target),
              (current) =>
                current.runtime._tag === "Idle" &&
                current.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.parts.some(
                      (part) => part.type === "text" && part.text === "work was cut short",
                    ),
                ),
              5_000,
              "the resumed turn answered",
            )
            const results = snapshot.messages.flatMap((message) =>
              message.parts.filter((part) => part.type === "tool-result"),
            )
            expect(results).toHaveLength(1)
            expect(results[0]).toMatchObject({
              isFailure: true,
              result: { reason: "Interrupted" },
            })
          }).pipe(Effect.timeout("8 seconds")),
        )
        expect(MutableRef.get(approvedRuns)).toBe(1)
      }),
    20_000,
  )
})

describe("a call answered while a sibling call still ran", () => {
  it.scopedLive(
    "takes its answer after a restart; only the sibling is reported as interrupted",
    () =>
      Effect.gen(function* () {
        const tempDir = yield* makeTempDirectoryScoped("gent-sibling-restart-")
        const dbPath = `${tempDir}/gent.db`
        const approvedRuns = MutableRef.make(0)
        const siblingRunning = yield* Deferred.make<void>()
        // One call asks; its sibling in the same step never finishes, so the
        // step never ends before the process stops.
        const extension: LoadedExtension = {
          manifest: { id: ExtensionId.make("@test/sibling-work") },
          scope: "builtin",
          sourcePath: "test",
          artifactIdentity: LoadedArtifactIdentity.make("@test/sibling-work@artifact-1"),
          contributions: {
            tools: [
              tool({
                id: "asking_work",
                description: "Ask, then do work",
                params: Schema.Struct({}),
                output: Schema.String,
                execute: Effect.fn("asking_work")(function* () {
                  const ctx = yield* ExtensionContext
                  const decision = yield* ctx.Interaction.approve({ text: "do the work?" })
                  if (!decision.approved) return "declined"
                  MutableRef.update(approvedRuns, (n) => n + 1)
                  return "worked"
                }),
              }),
              tool({
                id: "long_sibling",
                description: "Work that outlives the process",
                params: Schema.Struct({}),
                output: Schema.String,
                execute: Effect.fn("long_sibling")(function* () {
                  yield* Deferred.succeed(siblingRunning, void 0)
                  return yield* Effect.never
                }),
              }),
            ],
          },
        }
        const layerFor = (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) =>
          createE2ELayer({
            ...e2ePreset,
            providerLayer,
            extensions: [extension],
            durableApproval: true,
            storagePath: dbPath,
          })

        // First process: the call asks and is answered while its sibling
        // runs, and the process stops before the step ends.
        const firstProvider = yield* LanguageModelLayers.sequence([
          multiToolCallStep(
            { toolName: "asking_work", input: {} },
            { toolName: "long_sibling", input: {} },
          ),
        ])
        const target = yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(layerFor(firstProvider.layer))
            const { sessionId, branchId } = yield* client.session.create({ cwd: "/tmp" })
            const presented = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.filterMap((envelope) => {
                if (envelope.event._tag === "InteractionPresented")
                  return Result.succeed(envelope.event)
                return Result.failVoid
              }),
              Stream.take(1),
              Stream.runCollect,
              Effect.forkScoped,
            )
            yield* client.message.send({ sessionId, branchId, content: "do both" })
            const dialog = Array.from(yield* Fiber.join(presented))[0]
            if (Predicate.isUndefined(dialog)) return yield* Effect.die("no dialog")
            yield* Deferred.await(siblingRunning)
            yield* client.interaction.respondInteraction({
              sessionId,
              branchId,
              requestId: dialog.requestId,
              approved: true,
            })
            return { sessionId, branchId }
          }).pipe(Effect.timeout("8 seconds")),
        )
        expect(MutableRef.get(approvedRuns)).toBe(0)

        // Second process: the answered call takes its answer; the sibling was cut short.
        const secondProvider = yield* LanguageModelLayers.sequence([textStep("both settled")])
        yield* Effect.scoped(
          Effect.gen(function* () {
            const { client } = yield* createRpcClient(layerFor(secondProvider.layer))
            const snapshot = yield* waitFor(
              client.session.getSnapshot(target),
              (current) =>
                current.runtime._tag === "Idle" &&
                current.messages.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.parts.some(
                      (part) => part.type === "text" && part.text === "both settled",
                    ),
                ),
              5_000,
              "the resumed turn answered",
            )
            const results = snapshot.messages.flatMap((message) =>
              message.parts.filter((part) => part.type === "tool-result"),
            )
            expect(results).toHaveLength(2)
            expect(results.find((part) => part.name === "asking_work")).toMatchObject({
              isFailure: false,
              result: "worked",
            })
            expect(results.find((part) => part.name === "long_sibling")).toMatchObject({
              isFailure: true,
              result: { reason: "Interrupted" },
            })
          }).pipe(Effect.timeout("8 seconds")),
        )
        expect(MutableRef.get(approvedRuns)).toBe(1)
      }),
    20_000,
  )
})
