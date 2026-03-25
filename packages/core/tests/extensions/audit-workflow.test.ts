import { describe, test, expect } from "bun:test"
import {
  AuditWorkflowStateMachine,
  type AuditWorkflowState,
} from "@gent/core/extensions/audit-workflow"
import { createStateMachineHarness } from "@gent/core/test-utils/extension-harness"

const { reduce, derive, events } = createStateMachineHarness(AuditWorkflowStateMachine)

describe("AuditWorkflowStateMachine", () => {
  test("starts idle", () => {
    expect(AuditWorkflowStateMachine.initial.phase).toBe("idle")
  })

  test("transitions to detect on WorkflowPhaseStarted", () => {
    const next = reduce(
      AuditWorkflowStateMachine.initial,
      events.workflowPhaseStarted({ workflowName: "audit", phase: "detect" }),
    )
    expect(next.phase).toBe("detect")
  })

  test("tracks iteration and maxIterations", () => {
    const next = reduce(
      AuditWorkflowStateMachine.initial,
      events.workflowPhaseStarted({
        workflowName: "audit",
        phase: "execute",
        iteration: 2,
        maxIterations: 3,
      }),
    )
    expect(next.phase).toBe("execute")
    expect(next.iteration).toBe(2)
    expect(next.maxIterations).toBe(3)
  })

  test("resets to idle on WorkflowCompleted", () => {
    const active: AuditWorkflowState = {
      phase: "synthesize",
      iteration: 1,
      maxIterations: 3,
      concernCount: 4,
      findingsBySeverity: { critical: 1, warning: 2, suggestion: 3 },
      mode: "fix",
    }
    const next = reduce(
      active,
      events.workflowCompleted({ workflowName: "audit", result: "success" }),
    )
    expect(next.phase).toBe("idle")
    expect(next.iteration).toBe(0)
  })

  test("ignores events from other workflows", () => {
    const state = AuditWorkflowStateMachine.initial
    const next = reduce(
      state,
      events.workflowPhaseStarted({ workflowName: "code_review", phase: "review" }),
    )
    expect(next).toBe(state)
  })

  test("derive — idle has no prompt sections", () => {
    const projection = derive(AuditWorkflowStateMachine.initial)
    expect(projection.promptSections).toBeUndefined()
    const ui = projection.uiModel as { active: boolean }
    expect(ui.active).toBe(false)
  })

  test("derive — active phase has ui model", () => {
    const state: AuditWorkflowState = {
      ...AuditWorkflowStateMachine.initial,
      phase: "detect",
    }
    const projection = derive(state)
    const ui = projection.uiModel as { active: boolean; phase: string }
    expect(ui.active).toBe(true)
    expect(ui.phase).toBe("detect")
  })

  test("derive — execute phase injects prompt section", () => {
    const state: AuditWorkflowState = {
      ...AuditWorkflowStateMachine.initial,
      phase: "execute",
      iteration: 2,
      maxIterations: 3,
    }
    const projection = derive(state)
    expect(projection.promptSections).toBeDefined()
    expect(projection.promptSections!.length).toBe(1)
    expect(projection.promptSections![0]!.id).toBe("audit-workflow-context")
    expect(projection.promptSections![0]!.content).toContain("iteration 2/3")
  })
})
