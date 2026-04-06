import { describe, it, expect } from "effect-bun-test"
import { Effect, Layer } from "effect"
import { BunServices } from "@effect/platform-bun"
import { PromptTool } from "@gent/core/extensions/interaction-tools/prompt"
import type { ToolContext } from "@gent/core/domain/tool"
import { PromptPresenter } from "@gent/core/domain/prompt-presenter"
import { RuntimePlatform } from "@gent/core/runtime/runtime-platform"
import type { SessionId, BranchId, ToolCallId } from "@gent/core/domain/ids"

const ctx: ToolContext = {
  sessionId: "test-session" as SessionId,
  branchId: "test-branch" as BranchId,
  toolCallId: "test-call" as ToolCallId,
  approve: () => Effect.succeed({ approved: true }),
  cwd: "/tmp",
  home: "/tmp",
  extensions: {
    send: () => Effect.die("not wired"),
    ask: () => Effect.die("not wired"),
  },
}

const PlatformLayer = Layer.merge(
  BunServices.layer,
  RuntimePlatform.Test({
    cwd: process.cwd(),
    home: "/tmp/test-home",
    platform: "test",
  }),
)

describe("Prompt Tool", () => {
  it.live("review mode: writes content and returns decision", () => {
    const layer = Layer.merge(PromptPresenter.Test([], ["yes"]), PlatformLayer)

    return PromptTool.execute({ mode: "review", content: "## Plan\\n- Step 1" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.mode).toBe("review")
        if (result.mode === "review") {
          expect(result.decision).toBe("yes")
          expect(result.path).toBe("/tmp/test-prompt.md")
        }
      }),
      Effect.provide(layer),
    )
  })

  it.live("confirm mode: returns yes/no decision", () => {
    const layer = Layer.merge(PromptPresenter.Test(["no"]), PlatformLayer)

    return PromptTool.execute({ mode: "confirm", content: "Proceed?" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.mode).toBe("confirm")
        if (result.mode === "confirm") {
          expect(result.decision).toBe("no")
        }
      }),
      Effect.provide(layer),
    )
  })

  it.live("present mode: returns shown status", () => {
    const layer = Layer.merge(PromptPresenter.Test(), PlatformLayer)

    return PromptTool.execute({ mode: "present", content: "Info" }, ctx).pipe(
      Effect.map((result) => {
        expect(result.mode).toBe("present")
        if (result.mode === "present") {
          expect(result.status).toBe("shown")
        }
      }),
      Effect.provide(layer),
    )
  })
})
