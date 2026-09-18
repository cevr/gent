import { describe, it, expect } from "effect-bun-test"
import { Effect, Option } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"
import { DelegateTool } from "../../src/delegate.js"
import {
  AgentDefinition,
  AgentName,
  AgentRunResult,
  DEFAULT_AGENT_NAME,
  ModelId,
  SessionId,
  type ExtensionContextService,
} from "@gent/core/extensions/api"
import { AllBuiltinAgents } from "../helpers/builtin-agents.js"

const helperAgent = AgentDefinition.make({
  name: AgentName.make("helper"),
  model: ModelId.make("openai/gpt-5.4-mini"),
})
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { runToolWithCtx } from "@gent/core-internal/test-utils"

const makeCtx = (overrides: {
  agentName?: AgentName
  agentRun?: (
    params: Parameters<ExtensionContextService["Agent"]["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
}) =>
  testToolContext({
    agentName: overrides.agentName,
    Agent: {
      run:
        overrides.agentRun ??
        (() =>
          Effect.succeed(
            AgentRunResult.cases.Success.make({
              text: "",
              sessionId: SessionId.make("s1"),
              agentName: AgentName.make("test"),
            }),
          )),
      listAgents: Effect.succeed([...AllBuiltinAgents, helperAgent]),
    },
  })

describe("Delegate Tool", () => {
  it.live("delegates to a child running as the default agent and returns output", () => {
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.succeed(
          AgentRunResult.cases.Success.make({
            text: `${params.agent.name}:${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
          }),
        ),
    })

    return narrowR(
      runToolWithCtx(DelegateTool, { todo: "hello" }, ctx).pipe(
        Effect.map((result) => {
          expect("output" in result).toBe(true)
          if (!("output" in result)) return
          expect(result.output).toBe(
            `${DEFAULT_AGENT_NAME}:hello\n\nFull session: session://child-session`,
          )
          const metadata = Option.fromUndefinedOr(result.metadata)
          if (Option.isSome(metadata) && "sessionId" in metadata.value) {
            expect(metadata.value.sessionId).toBe(SessionId.make("child-session"))
          }
        }),
      ),
    )
  })

  it.live("a foreground child cannot delegate further", () => {
    const runs: Array<ReadonlyArray<string>> = []
    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.sync(() => {
          runs.push(params.runSpec?.overrides?.deniedTools ?? [])
          return AgentRunResult.cases.Success.make({
            text: "done",
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
          })
        }),
    })
    return narrowR(
      runToolWithCtx(DelegateTool, { todo: "hello" }, ctx).pipe(
        Effect.map(() => {
          expect(runs).toEqual([["delegate", "agent-child", "agent-children"]])
        }),
      ),
    )
  })

  it.live("child inherits the caller's agent from the tool context", () => {
    const ctx = makeCtx({
      agentName: helperAgent.name,
      agentRun: (params) =>
        Effect.succeed(
          AgentRunResult.cases.Success.make({
            text: `${params.agent.name}:${params.prompt}`,
            sessionId: SessionId.make("child-session"),
            agentName: params.agent.name,
          }),
        ),
    })

    return narrowR(
      runToolWithCtx(DelegateTool, { todo: "hello" }, ctx).pipe(
        Effect.map((result) => {
          expect("output" in result).toBe(true)
          if (!("output" in result)) return
          expect(result.output).toBe("helper:hello\n\nFull session: session://child-session")
        }),
      ),
    )
  })

  it.live("foreground delegation ties the child to the calling tool call", () => {
    let capturedRunSpec = Option.none<{ parentToolCallId?: string }>()
    const ctx = makeCtx({
      agentRun: (params) => {
        capturedRunSpec = Option.fromUndefinedOr(params.runSpec)
        return Effect.succeed(
          AgentRunResult.cases.Success.make({
            text: "ok",
            sessionId: SessionId.make("s"),
            agentName: params.agent.name,
          }),
        )
      },
    })

    return narrowR(
      runToolWithCtx(DelegateTool, { todo: "go" }, ctx).pipe(
        Effect.map(() => {
          expect(
            Option.flatMap(capturedRunSpec, (runSpec) =>
              Option.fromUndefinedOr(runSpec.parentToolCallId),
            ),
          ).toEqual(Option.some(ctx.toolCallId))
        }),
      ),
    )
  })
})
