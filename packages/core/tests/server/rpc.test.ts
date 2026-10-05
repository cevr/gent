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
  Ref,
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
  WORKSPACE_ID_HEADER,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
} from "../../src/server/workspace-rpc"
import {
  BranchId,
  ExtensionId,
  MessageId,
  ProcessGenerationId,
  RequestId,
  SessionId,
} from "../../src/domain/ids"
import { describe, expect, it } from "effect-bun-test"
import { TestClock } from "effect/testing"
import { RpcClient } from "effect/rpc"
import {
  finishPart,
  textDeltaPart,
  Auth,
  AuthError,
  serializeAuthStore,
  AuthApi,
  AuthInfo,
  ListAuthProvidersPayload,
  textStep,
  toolCallStep,
} from "../../src/runtime/provider"
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
  type E2ELayerConfig,
  fixedSessionProfiles,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  modelCatalogFixture,
  registerContributions,
  type SequenceStep,
  testTurnExtension,
  TEST_MODEL_ID,
  waitFor,
} from "../../src/test-utils/harness"
import { e2ePreset, testAgent } from "../helpers/test-preset"
import { Model as AiModel, type LanguageModel } from "effect/ai"
import { BunServices } from "@effect/platform-bun"
import {
  AuthMethod,
  CredentialSlot,
  type ModelDriverContribution,
  ProviderAuthError,
} from "../../src/domain/driver.js"
import {
  DeleteAuthKeyInput,
  type ExtensionHealthSnapshot,
  ExtensionStatusScope,
  SetAuthKeyInput,
  SetDriverOverrideInput,
} from "../../src/server/rpc.js"
import {
  defineResource,
  ExtensionLoadError,
  type GentExtension,
  hook,
  LoadedArtifactIdentity,
  type LoadedExtension,
  type SessionDeletedInput,
} from "../../src/domain/extension.js"
import {
  defineExtension,
  ExtensionContext,
  ExtensionHost,
  request,
  tool,
} from "@gent/core/extensions/api"
import { CapabilityError } from "../../src/domain/capability"
import {
  buildScopeResources,
  ExtensionRegistry,
  resolveExtensions,
  type SessionProfile,
  SessionProfileCache,
} from "../../src/runtime/extension-host"
import { SessionStorage, SqliteStorage } from "../../src/storage/storage"
import { StorageError } from "../../src/domain/errors"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { MinimumLogLevel } from "effect/References"
import { type Message, messagePartsText } from "../../src/domain/message"
import { ConfigService, RuntimeEnvironment } from "../../src/runtime/config"
import { type LogEvent, WideEventLogger } from "effect-wide-event"

// ── rpc contract schemas ────────────────────────────────────────────────────

const decodeSuccess = (key: string, value: Readonly<Record<string, string>>) => {
  const rpc = Option.getOrThrow(Option.fromUndefinedOr(GentRpcs.requests.get(key)))
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
    const { sessionId } = yield* client.session.create({})
    return { client, driverOverrides, sessionId }
  })

  it.live("driver.list returns the registered drivers and agents", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, sessionId } = yield* clientWithConfig
        const before = yield* client.driver.list({ sessionId })
        expect(before).toBeInstanceOf(DriverListResult)
        // The preset's `testTurnExtension` contributes the test driver, so the
        // registered list is non-empty.
        expect(before.drivers.length).toBeGreaterThan(0)
        expect(before.agents.map((agent) => agent.name)).toContain(DEFAULT_AGENT_NAME)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.set persists an override in the config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, driverOverrides, sessionId } = yield* clientWithConfig
        const someModel = (yield* client.driver.list({ sessionId })).drivers[0]
        if (Predicate.isUndefined(someModel)) {
          return yield* Effect.die(new Error("no model driver registered in test layer"))
        }
        yield* client.driver.set({
          agentName: DEFAULT_AGENT_NAME,
          driver: { id: someModel.id },
          sessionId,
        })
        expect((yield* driverOverrides)[DEFAULT_AGENT_NAME]?.id).toBe(someModel.id)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  test("driver.set names a driver; a ref with no id is not a second way to clear", () => {
    const decode = Schema.decodeUnknownExit(SetDriverOverrideInput)
    const named = { agentName: "main", sessionId: "session-a" }
    expect(Exit.isFailure(decode({ ...named, driver: { _tag: "Model" } }))).toBe(true)
    expect(Exit.isSuccess(decode({ ...named, driver: { _tag: "Model", id: "anthropic" } }))).toBe(
      true,
    )
  })

  it.live("driver.set rejects unknown driver id with NotFoundError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, sessionId } = yield* clientWithConfig
        const result = yield* client.driver
          .set({
            agentName: DEFAULT_AGENT_NAME,
            driver: { id: "definitely-not-registered" },
            sessionId,
          })
          .pipe(Effect.flip)
        expect(result._tag).toBe("NotFoundError")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.clear removes an existing override", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, driverOverrides, sessionId } = yield* clientWithConfig
        const someModel = (yield* client.driver.list({ sessionId })).drivers[0]
        if (Predicate.isUndefined(someModel)) {
          return yield* Effect.die(new Error("no model driver registered in test layer"))
        }
        yield* client.driver.set({
          agentName: DEFAULT_AGENT_NAME,
          driver: { id: someModel.id },
          sessionId,
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
          agents: e2ePreset.agents,
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

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

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
      list: Effect.succeed([]),
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
      list: Effect.fail(new AuthError({ message: "read failed" })),
      get: () => Effect.fail(new AuthError({ message: "read failed" })),
      set: () => Effect.void,
      remove: () => Effect.void,
    }),
  ),
)
const stubModel = AiModel.make("test", "model", LanguageModelLayers.failing)

class ProfileDriverResource extends Context.Service<
  ProfileDriverResource,
  { readonly value: string }
>()("@gent/core/tests/server/rpc.test/ProfileDriverResource") {}

const profileDriverModel = new Model({
  id: ModelId.make("profile-driver/model"),
  name: "Profile driver model",
  provider: ProviderId.make("profile-driver"),
  contextLength: 128_000,
})

const profileDriverExtension = defineExtension({
  id: "test-profile-driver",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register(
      "resource",
      defineResource({
        id: "test-profile-driver/resource",
        scope: "process",
        layer: Layer.succeed(ProfileDriverResource, ProfileDriverResource.of({ value: "profile" })),
      }),
    )
    yield* host.register("modelDriver", {
      id: "profile-driver",
      name: "Profile driver",
      resolveModel: () => Effect.succeed(stubModel),
      listModels: () =>
        Effect.gen(function* () {
          const resource = yield* Effect.serviceOption(ProfileDriverResource)
          if (Option.isNone(resource)) {
            return yield* new ProviderAuthError({ message: "profile resource missing" })
          }
          return [profileDriverModel]
        }),
      auth: {
        methods: [AuthMethod.make({ type: "oauth", label: "Profile OAuth" })],
        authorize: () => Effect.succeedSome({ url: "http://example.com/auth", method: "code" }),
        callback: () =>
          Effect.gen(function* () {
            const resource = yield* Effect.serviceOption(ProfileDriverResource)
            if (Option.isNone(resource)) {
              return yield* new ProviderAuthError({ message: "profile resource missing" })
            }
          }),
      },
    })
  }),
})

const profileDriverHarness = () =>
  createRpcHarness({
    providerLayer: LanguageModelLayers.debug(),
    agents: [],
    extensionInputs: [profileDriverExtension],
  })

describe("driver callbacks use the selected profile", () => {
  it.live("model.list provides the session profile's resource services", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, sessionId } = yield* profileDriverHarness()
        const models = yield* client.model.list({ sessionId })
        expect(models.map((model) => model.id)).toEqual([profileDriverModel.id])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("extension health provides profile services for an uncached catalog read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, sessionId } = yield* profileDriverHarness()
        const status = yield* client.extension.listStatus({
          scope: { _tag: "Session", id: sessionId },
        })
        expect(status._tag).toBe("Healthy")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("a retained auth callback keeps the profile resource services", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, sessionId } = yield* profileDriverHarness()
        const authorization = yield* client.auth.authorize({
          sessionId,
          provider: "profile-driver",
          method: 0,
        })
        if (Predicate.isNull(authorization)) return yield* Effect.die("authorization missing")
        yield* client.auth.callback({
          sessionId,
          provider: "profile-driver",
          method: 0,
          authorizationId: authorization.authorizationId,
          code: "callback-code",
        })
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

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
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [authDriversExtension],
          }),
        )
        const session = yield* client.session.create({ cwd: process.cwd() })
        const required = (providers: ReadonlyArray<{ provider: string; required: boolean }>) =>
          providers
            .values()
            .filter((entry) => entry.required)
            .map((entry) => entry.provider)
            .toArray()
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
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("a named agent adds its model's provider; other agents do not", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [authDriversExtension],
          }),
        )
        const required = (providers: ReadonlyArray<{ provider: string; required: boolean }>) =>
          providers
            .values()
            .filter((entry) => entry.required)
            .map((entry) => entry.provider)
            .toArray()
        const { sessionId } = yield* client.session.create({})
        expect(required(yield* client.auth.listProviders({ sessionId }))).toEqual(["anthropic"])
        expect(
          required(
            yield* client.auth.listProviders({ agentName: AgentName.make("helper"), sessionId }),
          ),
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
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [authDriversExtension],
            configServiceLayer: Layer.succeedContext(configContext),
          }),
        )
        const session = yield* client.session.create({ cwd: process.cwd() })
        // The model stays `anthropic/…`; the turn routes through `otherprov`.
        const { sessionId } = session
        yield* client.driver.set({
          agentName: DEFAULT_AGENT_NAME,
          driver: { id: "otherprov" },
          sessionId,
        })
        yield* client.auth.setKey({ provider: "otherprov", key: "sk-other", sessionId })
        const providers = yield* client.auth.listProviders({ sessionId })
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
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [envDrivers],
          }).pipe(Layer.provide(envLayer)),
        )
        const { sessionId } = yield* client.session.create({})
        const providers = yield* client.auth.listProviders({ sessionId })
        const anthropic = providers.find((entry) => entry.provider === "anthropic")
        expect(anthropic?.hasKey).toBe(true)
        expect(anthropic?.source).toBe("env")
        expect(anthropic?.required).toBe(true)
        const other = providers.find((entry) => entry.provider === "otherprov")
        expect(other?.hasKey).toBe(false)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
  it.live("signing out for a deleted session fails and keeps the key", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const kept = yield* client.session.create({})
        const session = yield* client.session.create({})
        yield* client.session.delete({ sessionId: session.sessionId })
        yield* client.auth.setKey({
          provider: "anthropic",
          key: "sk-kept",
          sessionId: kept.sessionId,
        })
        const error = yield* Effect.flip(
          client.auth.deleteKey({ provider: "anthropic", sessionId: session.sessionId }),
        )
        expect(error._tag).toBe("NotFoundError")
        const providers = yield* client.auth.listProviders({ sessionId: kept.sessionId })
        const anthropic = providers.find((entry) => entry.provider === "anthropic")
        expect(anthropic?.source).toBe("stored")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})
describe("auth sign-in prompts", () => {
  it.live(
    "a prompt whose variable is set is not asked, and the key's answers reach the driver",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // The server reads env through the ConfigProvider: the region is set, the account is not.
          const envLayer = ConfigProvider.layer(
            ConfigProvider.fromEnv({ env: { PROMPTED_REGION: "eu" } }),
          )
          const accountPrompt = {
            key: "accountId",
            label: "Account ID",
            placeholder: "e.g. 0123abcd",
            env: "PROMPTED_ACCOUNT_ID",
          }
          // The driver names its one model after the key and the answers it receives.
          const prompted: LoadedExtension = {
            manifest: { id: ExtensionId.make("@test/prompted") },
            scope: "builtin",
            sourcePath: "test",
            contributions: {
              modelDrivers: [
                {
                  id: "prompted",
                  name: "Prompted",
                  resolveModel: () => Effect.succeed(stubModel),
                  listModels: (_catalog, authInfo) => {
                    if (Predicate.isUndefined(authInfo) || authInfo._tag !== "Api") {
                      return Effect.succeed([])
                    }
                    const answers = Object.entries(authInfo.metadata ?? {}).map(
                      ([key, value]) => `${key}=${value}`,
                    )
                    return Effect.succeed([
                      Model.make({
                        id: ModelId.make("prompted/model"),
                        name: [authInfo.key, ...answers].join(" "),
                        provider: ProviderId.make("prompted"),
                      }),
                    ])
                  },
                  auth: {
                    methods: [
                      AuthMethod.make({
                        type: "api",
                        label: "Prompted key",
                        prompts: [
                          accountPrompt,
                          { key: "region", label: "Region", env: "PROMPTED_REGION" },
                        ],
                      }),
                    ],
                  },
                },
              ],
            },
          }
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              agents: e2ePreset.agents,
              providerLayer,
              extensions: [prompted],
            }).pipe(Layer.provide(envLayer)),
          )
          const { sessionId } = yield* client.session.create({})
          const listedName = client.model
            .list({ sessionId })
            .pipe(
              Effect.map((models) =>
                models.filter((model) => model.provider === "prompted").map((model) => model.name),
              ),
            )

          const methods = yield* client.auth.listMethods({ sessionId })
          expect(methods["prompted"]?.map((method) => method.prompts)).toEqual([[accountPrompt]])

          yield* client.auth.setKey({ provider: "prompted", key: "pk-plain", sessionId })
          expect(yield* listedName).toEqual(["pk-plain"])
          yield* client.auth.setKey({
            provider: "prompted",
            key: "pk-answered",
            metadata: { accountId: "acct-7" },
            sessionId,
          })
          expect(yield* listedName).toEqual(["pk-answered accountId=acct-7"])
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  // A turn fills a base URL's variables by one rule; a sign-in applies the
  // same rule to the answers it stores, so the user learns of a bad answer
  // on `/auth`, not on the first turn.
  it.live(
    "a base URL answer a turn would refuse is refused at sign-in with the turn's message, and nothing is stored",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const catalog = yield* modelCatalogFixture
          // Base URLs as models.dev writes Neon's (a variable holds the origin)
          // and Infomaniak's (one path segment).
          const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            gateway: {
              id: "gateway",
              name: "Gateway",
              env: ["GATEWAY_BASE_URL", "GATEWAY_KEY"],
              npm: "@ai-sdk/openai-compatible",
              api: "${GATEWAY_BASE_URL}/v1",
              models: { m: { name: "M", tool_call: true } },
            },
            product: {
              id: "product",
              name: "Product",
              env: ["PRODUCT_ID", "PRODUCT_KEY"],
              npm: "@ai-sdk/openai-compatible",
              api: "https://product.test/2/ai/${PRODUCT_ID}/openai/v1",
              models: { m: { name: "M", tool_call: true } },
            },
          })
          yield* catalog.serve("api.json", body, '"generic-url-1"')
          const store = Context.get(yield* Layer.build(Auth.Test()), Auth)
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              ...e2ePreset,
              providerLayer,
              modelCatalogHttpLayer: catalog.layer,
              authLayer: Layer.succeed(Auth, store),
            }),
          )
          const { sessionId } = yield* client.session.create({})
          const signIn = (provider: string, metadata: Record<string, string>) =>
            client.auth.setKey({ provider, key: "sk-url", metadata, sessionId }).pipe(
              Effect.as("saved"),
              Effect.catch((error) => Effect.succeed(`${error._tag}: ${error.message}`)),
            )
          const signedIn = store.list

          const gatewayRefused =
            "ProviderAuthError: Gateway needs GATEWAY_BASE_URL as an https URL with no user, password, query or fragment; sign in again with /auth"
          for (const value of ["http://insecure.gw.test/gw?x=1", "gw", "https://gw.test?"]) {
            expect(yield* signIn("gateway", { GATEWAY_BASE_URL: value })).toBe(gatewayRefused)
          }
          expect(yield* signIn("product", { PRODUCT_ID: ".." })).toBe(
            'ProviderAuthError: Product needs PRODUCT_ID as one URL component, not ".."; sign in again with /auth',
          )
          expect(yield* signedIn).toEqual([])

          // What a turn takes, the sign-in takes: a path in a component is
          // percent-encoded into that one component.
          expect(yield* signIn("gateway", { GATEWAY_BASE_URL: "https://gw.test/team" })).toBe(
            "saved",
          )
          expect(yield* signIn("product", { PRODUCT_ID: "12/../evil.example" })).toBe("saved")
          expect(yield* signedIn).toEqual(["gateway", "product"])
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )
})
describe("auth persistence RPC failures", () => {
  it.live("each auth call surfaces its store failure", () => {
    const rows: ReadonlyArray<{
      readonly call: string
      readonly root: (providerLayer: Layer.Layer<LanguageModel.LanguageModel>) => E2ELayerConfig
      readonly run: (
        client: GentNamespacedClient,
        sessionId: SessionId,
      ) => Effect.Effect<
        Exit.Exit<unknown, unknown>,
        Effect.Error<ReturnType<GentNamespacedClient["auth"]["authorize"]>>
      >
      readonly message: string
    }> = [
      {
        call: "auth.listProviders",
        root: (providerLayer) => ({
          ...e2ePreset,
          providerLayer,
          authLayer: failingReadAuthStoreLayer,
        }),
        run: (client, sessionId) => Effect.exit(client.auth.listProviders({ sessionId })),
        message: "read failed",
      },
      {
        call: "auth.setKey",
        root: (providerLayer) => ({
          ...e2ePreset,
          providerLayer,
          authLayer: failingAuthStoreLayer,
        }),
        run: (client, sessionId) =>
          Effect.exit(client.auth.setKey({ provider: "openai", key: "sk-test", sessionId })),
        message: "Failed to set auth",
      },
      {
        call: "auth.deleteKey",
        root: (providerLayer) => ({
          ...e2ePreset,
          providerLayer,
          authLayer: failingAuthStoreLayer,
        }),
        run: (client, sessionId) =>
          Effect.exit(client.auth.deleteKey({ provider: "openai", sessionId })),
        message: "Failed to delete auth",
      },
      {
        call: "auth.authorize",
        root: (providerLayer) => ({
          agents: e2ePreset.agents,
          providerLayer,
          extensions: makePersistingExtensions(),
          authLayer: failingAuthStoreLayer,
        }),
        run: (client, sessionId) =>
          Effect.exit(
            client.auth.authorize({ sessionId, provider: "persisting-authorize", method: 0 }),
          ),
        message: "Failed to persist auth",
      },
      {
        call: "auth.callback",
        root: (providerLayer) => ({
          agents: e2ePreset.agents,
          providerLayer,
          extensions: makePersistingExtensions(),
          authLayer: failingAuthStoreLayer,
        }),
        run: (client, sessionId) =>
          Effect.gen(function* () {
            const authorization = yield* client.auth.authorize({
              sessionId,
              provider: "persisting-oauth",
              method: 0,
            })
            if (Predicate.isNull(authorization)) return yield* Effect.die("auth setup failed")
            return yield* Effect.exit(
              client.auth.callback({
                sessionId,
                provider: "persisting-oauth",
                method: 0,
                authorizationId: authorization.authorizationId,
                code: "sk-callback",
              }),
            )
          }),
        message: "Failed to persist auth",
      },
    ]
    return Effect.forEach(
      rows,
      (row) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            const { client } = yield* createRpcClient(createE2ELayer(row.root(providerLayer)))
            const { sessionId } = yield* client.session.create({})
            const exit = yield* row.run(client, sessionId)
            expect({ call: row.call, exit: exit._tag }).toEqual({
              call: row.call,
              exit: "Failure",
            })
            if (exit._tag === "Failure") {
              expect(exit.cause.toString()).toContain(row.message)
            }
          }),
        ),
      { discard: true },
    ).pipe(Effect.timeout("8 seconds"))
  })
})
describe("provider login", () => {
  // Reads try the owner's key first, so a key stored under the sharing
  // driver's own id would sit behind a stale owner key.
  it.live("a key or a login through a driver that shares a sign-in is stored under its owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stale = AuthApi.make({ type: "api", key: "sk-stale" })
        const auth = yield* Effect.provide(Effect.service(Auth), Auth.Test({ gate: stale }))
        const sharing = defineExtension({
          id: "@test/shared-sign-in",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.register("modelDriver", {
              id: "gate",
              name: "Gate",
              resolveModel: () => Effect.succeed(stubModel),
              auth: { methods: [AuthMethod.make({ type: "api", label: "Gate key" })] },
            })
            yield* host.register("modelDriver", {
              id: "gate-plus",
              name: "Gate Plus",
              credentialFrom: "gate",
              resolveModel: () => Effect.succeed(stubModel),
              auth: {
                methods: [AuthMethod.make({ type: "api", label: "Gate Plus key" })],
                authorize: (ctx) =>
                  ctx.persist({ type: "api", key: "sk-login" }).pipe(Effect.as(Option.none())),
              },
            })
          }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensionInputs: [sharing],
            authLayer: Layer.succeed(Auth, auth),
          }),
        )
        const stored = Effect.forEach(["gate", "gate-plus"], (id) =>
          Effect.map(auth.get(id), (info) => {
            if (Predicate.isUndefined(info) || info.type !== "api") return "none"
            return info.key
          }),
        )

        const { sessionId } = yield* client.session.create({})
        yield* client.auth.setKey({ provider: "gate-plus", key: "sk-set", sessionId })
        expect(yield* stored).toEqual(["sk-set", "none"])

        yield* client.auth.authorize({ sessionId, provider: "gate-plus", method: 0 })
        expect(yield* stored).toEqual(["sk-login", "none"])

        yield* client.auth.setKey({ provider: "gate-plus", key: "sk-session", sessionId })
        expect(yield* stored).toEqual(["sk-session", "none"])

        yield* client.session.delete({ sessionId })
        const error = yield* Effect.flip(
          client.auth.setKey({ provider: "gate-plus", key: "sk-gone", sessionId }),
        )
        expect(error._tag).toBe("NotFoundError")
        expect(yield* stored).toEqual(["sk-session", "none"])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  // A driver may share a sign-in in one profile and own its own in another.
  it.live("a key typed in a session goes to the owner its profile names, not the launch one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = yield* Effect.provide(Effect.service(Auth), Auth.Test({}))
        const driver = (id: string, credentialFrom: Option.Option<string>) => {
          const base: ModelDriverContribution = {
            id,
            name: id,
            resolveModel: () => Effect.succeed(stubModel),
            auth: { methods: [AuthMethod.make({ type: "api", label: `${id} key` })] },
          }
          return Option.match(credentialFrom, {
            onNone: () => base,
            onSome: (owner) => ({ ...base, credentialFrom: owner }),
          })
        }
        const loaded = (id: string, drivers: ReadonlyArray<ModelDriverContribution>) =>
          ({
            manifest: { id: ExtensionId.make(id) },
            scope: "builtin",
            sourcePath: "test",
            contributions: { modelDrivers: [...drivers] },
          }) satisfies LoadedExtension
        const launch = loaded("@test/launch-sharing", [
          driver("other", Option.none()),
          driver("gate", Option.some("other")),
        ])
        const launchCwd = yield* makeTempDirectoryScoped("gent-key-launch-")
        const launchProfile = yield* makeProfile(launchCwd, [launch])
        const profileCwd = yield* makeTempDirectoryScoped("gent-key-owner-")
        const profile = yield* makeProfile(profileCwd, [
          loaded("@test/session-own", [driver("gate", Option.none())]),
        ])
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [],
            cwd: launchCwd,
            authLayer: Layer.succeed(Auth, auth),
            sessionProfileCacheLayer: fixedSessionProfiles(
              new Map([
                [launchCwd, launchProfile],
                [profileCwd, profile],
              ]),
            ),
          }),
        )
        const stored = Effect.forEach(["gate", "other"], (id) =>
          Effect.map(auth.get(id), (info) => {
            if (Predicate.isUndefined(info) || info.type !== "api") return "none"
            return info.key
          }),
        )
        const { sessionId } = yield* client.session.create({ cwd: profileCwd })
        yield* client.auth.setKey({ provider: "gate", key: "sk-own", sessionId })
        expect(yield* stored).toEqual(["sk-own", "none"])
        const launchSession = yield* client.session.create({ cwd: launchCwd })
        yield* client.auth.setKey({
          provider: "gate",
          key: "sk-launch",
          sessionId: launchSession.sessionId,
        })
        expect(yield* stored).toEqual(["sk-own", "sk-launch"])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("a session logs in through the drivers of its own profile, not the launch profile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const profileCwd = yield* makeTempDirectoryScoped("gent-login-")
        const projectDriver: LoadedExtension = {
          manifest: { id: ExtensionId.make("@test/project-driver") },
          scope: "project",
          sourcePath: "test",
          contributions: {
            modelDrivers: [
              {
                id: "project-oauth",
                name: "Project OAuth",
                resolveModel: () => Effect.succeed(stubModel),
                auth: {
                  methods: [AuthMethod.make({ type: "oauth", label: "OAuth" })],
                  authorize: () =>
                    Effect.succeedSome({ url: "http://example.com/auth", method: "code" }),
                  callback: (ctx) => ctx.persist({ type: "api", key: ctx.code ?? "" }),
                },
              },
            ],
          },
        }
        const profile = yield* makeProfile(profileCwd, [projectDriver])
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer: fixedSessionProfiles(new Map([[profileCwd, profile]])),
          }),
        )
        const { sessionId } = yield* client.session.create({ cwd: profileCwd })

        expect(Object.keys(yield* client.auth.listMethods({ sessionId }))).toEqual([
          "project-oauth",
        ])
        const launchSession = yield* client.session.create({})
        expect(
          Object.keys(yield* client.auth.listMethods({ sessionId: launchSession.sessionId })),
        ).toEqual([])
        const authorization = yield* client.auth.authorize({
          sessionId,
          provider: "project-oauth",
          method: 0,
        })
        if (Predicate.isNull(authorization)) return yield* Effect.die("authorize gave no link")
        yield* client.auth.callback({
          sessionId,
          provider: "project-oauth",
          method: 0,
          authorizationId: authorization.authorizationId,
          code: "sk-project",
        })
        const providers = yield* client.auth.listProviders({ sessionId })
        expect(providers.find((entry) => entry.provider === "project-oauth")?.hasKey).toBe(true)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("authorization refuses methods for the wrong immutable credential target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = Context.get(yield* Layer.build(Auth.Test()), Auth)
        const work = CredentialSlot.make("work")
        let authorizations = 0
        const extension = defineExtension({
          id: "@test/method-target",
          setup: Effect.gen(function* () {
            yield* (yield* ExtensionHost).register("modelDriver", {
              id: "method-target",
              name: "Method Target",
              resolveModel: () => Effect.succeed(stubModel),
              auth: {
                methods: [
                  AuthMethod.make({ type: "oauth", label: "Primary", credentialTarget: "default" }),
                  AuthMethod.make({ type: "oauth", label: "Named", credentialTarget: "named" }),
                  AuthMethod.make({ type: "oauth", label: "Either" }),
                ],
                authorize: (ctx) =>
                  Effect.gen(function* () {
                    authorizations++
                    yield* ctx.persist({ type: "api", key: "fake-login" })
                    return Option.none()
                  }),
              },
            })
          }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensionInputs: [extension],
            authLayer: Layer.succeed(Auth, auth),
          }),
        )
        const { sessionId } = yield* client.session.create({})
        const namedForDefault = yield* Effect.exit(
          client.auth.authorize({ sessionId, provider: "method-target", method: 1 }),
        )
        const defaultForNamed = yield* Effect.exit(
          client.auth.authorize({ sessionId, provider: "method-target", method: 0, slot: work }),
        )
        expect(Exit.isFailure(namedForDefault)).toBe(true)
        expect(Exit.isFailure(defaultForNamed)).toBe(true)
        expect(authorizations).toBe(0)
        expect(yield* auth.listSlots("method-target")).toEqual([])
        const methods = yield* client.auth.listMethods({ sessionId })
        expect(methods["method-target"]?.map((method) => method.label)).toEqual([
          "Primary",
          "Named",
          "Either",
        ])
        yield* client.auth.authorize({ sessionId, provider: "method-target", method: 0 })
        yield* client.auth.authorize({
          sessionId,
          provider: "method-target",
          method: 1,
          slot: work,
        })
        yield* client.auth.authorize({
          sessionId,
          provider: "method-target",
          method: 2,
          slot: CredentialSlot.make("legacy-named"),
        })
        yield* client.auth.authorize({ sessionId, provider: "method-target", method: 2 })
        expect(authorizations).toBe(4)
        expect((yield* auth.listSlots("method-target")).length).toBe(3)
      }),
    ).pipe(Effect.timeout("8 seconds")),
  )
  it.live("named set and delete through an alias preserve every default and other label", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = Context.get(yield* Layer.build(Auth.Test()), Auth)
        const personal = CredentialSlot.make("personal")
        const work = CredentialSlot.make("work")
        yield* auth.set("alias-slots", AuthApi.make({ type: "api", key: "fake-default" }))
        yield* auth.set(
          "alias-slots",
          AuthApi.make({ type: "api", key: "fake-legacy-named" }),
          personal,
        )
        yield* auth.set("owner-slots", AuthApi.make({ type: "api", key: "fake-work" }), work)
        const extension = defineExtension({
          id: "@test/alias-slots",
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            const owner: ModelDriverContribution = {
              id: "owner-slots",
              name: "Slots",
              resolveModel: () => Effect.succeed(stubModel),
              auth: { methods: [AuthMethod.make({ type: "api", label: "Key" })] },
            }
            yield* host.register("modelDriver", owner)
            yield* host.register("modelDriver", {
              ...owner,
              id: "alias-slots",
              credentialFrom: owner.id,
            })
          }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensionInputs: [extension],
            authLayer: Layer.succeed(Auth, auth),
          }),
        )
        const { sessionId } = yield* client.session.create({})
        const rows = yield* client.auth.listProviders({ sessionId })
        const summaries = rows.find((row) => row.provider === "owner-slots")?.credentials ?? []
        expect(summaries.map((entry) => entry.slot).sort()).toEqual([
          CredentialSlot.make("default"),
          personal,
          work,
        ])
        expect(
          summaries.every(
            (entry) =>
              !Object.keys(entry).some((key) =>
                ["key", "accountId", "access", "refresh", "directory"].includes(key),
              ),
          ),
        ).toBe(true)
        yield* client.auth.setKey({
          sessionId,
          provider: "alias-slots",
          slot: personal,
          key: "fake-new",
        })
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("owner-slots", personal)),
            (stored) => stored.type === "api" && stored.key === "fake-new",
          ),
        ).toBe(true)
        yield* client.auth.deleteKey({ sessionId, provider: "alias-slots", slot: personal })
        expect(Predicate.isUndefined(yield* auth.get("owner-slots", personal))).toBe(true)
        expect(Predicate.isUndefined(yield* auth.get("alias-slots", personal))).toBe(true)
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("alias-slots")),
            (stored) => stored.type === "api" && stored.key === "fake-default",
          ),
        ).toBe(true)
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("owner-slots", work)),
            (stored) => stored.type === "api" && stored.key === "fake-work",
          ),
        ).toBe(true)
      }),
    ).pipe(Effect.timeout("8 seconds")),
  )

  it.live("an expired named login cannot write into the default credential", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = Context.get(yield* Layer.build(Auth.Test()), Auth)
        const slot = CredentialSlot.make("personal")
        yield* auth.set("expired-slots", AuthApi.make({ type: "api", key: "fake-default" }))
        const extension = defineExtension({
          id: "@test/expired-slots",
          setup: Effect.gen(function* () {
            yield* (yield* ExtensionHost).register("modelDriver", {
              id: "expired-slots",
              name: "Expired Slots",
              resolveModel: () => Effect.succeed(stubModel),
              auth: {
                methods: [AuthMethod.make({ type: "oauth", label: "Login" })],
                authorize: () =>
                  Effect.succeedSome({ url: "http://localhost/login", method: "code" }),
                callback: (ctx) => ctx.persist({ type: "api", key: "fake-expired-callback" }),
              },
            })
          }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensionInputs: [extension],
            authLayer: Layer.succeed(Auth, auth),
          }),
        )
        const { sessionId } = yield* client.session.create({})
        const login = yield* client.auth.authorize({
          sessionId,
          provider: "expired-slots",
          method: 0,
          slot,
        })
        if (Predicate.isNull(login)) return yield* Effect.die("expected pending login")
        yield* TestClock.adjust("11 minutes")
        const result = yield* Effect.exit(
          client.auth.callback({
            sessionId,
            provider: "expired-slots",
            method: 0,
            authorizationId: login.authorizationId,
          }),
        )
        expect(Exit.isFailure(result)).toBe(true)
        expect(Predicate.isUndefined(yield* auth.get("expired-slots", slot))).toBe(true)
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("expired-slots")),
            (stored) => stored.type === "api" && stored.key === "fake-default",
          ),
        ).toBe(true)
      }),
    ).pipe(Effect.provide(TestClock.layer()), Effect.timeout("8 seconds")),
  )

  it.live("a callback retains its original named owner, method and inputs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const auth = yield* Effect.provide(Effect.service(Auth), Auth.Test())
        const slot = CredentialSlot.make("personal")
        const legacy = AuthInfo.cases.Api.make({ type: "api", key: "fake-default" })
        yield* auth.set("slot-oauth", legacy)
        const login = defineExtension({
          id: "@test/slot-login",
          setup: Effect.gen(function* () {
            yield* (yield* ExtensionHost).register("modelDriver", {
              id: "slot-oauth",
              name: "Slot OAuth",
              resolveModel: () => Effect.succeed(stubModel),
              auth: {
                methods: [AuthMethod.make({ type: "oauth", label: "Import" })],
                authorize: () =>
                  Effect.succeedSome({ url: "http://localhost/auth", method: "code" }),
                callback: (ctx) =>
                  Effect.gen(function* () {
                    expect(ctx.methodIndex).toBe(0)
                    expect(ctx.slot).toBe(slot)
                    expect(ctx.inputs?.["directory"]).toBe("/nonexistent/fake-import")
                    yield* ctx.persist({ type: "api", key: "fake-named" })
                  }),
              },
            })
          }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensionInputs: [login],
            authLayer: Layer.succeed(Auth, auth),
          }),
        )
        const { sessionId } = yield* client.session.create({})
        const launch = yield* client.auth.authorize({
          sessionId,
          provider: "slot-oauth",
          method: 0,
          slot,
          inputs: { directory: "/nonexistent/fake-import" },
        })
        if (Predicate.isNull(launch)) return yield* Effect.die("authorization absent")
        yield* client.auth.callback({
          sessionId,
          provider: "changed-ui-selection",
          method: 1,
          authorizationId: launch.authorizationId,
        })
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("slot-oauth", slot)),
            (info) => info.type === "api" && info.key === "fake-named",
          ),
        ).toBe(true)
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("slot-oauth")),
            (info) => info.type === "api" && info.key === legacy.key,
          ),
        ).toBe(true)
        yield* client.auth.setKey({ sessionId, provider: "slot-oauth", slot, key: "fake-replaced" })
        yield* client.auth.deleteKey({ sessionId, provider: "slot-oauth", slot })
        expect(Predicate.isUndefined(yield* auth.get("slot-oauth", slot))).toBe(true)
        expect(
          Option.exists(
            Option.fromUndefinedOr(yield* auth.get("slot-oauth")),
            (info) => info.type === "api" && info.key === legacy.key,
          ),
        ).toBe(true)
        const expired = yield* Effect.exit(
          client.auth.callback({
            sessionId,
            provider: "slot-oauth",
            method: 0,
            authorizationId: launch.authorizationId,
          }),
        )
        expect(Exit.isFailure(expired)).toBe(true)
      }),
    ).pipe(Effect.timeout("8 seconds")),
  )
  // A login's pending state lives on the driver instance that authorized it.
  // A config edit between the two calls supersedes the session's profile;
  // the callback still reaches the instance that holds the login.
  it.live("a login finishes on the profile that began it, across a config edit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const project = yield* makeTempDirectoryScoped("gent-login-edit-")
        const home = yield* makeTempDirectoryScoped("gent-login-edit-home-")
        const loginDriver = defineExtension({
          id: "@test/pending-login",
          setup: Effect.gen(function* () {
            const pending = new Set<string>()
            yield* (yield* ExtensionHost).register("modelDriver", {
              id: "pending-oauth",
              name: "Pending OAuth",
              resolveModel: () => Effect.succeed(stubModel),
              auth: {
                methods: [AuthMethod.make({ type: "oauth", label: "OAuth" })],
                authorize: (ctx) =>
                  Effect.sync(() => {
                    pending.add(ctx.authorizationId)
                    return Option.some({ url: "http://example.com/auth", method: "code" as const })
                  }),
                callback: (ctx) =>
                  Effect.gen(function* () {
                    if (!pending.delete(ctx.authorizationId)) {
                      return yield* new ProviderAuthError({ message: "login state missing" })
                    }
                    yield* ctx.persist({ type: "api", key: ctx.code ?? "" })
                  }),
              },
            })
          }),
        })
        const toggle = defineExtension({ id: "@test/login-toggle", setup: Effect.void })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensionInputs: [loginDriver, toggle],
            configServiceLayer: ConfigService.Live.pipe(
              Layer.provide(RuntimeEnvironment.Live({ cwd: project, home })),
              Layer.provide(BunPlatformLive),
            ),
          }),
        )
        const { sessionId } = yield* client.session.create({ cwd: project })
        const authorization = yield* client.auth.authorize({
          sessionId,
          provider: "pending-oauth",
          method: 0,
        })
        if (Predicate.isNull(authorization)) return yield* Effect.die("authorize gave no link")
        const projectConfig = path.join(project, ".gent", "config.json")
        yield* fs.makeDirectory(path.dirname(projectConfig), { recursive: true })
        yield* fs.writeFileString(
          projectConfig,
          encodeJson({ disabledExtensions: ["@test/login-toggle"] }),
        )
        yield* client.auth.callback({
          sessionId,
          provider: "pending-oauth",
          method: 0,
          authorizationId: authorization.authorizationId,
          code: "sk-edited",
        })
        const providers = yield* client.auth.listProviders({ sessionId })
        expect(providers.find((entry) => entry.provider === "pending-oauth")?.hasKey).toBe(true)
      }).pipe(Effect.timeout("8 seconds")),
    ).pipe(Effect.provide(BunServices.layer)),
  )

  // Two callbacks for one login: the one that succeeds first must not
  // retire the superseded profile under the one still running.
  it.live("a finished callback keeps the login's profile until a slower callback ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const project = yield* makeTempDirectoryScoped("gent-login-race-")
        const home = yield* makeTempDirectoryScoped("gent-login-race-home-")
        const slowStarted = yield* Deferred.make<void>()
        const slowGate = yield* Deferred.make<void>()
        const loginDriver = defineExtension({
          id: "@test/racing-login",
          setup: Effect.gen(function* () {
            // Set when this instance's profile retires.
            const retired = MutableRef.make(false)
            const host = yield* ExtensionHost
            yield* host.register(
              "resource",
              // oxlint-disable-next-line effect/noAs -- The fixture erases a resource with no service output at the contribution boundary.
              defineResource({
                id: "test/racing-login/instance",
                scope: "process",
                layer: Layer.effectDiscard(
                  Effect.addFinalizer(() => Effect.sync(() => MutableRef.set(retired, true))),
                ),
              }) as never,
            )
            yield* host.register("modelDriver", {
              id: "racing-oauth",
              name: "Racing OAuth",
              resolveModel: () => Effect.succeed(stubModel),
              auth: {
                methods: [AuthMethod.make({ type: "oauth", label: "OAuth" })],
                authorize: () =>
                  Effect.succeedSome({ url: "http://example.com/auth", method: "code" as const }),
                callback: (ctx) =>
                  Effect.gen(function* () {
                    if (ctx.code === "sk-slow") {
                      yield* Deferred.succeed(slowStarted, void 0)
                      yield* Deferred.await(slowGate)
                    }
                    if (MutableRef.get(retired)) {
                      return yield* new ProviderAuthError({ message: "login instance retired" })
                    }
                    yield* ctx.persist({ type: "api", key: ctx.code ?? "" })
                  }),
              },
            })
          }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(
          createE2ELayer({
            agents: e2ePreset.agents,
            providerLayer,
            extensionInputs: [loginDriver],
            configServiceLayer: ConfigService.Live.pipe(
              Layer.provide(RuntimeEnvironment.Live({ cwd: project, home })),
              Layer.provide(BunPlatformLive),
            ),
          }),
        )
        const { sessionId } = yield* client.session.create({ cwd: project })
        const authorization = yield* client.auth.authorize({
          sessionId,
          provider: "racing-oauth",
          method: 0,
        })
        if (Predicate.isNull(authorization)) return yield* Effect.die("authorize gave no link")
        const projectConfig = path.join(project, ".gent", "config.json")
        yield* fs.makeDirectory(path.dirname(projectConfig), { recursive: true })
        yield* fs.writeFileString(
          projectConfig,
          encodeJson({ disabledExtensions: ["@test/racing-login"] }),
        )
        // Reading the providers builds the new profile, which supersedes the login's.
        yield* client.auth.listProviders({ sessionId })
        const callback = (code: string) =>
          client.auth.callback({
            sessionId,
            provider: "racing-oauth",
            method: 0,
            authorizationId: authorization.authorizationId,
            code,
          })
        const slow = yield* callback("sk-slow").pipe(Effect.exit, Effect.forkChild)
        yield* Deferred.await(slowStarted)
        yield* callback("sk-fast")
        yield* Deferred.succeed(slowGate, void 0)
        const slowExit = yield* Fiber.join(slow)
        expect(Exit.isSuccess(slowExit)).toBe(true)
      }).pipe(Effect.timeout("8 seconds")),
    ).pipe(Effect.provide(BunServices.layer)),
  )
})

// ── extension command rpcs ──────────────────────────────────────────────────

class ProfileToken extends Context.Service<
  ProfileToken,
  {
    readonly read: Effect.Effect<string, never, never>
  }
>()("@gent/core/tests/server/rpc.test/ProfileToken") {}
/** `SessionProfileCache.Live` over `home` with its own storage, built in the scope that builds it. */
const liveSessionProfiles = (
  home: string,
  extensions: Parameters<typeof SessionProfileCache.Live>[0]["extensions"],
) =>
  Layer.unwrap(
    Effect.map(Effect.scope, (scope) =>
      SessionProfileCache.Live({
        home,
        failOnExtensionFailure: true,
        platform: "test",
        extensions,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            BunPlatformLive,
            ConfigService.Test(),
            SqliteStorage.MemoryWithSql.pipe(Layer.provide(BunPlatformLive)),
          ),
        ),
        Layer.orDie,
        Layer.provide(Layer.succeed(Scope.Scope, scope)),
      ),
    ),
  )
const expectExtensionProtocolFailure = (cause: Cause.Cause<unknown>, message?: string) => {
  const error = Cause.squash(cause)
  expect(Schema.is(ExtensionProtocolError)(error)).toBe(true)
  if (!Schema.is(ExtensionProtocolError)(error)) return
  expect(error._tag).toBe("ExtensionProtocolError")
  if (!Predicate.isUndefined(message)) expect(error.message).toBe(message)
}
/** A cwd's profile built from the given extensions, for a test profile cache. */
const makeProfile = (cwd: string, extensions: ReadonlyArray<LoadedExtension>) =>
  Effect.gen(function* () {
    const resolved = resolveExtensions(extensions)
    const registryContext = yield* Layer.build(ExtensionRegistry.fromResolved(resolved))
    const host = Context.merge(Context.makeUnsafe<unknown>(new Map()), registryContext)
    const started = yield* buildScopeResources({
      extensions: resolved.extensions,
      scope: "process",
      context: host,
      buildContext: (_extension, before) => before,
      parent: yield* Effect.scope,
      restore: (effect) => effect,
    })
    const layerContext = started.context
    const process = new Map(
      Array.from(started.services, ([id, context]) => [id, { key: `${cwd}:${id}`, context }]),
    )
    return {
      cwd,
      resolved,
      layerContext,
      registryService: Context.get(layerContext, ExtensionRegistry),
      baseSections: [],
      resourceBuilds: { host, process },
      generationId: ProcessGenerationId.make("test"),
    } satisfies SessionProfile
  })

// ── extension command fixtures ──────────────────────────────────────────────

const invoked: Array<{
  args: string
  sessionId: string
  cwd: string
}> = []
// Server-visible slash commands are slash-decorated requests.
class RefusedError extends Schema.TaggedError<RefusedError>()("RefusedError", {
  message: Schema.String,
}) {}
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
        // A structured input and output, so the round trip decodes both.
        input: Schema.Struct({ value: Schema.String }),
        output: Schema.Struct({ value: Schema.String }),
        execute: (input: { value: string }) => Effect.succeed({ value: input.value }),
      }),
      // A request without `slash`: callable, never listed as a command.
      request({
        id: "plain",
        input: Schema.String,
        output: Schema.Void,
        execute: () => Effect.void,
      }),
      // A request whose handler refuses, with its own reason.
      request({
        id: "refuse",
        input: Schema.String,
        output: Schema.Void,
        execute: () => Effect.fail(new RefusedError({ message: "Nothing to do on this branch" })),
      }),
    ],
  }),
}
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

describe("extension requests and slash commands", () => {
  it.live("RPC lists slash-decorated requests only and round-trips a request", () =>
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
            cwd: "/nonexistent/gent-extension-request-session",
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

          const echoed = yield* client.extension.request({
            sessionId,
            extensionId: ExtensionId.make("@test/commands"),
            capabilityId: "noop",
            input: { value: "hi" },
            branchId,
          })
          expect(echoed).toEqual({ value: "hi" })

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
          cwd: "/nonexistent/gent-extension-request-session",
        },
      ])
    }),
  )

  it.live("RPC slash request can queue follow-up through ExtensionContext service", () =>
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
              slash: {
                trigger: "queue",
                name: "Queue Follow Up",
                description: "Queue follow-up request",
              },
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
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [ext],
            cwd: "/nonexistent/gent-extension-queue-follow-up",
          })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual(["queue"])
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
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [ext],
            cwd: "/nonexistent/gent-extension-queue-follow-up-warm",
          })
          const assistantReplies = (
            messages: ReadonlyArray<{ role: string; parts: Message["parts"] }>,
          ) =>
            messages
              .values()
              .filter((message) => message.role === "assistant")
              .map((message) => messagePartsText(message.parts))
              .toArray()
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

  // A client shows the failure to a reader: the error says the extension's
  // own reason, without the loop's and the runtime's wrappers.
  for (const [capabilityId, reason] of [
    ["refuse", "Nothing to do on this branch"],
    ["missing", '"@test/commands" has no request "missing"'],
  ] as const) {
    it.live(`RPC request ${capabilityId} fails with the extension's own reason`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [TestCommandsExtension],
          })
          const result = yield* Effect.exit(
            client.extension.request({
              sessionId,
              branchId,
              extensionId: ExtensionId.make("@test/commands"),
              capabilityId,
              input: "x",
            }),
          )
          expect(Exit.isFailure(result)).toBe(true)
          if (Exit.isFailure(result)) expectExtensionProtocolFailure(result.cause, reason)
        }).pipe(Effect.timeout("4 seconds")),
      ),
    )
  }

  // No extension ran and no turn failed: the reason is the one to show.
  it.live("RPC request whose profile cannot be built fails with the reason", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broken = yield* Ref.make(false)
        const working = Context.get(yield* Layer.build(fixedSessionProfiles()), SessionProfileCache)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensions: [],
          sessionProfileCacheLayer: Layer.succeed(
            SessionProfileCache,
            SessionProfileCache.of({
              resolve: (cwd) =>
                Effect.gen(function* () {
                  if (yield* Ref.get(broken)) {
                    return yield* Effect.die(
                      new Error("profile unreadable: /nonexistent/broken-config"),
                    )
                  }
                  return yield* working.resolve(cwd)
                }),
              reload: working.reload,
            }),
          ),
        })
        yield* Ref.set(broken, true)
        const result = yield* Effect.exit(
          client.extension.request({
            sessionId,
            branchId,
            extensionId: ExtensionId.make("@test/commands"),
            capabilityId: "greet",
            input: "x",
          }),
        )
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expectExtensionProtocolFailure(
            result.cause,
            "profile unreadable: /nonexistent/broken-config",
          )
        }
      }).pipe(Effect.timeout("4 seconds")),
    ),
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
            cwd: "/nonexistent/gent-extension-request-missing-branch",
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
            cwd: "/nonexistent/gent-extension-request-first",
          })
          const first = { sessionId, branchId }
          const second = yield* client.session.create({
            cwd: "/nonexistent/gent-extension-request-second",
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
          const profile = yield* makeProfile("/nonexistent/gent-test-profile-cwd", [
            builtinExt,
            projectExt,
          ])
          expect(profile.resolved.failedExtensions).toEqual([])
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer: fixedSessionProfiles(
              new Map([["/nonexistent/gent-test-profile-cwd", profile]]),
            ),
            cwd: "/nonexistent/gent-test-profile-cwd",
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
          const profile = yield* makeProfile("/nonexistent/gent-test-profile-cwd", [
            builtinExt,
            projectExt,
          ])
          expect(profile.resolved.failedExtensions).toEqual([])
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId } = yield* createRpcHarness({
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [],
            sessionProfileCacheLayer: fixedSessionProfiles(
              new Map([["/nonexistent/gent-test-profile-cwd", profile]]),
            ),
            cwd: "/nonexistent/gent-test-profile-cwd",
          })
          const commands = yield* client.extension.listSlashCommands({ sessionId })
          expect(commands.map((command) => command.name)).toEqual([])
        }).pipe(Effect.timeout("4 seconds")),
      )
    }),
  )

  it.live("RPC listSlashCommands resolves commands from the requested session profile", () =>
    Effect.gen(function* () {
      const alphaCwd = "/nonexistent/gent-alpha-profile"
      const betaCwd = "/nonexistent/gent-beta-profile"
      const alphaExt = makeCommandExtension("@test/alpha-profile", "alpha")
      const betaExt = makeCommandExtension("@test/beta-profile", "beta")
      yield* Effect.scoped(
        Effect.gen(function* () {
          const alphaProfile = yield* makeProfile(alphaCwd, [alphaExt])
          const betaProfile = yield* makeProfile(betaCwd, [betaExt])
          const sessionProfileCacheLayer = fixedSessionProfiles(
            new Map([
              [alphaCwd, alphaProfile],
              [betaCwd, betaProfile],
            ]),
          )
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: e2ePreset.agents,
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

describe("extension health", () => {
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
          })
          const status = yield* client.extension.listStatus({
            scope: { _tag: "Session", id: sessionId },
          })
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
        const broken = configIssues(
          yield* client.extension.listStatus({ scope: { _tag: "Session", id: sessionId } }),
        )
        expect(broken).toHaveLength(1)
        expect(broken[0]).toMatchObject({ _tag: "ActivationFailed", phase: "load" })
        expect(broken[0]?.error).toContain(projectConfig)

        // Fixed on disk, same server: the next read has no config issue.
        yield* fs.writeFileString(projectConfig, '{ "disabledExtensions": ["x"] }')
        expect(
          configIssues(
            yield* client.extension.listStatus({ scope: { _tag: "Session", id: sessionId } }),
          ),
        ).toEqual([])
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
            createE2ELayer({
              agents: e2ePreset.agents,
              providerLayer,
              extensions: [catalogDrivers],
            }),
          )
          const { sessionId } = yield* client.session.create({})
          const models = yield* client.model.list({ sessionId })
          expect(models.map((model) => model.id)).toContain(ModelId.make("working/one"))
          const status = yield* client.extension.listStatus({
            scope: { _tag: "Session", id: sessionId },
          })
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
            createE2ELayer({
              agents: e2ePreset.agents,
              providerLayer,
              extensions: [catalogDrivers],
            }),
          )
          // No run yet: health runs the catalog once, then reads that record.
          const first = yield* client.extension.listStatus({ scope: { _tag: "Launch" } })
          const second = yield* client.extension.listStatus({ scope: { _tag: "Launch" } })
          expect(localCalls).toBe(1)
          const { sessionId } = yield* client.session.create({})
          yield* client.model.list({ sessionId })
          expect(localCalls).toBe(2)
          const third = yield* client.extension.listStatus({ scope: { _tag: "Launch" } })
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
})

describe("event subscriptions", () => {
  it.live("RPC event subscriptions mark the move from replay to live", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("synced reply"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensions: [],
          cwd: "/nonexistent/gent-extension-stream-synchronized",
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
})

describe("extension branch forks", () => {
  it.live(
    "an extension forks its branch at a message, and the same request id forks once",
    () =>
      Effect.gen(function* () {
        const extensionId = ExtensionId.make("@test/fork-at")
        const ForkInput = Schema.Struct({ atMessageId: MessageId, requestId: RequestId })
        const ext: LoadedExtension = {
          manifest: { id: extensionId },
          scope: "builtin",
          sourcePath: "test",
          contributions: {
            requests: [
              request({
                id: "fork-at",
                input: ForkInput,
                output: BranchId,
                execute: (input) =>
                  Effect.gen(function* () {
                    const ctx = yield* ExtensionContext
                    const forked = yield* ctx.Session.forkBranch({
                      atMessageId: input.atMessageId,
                      requestId: input.requestId,
                      name: "rewound",
                    })
                    return forked.branchId
                  }).pipe(
                    Effect.mapError(
                      (cause) =>
                        new CapabilityError({
                          extensionId,
                          capabilityId: "fork-at",
                          reason: cause.message,
                        }),
                    ),
                  ),
              }),
            ],
          },
        }
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("first answer"),
          textStep("second answer"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensions: [ext],
          cwd: "/nonexistent/gent-extension-fork",
        })
        for (const [index, content] of ["first", "second"].entries()) {
          yield* client.message.send({ sessionId, branchId, content })
          yield* waitFor(
            client.message.list({ branchId }),
            (messages) =>
              messages.filter((message) => message.role === "assistant").length === index + 1,
            4000,
            `reply to ${content}`,
          )
        }
        const before = yield* client.message.list({ branchId })
        const firstAnswer = before.find(
          (message) =>
            message.role === "assistant" && messagePartsText(message.parts) === "first answer",
        )
        expect(firstAnswer).toBeDefined()
        const fork = (requestId: string) =>
          client.extension
            .request({
              sessionId,
              branchId,
              extensionId,
              capabilityId: "fork-at",
              input: { atMessageId: firstAnswer?.id ?? "", requestId },
            })
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(BranchId)))
        const forked = yield* fork("fork-1")
        expect(forked).not.toBe(branchId)
        // A repeat of the request answers the branch the first call made.
        expect(yield* fork("fork-1")).toBe(forked)
        const branches = yield* client.branch.list({ sessionId })
        expect(branches.map((branch) => branch.id).sort()).toEqual([branchId, forked].sort())
        const made = branches.find((branch) => branch.id === forked)
        expect(made?.parentBranchId).toBe(branchId)
        expect(made?.name).toBe("rewound")
        // The fork holds the conversation up to the message; the old branch keeps all of it.
        const copied = yield* client.message.list({ branchId: forked })
        expect(copied.map((message) => messagePartsText(message.parts))).toEqual([
          "first",
          "first answer",
        ])
        expect((yield* client.message.list({ branchId })).length).toBe(before.length)
        // The session's active branch did not move.
        const session = (yield* client.session.list()).find((found) => found.id === sessionId)
        expect(session?.activeBranchId).toBe(branchId)
      }).pipe(Effect.scoped, Effect.timeout("8 seconds")),
    10_000,
  )
})

describe("session threads", () => {
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
            agents: e2ePreset.agents,
            providerLayer,
            extensions: [ext],
            cwd: "/nonexistent/gent-child-thread",
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
          cwd: "/nonexistent/gent-handoff-thread",
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
          reload: () => Effect.void,
        }),
      )
      return { layer }
    })

  it.live("a handoff to a project without the parent's agent fails before it is stored", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const projectCwd = "/nonexistent/gent-handoff-agent-project"
        const otherCwd = "/nonexistent/gent-handoff-agent-other"
        const profiles = yield* reviewerProfiles(projectCwd)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client } = yield* createRpcHarness({
          agents: e2ePreset.agents,
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

  // A config edit rebuilds the host cwd's profile; the session that stored no
  // cwd runs its turns there, so its admission and its route read it too.
  it.live("a session with no cwd reads the host cwd's profile as it is now, not at launch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hostCwd = "/nonexistent/gent-no-cwd-host"
        const auditor = AgentName.make("auditor")
        const agentsOf = (
          id: string,
          agents: ReadonlyArray<AgentDefinition>,
        ): ReadonlyArray<LoadedExtension> => [
          {
            manifest: { id: ExtensionId.make(id) },
            scope: "project",
            sourcePath: "test",
            contributions: { agents },
          },
        ]
        const launch = yield* makeProfile(
          hostCwd,
          agentsOf("@test/launch-agents", [
            AgentDefinition.make({ name: reviewerAgent, model: ModelId.make("test/first") }),
          ]),
        )
        const edited = yield* makeProfile(
          hostCwd,
          agentsOf("@test/edited-agents", [
            AgentDefinition.make({ name: reviewerAgent, model: ModelId.make("test/edited") }),
            AgentDefinition.make({ name: auditor }),
          ]),
        )
        const current = yield* Ref.make(launch)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensions: [],
          sessionProfileCacheLayer: Layer.succeed(
            SessionProfileCache,
            SessionProfileCache.of({ resolve: () => Ref.get(current), reload: () => Effect.void }),
          ),
          cwd: hostCwd,
        })
        const reviewing = yield* client.session.create({ admission: { agent: reviewerAgent } })
        yield* Ref.set(current, edited)
        const view = yield* client.session.get({ sessionId: reviewing.sessionId })
        expect(view?.resolvedModelId).toBe(ModelId.make("test/edited"))
        const auditing = yield* client.session.create({ admission: { agent: auditor } })
        const stored = yield* client.session.get({ sessionId: auditing.sessionId })
        expect(stored?.admission?.agent).toBe(auditor)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

describe("extension resources", () => {
  it.scoped("RPC request resolves resources from SessionProfileCache.Live", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped()
      const profileCwd = yield* fs.makeTempDirectoryScoped()
      const ext: GentExtension = {
        manifest: { id: ExtensionId.make("@test/live-profile-service-request") },
        setup: Effect.gen(function* () {
          const host = yield* ExtensionHost
          const token = defineResource({
            id: "test/extension-commands-rpc/live-profile-token",
            scope: "process",
            layer: Layer.succeed(
              ProfileToken,
              ProfileToken.of({
                read: Effect.succeed(`live:${host.cwd}`),
              }),
            ),
          })
          yield* host.register("resource", token)
          yield* host.register(
            "request",
            request({
              id: "read-live-profile-token",
              input: Schema.String,
              output: Schema.String,
              resources: [token],
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
          const sessionProfileCacheLayer = liveSessionProfiles(home, [ext])
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            agents: e2ePreset.agents,
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

  it.scoped(
    "a branch resource is built from the session's profile, not the launch cwd's profile",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped()
        const profileCwd = yield* fs.makeTempDirectoryScoped()
        const ext: GentExtension = {
          manifest: { id: ExtensionId.make("@test/branch-profile-token") },
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            const token = defineResource({
              id: "test/extension-commands-rpc/branch-profile-token",
              scope: "branch",
              layer: Layer.succeed(
                ProfileToken,
                ProfileToken.of({ read: Effect.succeed(`branch:${host.cwd}`) }),
              ),
            })
            yield* host.register("resource", token)
            yield* host.register(
              "request",
              request({
                id: "read-branch-profile-token",
                input: Schema.String,
                output: Schema.String,
                resources: [token],
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
            const sessionProfileCacheLayer = liveSessionProfiles(home, [ext])
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            // The launch cwd's profile does not load the extension: only the
            // profile for the session's cwd knows its branch resource.
            const { client, sessionId, branchId } = yield* createRpcHarness({
              agents: e2ePreset.agents,
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
        // Sorts after the broken one and needs the service it would have built.
        yield* fs.writeFileString(
          path.join(userDir, "dependent-branch.ts"),
          `import { Context, Effect, Layer, Schema } from "effect";
import { defineExtension, defineResource, ExtensionHost, tool } from "@gent/core/extensions/api";
class Broken extends Context.Service<Broken, { readonly value: string }>()(
  "@gent/core/tests/server/rpc.test/BrokenBranchResource",
) {}
class Dependent extends Context.Service<Dependent, { readonly value: string }>()(
  "@gent/core/tests/server/rpc.test/DependentBranchResource",
) {}
export default defineExtension({
  id: "@test/zz-dependent-branch-resource",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost;
    yield* host.register("resource", defineResource({
      id: "test/zz-dependent-branch-resource/resource",
      scope: "branch",
      layer: Layer.effect(Dependent, Effect.gen(function* () {
        const broken = yield* Broken;
        return Dependent.of({ value: broken.value });
      })),
    }));
    yield* host.register("tool", tool({
      id: "dependent_probe",
      description: "Read the dependent branch service",
      params: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.gen(function* () { return (yield* Dependent).value; }),
    }));
  }),
});
`,
        )
        const working: GentExtension = {
          manifest: { id: ExtensionId.make("@test/working-branch-resource") },
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            const token = defineResource({
              id: "test/working-branch-resource/token",
              scope: "branch",
              layer: Layer.succeed(
                ProfileToken,
                ProfileToken.of({ read: Effect.succeed("working branch resource") }),
              ),
            })
            yield* host.register(
              "tool",
              tool({
                id: "working_probe",
                description: "Read the working branch service",
                params: Schema.Struct({}),
                output: Schema.String,
                resources: [token],
                execute: () =>
                  Effect.gen(function* () {
                    const token = yield* ProfileToken
                    return yield* token.read
                  }),
              }),
            )
            // A leaf that reads core's registry sees the turn's registry.
            yield* host.register(
              "tool",
              tool({
                id: "registry_probe",
                description: "List the extensions the turn's registry holds",
                params: Schema.Struct({}),
                output: Schema.String,
                // No tool may require a core service; the probe looks it up.
                execute: () =>
                  Effect.map(Effect.serviceOption(ExtensionRegistry), (registry) =>
                    Option.match(registry, {
                      onNone: () => "no registry",
                      onSome: (found) =>
                        found
                          .getResolved()
                          .extensions.map((extension) => extension.manifest.id)
                          .join(","),
                    }),
                  ),
              }),
            )
            yield* host.register("resource", token)
            yield* host.register(
              "request",
              request({
                id: "read-working-branch-token",
                input: Schema.String,
                output: Schema.String,
                resources: [token],
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
            const sessionProfileCacheLayer = liveSessionProfiles(home, [
              agents,
              testTurnExtension,
              working,
            ])
            const offered: Array<string> = []
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
              {
                ...toolCallStep("registry_probe", {}),
                assertOptions: (options) => {
                  offered.push(...options.tools.map((entry) => entry.name))
                },
              },
              textStep("the turn ran"),
            ])
            const { client, sessionId, branchId } = yield* createRpcHarness({
              agents: e2ePreset.agents,
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
            // The dependent extension is suspended for this loop: its tool
            // is not offered, while the working one's is.
            expect(offered).toContain("working_probe")
            expect(offered).not.toContain("dependent_probe")
            // A leaf reading the registry sees the same narrowed registry.
            const probed = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.takeUntil(({ event }) => event._tag === "StreamSynchronized"),
              Stream.flatMap(({ event }) => {
                if (event._tag !== "ToolCallSucceeded" || event.toolName !== "registry_probe") {
                  return Stream.empty
                }
                return Stream.make(String(event.output))
              }),
              Stream.runCollect,
              Effect.map((all) => Array.from(all)),
            )
            expect(probed).toHaveLength(1)
            expect(probed[0]).toContain("@test/working-branch-resource")
            expect(probed[0]).not.toContain("@test/zz-dependent-branch-resource")
            // Each failure names its extension once, as a notice.
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
            const dependentNotices = events.filter(
              (event) =>
                event._tag === "ErrorOccurred" &&
                event.error.includes("@test/zz-dependent-branch-resource"),
            )
            expect(dependentNotices).toHaveLength(1)
            expect(dependentNotices[0]).toMatchObject({ notice: true })
          }).pipe(Effect.timeout("8 seconds")),
        )
      }).pipe(Effect.provide(BunPlatformLive)),
  )
})

// ── session deletion hooks ──────────────────────────────────────────────────

describe("sessionDeleted hook", () => {
  it.live(
    "an extension hears every session a delete removed, once each, beside another's failing hook",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const heard: Array<{
            readonly sessionId: SessionId
            readonly contextSessionId: SessionId
          }> = []
          const listener: GentExtension = {
            manifest: { id: ExtensionId.make("@test/session-deleted-listener") },
            setup: Effect.gen(function* () {
              const host = yield* ExtensionHost
              yield* host.on("sessionDeleted", ({ sessionId }) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  heard.push({ sessionId, contextSessionId: ctx.sessionId })
                }),
              )
            }),
          }
          const failing: GentExtension = {
            manifest: { id: ExtensionId.make("@test/session-deleted-failing") },
            setup: Effect.gen(function* () {
              const host = yield* ExtensionHost
              yield* host.on("sessionDeleted", () => Effect.fail("cannot clean up"))
            }),
          }
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
          const { client, sessionId, branchId } = yield* createRpcHarness({
            ...e2ePreset,
            providerLayer,
            extensionInputs: [...e2ePreset.extensionInputs, failing, listener],
          })
          const child = yield* client.session.create({
            parentSessionId: sessionId,
            parentBranchId: branchId,
          })
          const bystander = yield* client.session.create({})

          yield* client.session.delete({ sessionId })

          // The delete returns after the hooks ran, with the rows gone. Each
          // session is heard under its own context.
          expect(heard).toHaveLength(2)
          expect(new Set(heard.map((entry) => entry.sessionId))).toEqual(
            new Set([sessionId, child.sessionId]),
          )
          for (const entry of heard) expect(entry.contextSessionId).toBe(entry.sessionId)
          expect(yield* client.session.get({ sessionId })).toBeNull()
          expect(yield* client.session.get({ sessionId: child.sessionId })).toBeNull()
          expect(yield* client.session.get({ sessionId: bystander.sessionId })).not.toBeNull()
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  it.live("a descendant in another cwd is heard under its own cwd's extensions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parentCwd = "/nonexistent/gent-probe-deleted-parent"
        const childCwd = "/nonexistent/gent-probe-deleted-child"
        const heard: Array<{ readonly sessionId: SessionId; readonly cwd: string }> = []
        // Only the child's cwd enables the cleanup extension; the parent's
        // roster holds the parent's agent, so the child's parent run resolves.
        const parentAgents: LoadedExtension = {
          manifest: { id: ExtensionId.make("@test/parent-agents") },
          scope: "builtin",
          sourcePath: "test",
          contributions: { agents: e2ePreset.agents },
        }
        const cleanup: LoadedExtension = {
          manifest: { id: ExtensionId.make("@test/session-deleted-cleanup") },
          scope: "builtin",
          sourcePath: "test",
          contributions: {
            hooks: [
              hook("sessionDeleted", ({ sessionId }) =>
                Effect.gen(function* () {
                  const ctx = yield* ExtensionContext
                  heard.push({ sessionId, cwd: ctx.cwd })
                }),
              ),
            ],
          },
        }
        const sessionProfileCacheLayer = fixedSessionProfiles(
          new Map([
            [parentCwd, yield* makeProfile(parentCwd, [parentAgents])],
            [childCwd, yield* makeProfile(childCwd, [cleanup])],
          ]),
        )
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          providerLayer,
          extensions: [],
          sessionProfileCacheLayer,
          cwd: parentCwd,
        })
        const child = yield* client.session.create({
          parentSessionId: sessionId,
          parentBranchId: branchId,
          cwd: childCwd,
        })

        yield* client.session.delete({ sessionId })

        expect(heard).toEqual([{ sessionId: child.sessionId, cwd: childCwd }])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("the hook names every branch of the deleted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const heard: Array<SessionDeletedInput> = []
        const listener: GentExtension = {
          manifest: { id: ExtensionId.make("@test/session-deleted-branches") },
          setup: Effect.gen(function* () {
            const host = yield* ExtensionHost
            yield* host.on("sessionDeleted", (input) => Effect.sync(() => heard.push(input)))
          }),
        }
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensionInputs: [...e2ePreset.extensionInputs, listener],
        })
        const second = yield* client.branch.create({ sessionId })

        yield* client.session.delete({ sessionId })

        expect(heard).toHaveLength(1)
        expect(heard[0]?.sessionId).toBe(sessionId)
        expect([...(heard[0]?.branchIds ?? [])].sort()).toEqual([branchId, second.branchId].sort())
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

// ── no default model ────────────────────────────────────────────────────────

describe("no default model", () => {
  // Gent ships no model: an agent that names none runs the user's, and with
  // no user's model a send is refused.
  const modelless = AgentDefinition.make({ name: DEFAULT_AGENT_NAME, description: "No model" })
  const worker = AgentDefinition.make({ name: AgentName.make("worker"), description: "No model" })
  const picked = ModelId.make("anthropic/claude-opus-5-5")
  const later = ModelId.make("anthropic/claude-sonnet-5-5")
  // The user config names no model either.
  const modellessPreset = {
    ...e2ePreset,
    agents: [modelless, worker],
    configServiceLayer: ConfigService.Test(),
  }

  it.live("a send to a session nobody named a model for is refused with the /model hint", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...modellessPreset,
          providerLayer,
        })
        const view = yield* client.session.get({ sessionId })
        expect(view?.resolvedModelId).toBeUndefined()
        const refused = yield* client.message
          .send({ sessionId, branchId, content: "hello" })
          .pipe(Effect.flip)
        expect(refused._tag).toBe("NoModelError")
        expect(refused.message).toContain("/model")
        // No turn ran: the scripted model was never asked.
        yield* controls.assertDone
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )

  it.live("a turn admitted without a send ends with the same refusal, on no model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([])
        const cwd = yield* makeTempDirectoryScoped("gent-no-model-")
        const { client } = yield* createRpcHarness({ ...modellessPreset, cwd, providerLayer })
        const created = yield* client.session.create({ cwd, initialPrompt: "hello" })
        const error = yield* client.session
          .events({ sessionId: created.sessionId, branchId: created.branchId })
          .pipe(
            Stream.filter(({ event }) => event._tag === "ErrorOccurred"),
            Stream.runHead,
          )
        expect(Option.getOrThrow(error).event).toMatchObject({
          error: expect.stringContaining("/model"),
        })
        yield* controls.assertDone
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )

  it.live("the first model pick is the user's model: new sessions and child agents run it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const cwd = yield* makeTempDirectoryScoped("gent-no-model-")
        const { client, sessionId } = yield* createRpcHarness({
          ...modellessPreset,
          cwd,
          providerLayer,
        })
        const resolvedIn = (created: Effect.Success<ReturnType<typeof client.session.create>>) =>
          client.session
            .get({ sessionId: created.sessionId })
            .pipe(Effect.map((view) => view?.resolvedModelId))
        yield* client.session.updateSettings({ sessionId, modelId: Option.some(picked) })
        expect(yield* resolvedIn(yield* client.session.create({ cwd }))).toBe(picked)
        expect(
          yield* resolvedIn(
            yield* client.session.create({ cwd, admission: { agent: worker.name } }),
          ),
        ).toBe(picked)
        // A later pick is that session's own; the user's model stands.
        const second = yield* client.session.create({ cwd })
        yield* client.session.updateSettings({
          sessionId: second.sessionId,
          modelId: Option.some(later),
        })
        expect((yield* client.session.get({ sessionId: second.sessionId }))?.resolvedModelId).toBe(
          later,
        )
        expect(yield* resolvedIn(yield* client.session.create({ cwd }))).toBe(picked)
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )
})

// ── effort receipt ──────────────────────────────────────────────────────────

describe("effort receipt", () => {
  // A model that accepts three levels: a hint between or past them is clamped.
  const effortModel = Model.make({
    id: TEST_MODEL_ID,
    name: "Effort model",
    provider: ProviderId.make("effort-driver"),
    contextLength: 128_000,
    reasoning: true,
    efforts: ["low", "medium", "high"],
  })

  it.live("a settings change reaches the next step's receipt at the level the model accepts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          textStep("first"),
          textStep("second"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          models: [effortModel],
          providerLayer,
        })
        // The subscription replays the branch: turn `n` ends at the `n`th completion.
        const turn = (content: string, level: "minimal" | "max", earlierTurns: number) =>
          Effect.gen(function* () {
            yield* client.session.updateSettings({ sessionId, reasoningLevel: Option.some(level) })
            const turnCompleted = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.filter(({ event }) => event._tag === "TurnCompleted"),
              Stream.drop(earlierTurns),
              Stream.runHead,
              Effect.forkScoped,
            )
            yield* client.message.send({ sessionId, branchId, content })
            yield* Fiber.join(turnCompleted)
          })
        yield* turn("first", "minimal", 0)
        yield* turn("second", "max", 1)
        const levels = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filterMap(({ event }) => {
            if (event._tag === "StreamEnded") {
              return Result.succeed(Option.fromUndefinedOr(event.reasoningLevel))
            }
            return Result.failVoid
          }),
          Stream.take(2),
          Stream.runCollect,
        )
        // `minimal` is below the lowest accepted level and `max` above the highest.
        expect(levels).toEqual([Option.some("low"), Option.some("high")])
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )

  it.live("each request names the effort every earlier assistant run was sent at", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const history: Array<ReadonlyArray<Option.Option<string>>> = []
        const recorded = (text: string) => ({
          ...textStep(text),
          assertRequest: (request: {
            readonly reasoningHistory: ReadonlyArray<Option.Option<string>>
          }) => {
            history.push(request.reasoningHistory)
          },
        })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          recorded("first"),
          recorded("second"),
          recorded("third"),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          models: [effortModel],
          providerLayer,
        })
        const turn = (content: string, level: "minimal" | "max", earlierTurns: number) =>
          Effect.gen(function* () {
            yield* client.session.updateSettings({ sessionId, reasoningLevel: Option.some(level) })
            const turnCompleted = yield* client.session.events({ sessionId, branchId }).pipe(
              Stream.filter(({ event }) => event._tag === "TurnCompleted"),
              Stream.drop(earlierTurns),
              Stream.runHead,
              Effect.forkScoped,
            )
            yield* client.message.send({ sessionId, branchId, content })
            yield* Fiber.join(turnCompleted)
          })
        yield* turn("first", "minimal", 0)
        yield* turn("second", "max", 1)
        yield* turn("third", "max", 2)
        yield* controls.assertDone
        expect(history).toEqual([
          [],
          [Option.some("low")],
          [Option.some("low"), Option.some("high")],
        ])
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )

  it.live("an effort set while a turn runs takes effect at the next turn, as a marker does", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sent: Array<Option.Option<string>> = []
        const recorded = (step: SequenceStep): SequenceStep => ({
          ...step,
          assertRequest: (request) => {
            sent.push(Option.fromUndefinedOr(request.reasoning))
          },
        })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          { ...recorded(toolCallStep("echo_probe", { text: "ping" })), gated: true },
          recorded(textStep("same turn")),
          recorded(textStep("next turn")),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: e2ePreset.agents,
          models: [effortModel],
          providerLayer,
          extensions: [EchoProbeExtension],
        })
        const turnEnd = (earlierTurns: number) =>
          client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(({ event }) => event._tag === "TurnCompleted"),
            Stream.drop(earlierTurns),
            Stream.runHead,
            Effect.forkScoped,
          )
        yield* client.session.updateSettings({ sessionId, reasoningLevel: Option.some("low") })
        const firstEnd = yield* turnEnd(0)
        yield* client.message.send({ sessionId, branchId, content: "call echo" })
        // The first step waits on the model; the level changes now.
        yield* controls.waitForCall(0)
        yield* client.session.updateSettings({ sessionId, reasoningLevel: Option.some("high") })
        yield* controls.emitAll(0)
        yield* Fiber.join(firstEnd)
        const secondEnd = yield* turnEnd(1)
        yield* client.message.send({ sessionId, branchId, content: "again" })
        yield* Fiber.join(secondEnd)
        yield* controls.assertDone
        const receipts = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filterMap(({ event }) => {
            if (event._tag === "StreamEnded") {
              return Result.succeed(Option.fromUndefinedOr(event.reasoningLevel))
            }
            return Result.failVoid
          }),
          Stream.take(3),
          Stream.runCollect,
        )
        // Each step's receipt names the level its request was sent at; the
        // running turn keeps its level, the next turn takes the new one.
        expect(sent).toEqual([Option.some("low"), Option.some("low"), Option.some("high")])
        expect(receipts).toEqual([Option.some("low"), Option.some("low"), Option.some("high")])
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )

  it.live("a step that names no level records the model's default, not an unknown level", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const history: Array<ReadonlyArray<Option.Option<string>>> = []
        const recorded = (text: string): SequenceStep => ({
          ...textStep(text),
          assertRequest: (request) => {
            history.push(request.reasoningHistory)
          },
        })
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          recorded("first"),
          recorded("second"),
        ])
        // The agent and the session name no level.
        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          models: [effortModel],
          providerLayer,
        })
        for (const [index, content] of ["first", "second"].entries()) {
          const turnCompleted = yield* client.session.events({ sessionId, branchId }).pipe(
            Stream.filter(({ event }) => event._tag === "TurnCompleted"),
            Stream.drop(index),
            Stream.runHead,
            Effect.forkScoped,
          )
          yield* client.message.send({ sessionId, branchId, content })
          yield* Fiber.join(turnCompleted)
        }
        yield* controls.assertDone
        const receipt = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filterMap(({ event }) => {
            if (event._tag === "StreamEnded") {
              return Result.succeed([
                Option.fromUndefinedOr(event.reasoningLevel),
                Option.fromUndefinedOr(event.reasoningDefault),
              ] as const)
            }
            return Result.failVoid
          }),
          Stream.runHead,
        )
        expect(receipt).toEqual(Option.some([Option.none(), Option.some(true)]))
        expect(history).toEqual([[], [Option.some("default")]])
      }).pipe(Effect.timeout("8 seconds")),
    ),
  )
})

// ── rpc wide events ─────────────────────────────────────────────────────────

describe("rpc wide events", () => {
  it.live("the wide event of a failed call names its session and branch", () =>
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
          extraLayers: [WideEventLogger.Capture(wideEvents), minimumLogLevel],
        })
        const missingBranchId = BranchId.make("missing-branch")
        const failed = yield* Effect.exit(
          client.session.getSnapshot({ sessionId, branchId: missingBranchId }),
        )
        expect(failed._tag).toBe("Failure")

        const event = MutableRef.get(wideEvents).find(
          (entry) =>
            entry.annotations["service"] === "rpc" &&
            entry.annotations["method"] === "session.getSnapshot",
        )
        expect(event).not.toBeUndefined()
        expect(event?.annotations["sessionId"]).toBe(sessionId)
        expect(event?.annotations["branchId"]).toBe(missingBranchId)
      }).pipe(Effect.timeout("4 seconds")),
    ),
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
          cwd: "/nonexistent/gent-settings-wide-event",
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
          cwd: "/nonexistent/gent-turn-wide-event",
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
})

describe("session profile lookup", () => {
  it.live(
    "a storage failure while reading the session fails the call, not the launch profile",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
          const base = createE2ELayer({ ...e2ePreset, providerLayer })
          const unreadable = Layer.effect(
            SessionStorage,
            Effect.map(SessionStorage, (storage) =>
              SessionStorage.of({
                ...storage,
                getSession: () => Effect.fail(new StorageError({ message: "session unreadable" })),
              }),
            ),
          )
          const { client } = yield* createRpcClient(unreadable.pipe(Layer.provideMerge(base)))
          const sessionId = SessionId.make("unreadable-session")
          const tags = [
            (yield* Effect.flip(client.model.list({ sessionId })))._tag,
            (yield* Effect.flip(client.driver.list({ sessionId })))._tag,
            (yield* Effect.flip(
              client.extension.listStatus({ scope: { _tag: "Session", id: sessionId } }),
            ))._tag,
            (yield* Effect.flip(client.extension.listSlashCommands({ sessionId })))._tag,
          ]
          expect(tags).toEqual(["StorageError", "StorageError", "StorageError", "StorageError"])
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  it.live("a call that names a deleted session fails, never answers from the launch profile", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const { sessionId } = yield* client.session.create({})
        const { drivers } = yield* client.driver.list({ sessionId })
        const driver = { _tag: "Model" as const, id: drivers[0]?.id ?? "none" }
        yield* client.session.delete({ sessionId })
        const tagOf = <A, E extends { readonly _tag: string }, R>(call: Effect.Effect<A, E, R>) =>
          Effect.match(call, { onFailure: (error) => error._tag, onSuccess: () => "answered" })
        const authorizeInput = { sessionId, provider: driver.id, method: 0 }
        const calls = {
          "model.list": tagOf(client.model.list({ sessionId })),
          "driver.list": tagOf(client.driver.list({ sessionId })),
          "driver.set": tagOf(
            client.driver.set({ agentName: DEFAULT_AGENT_NAME, driver, sessionId }),
          ),
          "auth.listMethods": tagOf(client.auth.listMethods({ sessionId })),
          "auth.listProviders": tagOf(client.auth.listProviders({ sessionId })),
          "auth.authorize": tagOf(client.auth.authorize(authorizeInput)),
          "auth.callback": tagOf(
            client.auth.callback({ ...authorizeInput, authorizationId: "none" }),
          ),
          "auth.setKey": tagOf(client.auth.setKey({ provider: driver.id, key: "sk", sessionId })),
          "auth.deleteKey": tagOf(client.auth.deleteKey({ provider: driver.id, sessionId })),
          "extension.listStatus": tagOf(
            client.extension.listStatus({ scope: { _tag: "Session", id: sessionId } }),
          ),
          "extension.listSlashCommands": tagOf(client.extension.listSlashCommands({ sessionId })),
        }
        const tags = yield* Effect.all(calls)
        // Each call that did not fail with NotFoundError, with what it did.
        expect(Object.entries(tags).filter(([, tag]) => tag !== "NotFoundError")).toEqual([])
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  test("a session-scoped payload that names no session is a type error", () => {
    type Client = GentNamespacedClient
    const provider = "anthropic"
    // @ts-expect-error -- auth.setKey names its session
    const setKey: Parameters<Client["auth"]["setKey"]>[0] = { provider, key: "sk" }
    // @ts-expect-error -- auth.deleteKey names its session
    const deleteKey: Parameters<Client["auth"]["deleteKey"]>[0] = { provider }
    // @ts-expect-error -- auth.listMethods names its session
    const listMethods: Parameters<Client["auth"]["listMethods"]>[0] = {}
    // @ts-expect-error -- auth.listProviders names its session
    const listProviders: Parameters<Client["auth"]["listProviders"]>[0] = {
      agentName: DEFAULT_AGENT_NAME,
    }
    // @ts-expect-error -- driver.set names its session
    const setDriver: Parameters<Client["driver"]["set"]>[0] = {
      agentName: DEFAULT_AGENT_NAME,
      driver: { _tag: "Model", id: provider },
    }
    // @ts-expect-error -- driver.list names its session
    const listDrivers: Parameters<Client["driver"]["list"]>[0] = {}
    // @ts-expect-error -- model.list names its session
    const listModels: Parameters<Client["model"]["list"]>[0] = {}
    // @ts-expect-error -- extension.listStatus names its scope
    const listStatus: Parameters<Client["extension"]["listStatus"]>[0] = {}
    const payloads = [setKey, deleteKey, listMethods, listProviders, setDriver, listDrivers]
    expect([...payloads, listModels, listStatus]).toHaveLength(8)
  })

  // The client builds each payload with its schema's constructor, so a tag
  // the constructor filled in would turn an empty scope into `Launch`.
  it.live("a health read whose scope names neither a session nor the launch is refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client } = yield* createRpcHarness({ ...e2ePreset, providerLayer })
        const exit = yield* Effect.exit(
          // @ts-expect-error -- a scope names its tag; no constructor default picks `Launch`
          client.extension.listStatus({ scope: {} }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  test("a session-scoped payload that names no session does not decode", () => {
    const statusPayload = Schema.Struct({ scope: ExtensionStatusScope })
    const driver = { _tag: "Model", id: "anthropic" }
    const exits: ReadonlyArray<Exit.Exit<unknown, Schema.SchemaError>> = [
      Schema.decodeUnknownExit(SetAuthKeyInput)({ provider: "anthropic", key: "sk" }),
      Schema.decodeUnknownExit(DeleteAuthKeyInput)({ provider: "anthropic" }),
      Schema.decodeUnknownExit(ListAuthProvidersPayload)({}),
      Schema.decodeUnknownExit(SetDriverOverrideInput)({ agentName: "main", driver }),
      Schema.decodeUnknownExit(statusPayload)({}),
    ]
    expect(exits.map((exit) => Exit.isFailure(exit))).toEqual([true, true, true, true, true])
    expect(Exit.isSuccess(Schema.decodeExit(statusPayload)({ scope: { _tag: "Launch" } }))).toBe(
      true,
    )
  })

  // `/auth` and `/model` name the session, so a project's own driver serves them.
  it.live(
    "/auth and /model in a project session with a project driver answer from the project profile",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const profileCwd = yield* makeTempDirectoryScoped("gent-project-driver-")
          const projectDriver: LoadedExtension = {
            manifest: { id: ExtensionId.make("@test/project-models") },
            scope: "project",
            sourcePath: "test",
            contributions: {
              agents: [...e2ePreset.agents],
              modelDrivers: [
                {
                  id: "project-models",
                  name: "Project models",
                  resolveModel: () => Effect.succeed(stubModel),
                  listModels: () =>
                    Effect.succeed([
                      Model.make({
                        id: ModelId.make("project-models/one"),
                        name: "One",
                        provider: ProviderId.make("project-models"),
                      }),
                    ]),
                  auth: { methods: [AuthMethod.make({ type: "api", label: "Project key" })] },
                },
              ],
            },
          }
          const profile = yield* makeProfile(profileCwd, [projectDriver])
          const auth = yield* Effect.provide(Effect.service(Auth), Auth.Test({}))
          const configContext = yield* Layer.build(ConfigService.Test())
          const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
          const { client } = yield* createRpcClient(
            createE2ELayer({
              agents: e2ePreset.agents,
              providerLayer,
              extensions: [],
              authLayer: Layer.succeed(Auth, auth),
              configServiceLayer: Layer.succeedContext(configContext),
              sessionProfileCacheLayer: fixedSessionProfiles(new Map([[profileCwd, profile]])),
            }),
          )
          const { sessionId } = yield* client.session.create({ cwd: profileCwd })
          const projectSignIn = client.auth
            .listProviders({ sessionId })
            .pipe(
              Effect.map((providers) =>
                providers.find((entry) => entry.provider === "project-models"),
              ),
            )

          // /model: the catalog and the drivers are the project's.
          const models = yield* client.model.list({ sessionId })
          expect(models.map((model) => model.id)).toEqual([ModelId.make("project-models/one")])
          const { drivers } = yield* client.driver.list({ sessionId })
          expect(drivers.map((driver) => driver.id)).toEqual(["project-models"])
          yield* client.driver.set({
            agentName: DEFAULT_AGENT_NAME,
            driver: { _tag: "Model", id: "project-models" },
            sessionId,
          })

          // /auth: the project driver is the sign-in the session needs.
          expect(Object.keys(yield* client.auth.listMethods({ sessionId }))).toEqual([
            "project-models",
          ])
          expect(yield* projectSignIn).toMatchObject({ required: true, hasKey: false })
          yield* client.auth.setKey({ provider: "project-models", key: "sk-project", sessionId })
          expect(yield* projectSignIn).toMatchObject({ required: true, hasKey: true })
          yield* client.auth.deleteKey({ provider: "project-models", sessionId })
          expect(yield* projectSignIn).toMatchObject({ required: true, hasKey: false })
        }).pipe(Effect.timeout("4 seconds")),
      ),
  )

  // A client of the launch cwd works in the launch workspace, so its
  // session shares the launch profile instead of setting it up again.
  it.live("a session in the launch cwd runs each extension's setup once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const setups = yield* Ref.make(0)
        const counted = defineExtension({
          id: "@test/counted-setup",
          setup: Ref.update(setups, (n) => n + 1),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        const { client, sessionId } = yield* createRpcHarness({
          ...e2ePreset,
          extensionInputs: [...e2ePreset.extensionInputs, counted],
          providerLayer,
        })
        yield* client.extension.listStatus({ scope: { _tag: "Session", id: sessionId } })
        expect(yield* Ref.get(setups)).toBe(1)
      }).pipe(Effect.timeout("4 seconds")),
    ),
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
        // oxlint-disable-next-line effect/noNullish -- A proxy answers undefined for a key it does not hold.
        if (!Predicate.isString(property)) return undefined
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
          // oxlint-disable-next-line effect/noNullish -- A proxy answers undefined for a key it does not hold.
          if (property !== "session.list") return undefined
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
          // oxlint-disable-next-line effect/noNullish -- A proxy answers undefined for a key it does not hold.
          if (property !== "session.watchRuntime") return undefined
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
