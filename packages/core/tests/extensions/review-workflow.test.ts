import { describe, test, expect } from "bun:test"
import {
  ReviewWorkflowStateMachine,
  type ReviewWorkflowState,
} from "@gent/core/extensions/review-workflow"
import { createStateMachineHarness } from "@gent/core/test-utils/extension-harness"

const { reduce, derive, events } = createStateMachineHarness(ReviewWorkflowStateMachine)

describe("ReviewWorkflowStateMachine", () => {
  test("starts idle", () => {
    expect(ReviewWorkflowStateMachine.initial.phase).toBe("idle")
  })

  test("transitions to review on WorkflowPhaseStarted", () => {
    const next = reduce(
      ReviewWorkflowStateMachine.initial,
      events.workflowPhaseStarted({ workflowName: "code_review", phase: "review" }),
    )
    expect(next.phase).toBe("review")
  })

  test("transitions through adversarial phase", () => {
    const state: ReviewWorkflowState = {
      ...ReviewWorkflowStateMachine.initial,
      phase: "review",
    }
    const next = reduce(
      state,
      events.workflowPhaseStarted({ workflowName: "code_review", phase: "adversarial" }),
    )
    expect(next.phase).toBe("adversarial")
  })

  test("tracks iteration and maxIterations", () => {
    const next = reduce(
      ReviewWorkflowStateMachine.initial,
      events.workflowPhaseStarted({
        workflowName: "code_review",
        phase: "execute",
        iteration: 1,
        maxIterations: 5,
      }),
    )
    expect(next.iteration).toBe(1)
    expect(next.maxIterations).toBe(5)
  })

  test("resets to idle on WorkflowCompleted", () => {
    const active: ReviewWorkflowState = {
      phase: "evaluate",
      iteration: 2,
      maxIterations: 3,
      commentsBySeverity: { critical: 1, high: 2, medium: 3, low: 4 },
      mode: "fix",
    }
    const next = reduce(
      active,
      events.workflowCompleted({ workflowName: "code_review", result: "success" }),
    )
    expect(next.phase).toBe("idle")
    expect(next.iteration).toBe(0)
  })

  test("ignores events from other workflows", () => {
    const state = ReviewWorkflowStateMachine.initial
    const next = reduce(
      state,
      events.workflowPhaseStarted({ workflowName: "audit", phase: "detect" }),
    )
    expect(next).toBe(state)
  })

  test("derive — idle has no prompt sections", () => {
    const projection = derive(ReviewWorkflowStateMachine.initial)
    expect(projection.promptSections).toBeUndefined()
    const ui = projection.uiModel as { active: boolean }
    expect(ui.active).toBe(false)
  })

  test("derive — execute phase injects prompt section", () => {
    const state: ReviewWorkflowState = {
      ...ReviewWorkflowStateMachine.initial,
      phase: "execute",
      iteration: 1,
      maxIterations: 3,
    }
    const projection = derive(state)
    expect(projection.promptSections).toBeDefined()
    expect(projection.promptSections!.length).toBe(1)
    expect(projection.promptSections![0]!.id).toBe("review-workflow-context")
  })
})
