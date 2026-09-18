import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { narrowR } from "../../../core/tests/helpers/effect"
import { PromptTool } from "../../src/interaction-tools.js"
import { testToolContext } from "@gent/core-internal/test-utils/extension-harness"
import { runToolWithCtx } from "@gent/core-internal/test-utils"
import { makeTempDirectoryScoped } from "@gent/core-internal/test-utils/language-model"
import { BunFileSystem } from "@effect/platform-bun"
import type { ApprovalDecision } from "@gent/core-internal/domain/interaction.js"
import type { ExtensionContextService } from "@gent/core/extensions/api"

const interactionDeciding = (
  decision: ApprovalDecision,
): ExtensionContextService["Interaction"] => ({
  approve: () => Effect.succeed(decision),
  present: () => Effect.die("interaction.present not wired"),
})

describe("Prompt Tool", () => {
  it.scopedLive(
    "review mode: writes the content under .gent/prompts and returns the decision",
    () =>
      narrowR(
        Effect.gen(function* () {
          const cwd = yield* makeTempDirectoryScoped("prompt-review")
          const ctx = testToolContext({ cwd, Interaction: interactionDeciding({ approved: true }) })
          const result = yield* runToolWithCtx(
            PromptTool,
            { mode: "review", content: "## Plan\n- Step 1", title: "Release Plan" },
            ctx,
          )
          expect(result.mode).toBe("review")
          if (result.mode !== "review") return
          expect(result.decision).toBe("yes")
          expect(result.path.startsWith(`${cwd}/.gent/prompts/release-plan-`)).toBe(true)
          expect(yield* ctx.Files.read(result.path)).toBe("# Release Plan\n\n## Plan\n- Step 1")
        }).pipe(Effect.provide(BunFileSystem.layer)),
      ),
  )

  it.scopedLive("review mode: an edit decision stores the edited content", () =>
    narrowR(
      Effect.gen(function* () {
        const cwd = yield* makeTempDirectoryScoped("prompt-edit")
        const ctx = testToolContext({
          cwd,
          Interaction: interactionDeciding({
            approved: true,
            notes: "edit",
            editedContent: "revised",
          }),
        })
        const result = yield* runToolWithCtx(PromptTool, { mode: "review", content: "draft" }, ctx)
        expect(result.mode).toBe("review")
        if (result.mode !== "review") return
        expect(result.decision).toBe("edit")
        expect(result.content).toBe("revised")
        expect(yield* ctx.Files.read(result.path)).toBe("revised")
      }).pipe(Effect.provide(BunFileSystem.layer)),
    ),
  )

  it.live("confirm mode: a rejected approval is a no", () =>
    narrowR(
      runToolWithCtx(
        PromptTool,
        { mode: "confirm", content: "Proceed?" },
        testToolContext({ Interaction: interactionDeciding({ approved: false }) }),
      ).pipe(
        Effect.map((result) => {
          expect(result.mode).toBe("confirm")
          if (result.mode === "confirm") expect(result.decision).toBe("no")
        }),
      ),
    ),
  )

  it.live("present mode: returns shown status", () =>
    narrowR(
      runToolWithCtx(
        PromptTool,
        { mode: "present", content: "Info" },
        testToolContext({
          Interaction: {
            approve: () => Effect.die("interaction.approve not wired"),
            present: () => Effect.void,
          },
        }),
      ).pipe(
        Effect.map((result) => {
          expect(result.mode).toBe("present")
          if (result.mode === "present") expect(result.status).toBe("shown")
        }),
      ),
    ),
  )
})
