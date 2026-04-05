import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer, FileSystem } from "effect"
import { BunServices } from "@effect/platform-bun"
import { CounselTool } from "@gent/core/extensions/subagent-tools/counsel"
import { Agents, AgentRunnerService } from "@gent/core/domain/agent"
import type { ToolContext } from "@gent/core/domain/tool"
import type { SessionId } from "@gent/core/domain/ids"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import { ExtensionRegistry, resolveExtensions } from "@gent/core/runtime/extensions/registry"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

const mockRunnerErrorWithSession = Layer.succeed(AgentRunnerService, {
  run: () =>
    Effect.succeed({
      _tag: "error" as const,
      error: "runner failed",
      sessionId: "error-session" as SessionId,
    }),
})

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

const runtimePlatformLayer = RuntimePlatform.Test({
  cwd: process.cwd(),
  home: "/tmp/test-home",
  platform: "test",
})

const platformLayer = Layer.mergeAll(BunServices.layer, runtimePlatformLayer, TestExtRegistry)

describe("CounselTool", () => {
  it.live("always routes to deepwork reviewer", () => {
    let capturedAgent = ""
    const capturingRunner = Layer.succeed(AgentRunnerService, {
      run: (params) => {
        capturedAgent = params.agent.name
        return Effect.succeed({
          _tag: "success" as const,
          text: "review from deepwork",
          sessionId: "counsel-session" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    const coworkCtx: ToolContext = { ...ctx, agentName: "cowork" }
    return CounselTool.execute({ prompt: "review this code" }, coworkCtx).pipe(
      Effect.map((result) => {
        expect(capturedAgent).toBe("deepwork")
        expect(result.review).toContain("review from deepwork")
        expect(result.review).toContain("session://counsel-session")
        expect(result.reviewer).toBe("deepwork")
      }),
      Effect.provide(layer),
    )
  })

  it.live("includes adversarial framing in prompt", () => {
    let capturedPrompt = ""
    const capturingRunner = Layer.succeed(AgentRunnerService, {
      run: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed({
          _tag: "success" as const,
          text: "looks fine",
          sessionId: "session" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    return CounselTool.execute({ prompt: "review auth module" }, ctx).pipe(
      Effect.map(() => {
        expect(capturedPrompt).toContain("adversarial peer reviewer")
        expect(capturedPrompt).toContain("review auth module")
      }),
      Effect.provide(layer),
    )
  })

  it.live("inlines file contents when provided", () => {
    let capturedPrompt = ""
    const capturingRunner = Layer.succeed(AgentRunnerService, {
      run: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed({
          _tag: "success" as const,
          text: "review result",
          sessionId: "session" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const tmpDir = yield* fs.makeTempDirectory()
      const filePath = `${tmpDir}/auth.ts`
      yield* fs.writeFileString(filePath, "export const secret = 42")
      yield* CounselTool.execute({ prompt: "review this", files: [filePath] }, ctx)
    }).pipe(
      Effect.scoped,
      Effect.map(() => {
        expect(capturedPrompt).toContain("export const secret = 42")
      }),
      Effect.provide(layer),
    )
  })

  it.live("returns error with session ref on failure", () => {
    const layer = Layer.mergeAll(mockRunnerErrorWithSession, platformLayer)
    return CounselTool.execute({ prompt: "review" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.error).toContain("runner failed")
        expect(result.error).toContain("session://error-session")
      }),
      Effect.provide(layer),
    )
  })

  it.live("spawns agent with restricted read-only tools", () => {
    let capturedAllowedActions: readonly string[] | undefined
    let capturedDeniedTools: readonly string[] | undefined
    const capturingRunner = Layer.succeed(AgentRunnerService, {
      run: (params) => {
        capturedAllowedActions = params.agent.allowedActions
        capturedDeniedTools = params.agent.deniedTools
        return Effect.succeed({
          _tag: "success" as const,
          text: "review",
          sessionId: "session" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    return CounselTool.execute({ prompt: "review" }, ctx).pipe(
      Effect.map(() => {
        expect(capturedAllowedActions).toBeDefined()
        expect(capturedAllowedActions).toContain("read")
        expect(capturedAllowedActions).not.toContain("edit")
        expect(capturedAllowedActions).not.toContain("exec")
        expect(capturedDeniedTools).toBeDefined()
        expect(capturedDeniedTools).toContain("bash")
      }),
      Effect.provide(layer),
    )
  })

  it.live("works from any agent (always routes to deepwork)", () => {
    let capturedAgent = ""
    const capturingRunner = Layer.succeed(AgentRunnerService, {
      run: (params) => {
        capturedAgent = params.agent.name
        return Effect.succeed({
          _tag: "success" as const,
          text: "review result",
          sessionId: "session" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    const explorerCtx: ToolContext = { ...ctx, agentName: "explore" }
    return CounselTool.execute({ prompt: "review" }, explorerCtx).pipe(
      Effect.map((result) => {
        expect(capturedAgent).toBe("deepwork")
        expect(result.reviewer).toBe("deepwork")
      }),
      Effect.provide(layer),
    )
  })
})
