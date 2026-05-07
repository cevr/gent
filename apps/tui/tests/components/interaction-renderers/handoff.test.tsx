/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { BranchId, SessionId } from "@gent/core/domain/ids"
import type { ActiveInteraction, ApprovalResult } from "@gent/core/domain/event"
import { HandoffRenderer } from "../../../src/components/interaction-renderers/handoff"
import { destroyRenderSetup, renderWithProviders } from "../../render-harness"
import { waitForRenderedFrame } from "../../helpers"

const interaction = (text: string, metadata?: unknown): ActiveInteraction =>
  ({
    _tag: "InteractionPresented",
    sessionId: SessionId.make("s"),
    branchId: BranchId.make("b"),
    requestId: "req-1",
    text,
    metadata,
  }) as ActiveInteraction

describe("HandoffRenderer", () => {
  it.live("renders confirmation with summary", () =>
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
