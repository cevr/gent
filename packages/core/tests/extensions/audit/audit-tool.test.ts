import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { AuditTool } from "@gent/extensions/audit/audit-tool"
import { type AgentRunResult } from "@gent/core/domain/agent"
import { Agents } from "@gent/extensions/all-agents"
import { testToolContext } from "@gent/core/test-utils/extension-harness"
import type { ExtensionHostContext } from "@gent/core/domain/extension-host-context"
import type { ToolContext } from "@gent/core/domain/tool"
import { RuntimePlatform } from "../../../src/runtime/runtime-platform"

const dieStub = (label: string) => () => Effect.die(`${label} not wired in test`)

const makeSuccess = (
  text: string,
  sessionId: string = "s1",
  agentName: string = "architect",
): AgentRunResult => ({
  _tag: "success",
  text,
  sessionId,
  agentName,
})

const makeCtx = (overrides: {
  agentRun: (
    params: Parameters<ExtensionHostContext.Agent["run"]>[0],
  ) => Effect.Effect<AgentRunResult>
  present?: ExtensionHostContext.Interaction["present"]
}): ToolContext =>
  testToolContext({
    agentName: "cowork",
    agent: {
      get: (name) => Effect.succeed(Object.values(Agents).find((a) => a.name === name)),
      require: (name) => {
        const agent = Object.values(Agents).find((a) => a.name === name)
        return agent !== undefined ? Effect.succeed(agent) : Effect.die(`Agent "${name}" not found`)
      },
      run: overrides.agentRun,
      resolveDualModelPair: () =>
        Effect.succeed(["anthropic/claude-opus-4-6", "openai/gpt-5.4"] as const),
    },
    interaction: {
      approve: dieStub("interaction.approve"),
      present: overrides.present ?? (() => Effect.void),
      confirm: dieStub("interaction.confirm"),
      review: dieStub("interaction.review"),
    },
  })

// RuntimePlatform still needed — resolveAuditPaths carries it in the type even when paths are provided
const runtimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

describe("Audit Tool", () => {
  it.live(
    "fix mode detects concerns, audits each concern with both models, synthesizes, and executes",
    () => {
      const calls: Array<{ agentName: string; prompt: string }> = []
      const parentToolCallIds: Array<unknown> = []

      const ctx = makeCtx({
        agentRun: (params) =>
          Effect.sync(() => {
            const prompt = params.prompt
            calls.push({ agentName: params.agent.name, prompt })
            parentToolCallIds.push(params.runSpec?.parentToolCallId)

            if (prompt.includes("Identify audit concerns")) {
              return makeSuccess(
                "1. error-handling: Check error handling patterns\n2. types: Check type safety",
              )
            }
            if (prompt.includes("Audit the code for this concern:")) {
              return makeSuccess("Found issues in src/foo.ts")
            }
            if (prompt.includes("Synthesize these audit notes into final findings")) {
              return makeSuccess(
                "1. [warning] src/foo.ts — missing error handling\n2. [suggestion] src/bar.ts — use stricter types",
              )
            }
            if (prompt.includes("Execute this audit plan")) {
              return makeSuccess("Applied all fixes.")
            }
            return makeSuccess("ok")
          }),
      })

      return AuditTool.effect(
        {
          prompt: "check error handling",
          paths: ["src/foo.ts", "src/bar.ts"],
          mode: "fix",
        },
        ctx,
      ).pipe(
        Effect.map((result) => {
          // Single-cycle: detect + audit + synthesize + execute (no evaluator loop)
          const detectCalls = calls.filter((c) => c.prompt.includes("Identify audit concerns"))
          const auditCalls = calls.filter((c) =>
            c.prompt.includes("Audit the code for this concern:"),
          )
          const synthesisCalls = calls.filter((c) =>
            c.prompt.includes("Synthesize these audit notes into final findings"),
          )
          const executeCalls = calls.filter((c) => c.prompt.includes("Execute this audit plan"))

          expect(detectCalls.length).toBe(1)
          expect(auditCalls.length).toBe(4) // 2 concerns x 2 models
          expect(synthesisCalls.length).toBe(1)
          expect(executeCalls.length).toBe(1)
          expect(result.findings.length).toBe(2)
          expect(result.output).toBe("Applied all fixes.")
          expect(parentToolCallIds.every((id) => id === "test-call")).toBe(true)
          expect(auditCalls.every((c) => c.agentName === "auditor")).toBe(true)
        }),
        Effect.provide(runtimePlatformLayer),
      )
    },
  )

  it.live("report mode skips execution", () => {
    const calls: Array<{ prompt: string }> = []

    const ctx = makeCtx({
      agentRun: (params) => {
        calls.push({ prompt: params.prompt })
        if (params.prompt.includes("Identify audit concerns")) {
          return Effect.succeed(makeSuccess("1. security: Check security patterns"))
        }
        if (params.prompt.includes("Audit the code for this concern:")) {
          return Effect.succeed(makeSuccess("Found SQL injection risk"))
        }
        if (params.prompt.includes("Synthesize these audit notes into final findings")) {
          return Effect.succeed(
            makeSuccess("1. [critical] src/db.ts — SQL injection vulnerability"),
          )
        }
        return Effect.succeed(makeSuccess("ok"))
      },
    })

    return AuditTool.effect({ paths: ["src/db.ts"], mode: "report" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.findings.length).toBe(1)
        const executeCalls = calls.filter((c) => c.prompt.includes("Execute this audit plan"))
        expect(executeCalls.length).toBe(0)
      }),
      Effect.provide(runtimePlatformLayer),
    )
  })

  it.live("stops when no concerns detected", () => {
    const ctx = makeCtx({
      agentRun: () => Effect.succeed(makeSuccess("No specific concerns found for this code.")),
    })

    return AuditTool.effect({ paths: ["src/clean.ts"], mode: "fix" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.findings.length).toBe(0)
        expect(result.output).toBe("No findings to fix.")
      }),
      Effect.provide(runtimePlatformLayer),
    )
  })

  it.live("uses primary agent for execution, not architect", () => {
    const executorAgents: string[] = []

    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.sync(() => {
          if (params.prompt.includes("Execute this audit plan")) {
            executorAgents.push(params.agent.name)
          }
          if (params.prompt.includes("Identify audit concerns")) {
            return makeSuccess("1. types: Check types")
          }
          if (params.prompt.includes("Audit the code for this concern:")) {
            return makeSuccess("Issues found")
          }
          if (params.prompt.includes("Synthesize these audit notes into final findings")) {
            return makeSuccess("1. [warning] src/a.ts — type issue")
          }
          return makeSuccess("done")
        }),
    })

    return AuditTool.effect({ paths: ["src/a.ts"], mode: "fix" }, ctx).pipe(
      Effect.map(() => {
        expect(executorAgents.length).toBeGreaterThan(0)
        expect(executorAgents[0]).toBe("cowork")
      }),
      Effect.provide(runtimePlatformLayer),
    )
  })

  it.live("auditor subagents run read-only with bash denied", () => {
    const auditOverrides: Array<Record<string, unknown> | undefined> = []

    const ctx = makeCtx({
      agentRun: (params) =>
        Effect.sync(() => {
          if (params.prompt.includes("Audit the code for this concern:")) {
            auditOverrides.push(params.runSpec?.overrides as Record<string, unknown> | undefined)
          }
          if (params.prompt.includes("Identify audit concerns")) {
            return makeSuccess("1. types: Check types")
          }
          if (params.prompt.includes("Audit the code for this concern:")) {
            return makeSuccess("Issues found")
          }
          if (params.prompt.includes("Synthesize these audit notes into final findings")) {
            return makeSuccess("1. [warning] src/a.ts — type issue")
          }
          return makeSuccess("done")
        }),
    })

    return AuditTool.effect({ paths: ["src/a.ts"], mode: "fix" }, ctx).pipe(
      Effect.map(() => {
        expect(auditOverrides.length).toBeGreaterThan(0)
        for (const overrides of auditOverrides) {
          expect(overrides?.["allowedTools"]).toEqual(["grep", "glob", "read", "memory_search"])
          expect(overrides?.["deniedTools"]).toEqual(["bash"])
        }
      }),
      Effect.provide(runtimePlatformLayer),
    )
  })
})
