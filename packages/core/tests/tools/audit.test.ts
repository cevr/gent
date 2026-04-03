import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { AuditTool } from "@gent/core/tools/audit"
import { Agents, AgentRunnerService, type AgentRunResult } from "@gent/core/domain/agent"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"

const TestExtRegistry = ExtensionRegistry.fromResolved(
  resolveExtensions([
    {
      manifest: { id: "agents" },
      kind: "builtin",
      sourcePath: "test",
      setup: { agents: Object.values(Agents) },
    },
  ]),
)
import { PromptPresenter } from "@gent/core/domain/prompt-presenter"
import { EventStore } from "@gent/core/domain/event"
import { Storage } from "@gent/core/storage/sqlite-storage"
import type { ToolContext } from "@gent/core/domain/tool"

const RuntimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
  agentName: "cowork",
}

const makeSuccess = (
  text: string,
  sessionId: AgentRunResult & { _tag: "success" } extends { sessionId: infer S }
    ? S
    : never = "s1" as AgentRunResult & { _tag: "success" } extends { sessionId: infer S }
    ? S
    : never,
  agentName: AgentRunResult & { _tag: "success" } extends { agentName: infer A }
    ? A
    : never = "architect" as AgentRunResult & { _tag: "success" } extends { agentName: infer A }
    ? A
    : never,
): AgentRunResult => ({
  _tag: "success",
  text,
  sessionId,
  agentName,
})

describe("Audit Tool", () => {
  it.live(
    "fix mode detects concerns, audits each concern with both models, synthesizes, and executes",
    () => {
      const calls: Array<{ agentName: string; prompt: string }> = []

      const runnerLayer = Layer.succeed(AgentRunnerService, {
        run: (params) =>
          Effect.sync(() => {
            const prompt = params.prompt
            calls.push({ agentName: params.agent.name, prompt })

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

      const layer = Layer.mergeAll(
        runnerLayer,
        TestExtRegistry,
        PromptPresenter.Test(["yes"]),
        EventStore.Test(),
        Storage.Test(),
        BunServices.layer,
        RuntimePlatformLayer,
      )

      return AuditTool.execute(
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
          expect(auditCalls.every((c) => c.agentName === "auditor")).toBe(true)
        }),
        Effect.provide(layer),
      )
    },
  )

  it.live("report mode skips execution", () => {
    const calls: Array<{ prompt: string }> = []

    const runnerLayer = Layer.succeed(AgentRunnerService, {
      run: (params) => {
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

    const layer = Layer.mergeAll(
      runnerLayer,
      TestExtRegistry,
      PromptPresenter.Test(["yes"]),
      EventStore.Test(),
      Storage.Test(),
      BunServices.layer,
      RuntimePlatformLayer,
    )

    return AuditTool.execute({ paths: ["src/db.ts"], mode: "report" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.findings.length).toBe(1)
        const executeCalls = calls.filter((c) => c.prompt.includes("Execute this audit plan"))
        expect(executeCalls.length).toBe(0)
      }),
      Effect.provide(layer),
    )
  })

  it.live("stops when no concerns detected", () => {
    const runnerLayer = Layer.succeed(AgentRunnerService, {
      run: () => Effect.succeed(makeSuccess("No specific concerns found for this code.")),
    })

    const layer = Layer.mergeAll(
      runnerLayer,
      TestExtRegistry,
      PromptPresenter.Test(),
      EventStore.Test(),
      Storage.Test(),
      BunServices.layer,
      RuntimePlatformLayer,
    )

    return AuditTool.execute({ paths: ["src/clean.ts"], mode: "fix" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.findings.length).toBe(0)
        expect(result.output).toBe("No findings to fix.")
      }),
      Effect.provide(layer),
    )
  })

  it.live("uses primary agent for execution, not architect", () => {
    const executorAgents: string[] = []

    const runnerLayer = Layer.succeed(AgentRunnerService, {
      run: (params) =>
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

    const layer = Layer.mergeAll(
      runnerLayer,
      TestExtRegistry,
      PromptPresenter.Test(["yes"]),
      EventStore.Test(),
      Storage.Test(),
      BunServices.layer,
      RuntimePlatformLayer,
    )

    return AuditTool.execute({ paths: ["src/a.ts"], mode: "fix" }, ctx).pipe(
      Effect.map(() => {
        expect(executorAgents.length).toBeGreaterThan(0)
        expect(executorAgents[0]).toBe("cowork")
      }),
      Effect.provide(layer),
    )
  })

  it.live("auditor subagents run read-only with bash denied", () => {
    const auditOverrides: Array<Record<string, unknown> | undefined> = []

    const runnerLayer = Layer.succeed(AgentRunnerService, {
      run: (params) =>
        Effect.sync(() => {
          if (params.prompt.includes("Audit the code for this concern:")) {
            auditOverrides.push(params.overrides as Record<string, unknown> | undefined)
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

    const layer = Layer.mergeAll(
      runnerLayer,
      TestExtRegistry,
      PromptPresenter.Test(["yes"]),
      EventStore.Test(),
      Storage.Test(),
      BunServices.layer,
      RuntimePlatformLayer,
    )

    return AuditTool.execute({ paths: ["src/a.ts"], mode: "fix" }, ctx).pipe(
      Effect.map(() => {
        expect(auditOverrides.length).toBeGreaterThan(0)
        for (const overrides of auditOverrides) {
          expect(overrides?.["allowedActions"]).toEqual(["read"])
          expect(overrides?.["deniedTools"]).toEqual(["bash"])
        }
      }),
      Effect.provide(layer),
    )
  })
})
