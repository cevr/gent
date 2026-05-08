/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { BranchId, SessionId } from "@gent/core-internal/domain/ids"
import type { ActiveInteraction, ApprovalResult } from "@gent/core-internal/domain/event"
import { PromptRenderer } from "../../../src/components/interaction-renderers/prompt"
import { destroyRenderSetup, renderWithProviders } from "../../render-harness-boundary"
import { waitForRenderedFrame } from "../../helpers-boundary"

const interaction = (text: string, metadata?: unknown): ActiveInteraction =>
  ({
    _tag: "InteractionPresented",
    sessionId: SessionId.make("s"),
    branchId: BranchId.make("b"),
    requestId: "req-1",
    text,
    metadata,
  }) as ActiveInteraction

describe("PromptRenderer", () => {
  it.live("renders review content with yes/no", () =>
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
})
