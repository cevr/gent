/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { BranchId, InteractionRequestId, SessionId } from "@gent/core-internal/domain/ids"
import type { ActiveInteraction, ApprovalResult } from "@gent/core-internal/domain/event"
import { AskUserRenderer } from "../../../src/components/interaction-renderers/ask-user"
import { destroyRenderSetup, renderWithProviders } from "../../render-harness-boundary"
import { waitForRenderedFrame } from "../../helpers-boundary"

const interaction = (text: string) =>
  ({
    _tag: "InteractionPresented",
    sessionId: SessionId.make("s"),
    branchId: BranchId.make("b"),
    requestId: InteractionRequestId.make("req-1"),
    text,
  }) satisfies ActiveInteraction

describe("AskUserRenderer", () => {
  it.live("renders structured questions", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <AskUserRenderer
              event={
                {
                  ...interaction("fallback question"),
                  metadata: {
                    type: "ask-user",
                    questions: [
                      {
                        header: "Pick a color",
                        question: "Choose your favorite",
                        options: [{ label: "Red" }, { label: "Blue" }],
                      },
                    ],
                  },
                } satisfies ActiveInteraction
              }
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

  it.live("falls back to yes/no without structured metadata", () =>
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
})
