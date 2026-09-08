import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import {
  Context,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Scope,
  Stream,
} from "effect"
import { LoadedArtifactIdentity } from "@gent/core-internal/domain/extension"
import { createRpcHarness } from "@gent/core-internal/test-utils/rpc-harness"
import { waitFor } from "@gent/core-internal/test-utils/fixtures"
import { LanguageModelLayers } from "@gent/core-internal/test-utils/language-model"
import { textStep, toolCallStep } from "@gent/core-internal/debug/provider"
import { SessionProfileCache } from "@gent/core-internal/runtime/session-profile"
import { ConfigService } from "@gent/core-internal/runtime/config-service"
import { RuntimeEnvironment } from "@gent/core-internal/runtime/runtime-environment"
import { ProcessRunnerLive } from "@gent/core-internal/utils/run-process"
import { BunPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { CurrentWorkspaceId, WorkspaceId } from "@gent/core-internal/server/workspace-rpc"
import { SqliteStorage } from "@gent/core-internal/storage/sqlite-storage"
import {
  ExtensionContext,
  ExtensionHost,
  defineExtension,
  defineResource,
  tool,
  type GentExtension,
} from "@gent/core/extensions/api"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

class ReplayResource extends Context.Service<ReplayResource, { readonly revision: string }>()(
  "@gent/core/tests/server/tool-replay-rpc.test/ReplayResource",
) {}

type ReplayScenario = "config" | "resource"

interface ReplayState {
  resourceRevision: string
  toolExecutions: number
  resourceAcquisitions: number
  resourceReleases: number
}

const replayExtensionId = "@test/tool-replay-rpc"
const replayResourceId = "test/tool-replay-rpc/resource"

const makeReplayExtension = (state: ReplayState): GentExtension => ({
  ...defineExtension({
    id: replayExtensionId,
    setup: Effect.gen(function* () {
      const host = yield* ExtensionHost
      // Resource revision is read at setup time so each profile rebuild sees the current one.
      yield* host.register(
        "resource",
        defineResource({
          id: replayResourceId,
          revision: state.resourceRevision,
          tag: ReplayResource,
          scope: "process",
          layer: Layer.effect(
            ReplayResource,
            Effect.acquireRelease(
              Effect.sync(() => {
                state.resourceAcquisitions += 1
                return ReplayResource.of({ revision: state.resourceRevision })
              }),
              () =>
                Effect.sync(() => {
                  state.resourceReleases += 1
                }),
            ),
          ),
        }),
      )
      yield* host.register(
        "tool",
        tool({
          id: "replay-tool",
          description: "Request approval before recording execution",
          params: Schema.Struct({ text: Schema.String }),
          output: Schema.String,
          execute: Effect.fn("toolReplayRpc.replayTool")(function* (params) {
            const ctx = yield* ExtensionContext
            const decision = yield* ctx.Interaction.approve({ text: params.text })
            state.toolExecutions += 1
            if (decision.approved) return "executed"
            return "declined"
          }),
        }),
      )
    }),
  }),
  artifactIdentity: LoadedArtifactIdentity.make("@test/tool-replay-rpc@artifact-1"),
})

const runReplayScenario = (scenario: ReplayScenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const platform = yield* GentPlatform
    const home = yield* fs.makeTempDirectoryScoped()
    const profileCwd = yield* fs.makeTempDirectoryScoped()
    const configPath = path.join(home, ".gent", "config.json")
    yield* fs.makeDirectory(path.dirname(configPath), { recursive: true })
    yield* fs.writeFileString(configPath, encodeJson({ permissions: [] }))

    const state: ReplayState = {
      resourceRevision: "resource-1",
      toolExecutions: 0,
      resourceAcquisitions: 0,
      resourceReleases: 0,
    }
    const replayExtension = makeReplayExtension(state)
    const agentsExtension = defineExtension({
      id: "@test/tool-replay-rpc-agents",
      setup: Effect.gen(function* () {
        const host = yield* ExtensionHost
        yield* host.register("agent", ...e2ePreset.agents)
      }),
    })

    const runtimeEnvironmentLive = RuntimeEnvironment.Live({
      cwd: profileCwd,
      home,
      platform: "test",
    })
    const configServiceLive = ConfigService.Live.pipe(
      Layer.provide(Layer.merge(BunServices.layer, runtimeEnvironmentLive)),
    )
    const processRunnerLive = ProcessRunnerLive.pipe(Layer.provide(BunServices.layer))
    const sessionProfileCacheLayer = Layer.unwrap(
      Effect.map(Effect.scope, (scope) =>
        SessionProfileCache.Live({
          home,
          platform: "test",
          extensions: [agentsExtension, replayExtension],
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              BunServices.layer,
              processRunnerLive,
              configServiceLive,
              SqliteStorage.MemoryWithSql().pipe(Layer.provide(BunPlatformLive)),
            ),
          ),
          Layer.orDie,
          Layer.provide(Layer.succeed(Scope.Scope, scope)),
        ),
      ),
    )

    const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
      toolCallStep("replay-tool", { text: "approve replay" }),
      textStep("recovered after replay rejection"),
    ])

    yield* Effect.scoped(
      Effect.gen(function* () {
        const cacheContext = yield* Layer.build(sessionProfileCacheLayer)
        const cache = Context.get(cacheContext, SessionProfileCache)
        const requestWorkspace = WorkspaceId.make(
          platform.hash("sha256", path.resolve(process.cwd())),
        )
        yield* cache
          .resolve(profileCwd)
          .pipe(Effect.provideService(CurrentWorkspaceId, requestWorkspace))

        const { client, sessionId, branchId } = yield* createRpcHarness({
          ...e2ePreset,
          providerLayer,
          extensions: [],
          durableApproval: true,
          sessionProfileCacheLayer: Layer.succeed(SessionProfileCache, cache),
          cwd: profileCwd,
        })

        const interactionFiber = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "InteractionPresented"),
          Stream.runHead,
          Effect.forkScoped,
        )
        const initialTurn = yield* client.message
          .send({
            sessionId,
            branchId,
            content: "run the replay tool",
          })
          .pipe(Effect.forkChild)
        const presented = yield* Fiber.join(interactionFiber)
        expect(Option.isSome(presented)).toBe(true)
        if (Option.isNone(presented)) {
          return yield* Effect.die(new Error("replay interaction was not presented"))
        }
        if (presented.value.event._tag !== "InteractionPresented") {
          return yield* Effect.die(new Error("unexpected event in replay interaction stream"))
        }
        const requestId = presented.value.event.requestId
        const waiting = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) => snapshot.runtime._tag === "WaitingForInteraction",
          4_000,
          "replay turn parks at interaction",
        )
        expect(waiting.runtime._tag).toBe("WaitingForInteraction")
        yield* Fiber.join(initialTurn)
        const acquisitionsBeforeRefresh = state.resourceAcquisitions
        const releasesBeforeRefresh = state.resourceReleases

        if (scenario === "config") {
          yield* fs.writeFileString(
            configPath,
            encodeJson({ permissions: [{ tool: "unrelated-tool", action: "deny" }] }),
          )
        } else {
          state.resourceRevision = "resource-2"
        }
        yield* cache
          .refresh(profileCwd)
          .pipe(
            Effect.provideService(CurrentWorkspaceId, requestWorkspace),
            Effect.timeout("3 seconds"),
          )

        if (scenario === "config") {
          expect(state.resourceAcquisitions).toBe(acquisitionsBeforeRefresh)
          expect(state.resourceReleases).toBe(releasesBeforeRefresh)
        } else {
          expect(state.resourceAcquisitions).toBe(acquisitionsBeforeRefresh + 1)
          expect(state.resourceReleases).toBe(releasesBeforeRefresh + 1)
        }

        const errorFiber = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.filter((envelope) => envelope.event._tag === "ErrorOccurred"),
          Stream.runHead,
          Effect.forkScoped,
        )
        yield* client.interaction.respondInteraction({
          sessionId,
          branchId,
          requestId,
          approved: true,
          notes: "respond after publication replacement",
        })

        const failed = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) =>
            snapshot.runtime._tag === "Idle" &&
            snapshot.messages.some((message) =>
              message.parts.some((part) => part.type === "tool-result" && part.isFailure),
            ),
          5_000,
          "replay rejection reaches idle with failed tool result",
        )
        const errorEvent = yield* Fiber.join(errorFiber)
        expect(Option.isSome(errorEvent)).toBe(true)
        if (Option.isNone(errorEvent)) {
          return yield* Effect.die(new Error("replay rejection did not publish ErrorOccurred"))
        }
        if (errorEvent.value.event._tag !== "ErrorOccurred") {
          return yield* Effect.die(new Error("unexpected replay error event"))
        }
        expect(errorEvent.value.event.error).toContain("ToolBindingReplayError")
        expect(errorEvent.value.event.error).toContain("SourceMismatch")

        const toolCalls = failed.messages.flatMap((message) =>
          message.parts.flatMap((part) => {
            if (part.type !== "tool-call") return []
            return [part]
          }),
        )
        const toolResults = failed.messages.flatMap((message) =>
          message.parts.flatMap((part) => {
            if (part.type !== "tool-result") return []
            return [part]
          }),
        )
        expect(toolCalls.length).toBe(1)
        expect(toolResults.length).toBe(1)
        const toolCall = Option.fromUndefinedOr(toolCalls[0])
        const toolResult = Option.fromUndefinedOr(toolResults[0])
        if (Option.isNone(toolCall) || Option.isNone(toolResult)) {
          return yield* Effect.die(new Error("replay result pairing is incomplete"))
        }
        expect(toolResult.value.id).toBe(toolCall.value.id)
        expect(toolResult.value.isFailure).toBe(true)
        expect(encodeJson(toolResult.value.result)).toContain("SourceMismatch")
        expect(state.toolExecutions).toBe(0)

        const laterErrors = yield* client.session
          .events({
            sessionId,
            branchId,
            after: Option.getOrElse(Option.fromNullishOr(failed.lastEventId), () => 0),
          })
          .pipe(
            Stream.filter((envelope) => envelope.event._tag === "ErrorOccurred"),
            Stream.runHead,
            Effect.forkScoped,
          )
        yield* client.message.send({
          sessionId,
          branchId,
          content: "start a fresh turn",
        })
        const recovered = yield* waitFor(
          client.session.getSnapshot({ sessionId, branchId }),
          (snapshot) =>
            snapshot.runtime._tag === "Idle" &&
            snapshot.messages.some((message) =>
              message.parts.some(
                (part) => part.type === "text" && part.text === "recovered after replay rejection",
              ),
            ),
          5_000,
          "fresh turn completes after replay rejection",
        )
        expect(
          recovered.messages.some((message) =>
            message.parts.some(
              (part) => part.type === "text" && part.text === "recovered after replay rejection",
            ),
          ),
        ).toBe(true)
        const laterError = yield* Fiber.join(laterErrors).pipe(Effect.timeoutOption("500 millis"))
        expect(Option.isNone(laterError)).toBe(true)
      }).pipe(Effect.timeout("8 seconds")),
    )
  }).pipe(Effect.provide(BunPlatformLive))

describe("native RPC tool replay rejection", () => {
  it.scopedLive(
    "rejects a parked tool call after a semantic configuration revision and recovers",
    () => runReplayScenario("config"),
    12_000,
  )

  it.scopedLive(
    "rejects a parked tool call after a resource revision and recovers",
    () => runReplayScenario("resource"),
    12_000,
  )
})
