import { describe, test, expect } from "bun:test"
import { Effect, Layer, FileSystem } from "effect"
import { BunServices } from "@effect/platform-bun"
import { FinderTool, OracleTool, CodeReviewTool, LookAtTool, HandoffTool } from "@gent/tools"
import { SubagentRunnerService, HandoffHandler, type ToolContext, type SessionId } from "@gent/core"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

const mockRunnerSuccess = Layer.succeed(SubagentRunnerService, {
  run: (params) =>
    Effect.succeed({
      _tag: "success" as const,
      text: `response from ${params.agent.name}`,
      sessionId: "child-session" as SessionId,
      agentName: params.agent.name,
    }),
})

const mockRunnerError = Layer.succeed(SubagentRunnerService, {
  run: () =>
    Effect.succeed({
      _tag: "error" as const,
      error: "runner failed",
    }),
})

const mockRunnerErrorWithSession = Layer.succeed(SubagentRunnerService, {
  run: () =>
    Effect.succeed({
      _tag: "error" as const,
      error: "runner failed",
      sessionId: "error-session" as SessionId,
    }),
})

const platformLayer = BunServices.layer

describe("FinderTool", () => {
  test("success → { found: true, response }", async () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer)
    const result = await Effect.runPromise(
      FinderTool.execute({ query: "find auth module" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.found).toBe(true)
    expect(result.response).toContain("response from")
  })

  test("error → { found: false, error }", async () => {
    const layer = Layer.mergeAll(mockRunnerError, platformLayer)
    const result = await Effect.runPromise(
      FinderTool.execute({ query: "find something" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.found).toBe(false)
    expect(result.error).toBe("runner failed")
  })
})

describe("OracleTool", () => {
  test("passes task to runner prompt", async () => {
    let capturedPrompt = ""
    const capturingRunner = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed({
          _tag: "success" as const,
          text: "oracle response",
          sessionId: "child" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    await Effect.runPromise(
      OracleTool.execute({ task: "analyze architecture" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(capturedPrompt).toContain("analyze architecture")
  })

  test("inlines file contents when files provided", async () => {
    let capturedPrompt = ""
    const capturingRunner = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed({
          _tag: "success" as const,
          text: "oracle response",
          sessionId: "child" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)

    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectory()
        const filePath = `${tmpDir}/test.ts`
        yield* fs.writeFileString(filePath, "const x = 42")

        yield* OracleTool.execute({ task: "review this", files: [filePath] }, ctx)
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    expect(capturedPrompt).toContain("const x = 42")
  })

  test("returns error on runner failure", async () => {
    const layer = Layer.mergeAll(mockRunnerError, platformLayer)
    const result = await Effect.runPromise(
      OracleTool.execute({ task: "solve this" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.error).toBe("runner failed")
  })
})

describe("CodeReviewTool", () => {
  test("passes description to runner", async () => {
    let capturedPrompt = ""
    const capturingRunner = Layer.succeed(SubagentRunnerService, {
      run: (params) => {
        capturedPrompt = params.prompt
        return Effect.succeed({
          _tag: "success" as const,
          text: "[]",
          sessionId: "child" as SessionId,
          agentName: params.agent.name,
        })
      },
    })
    const layer = Layer.mergeAll(capturingRunner, platformLayer)
    await Effect.runPromise(
      CodeReviewTool.execute({ description: "refactored auth module" }, ctx).pipe(
        Effect.provide(layer),
      ),
    )
    expect(capturedPrompt).toContain("refactored auth module")
  })

  test("parses structured JSON review output", async () => {
    const jsonOutput = JSON.stringify([
      {
        file: "src/auth.ts",
        line: 10,
        severity: "high",
        type: "bug",
        text: "Missing null check",
      },
    ])
    const runner = Layer.succeed(SubagentRunnerService, {
      run: () =>
        Effect.succeed({
          _tag: "success" as const,
          text: jsonOutput,
          sessionId: "child" as SessionId,
          agentName: "reviewer",
        }),
    })
    const layer = Layer.mergeAll(runner, platformLayer)
    const result = await Effect.runPromise(
      CodeReviewTool.execute({ description: "test" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.comments.length).toBe(1)
    expect(result.comments[0]!.severity).toBe("high")
    expect(result.summary?.high).toBe(1)
  })

  test("falls back to raw text on parse failure", async () => {
    const runner = Layer.succeed(SubagentRunnerService, {
      run: () =>
        Effect.succeed({
          _tag: "success" as const,
          text: "not valid json",
          sessionId: "child" as SessionId,
          agentName: "reviewer",
        }),
    })
    const layer = Layer.mergeAll(runner, platformLayer)
    const result = await Effect.runPromise(
      CodeReviewTool.execute({ description: "test" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.comments.length).toBe(0)
    expect(result.raw).toBe("not valid json\n\nFull session: session://child")
  })
})

describe("LookAtTool", () => {
  test("returns analysis output on success", async () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectory()
        const filePath = `${tmpDir}/image.png`
        yield* fs.writeFileString(filePath, "fake image data")

        return yield* LookAtTool.execute({ path: filePath, objective: "describe this" }, ctx)
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    expect(result.output).toContain("response from")
  })

  test("errors on missing file", async () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer)
    const result = await Effect.runPromise(
      Effect.result(
        LookAtTool.execute({ path: "/nonexistent/file.png", objective: "analyze" }, ctx).pipe(
          Effect.provide(layer),
        ),
      ),
    )
    expect(result._tag).toBe("Failure")
  })
})

describe("HandoffTool", () => {
  test("returns handoff confirmed when user accepts", async () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer, HandoffHandler.Test(["confirm"]))
    const result = await Effect.runPromise(
      HandoffTool.execute(
        {
          context: "Current task: implement auth. Key files: src/auth.ts",
          reason: "context window filling up",
        },
        ctx,
      ).pipe(Effect.provide(layer)),
    )
    expect(result.handoff).toBe(true)
    expect(result.summary).toContain("implement auth")
    expect(result.parentSessionId).toBe("test-session")
  })

  test("returns handoff rejected when user declines", async () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer, HandoffHandler.Test(["reject"]))
    const result = await Effect.runPromise(
      HandoffTool.execute(
        {
          context: "Current task: implement auth",
        },
        ctx,
      ).pipe(Effect.provide(layer)),
    )
    expect(result.handoff).toBe(false)
    expect(result.reason).toBe("User rejected handoff")
  })
})

describe("Session refs in subagent output", () => {
  test("FinderTool appends session ref to response", async () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer)
    const result = await Effect.runPromise(
      FinderTool.execute({ query: "find something" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.response).toContain("\n\nFull session: session://child-session")
  })

  test("OracleTool appends session ref to output", async () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer)
    const result = await Effect.runPromise(
      OracleTool.execute({ task: "analyze" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.output).toContain("\n\nFull session: session://child-session")
  })

  test("LookAtTool appends session ref to output", async () => {
    const layer = Layer.mergeAll(mockRunnerSuccess, platformLayer)
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const tmpDir = yield* fs.makeTempDirectory()
        const filePath = `${tmpDir}/test.txt`
        yield* fs.writeFileString(filePath, "test content")
        return yield* LookAtTool.execute({ path: filePath, objective: "analyze" }, ctx)
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
    expect(result.output).toContain("\n\nFull session: session://child-session")
  })

  test("CodeReviewTool includes session ref on structured output", async () => {
    const jsonOutput = JSON.stringify([
      { file: "a.ts", severity: "low", type: "style", text: "minor" },
    ])
    const runner = Layer.succeed(SubagentRunnerService, {
      run: () =>
        Effect.succeed({
          _tag: "success" as const,
          text: jsonOutput,
          sessionId: "child" as SessionId,
          agentName: "reviewer",
        }),
    })
    const layer = Layer.mergeAll(runner, platformLayer)
    const result = await Effect.runPromise(
      CodeReviewTool.execute({ description: "test" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.session).toBe("session://child")
  })

  test("error path includes session ref when sessionId present", async () => {
    const layer = Layer.mergeAll(mockRunnerErrorWithSession, platformLayer)
    const result = await Effect.runPromise(
      FinderTool.execute({ query: "find something" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.found).toBe(false)
    expect(result.error).toContain("session://error-session")
  })

  test("error path omits session ref when sessionId absent", async () => {
    const layer = Layer.mergeAll(mockRunnerError, platformLayer)
    const result = await Effect.runPromise(
      OracleTool.execute({ task: "solve" }, ctx).pipe(Effect.provide(layer)),
    )
    expect(result.error).toBe("runner failed")
    expect(result.error).not.toContain("session://")
  })
})
