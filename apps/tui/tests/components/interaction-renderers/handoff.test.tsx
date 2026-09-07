/** @jsxImportSource @opentui/solid */
import { describe, it, expect } from "effect-bun-test"
import { Effect, Option } from "effect"
import { BranchId, InteractionRequestId, SessionId } from "@gent/core-internal/domain/ids"
import type { ActiveInteraction, ApprovalResult } from "@gent/core-internal/domain/event"
import type { CreateSessionInput } from "@gent/core-internal/server/transport-contract"
import { HandoffRenderer } from "../../../src/components/interaction-renderers/handoff"
import {
  createMockClient,
  destroyRenderSetup,
  renderWithProviders,
} from "../../render-harness-boundary"
import { waitForRenderedFrame } from "../../helpers-boundary"

const interaction = (text: string) =>
  ({
    _tag: "InteractionPresented",
    sessionId: SessionId.make("s"),
    branchId: BranchId.make("b"),
    requestId: InteractionRequestId.make("req-1"),
    text,
  }) satisfies ActiveInteraction

describe("HandoffRenderer", () => {
  it.live("renders confirmation with summary", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <HandoffRenderer
              event={interaction("Todo complete. Ready to hand off to the user.")}
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

  it.live("confirming opens a linked session seeded with the summary", () =>
    Effect.gen(function* () {
      const results: ApprovalResult[] = []
      const created: CreateSessionInput[] = []
      const client = createMockClient({
        session: {
          create: (input: CreateSessionInput) => {
            created.push(input)
            return Effect.succeed({
              sessionId: SessionId.make("handoff-child"),
              branchId: BranchId.make("handoff-branch"),
              name: "Handoff",
            })
          },
        },
      })
      const setup = yield* Effect.promise(() =>
        renderWithProviders(
          () => (
            <HandoffRenderer
              event={interaction("Carry over: rows and marker.")}
              resolve={(r) => results.push(r)}
            />
          ),
          {
            width: 80,
            height: 24,
            client,
            initialSession: {
              sessionId: SessionId.make("parent-session"),
              branchId: BranchId.make("parent-branch"),
              name: "Parent",
              reasoningLevel: Option.getOrUndefined(Option.none()),
            },
          },
        ),
      )
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, (f) => f.includes("Handoff"), "handoff renderer"),
      )
      setup.mockInput.pressEnter()
      yield* Effect.promise(() =>
        waitForRenderedFrame(setup, () => created.length === 1, "handoff session request"),
      )
      expect(results).toEqual([{ approved: true }])
      expect(created[0]).toMatchObject({
        parentSessionId: "parent-session",
        parentBranchId: "parent-branch",
        initialPrompt: "Carry over: rows and marker.",
      })
      destroyRenderSetup(setup)
    }),
  )
})
