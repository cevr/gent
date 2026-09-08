import { Effect, Option, Schema } from "effect"
import { CapabilityError, defineRequests, request } from "@gent/core/extensions/api"
import { GOAL_EXTENSION_ID, GoalSnapshot } from "./goal-protocol.js"
import { readGoal } from "./goal-store.js"

export const GoalRpc = defineRequests(GOAL_EXTENSION_ID, {
  Get: request({
    id: "goal.get",
    description: "Read the goal of the current branch",
    input: Schema.Struct({}),
    output: GoalSnapshot,
    execute: Effect.fn("GoalRpc.Get")(
      function* () {
        const goal = yield* readGoal()
        return Option.match(goal, {
          onNone: (): GoalSnapshot => ({}),
          onSome: (value): GoalSnapshot => ({ goal: value }),
        })
      },
      (effect) =>
        Effect.mapError(
          effect,
          (cause) =>
            new CapabilityError({
              extensionId: GOAL_EXTENSION_ID,
              capabilityId: "goal.get",
              reason: cause.message,
            }),
        ),
    ),
  }),
})
