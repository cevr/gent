/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import type { ActiveInteraction, ApprovalResult } from "@gent/core/domain/event"
import { AskUserRenderer } from "../../src/components/interaction-renderers/ask-user"
import { PromptRenderer } from "../../src/components/interaction-renderers/prompt"
import { HandoffRenderer } from "../../src/components/interaction-renderers/handoff"
import { destroyRenderSetup, renderWithProviders } from "../../src/../tests/render-harness"
import { waitForRenderedFrame } from "../../src/../tests/helpers"
const interaction = (text: string, metadata?: unknown): ActiveInteraction =>
  ({
    _tag: "InteractionPresented",
    sessionId: SessionId.make("s"),
    branchId: BranchId.make("b"),
    requestId: "req-1",
    text,
    metadata,
  }) as ActiveInteraction
describe("interaction renderers", () => {
  it.live("ask-user renders structured questions", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <AskUserRenderer
              event={interaction("fallback question", {
                type: "ask-user",
                questions: [
                  {
                    header: "Pick a color",
                    question: "Choose your favorite",
                    options: [{ label: "Red" }, { label: "Blue" }],
                  },
                ],
              })}
              resolve={(r) => results.push(r)}
            />
          ),
          { width: 80, height: 24 },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (f) => f.includes("Pick a color"), "ask-user question"),
      )
      expect(frame).toContain("Pick a color")
      expect(frame).toContain("Choose your favorite")
      expect(frame).toContain("Red")
      expect(frame).toContain("Blue")
      destroyRenderSetup(setup)
    }),
  )
  it.live("ask-user falls back to yes/no without structured metadata", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <AskUserRenderer
              event={interaction("Do you want to proceed?")}
              resolve={(r) => results.push(r)}
            />
          ),
          { width: 80, height: 24 },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(
          setup,
          (f) => f.includes("Do you want to proceed"),
          "ask-user fallback",
        ),
      )
      expect(frame).toContain("Do you want to proceed")
      expect(frame).toContain("Yes")
      expect(frame).toContain("No")
      destroyRenderSetup(setup)
    }),
  )
  it.live("prompt renderer renders review content with yes/no", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <PromptRenderer
              event={interaction("Here is the generated code", {
                type: "prompt",
                mode: "confirm",
                title: "Code Review",
              })}
              resolve={(r) => results.push(r)}
            />
          ),
          { width: 80, height: 24 },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (f) => f.includes("Code Review"), "prompt renderer"),
      )
      expect(frame).toContain("Code Review")
      expect(frame).toContain("Here is the generated code")
      expect(frame).toContain("Yes")
      expect(frame).toContain("No")
      destroyRenderSetup(setup)
    }),
  )
  it.live("handoff renderer renders confirmation with summary", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <HandoffRenderer
              event={interaction("Task complete. Ready to hand off to the user.")}
              resolve={(r) => results.push(r)}
            />
          ),
          { width: 80, height: 24 },
        ),
      )
      const frame = yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (f) => f.includes("Handoff"), "handoff renderer"),
      )
      expect(frame).toContain("Handoff")
      expect(frame).toContain("Ready to hand off")
      expect(frame).toContain("Yes")
      expect(frame).toContain("No")
      destroyRenderSetup(setup)
    }),
  )
})
