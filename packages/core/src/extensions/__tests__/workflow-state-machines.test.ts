import { describe, test, expect } from "bun:test"
import { AgentDefinition } from "../../domain/agent.js"
import { WorkflowPhaseStarted, WorkflowCompleted } from "../../domain/event.js"
import type { BranchId, SessionId } from "../../domain/ids.js"
import { AuditWorkflowStateMachine, type AuditWorkflowState } from "../audit-workflow.js"
import { ReviewWorkflowStateMachine, type ReviewWorkflowState } from "../review-workflow.js"

const ctx = {
  sessionId: "test-session" as SessionId,
  branchId: "test-branch" as BranchId,
}

const deriveCtx = {
  agent: new AgentDefinition({ name: "cowork" as never, kind: "primary" }),
  allTools: [],
}

describe("AuditWorkflowStateMachine", () => {
  const reduce = (
    state: AuditWorkflowState,
    event: Parameters<typeof AuditWorkflowStateMachine.reduce>[1],
  ) => AuditWorkflowStateMachine.reduce(state, event, ctx)

  const derive = (state: AuditWorkflowState) => AuditWorkflowStateMachine.derive(state, deriveCtx)

  test("starts idle", () => {
    expect(AuditWorkflowStateMachine.initial.phase).toBe("idle")
  })

  test("transitions to detect on WorkflowPhaseStarted", () => {
    const next = reduce(
      AuditWorkflowStateMachine.initial,
      new WorkflowPhaseStarted({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        workflowName: "audit",
        phase: "detect",
      }),
    )
    expect(next.phase).toBe("detect")
  })

  test("tracks iteration and maxIterations", () => {
    const next = reduce(
      AuditWorkflowStateMachine.initial,
      new WorkflowPhaseStarted({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
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
      new WorkflowCompleted({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        workflowName: "audit",
        result: "success",
      }),
    )
    expect(next.phase).toBe("idle")
    expect(next.iteration).toBe(0)
  })

  test("ignores events from other workflows", () => {
    const state = AuditWorkflowStateMachine.initial
    const next = reduce(
      state,
      new WorkflowPhaseStarted({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        workflowName: "code_review",
        phase: "review",
      }),
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

describe("ReviewWorkflowStateMachine", () => {
  const reduce = (
    state: ReviewWorkflowState,
    event: Parameters<typeof ReviewWorkflowStateMachine.reduce>[1],
  ) => ReviewWorkflowStateMachine.reduce(state, event, ctx)

  const derive = (state: ReviewWorkflowState) => ReviewWorkflowStateMachine.derive(state, deriveCtx)

  test("starts idle", () => {
    expect(ReviewWorkflowStateMachine.initial.phase).toBe("idle")
  })

  test("transitions to review on WorkflowPhaseStarted", () => {
    const next = reduce(
      ReviewWorkflowStateMachine.initial,
      new WorkflowPhaseStarted({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        workflowName: "code_review",
        phase: "review",
      }),
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
      new WorkflowPhaseStarted({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        workflowName: "code_review",
        phase: "adversarial",
      }),
    )
    expect(next.phase).toBe("adversarial")
  })

  test("tracks iteration and maxIterations", () => {
    const next = reduce(
      ReviewWorkflowStateMachine.initial,
      new WorkflowPhaseStarted({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
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
      new WorkflowCompleted({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        workflowName: "code_review",
        result: "success",
      }),
    )
    expect(next.phase).toBe("idle")
    expect(next.iteration).toBe(0)
  })

  test("ignores events from other workflows", () => {
    const state = ReviewWorkflowStateMachine.initial
    const next = reduce(
      state,
      new WorkflowPhaseStarted({
        sessionId: ctx.sessionId,
        branchId: ctx.branchId,
        workflowName: "audit",
        phase: "detect",
      }),
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
