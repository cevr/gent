import { Effect, Option, Predicate, Schema } from "effect"
import {
  CapabilityError,
  defineExtension,
  ExtensionContext,
  hook,
  request,
  tool,
  type TurnAfterInput,
} from "@gent/core/extensions/api"
import {
  GOAL_CONTEXT_MESSAGE_TYPE,
  GOAL_EXTENSION_ID,
  goalContinuationSource,
  GoalState,
  isPendingGoal,
  MAXIMUM_GOAL_OBJECTIVE_CHARS,
  remainingTokens,
} from "./goal-protocol.js"
import { GoalRpc } from "./goal-rpc.js"
import { modifyGoal, readGoal } from "./goal-store.js"
import {
  budgetLimitPrompt,
  continuationPrompt,
  formatGoalStatus,
  formatGoalUsage,
} from "./goal-prompts.js"

export { GOAL_EXTENSION_ID, GOAL_CONTEXT_MESSAGE_TYPE, GoalState } from "./goal-protocol.js"
export { GoalRpc } from "./goal-rpc.js"

// ── Errors ──

export class GoalError extends Schema.TaggedError<GoalError>()("GoalError", {
  message: Schema.String,
}) {}

// ── State transitions ──

const now = Effect.clockWith((clock) => clock.currentTimeMillis)

const validateObjective = (value: string) =>
  Effect.gen(function* () {
    const objective = value.trim()
    if (objective.length === 0) return yield* new GoalError({ message: "Goal objective is empty" })
    if ([...objective].length > MAXIMUM_GOAL_OBJECTIVE_CHARS) {
      return yield* new GoalError({
        message: `Goal objective exceeds ${MAXIMUM_GOAL_OBJECTIVE_CHARS} characters`,
      })
    }
    return objective
  })

const validateBudget = (value: Option.Option<number>) =>
  Effect.gen(function* () {
    if (Option.isNone(value)) return value
    if (!Number.isSafeInteger(value.value) || value.value <= 0) {
      return yield* new GoalError({ message: "Goal token budget must be a positive integer" })
    }
    return value
  })

/**
 * Queues the next goal prompt as a user-role message and wakes the loop if it is idle.
 * The source id changes with every continuation; the runtime keys the message on it.
 */
const queueGoalMessage = (goal: GoalState, content: string) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    yield* ctx.Session.queueFollowUp({
      sourceId: goalContinuationSource(goal),
      content,
      metadata: { customType: GOAL_CONTEXT_MESSAGE_TYPE, extensionId: GOAL_EXTENSION_ID },
      wake: true,
    })
  })

/** Pulls the continuation queued for this goal state, if the loop has not started it yet. */
const dequeueGoalMessage = (goal: GoalState) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    return yield* ctx.Session.dequeueFollowUp({ sourceId: goalContinuationSource(goal) })
  })

interface CreateGoalInput {
  readonly objective: string
  readonly tokenBudget: Option.Option<number>
}

const createGoal = (input: CreateGoalInput) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const objective = yield* validateObjective(input.objective)
    const tokenBudget = yield* validateBudget(input.tokenBudget)
    const goal = yield* modifyGoal((current) =>
      Effect.gen(function* () {
        if (Option.isSome(current) && isPendingGoal(current.value)) {
          return yield* new GoalError({
            message: `A goal is already ${current.value.status}; clear or complete it first`,
          })
        }
        const time = yield* now
        const created: GoalState = {
          goalId: yield* ctx.Process.randomId,
          branchId: ctx.branchId,
          objective,
          status: "active",
          ...Option.match(tokenBudget, {
            onNone: () => ({}),
            onSome: (budget) => ({ tokenBudget: budget }),
          }),
          tokensUsed: 0,
          timeUsedMs: 0,
          continuationsUsed: 0,
          createdAt: time,
          updatedAt: time,
        }
        return { next: Option.some(created), result: created }
      }),
    )
    yield* ctx.State.changed({})
    return goal
  })

interface StatusChange {
  readonly status: GoalState["status"]
  readonly allowed: ReadonlyArray<GoalState["status"]>
  /** A fresh budget; required to leave `budget_limited`, since the old one is spent. */
  readonly tokenBudget: Option.Option<number>
}

/** Pause, complete, and clear also pull the pending continuation before it starts a turn. */
const setStatus = (change: StatusChange) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const tokenBudget = yield* validateBudget(change.tokenBudget)
    const goal = yield* modifyGoal((current) =>
      Effect.gen(function* () {
        if (Option.isNone(current))
          return yield* new GoalError({ message: "No goal on this branch" })
        if (!change.allowed.includes(current.value.status)) {
          return yield* new GoalError({
            message: `Cannot ${change.status} a goal that is ${current.value.status}`,
          })
        }
        if (
          change.status === "active" &&
          current.value.status === "budget_limited" &&
          Option.isNone(tokenBudget)
        ) {
          return yield* new GoalError({
            message: "The budget is spent; resume with /goal resume --budget <tokens>",
          })
        }
        if (change.status !== "active") yield* dequeueGoalMessage(current.value)
        // A resume is a continuation: the counter keeps its queued message id unique.
        let continuationsUsed = current.value.continuationsUsed
        if (change.status === "active") continuationsUsed += 1
        const updated: GoalState = {
          ...current.value,
          status: change.status,
          continuationsUsed,
          ...Option.match(tokenBudget, {
            onNone: () => ({}),
            onSome: (budget) => ({ tokenBudget: current.value.tokensUsed + budget }),
          }),
          updatedAt: yield* now,
        }
        return { next: Option.some(updated), result: updated }
      }),
    )
    yield* ctx.State.changed({})
    return goal
  })

const completeGoal = setStatus({
  status: "complete",
  allowed: ["active", "paused", "budget_limited"],
  tokenBudget: Option.none(),
})

/** Clearing forgets the goal entirely; status reports no goal afterwards. */
const clearGoal = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  const goal = yield* modifyGoal((current) =>
    Effect.gen(function* () {
      if (Option.isSome(current)) yield* dequeueGoalMessage(current.value)
      return { next: Option.none<GoalState>(), result: current }
    }),
  )
  yield* ctx.State.changed({})
  return goal
})

// ── Turn-after continuation ──

const continueGoal = (input: TurnAfterInput) =>
  Effect.gen(function* () {
    if (input.interrupted) return
    const ctx = yield* ExtensionContext
    const decision = yield* modifyGoal((current) =>
      Effect.gen(function* () {
        if (Option.isNone(current)) return { next: current, result: Option.none<GoalState>() }
        const goal = current.value
        // The turn that completed the goal is charged once; nothing continues after it.
        if (goal.status === "complete" && goal.finalized !== true) {
          const finalized: GoalState = {
            ...goal,
            tokensUsed: goal.tokensUsed + input.usage.inputTokens + input.usage.outputTokens,
            timeUsedMs: goal.timeUsedMs + input.durationMs,
            finalized: true,
            updatedAt: yield* now,
          }
          return { next: Option.some(finalized), result: Option.none<GoalState>() }
        }
        if (goal.status !== "active") return { next: current, result: Option.none<GoalState>() }
        const charged: GoalState = {
          ...goal,
          tokensUsed: goal.tokensUsed + input.usage.inputTokens + input.usage.outputTokens,
          timeUsedMs: goal.timeUsedMs + input.durationMs,
          updatedAt: yield* now,
        }
        if (Option.contains(remainingTokens(charged), 0)) {
          const limited: GoalState = { ...charged, status: "budget_limited" }
          return { next: Option.some(limited), result: Option.some(limited) }
        }
        const continued: GoalState = {
          ...charged,
          continuationsUsed: charged.continuationsUsed + 1,
        }
        return { next: Option.some(continued), result: Option.some(continued) }
      }),
    )
    yield* ctx.State.changed({})
    if (Option.isNone(decision)) return
    const goal = decision.value
    if (goal.status === "budget_limited") {
      yield* queueGoalMessage(goal, budgetLimitPrompt(goal))
      return
    }
    yield* queueGoalMessage(goal, continuationPrompt(goal))
  }).pipe(
    Effect.catchEager((error) =>
      Effect.logWarning("goal.continue.failed").pipe(Effect.annotateLogs({ error: String(error) })),
    ),
  )

// ── Slash command ──

interface ParsedGoalArgs {
  readonly rest: string
  readonly budget: Option.Option<number>
}

const parseBudget = (args: string): ParsedGoalArgs =>
  Option.match(Option.fromNullishOr(/^--budget\s+(\S+)\s*(.*)$/s.exec(args)), {
    onNone: () => ({ rest: args, budget: Option.none() }),
    onSome: (match) => ({
      rest: Option.getOrElse(Option.fromUndefinedOr(match[2]), () => ""),
      budget: Option.some(Number(match[1])),
    }),
  })

const commandError = (cause: { readonly message: string }) =>
  new CapabilityError({
    extensionId: GOAL_EXTENSION_ID,
    capabilityId: "goal-command",
    reason: cause.message,
  })

const GoalCommand = request({
  id: "goal-command",
  description: "Set or view a persistent goal; supports status, pause, resume, and clear",
  slash: {
    trigger: "goal",
    name: "Goal",
    description:
      "/goal <objective> · /goal [--budget N] <objective> · status · pause · resume · clear",
    category: "Session",
  },
  input: Schema.String,
  output: Schema.Void,
  execute: (input: string) =>
    Effect.gen(function* () {
      const ctx = yield* ExtensionContext
      const args = input.trim()
      const present = (content: string) => ctx.Interaction.present({ title: "Goal", content })
      const resume = /^resume(?:\s+(.*))?$/s.exec(args)
      if (Predicate.isNotNull(resume)) {
        const parsed = parseBudget(Option.getOrElse(Option.fromUndefinedOr(resume[1]), () => ""))
        const goal = yield* setStatus({
          status: "active",
          allowed: ["paused", "budget_limited"],
          tokenBudget: parsed.budget,
        })
        yield* queueGoalMessage(goal, continuationPrompt(goal))
        return yield* present(`Resumed.\n\n${formatGoalUsage(goal)}`)
      }
      switch (args) {
        case "":
        case "status":
          return yield* present(formatGoalStatus(yield* readGoal()))
        case "pause": {
          const goal = yield* setStatus({
            status: "paused",
            allowed: ["active", "budget_limited"],
            tokenBudget: Option.none(),
          })
          return yield* present(`Paused.\n\n${formatGoalUsage(goal)}`)
        }
        case "clear": {
          const goal = yield* clearGoal
          return yield* present(
            Option.match(goal, {
              onNone: () => "No goal on this branch.",
              onSome: (value) => `Cleared.\n\n${formatGoalUsage(value)}`,
            }),
          )
        }
        default: {
          const parsed = parseBudget(args)
          const goal = yield* createGoal({ objective: parsed.rest, tokenBudget: parsed.budget })
          // The first continuation starts the work at once when the loop is idle.
          yield* queueGoalMessage(goal, continuationPrompt(goal))
        }
      }
    }).pipe(Effect.mapError(commandError)),
})

// ── Model-facing tool ──

const GoalToolParams = Schema.Struct({
  action: Schema.Literals(["get", "create", "complete"]).annotate({
    description:
      "get reads the goal and its budget; create starts a goal only when the user explicitly asked for a persistent goal; complete marks the goal achieved once every requirement is met.",
  }),
  objective: Schema.optional(Schema.String.annotate({ description: "Objective text for create." })),
  tokenBudget: Schema.optional(
    Schema.Int.annotate({ description: "Optional token budget for create." }),
  ),
})

const GoalToolResult = Schema.Struct({
  goal: Schema.optional(GoalState),
  remainingTokens: Schema.optional(Schema.Int),
  report: Schema.optional(Schema.String),
})

const toolResult = (goal: Option.Option<GoalState>, report?: string) =>
  Option.match(goal, {
    onNone: (): typeof GoalToolResult.Type => ({}),
    onSome: (value): typeof GoalToolResult.Type => ({
      goal: value,
      ...Option.match(remainingTokens(value), {
        onNone: () => ({}),
        onSome: (remaining) => ({ remainingTokens: remaining }),
      }),
      ...Option.match(Option.fromUndefinedOr(report), {
        onNone: () => ({}),
        onSome: (text) => ({ report: text }),
      }),
    }),
  })

export const GoalTool = tool({
  id: "goal",
  description:
    "Read, create, or complete the persistent goal of this branch. The harness keeps prompting an active goal after every turn until complete is called.",
  promptSnippet: "Persistent goal state",
  promptGuidelines: [
    "Only create a goal when the user or system instructions explicitly ask for a persistent long-running goal; do not infer one from ordinary tasks.",
    "Call complete only when every requirement of the objective is met. The harness keeps continuing the goal until the completion call arrives; saying it is done is not enough.",
    "Do not complete a goal because the budget is nearly exhausted or because you are stopping work.",
  ],
  params: GoalToolParams,
  output: GoalToolResult,
  execute: Effect.fn("GoalTool.execute")(function* (params: typeof GoalToolParams.Type) {
    switch (params.action) {
      case "get":
        return toolResult(yield* readGoal())
      case "create": {
        const goal = yield* createGoal({
          objective: Option.getOrElse(Option.fromUndefinedOr(params.objective), () => ""),
          tokenBudget: Option.fromUndefinedOr(params.tokenBudget),
        })
        return toolResult(Option.some(goal))
      }
      case "complete": {
        const goal = yield* completeGoal
        return toolResult(Option.some(goal), `Goal complete. ${formatGoalUsage(goal)}`)
      }
    }
  }),
})

export const GoalExtension = defineExtension({
  id: GOAL_EXTENSION_ID,
  requests: [GoalCommand, GoalRpc.Get],
  tools: [GoalTool],
  hooks: [hook.turnAfter(continueGoal)],
})
