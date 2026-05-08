import { Effect } from "effect"
import { AllBuiltinAgents } from "@gent/extensions/all-agents"
import { TaskExtension } from "@gent/extensions/task-tools"
import { AgentRunResult, type AgentRunner } from "@gent/core-internal/domain/agent"
import { BranchId, SessionId, ToolCallId } from "@gent/core-internal/domain/ids"
import { dateFromMillis, Branch, Session } from "@gent/core-internal/domain/message"
import { BranchStorage } from "@gent/core-internal/storage/branch-storage"
import { SessionStorage } from "@gent/core-internal/storage/session-storage"
import {
  createToolTestLayer,
  provideCapabilityAccessNeeds,
  testToolContext,
} from "@gent/core-internal/test-utils"
import { toolPreset } from "../helpers/test-preset.js"

export const narrowR = <A, E, R>(e: Effect.Effect<A, E, R>): Effect.Effect<A, E, never> =>
  e as Effect.Effect<A, E, never>

export const withTaskWrite = provideCapabilityAccessNeeds([{ tag: "task", access: "write" }])

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

export const FIXTURE_DATE = dateFromMillis(0)

const mockRunnerSuccess: AgentRunner = {
  run: (params) =>
    Effect.succeed(
      AgentRunResult.Success.make({
        text: `done: ${params.prompt}`,
        sessionId: SessionId.make("child-session"),
        agentName: params.agent.name,
        persistence: "ephemeral",
      }),
    ),
}

export const makeCtx = Effect.succeed(
  testToolContext({
    sessionId: SessionId.make("s1"),
    branchId: BranchId.make("b1"),
    toolCallId: ToolCallId.make("tc1"),
    agent: {
      get: (name) => Effect.succeed(AllBuiltinAgents.find((a) => a.name === name)),
      require: (name) => {
        const agent = AllBuiltinAgents.find((a) => a.name === name)
        return agent !== undefined ? Effect.succeed(agent) : Effect.die(`Agent "${name}" not found`)
      },
      run: (params) =>
        Effect.succeed(
          AgentRunResult.Success.make({
            text: `done: ${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
            persistence: "ephemeral",
          }),
        ),
      resolveDualModelPair: dieStub("agent.resolveDualModelPair"),
    },
  }),
)

export const layer = createToolTestLayer({
  ...toolPreset,
  extensions: [TaskExtension],
  subagentRunner: mockRunnerSuccess,
})

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
