import { Option, Schema } from "effect"
import { BranchId, ExtensionId } from "@gent/core/extensions/api"

export const GOAL_EXTENSION_ID = ExtensionId.make("@gent/goal")

/** Custom type on the user message the harness queues to continue a goal. */
export const GOAL_CONTEXT_MESSAGE_TYPE = "goal-context"

export const MAXIMUM_GOAL_OBJECTIVE_CHARS = 4000

export const GoalStatus = Schema.Literals(["active", "paused", "budget_limited", "complete"])
export type GoalStatus = typeof GoalStatus.Type

/** One durable objective per branch. Token and time usage accumulate per turn. */
export const GoalState = Schema.Struct({
  goalId: Schema.String,
  branchId: BranchId,
  objective: Schema.String,
  status: GoalStatus,
  tokenBudget: Schema.optional(Schema.Int),
  tokensUsed: Schema.Int,
  timeUsedMs: Schema.Int,
  continuationsUsed: Schema.Int,
  createdAt: Schema.Int,
  updatedAt: Schema.Int,
})
export type GoalState = typeof GoalState.Type

export const GoalSnapshot = Schema.Struct({
  goal: Schema.optional(GoalState),
})
export type GoalSnapshot = typeof GoalSnapshot.Type

/** Remaining budget is absent for an unbounded goal. */
export const remainingTokens = (goal: GoalState): Option.Option<number> =>
  Option.map(Option.fromUndefinedOr(goal.tokenBudget), (budget) =>
    Math.max(0, budget - goal.tokensUsed),
  )

/** A goal still waiting on work blocks a new one; a finished goal can be replaced. */
export const isPendingGoal = (goal: GoalState): boolean => goal.status !== "complete"
