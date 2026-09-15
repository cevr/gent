import { Effect, Option, Schema } from "effect"
import { makeBranchStateStore } from "../branch-state-store.js"
import { GoalSnapshot, type GoalState } from "./goal-protocol.js"

export class GoalStoreError extends Schema.TaggedError<GoalStoreError>()("GoalStoreError", {
  message: Schema.String,
}) {}

/** The file holds a snapshot so a cleared goal is an empty snapshot, not a deleted file. */
const store = makeBranchStateStore({
  name: "GoalStore",
  directory: "goals",
  codec: Schema.fromJsonString(GoalSnapshot),
  empty: {},
  invalid: (file, cause) =>
    new GoalStoreError({ message: `Goal file ${file} is invalid: ${cause.message}` }),
})

const goalOf = (snapshot: GoalSnapshot) => Option.fromUndefinedOr(snapshot.goal)

export const readGoal = Effect.fn("GoalStore.readGoal")(function* () {
  return goalOf(yield* store.read())
})

/** Serializes read-modify-write cycles on one branch's goal across concurrent hooks. */
export const modifyGoal = <A, E, R>(
  update: (
    goal: Option.Option<GoalState>,
  ) => Effect.Effect<{ readonly next: Option.Option<GoalState>; readonly result: A }, E, R>,
) =>
  store.modify((snapshot) =>
    update(goalOf(snapshot)).pipe(
      Effect.map(({ next, result }) => {
        if (Option.getOrUndefined(next) === snapshot.goal) return { next: snapshot, result }
        return {
          next: Option.match(next, {
            onNone: (): GoalSnapshot => ({}),
            onSome: (value): GoalSnapshot => ({ goal: value }),
          }),
          result,
        }
      }),
    ),
  )
