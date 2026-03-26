import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { AuditTool } from "@gent/core/tools/audit"
import { Agents, SubagentRunnerService, type SubagentResult } from "@gent/core/domain/agent"
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
import { EventStore, ToolCallStarted, ToolCallSucceeded } from "@gent/core/domain/event"
import { Storage } from "@gent/core/storage/sqlite-storage"
import type { ToolContext } from "@gent/core/domain/tool"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
  agentName: "cowork",
}

const makeSuccess = (
  text: string,
  sessionId: SubagentResult & { _tag: "success" } extends { sessionId: infer S }
    ? S
    : never = "s1" as SubagentResult & { _tag: "success" } extends { sessionId: infer S }
    ? S
    : never,
  agentName: SubagentResult & { _tag: "success" } extends { agentName: infer A }
    ? A
    : never = "architect" as SubagentResult & { _tag: "success" } extends { agentName: infer A }
    ? A
    : never,
): SubagentResult => ({
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

      const runnerLayer = Layer.succeed(SubagentRunnerService, {
        run: (params) =>
          Effect.gen(function* () {
            const prompt = params.prompt
            calls.push({ agentName: params.agent.name, prompt })

            // Detection response
            if (prompt.includes("Identify audit concerns")) {
              return makeSuccess(
                "1. error-handling: Check error handling patterns\n2. types: Check type safety",
                "s1" as SubagentResult & { _tag: "success" } extends { sessionId: infer S }
                  ? S
                  : never,
                params.agent.name as SubagentResult & { _tag: "success" } extends {
                  agentName: infer A
                }
                  ? A
                  : never,
              )
            }

            // Concern audit responses
            if (prompt.includes("Audit the code for this concern:")) {
              return makeSuccess(
                "Found issues in src/foo.ts",
                "s1" as SubagentResult & { _tag: "success" } extends { sessionId: infer S }
                  ? S
                  : never,
                params.agent.name as SubagentResult & { _tag: "success" } extends {
                  agentName: infer A
                }
                  ? A
                  : never,
              )
            }

            // Synthesis response
            if (prompt.includes("Synthesize these audit notes into final findings")) {
              return makeSuccess(
                "1. [warning] src/foo.ts — missing error handling\n2. [suggestion] src/bar.ts — use stricter types",
                "s1" as SubagentResult & { _tag: "success" } extends { sessionId: infer S }
                  ? S
                  : never,
                params.agent.name as SubagentResult & { _tag: "success" } extends {
                  agentName: infer A
                }
                  ? A
                  : never,
              )
            }

            // Execution response
            if (prompt.includes("Execute this audit plan")) {
              return makeSuccess(
                "Applied all fixes.",
                "s1" as SubagentResult & { _tag: "success" } extends { sessionId: infer S }
                  ? S
                  : never,
                params.agent.name as SubagentResult & { _tag: "success" } extends {
                  agentName: infer A
                }
                  ? A
                  : never,
              )
            }

            // Evaluation response
            if (prompt.includes("Evaluate whether")) {
              const storage = yield* Storage
              const sessionId = "audit-eval-session" as SubagentResult & {
                _tag: "success"
              } extends {
                sessionId: infer S
              }
                ? S
                : never
              yield* storage.appendEvent(
                new ToolCallStarted({
                  sessionId,
                  branchId: "test-branch",
                  toolCallId: "audit-loop-eval-call",
                  toolName: "loop_evaluation",
                  input: { verdict: "done", summary: "complete" },
                }),
              )
              yield* storage.appendEvent(
                new ToolCallSucceeded({
                  sessionId,
                  branchId: "test-branch",
                  toolCallId: "audit-loop-eval-call",
                  toolName: "loop_evaluation",
                  summary: "complete",
                }),
              )
              return makeSuccess(
                "evaluation complete",
                sessionId,
                params.agent.name as SubagentResult & { _tag: "success" } extends {
                  agentName: infer A
                }
                  ? A
                  : never,
              )
            }

            return makeSuccess(
              "ok",
              "s1" as SubagentResult & { _tag: "success" } extends { sessionId: infer S }
                ? S
                : never,
              params.agent.name as SubagentResult & { _tag: "success" } extends {
                agentName: infer A
              }
                ? A
                : never,
            )
          }),
      })

      const layer = Layer.mergeAll(
        runnerLayer,

        TestExtRegistry,
        PromptPresenter.Test(["yes"]),
        EventStore.Test(),
        Storage.Test(),
        BunServices.layer,
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
          expect(result.reason).toBe("done")

          // detect(1) + audit(2 concerns x 2 models) + synthesize(1) + execute(1) + evaluate(1)
          const detectCalls = calls.filter((c) => c.prompt.includes("Identify audit concerns"))
          const auditCalls = calls.filter((c) =>
            c.prompt.includes("Audit the code for this concern:"),
          )
          const synthesisCalls = calls.filter((c) =>
            c.prompt.includes("Synthesize these audit notes into final findings"),
          )
          const executeCalls = calls.filter((c) => c.prompt.includes("Execute this audit plan"))

          expect(detectCalls.length).toBe(1)
          expect(auditCalls.length).toBe(4)
          expect(synthesisCalls.length).toBe(1)
          expect(executeCalls.length).toBe(1)
          expect(synthesisCalls[0]!.prompt).toContain("executor can work in batches")
          expect(executeCalls[0]!.prompt).toContain("small batches grouped by file or dependency")

          // Auditor agent used for concern audits
          expect(auditCalls.every((c) => c.agentName === "auditor")).toBe(true)
        }),
        Effect.provide(layer),
      )
    },
  )

  it.live("report mode skips execution and returns done", () => {
    const calls: Array<{ prompt: string }> = []

    const runnerLayer = Layer.succeed(SubagentRunnerService, {
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
    )

    return AuditTool.execute({ paths: ["src/db.ts"], mode: "report" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.reason).toBe("done")
        // No execution calls in report mode
        const executeCalls = calls.filter((c) => c.prompt.includes("Execute this audit plan"))
        expect(executeCalls.length).toBe(0)
      }),
      Effect.provide(layer),
    )
  })

  it.live("stops when no concerns detected", () => {
    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: () => Effect.succeed(makeSuccess("No specific concerns found for this code.")),
    })

    const layer = Layer.mergeAll(
      runnerLayer,

      TestExtRegistry,
      PromptPresenter.Test(),
      EventStore.Test(),
      Storage.Test(),
      BunServices.layer,
    )

    return AuditTool.execute({ paths: ["src/clean.ts"], mode: "fix" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.reason).toBe("done")
        expect(result.iterations).toBe(1)
      }),
      Effect.provide(layer),
    )
  })

  it.live("uses primary agent for execution, not architect", () => {
    const executorAgents: string[] = []

    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) =>
        Effect.gen(function* () {
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
          if (params.prompt.includes("Evaluate whether")) {
            const storage = yield* Storage
            const sessionId = "executor-eval-session" as SubagentResult & {
              _tag: "success"
            } extends { sessionId: infer S }
              ? S
              : never
            yield* storage.appendEvent(
              new ToolCallStarted({
                sessionId,
                branchId: "test-branch",
                toolCallId: "executor-loop-eval-call",
                toolName: "loop_evaluation",
                input: { verdict: "done", summary: "complete" },
              }),
            )
            yield* storage.appendEvent(
              new ToolCallSucceeded({
                sessionId,
                branchId: "test-branch",
                toolCallId: "executor-loop-eval-call",
                toolName: "loop_evaluation",
                summary: "complete",
              }),
            )
            return makeSuccess("evaluation complete", sessionId)
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
    )

    return AuditTool.execute({ paths: ["src/a.ts"], mode: "fix" }, ctx).pipe(
      Effect.map(() => {
        // Executor should be the caller agent (cowork), not architect
        expect(executorAgents.length).toBeGreaterThan(0)
        expect(executorAgents[0]).toBe("cowork")
      }),
      Effect.provide(layer),
    )
  })

  it.live("auditor subagents run read-only with bash denied", () => {
    const auditOverrides: Array<Record<string, unknown> | undefined> = []

    const runnerLayer = Layer.succeed(SubagentRunnerService, {
      run: (params) =>
        Effect.gen(function* () {
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
          if (params.prompt.includes("Evaluate whether")) {
            const storage = yield* Storage
            const sessionId = "readonly-eval-session" as SubagentResult & {
              _tag: "success"
            } extends { sessionId: infer S }
              ? S
              : never
            yield* storage.appendEvent(
              new ToolCallStarted({
                sessionId,
                branchId: "test-branch",
                toolCallId: "readonly-loop-eval-call",
                toolName: "loop_evaluation",
                input: { verdict: "done", summary: "complete" },
              }),
            )
            yield* storage.appendEvent(
              new ToolCallSucceeded({
                sessionId,
                branchId: "test-branch",
                toolCallId: "readonly-loop-eval-call",
                toolName: "loop_evaluation",
                summary: "complete",
              }),
            )
            return makeSuccess("evaluation complete", sessionId)
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
