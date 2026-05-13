import { Effect, Layer } from "effect"
export { narrowR } from "../../../core/tests/helpers/effect"
import { AllBuiltinAgents } from "../helpers/builtin-agents.js"
import { TODO_EXTENSION_ID } from "../../src/todo/domain.js"
import { TodoExtension } from "../../src/todo/index.js"
import { AgentRunResult, type AgentRunner } from "@gent/core-internal/domain/agent"
import { ExtensionStatePublisher } from "@gent/core-internal/domain/event-publisher"
import {
  ExtensionContext,
  ExtensionServiceError,
  type ExtensionContextService,
} from "@gent/core-internal/domain/extension-services"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { dateFromMillis, Branch, Session } from "@gent/core-internal/domain/message"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import { createToolTestLayer, testToolContext } from "@gent/core-internal/test-utils"
import { toolPreset } from "../helpers/test-preset.js"

export const withTodoWrite = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  effect

export const FIXTURE_DATE = dateFromMillis(0)

const mockRunnerSuccess: AgentRunner = {
  run: (params) =>
    Effect.succeed(
      AgentRunResult.cases.success.make({
        text: `done: ${params.prompt}`,
        sessionId: SessionId.make("child-session"),
        agentName: params.agent.name,
        persistence: "ephemeral",
      }),
    ),
}

export const makeCtx = Effect.gen(function* () {
  const publisher = yield* ExtensionStatePublisher
  const base = testToolContext({
    extensionId: TODO_EXTENSION_ID,
    sessionId: SessionId.make("s1"),
    branchId: BranchId.make("b1"),
    toolCallId: ToolCallId.make("tc1"),
    Agent: {
      run: (params) =>
        Effect.succeed(
          AgentRunResult.cases.success.make({
            text: `done: ${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
            persistence: "ephemeral",
          }),
        ),
      listAgents: () => Effect.succeed(AllBuiltinAgents),
    },
  })
  const State: ExtensionContextService["State"] = {
    changed: (params) =>
      publisher
        .changed({
          extensionId: base.extensionId,
          sessionId: params.sessionId ?? base.sessionId,
          branchId: params.branchId ?? base.branchId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ExtensionServiceError({
                service: "ExtensionState",
                operation: "changed",
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          ),
        ),
  }
  return { ...base, State }
})

const ExtensionContextLayer: Layer.Layer<ExtensionContext, never, ExtensionStatePublisher> =
  Layer.effect(
    ExtensionContext,
    Effect.gen(function* () {
      const publisher = yield* ExtensionStatePublisher
      const base = testToolContext({
        extensionId: TODO_EXTENSION_ID,
        sessionId: SessionId.make("s1"),
        branchId: BranchId.make("b1"),
        toolCallId: ToolCallId.make("tc1"),
      })
      const State: ExtensionContextService["State"] = {
        changed: (params) =>
          publisher
            .changed({
              extensionId: base.extensionId,
              sessionId: params.sessionId ?? base.sessionId,
              branchId: params.branchId ?? base.branchId,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ExtensionServiceError({
                    service: "ExtensionState",
                    operation: "changed",
                    message: cause instanceof Error ? cause.message : String(cause),
                    cause,
                  }),
              ),
            ),
      }
      return { ...base, State }
    }),
  )

const baseLayer = createToolTestLayer({
  ...toolPreset,
  extensions: [TodoExtension],
  subagentRunner: mockRunnerSuccess,
})

export const layer = Layer.merge(baseLayer, Layer.provide(ExtensionContextLayer, baseLayer))

export const setup = Effect.gen(function* () {
  const sessionStorage = yield* SessionStorage
  const branchStorage = yield* BranchStorage
  const now = FIXTURE_DATE
  yield* sessionStorage.createSession(
    new Session({
      id: SessionId.make("s1"),
      name: "Test",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* branchStorage.createBranch(
    new Branch({
      id: BranchId.make("b1"),
      sessionId: SessionId.make("s1"),
      createdAt: now,
    }),
  )
})
