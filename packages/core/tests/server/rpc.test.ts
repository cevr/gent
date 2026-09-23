import { test } from "bun:test"
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  MutableRef,
  Option,
  Predicate,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect"
import {
  DriverListResult,
  ExtensionProtocolError,
  type GentRpcClient,
  GentRpcs,
  makeNamespacedClient,
  SessionRpcs,
  SlashCommandInfo,
} from "../../src/server/rpc"
import {
  WorkspaceRpcMiddleware,
  CurrentWorkspaceId,
  WORKSPACE_ID_HEADER,
  workspaceHeadersForCwd,
  workspaceIdForCwd,
} from "../../src/server/workspace-rpc"
import { describe, expect, it } from "effect-bun-test"
import { RpcClient } from "effect/unstable/rpc"
import { finishPart, textDeltaPart, Auth, AuthError, AuthMethod } from "../../src/runtime/provider"
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
  DriverRef,
  ModelId,
  type ReasoningEffort,
} from "../../src/domain/agent"
import { createE2ELayer, createRpcClient, createRpcHarness } from "../../src/test-utils/harness"
import { e2ePreset } from "../helpers/test-preset"
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
import { InteractionStorage, SqliteStorage } from "../../src/storage/storage"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { encodeInteractionDecision } from "../../src/domain/interaction.js"
import { MinimumLogLevel } from "effect/References"
import { narrowR } from "../helpers/effect"
import { type Message, messageSingleText } from "../../src/domain/message"
import { ConfigService } from "../../src/runtime/config"
import { type LogEvent, WideEventLogger } from "effect-wide-event"

// ── rpc-contract.test ───────────────────────────────────────────────────────

const decodeSuccess = (key: string, value: Readonly<Record<string, string>>): unknown => {
  const group = SessionRpcs
  const rpc = group.requests.get(key)
  if (Predicate.isUndefined(rpc)) return Effect.runSync(Effect.die(new Error(`Missing RPC ${key}`)))
  return Schema.decodeUnknownSync(rpc.successSchema)(value)
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

// ── driver-rpc.test ─────────────────────────────────────────────────────────

/**
 * Driver routing RPCs — `driver.list` / `driver.set` / `driver.clear`
 * acceptance tests.
 *
 * Drives the full transport boundary (createRpcClient → RpcServer → handler →
 * ConfigService + ExtensionRegistry) so the tests catch wiring bugs the
 * unit tests on `ConfigService.setDriverOverride` don't cover.
 */

describe("ExtensionRpcs", () => {
  it.live("driver.list returns registered drivers and current overrides", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const before = yield* client.driver.list({})
        expect(before).toBeInstanceOf(DriverListResult)
        expect(before.drivers[0]?._tag).toBeDefined()
        // Built-in agents extension contributes the "anthropic" model driver
        // (and friends); the registered list should be non-empty even when no
        // overrides are set.
        expect(before.drivers.length).toBeGreaterThan(0)
        expect(before.agents.map((agent) => agent.name)).toContain(DEFAULT_AGENT_NAME)
        expect(before.overrides).toEqual({})
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.set persists an override; driver.list reflects it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const drivers = (yield* client.driver.list({})).drivers
        const someModel = drivers.find((d) => d._tag === "Model")
        if (Predicate.isUndefined(someModel)) {
          return yield* Effect.die(new Error("no model driver registered in test layer"))
        }
        yield* client.driver.set({
          agentName: DEFAULT_AGENT_NAME,
          driver: DriverRef.make({ id: someModel.id }),
        })
        const after = yield* client.driver.list({})
        expect(after.overrides[DEFAULT_AGENT_NAME]?._tag).toBe("Model")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.set rejects unknown driver id with NotFoundError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const result = yield* client.driver
          .set({
            agentName: DEFAULT_AGENT_NAME,
            driver: DriverRef.make({ id: "definitely-not-registered" }),
          })
          .pipe(Effect.flip)
        expect(result._tag).toBe("NotFoundError")
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.clear removes an existing override", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        const drivers = (yield* client.driver.list({})).drivers
        const someModel = drivers.find((d) => d._tag === "Model")
        if (Predicate.isUndefined(someModel)) {
          return yield* Effect.die(new Error("no model driver registered in test layer"))
        }
        yield* client.driver.set({
          agentName: DEFAULT_AGENT_NAME,
          driver: DriverRef.make({ id: someModel.id }),
        })
        yield* client.driver.clear({ agentName: DEFAULT_AGENT_NAME })
        const after = yield* client.driver.list({})
        expect(after.overrides).toEqual({})
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )

  it.live("driver.clear is a no-op for an unknown agent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
        const { client } = yield* createRpcClient(createE2ELayer({ ...e2ePreset, providerLayer }))
        yield* client.driver.clear({ agentName: AgentName.make("does-not-exist") })
        const after = yield* client.driver.list({})
        expect(after.overrides).toEqual({})
      }).pipe(Effect.timeout("4 seconds")),
    ),
  )
})

// ── model-context.test ──────────────────────────────────────────────────────

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

// ── branch-fork ─────────────────────────────────────────────────────────────

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

// ── auth-rpc.test ───────────────────────────────────────────────────────────

/**
 * `auth.listProviders` RPC acceptance tests.
 *
 * An unknown session fails the listing; otherwise the selected agent's
 * model decides which providers need auth.
 */

const failingAuthStoreLayer = Layer.succeed(
  Auth,
  Auth.of({
    get: () => Effect.as(Effect.void, void 0),
    set: () => Effect.fail(new AuthError({ message: "write failed" })),
    remove: () => Effect.fail(new AuthError({ message: "delete failed" })),
  }),
)
const failingReadAuthStoreLayer = Layer.succeed(
  Auth,
  Auth.of({
    get: () => Effect.fail(new AuthError({ message: "read failed" })),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
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
          modelId: ModelId.make("otherprov/model"),
          reasoningLevel: Option.getOrUndefined(Option.none<ReasoningEffort>()),
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

// ── interaction-commands.test ───────────────────────────────────────────────

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
          yield* storage.decide(first.requestId, decisionJson)
        }).pipe(
          // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
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
})

// ── extension-commands-rpc.test ─────────────────────────────────────────────

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
    narrowR(
      Effect.gen(function* () {
        const registry = yield* ExtensionRegistry
        const cmds = registry.getResolved().slashCommands
        const testCmds = cmds.filter((c) => c.name === "greet" || c.name === "noop")
        expect(testCmds).toHaveLength(2)
        expect(testCmds.find((c) => c.name === "greet")?.description).toBe("Say hello")
        expect(testCmds.find((c) => c.name === "noop")?.description).toBe("noop")
      }).pipe(Effect.provide(layer)),
    ),
  )
  it.live("RPC listSlashCommands + request round-trip through the transport boundary", () =>
    Effect.gen(function* () {
      invoked.length = 0
      let createdSessionId = ""
      yield* narrowR(
        Effect.scoped(
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
        ),
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
      yield* narrowR(
        Effect.scoped(
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
        ),
      )
    }),
  )
  it.live("a turn emits one agent-loop wide event with its session envelope", () =>
    narrowR(
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
      ),
    ).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
  )
  it.live("RPC event subscriptions mark the move from replay to live", () =>
    narrowR(
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
          expect(fresh.map((env) => env.event._tag)).toEqual([
            "SessionStarted",
            "StreamSynchronized",
          ])
          expect(fresh[1]?.id).toBe(fresh[0]?.id)
          yield* client.message.send({ sessionId, branchId, content: "sync" })
          yield* waitFor(
            client.message.list({ branchId }),
            (messages) =>
              messages.some(
                (message) =>
                  message.role === "assistant" &&
                  messageSingleText(message.parts) === "synced reply",
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
      ),
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
      yield* narrowR(
        Effect.scoped(
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
        ),
      )
    }),
  )

  it.live("a handoff joins its parent's thread; a plain child starts its own", () =>
    narrowR(
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
      yield* narrowR(
        Effect.scoped(
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
                .map((message) => messageSingleText(message.parts))
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
                  message.role === "user" &&
                  messageSingleText(message.parts) === "queued while idle",
              ),
            ).toBe(true)
            yield* controls.assertDone
          }).pipe(Effect.timeout("10 seconds")),
        ),
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
      yield* narrowR(
        Effect.scoped(
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
        ),
      )
    }),
  )
  it.live("RPC request rejects missing sessions instead of using launch cwd", () =>
    Effect.gen(function* () {
      invoked.length = 0
      yield* narrowR(
        Effect.scoped(
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
        ),
      )
    }),
  )
  it.live("RPC request rejects missing branches", () =>
    Effect.gen(function* () {
      invoked.length = 0
      yield* narrowR(
        Effect.scoped(
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
        ),
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
      yield* narrowR(
        Effect.scoped(
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
        ),
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
      const exit = yield* narrowR(
        Effect.scoped(
          Effect.gen(function* () {
            const { layer: providerLayer } = yield* LanguageModelLayers.sequence([textStep("ok")])
            return yield* createRpcHarness({
              ...e2ePreset,
              providerLayer,
              extensionInputs: [failingExtension],
              cwd: "/tmp",
            })
          }).pipe(Effect.timeout("4 seconds")),
        ),
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
      yield* narrowR(
        Effect.scoped(
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
        ),
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
                narrowR(
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
                ),
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
        narrowR(
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
        ),
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
        narrowR(
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
        ),
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
        narrowR(
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
        ),
      )
    }),
  )
})

// ── namespaced-client.test ──────────────────────────────────────────────────

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
