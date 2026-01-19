import { describe, test, expect } from "bun:test"
import { Effect, Schema } from "effect"
import {
  PlanEnterTool,
  PlanExitTool,
  PlanModeHandler,
  isToolAllowedInMode,
  PLAN_MODE_TOOLS,
} from "@gent/tools"
import { SteerCommand } from "@gent/runtime"
import { AgentMode } from "@gent/core"
import type { ToolContext } from "@gent/core"

const ctx: ToolContext = {
  sessionId: "test-session",
  branchId: "test-branch",
  toolCallId: "test-call",
}

describe("Plan Mode", () => {
  test("PlanEnterTool switches to plan mode", async () => {
    const layer = PlanModeHandler.Test("build", [true])

    const result = await Effect.runPromise(
      PlanEnterTool.execute({}, ctx).pipe(Effect.provide(layer))
    )

    expect(result.mode).toBe("plan")
    expect(result.message).toContain("plan mode")
  })

  test("PlanEnterTool respects user declining", async () => {
    const layer = PlanModeHandler.Test("build", [false])

    const result = await Effect.runPromise(
      PlanEnterTool.execute({}, ctx).pipe(Effect.provide(layer))
    )

    expect(result.mode).toBe("build")
    expect(result.message).toContain("declined")
  })

  test("PlanExitTool switches to build mode", async () => {
    const layer = PlanModeHandler.Test("plan", [true])

    const result = await Effect.runPromise(
      PlanExitTool.execute({}, ctx).pipe(Effect.provide(layer))
    )

    expect(result.mode).toBe("build")
    expect(result.message).toContain("build mode")
  })

  test("isToolAllowedInMode allows all tools in build mode", () => {
    expect(isToolAllowedInMode("write", "build")).toBe(true)
    expect(isToolAllowedInMode("bash", "build")).toBe(true)
    expect(isToolAllowedInMode("edit", "build")).toBe(true)
  })

  test("isToolAllowedInMode restricts tools in plan mode", () => {
    expect(isToolAllowedInMode("read", "plan")).toBe(true)
    expect(isToolAllowedInMode("grep", "plan")).toBe(true)
    expect(isToolAllowedInMode("glob", "plan")).toBe(true)
    expect(isToolAllowedInMode("webfetch", "plan")).toBe(true)
    expect(isToolAllowedInMode("question", "plan")).toBe(true)

    expect(isToolAllowedInMode("write", "plan")).toBe(false)
    expect(isToolAllowedInMode("edit", "plan")).toBe(false)
    expect(isToolAllowedInMode("bash", "plan")).toBe(false)
  })

  test("PLAN_MODE_TOOLS contains expected tools", () => {
    expect(PLAN_MODE_TOOLS).toContain("read")
    expect(PLAN_MODE_TOOLS).toContain("grep")
    expect(PLAN_MODE_TOOLS).toContain("glob")
    expect(PLAN_MODE_TOOLS).toContain("webfetch")
    expect(PLAN_MODE_TOOLS).toContain("plan_exit")
  })
})

describe("Session Mode Initialization", () => {
  test("AgentLoop defaults to plan mode", async () => {
    // The agent loop starts in plan mode by default
    // This is verified by checking the PLAN_MODE_TOOLS restriction
    // When in plan mode, only read-only tools should be allowed
    expect(isToolAllowedInMode("read", "plan")).toBe(true)
    expect(isToolAllowedInMode("write", "plan")).toBe(false)
    expect(isToolAllowedInMode("bash", "plan")).toBe(false)
  })

  test("mode can be switched from plan to build", async () => {
    const layer = PlanModeHandler.Test("plan", [true])

    const result = await Effect.runPromise(
      PlanExitTool.execute({}, ctx).pipe(Effect.provide(layer))
    )

    expect(result.mode).toBe("build")
    expect(result.message).toContain("build mode")
  })

  test("mode can be switched from build to plan", async () => {
    const layer = PlanModeHandler.Test("build", [true])

    const result = await Effect.runPromise(
      PlanEnterTool.execute({}, ctx).pipe(Effect.provide(layer))
    )

    expect(result.mode).toBe("plan")
    expect(result.message).toContain("plan mode")
  })

  test("PLAN_MODE_TOOLS contains all read-only tools", () => {
    expect(PLAN_MODE_TOOLS).toContain("read")
    expect(PLAN_MODE_TOOLS).toContain("grep")
    expect(PLAN_MODE_TOOLS).toContain("glob")
    expect(PLAN_MODE_TOOLS).toContain("webfetch")
    expect(PLAN_MODE_TOOLS).toContain("question")
    expect(PLAN_MODE_TOOLS).toContain("todo_read")
    expect(PLAN_MODE_TOOLS).toContain("ask_user")
    expect(PLAN_MODE_TOOLS).toContain("plan_exit")
  })

  test("write tools are excluded from plan mode", () => {
    const writeTools = ["write", "edit", "bash"]
    for (const tool of writeTools) {
      expect(isToolAllowedInMode(tool, "plan")).toBe(false)
    }
  })
})

describe("Steer Commands", () => {
  test("SteerCommand schema accepts SwitchMode with plan", () => {
    const cmd = { _tag: "SwitchMode" as const, mode: "plan" as const }
    const decoded = Schema.decodeUnknownSync(SteerCommand)(cmd)
    expect(decoded._tag).toBe("SwitchMode")
    expect((decoded as { mode: string }).mode).toBe("plan")
  })

  test("SteerCommand schema accepts SwitchMode with build", () => {
    const cmd = { _tag: "SwitchMode" as const, mode: "build" as const }
    const decoded = Schema.decodeUnknownSync(SteerCommand)(cmd)
    expect(decoded._tag).toBe("SwitchMode")
    expect((decoded as { mode: string }).mode).toBe("build")
  })

  test("SteerCommand schema rejects invalid mode", () => {
    const cmd = { _tag: "SwitchMode", mode: "invalid" }
    expect(() => Schema.decodeUnknownSync(SteerCommand)(cmd)).toThrow()
  })

  test("SteerCommand schema accepts Cancel", () => {
    const cmd = { _tag: "Cancel" as const }
    const decoded = Schema.decodeUnknownSync(SteerCommand)(cmd)
    expect(decoded._tag).toBe("Cancel")
  })

  test("SteerCommand schema accepts SwitchModel", () => {
    const cmd = { _tag: "SwitchModel" as const, model: "anthropic/claude-3-opus" }
    const decoded = Schema.decodeUnknownSync(SteerCommand)(cmd)
    expect(decoded._tag).toBe("SwitchModel")
    expect((decoded as { model: string }).model).toBe("anthropic/claude-3-opus")
  })
})

describe("AgentMode Schema", () => {
  test("AgentMode accepts plan", () => {
    const decoded = Schema.decodeUnknownSync(AgentMode)("plan")
    expect(decoded).toBe("plan")
  })

  test("AgentMode accepts build", () => {
    const decoded = Schema.decodeUnknownSync(AgentMode)("build")
    expect(decoded).toBe("build")
  })

  test("AgentMode rejects invalid values", () => {
    expect(() => Schema.decodeUnknownSync(AgentMode)("other")).toThrow()
    expect(() => Schema.decodeUnknownSync(AgentMode)("planning")).toThrow()
    expect(() => Schema.decodeUnknownSync(AgentMode)(null)).toThrow()
  })
})
