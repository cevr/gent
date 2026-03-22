import { describe, test, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { AuditTool } from "@gent/core/tools/audit"
import {
  AgentRegistry,
  Agents,
  SubagentRunnerService,
  type SubagentResult,
} from "@gent/core/domain/agent"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"

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

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
  agentName: "cowork",
}

const makeSuccess = (text: string): SubagentResult => ({
  _tag: "success",
  text,
  sessionId: "s1" as SubagentResult & { _tag: "success" } extends { sessionId: infer S }
    ? S
    : never,
  agentName: "architect" as SubagentResult & { _tag: "success" } extends { agentName: infer A }
    ? A
    : never,
})

describe("Audit Workflow", () => {
  test("detects concerns, audits, synthesizes, and executes", async () => {
    const calls: Array<{ agentName: string; prompt: string }> = []

    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        const prompt = params.prompt
        calls.push({ agentName: params.agent.name, prompt })

        // Detection response
        if (prompt.includes("Identify audit concerns")) {
          return Effect.succeed(
            makeSuccess(
              "1. error-handling: Check error handling patterns\n2. types: Check type safety",
            ),
          )
        }

        // Concern audit responses
        if (prompt.includes("Audit the following code for:")) {
          return Effect.succeed(makeSuccess("Found issues in src/foo.ts"))
        }

        // Synthesis response
        if (prompt.includes("Synthesize audit findings")) {
          return Effect.succeed(
            makeSuccess(
              "1. [warning] src/foo.ts — missing error handling\n2. [suggestion] src/bar.ts — use stricter types",
            ),
          )
        }

        // Execution response
        if (prompt.includes("Execute this audit plan")) {
          return Effect.succeed(makeSuccess("Applied all fixes.\n\nVERDICT: done"))
        }

        // Evaluation response
        if (prompt.includes("Evaluate whether")) {
          return Effect.succeed(makeSuccess("VERDICT: done"))
        }

        return Effect.succeed(makeSuccess("ok"))
      },
    })

    const layer = Layer.mergeAll(
      runnerLayer,
      AgentRegistry.Live,
      TestExtRegistry,
      PromptPresenter.Test(["yes"]),
      EventStore.Test(),
      Storage.Test(),
      BunServices.layer,
    )

    const result = await Effect.runPromise(
      AuditTool.execute(
        {
          prompt: "check error handling",
          paths: ["src/foo.ts", "src/bar.ts"],
          autoApprove: true,
        },
        ctx,
      ).pipe(Effect.provide(layer)),
    )

    expect(result.reason).toBe("done")

    // Should have: detect(1) + audit(2 concerns) + synthesize(1) + execute(1) + evaluate(1) = 6
    const detectCalls = calls.filter((c) => c.prompt.includes("Identify audit concerns"))
    const auditCalls = calls.filter((c) => c.prompt.includes("Audit the following code for:"))
    const synthesisCalls = calls.filter((c) => c.prompt.includes("Synthesize audit findings"))
    const executeCalls = calls.filter((c) => c.prompt.includes("Execute this audit plan"))

    expect(detectCalls.length).toBe(1)
    expect(auditCalls.length).toBe(2)
    expect(synthesisCalls.length).toBe(1)
    expect(executeCalls.length).toBe(1)

    // Auditor agent used for concern audits
    expect(auditCalls.every((c) => c.agentName === "auditor")).toBe(true)
  })

  test("report mode skips execution", async () => {
    const calls: Array<{ prompt: string }> = []

    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        calls.push({ prompt: params.prompt })
        if (params.prompt.includes("Identify audit concerns")) {
          return Effect.succeed(makeSuccess("1. security: Check security patterns"))
        }
        if (params.prompt.includes("Audit the following code for:")) {
          return Effect.succeed(makeSuccess("Found SQL injection risk"))
        }
        if (params.prompt.includes("Synthesize audit findings")) {
          return Effect.succeed(
            makeSuccess("1. [critical] src/db.ts — SQL injection vulnerability"),
          )
        }
        return Effect.succeed(makeSuccess("ok"))
      },
    })

    const layer = Layer.mergeAll(
      runnerLayer,
      AgentRegistry.Live,
      TestExtRegistry,
      PromptPresenter.Test(["yes"]),
      EventStore.Test(),
      Storage.Test(),
      BunServices.layer,
    )

    const result = await Effect.runPromise(
      AuditTool.execute({ paths: ["src/db.ts"], mode: "report", autoApprove: true }, ctx).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result.reason).toBe("done")
    // No execution calls in report mode
    const executeCalls = calls.filter((c) => c.prompt.includes("Execute this audit plan"))
    expect(executeCalls.length).toBe(0)
  })

  test("stops when no concerns detected", async () => {
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: () => Effect.succeed(makeSuccess("No specific concerns found for this code.")),
    })

    const layer = Layer.mergeAll(
      runnerLayer,
      AgentRegistry.Live,
      TestExtRegistry,
      PromptPresenter.Test(),
      EventStore.Test(),
      Storage.Test(),
      BunServices.layer,
    )

    const result = await Effect.runPromise(
      AuditTool.execute({ paths: ["src/clean.ts"], autoApprove: true }, ctx).pipe(
        Effect.provide(layer),
      ),
    )

    expect(result.reason).toBe("done")
    expect(result.iterations).toBe(1)
  })

  test("respects concern approval rejection", async () => {
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        if (params.prompt.includes("Identify audit concerns")) {
          return Effect.succeed(makeSuccess("1. perf: Check performance"))
        }
        return Effect.succeed(makeSuccess("ok"))
      },
    })

    const layer = Layer.mergeAll(
      runnerLayer,
      AgentRegistry.Live,
      TestExtRegistry,
      PromptPresenter.Test(["no"]),
      EventStore.Test(),
      Storage.Test(),
      BunServices.layer,
    )

    const result = await Effect.runPromise(
      AuditTool.execute({ paths: ["src/app.ts"] }, ctx).pipe(Effect.provide(layer)),
    )

    expect(result.reason).toBe("done")
    expect(result.output).toContain("cancelled")
  })

  test("uses primary agent for execution, not architect", async () => {
    const executorAgents: string[] = []

    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        if (params.prompt.includes("Execute this audit plan")) {
          executorAgents.push(params.agent.name)
        }
        if (params.prompt.includes("Identify audit concerns")) {
          return Effect.succeed(makeSuccess("1. types: Check types"))
        }
        if (params.prompt.includes("Audit the following code for:")) {
          return Effect.succeed(makeSuccess("Issues found"))
        }
        if (params.prompt.includes("Synthesize audit findings")) {
          return Effect.succeed(makeSuccess("1. [warning] src/a.ts — type issue"))
        }
        if (params.prompt.includes("Evaluate whether")) {
          return Effect.succeed(makeSuccess("VERDICT: done"))
        }
        return Effect.succeed(makeSuccess("done"))
      },
    })

    const layer = Layer.mergeAll(
      runnerLayer,
      AgentRegistry.Live,
      TestExtRegistry,
      PromptPresenter.Test(["yes"]),
      EventStore.Test(),
      Storage.Test(),
      BunServices.layer,
    )

    await Effect.runPromise(
      AuditTool.execute({ paths: ["src/a.ts"], autoApprove: true }, ctx).pipe(
        Effect.provide(layer),
      ),
    )

    // Executor should be the caller agent (cowork), not architect
    expect(executorAgents.length).toBeGreaterThan(0)
    expect(executorAgents[0]).toBe("cowork")
  })
})
