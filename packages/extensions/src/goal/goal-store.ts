import { Effect, Option, Schema } from "effect"
import { ExtensionContext } from "@gent/core/extensions/api"
import { GoalState } from "./goal-protocol.js"

const codec = Schema.fromJsonString(GoalState)
const decode = Schema.decodeUnknownOption(codec)
const encode = Schema.encodeSync(codec)

/** Goals live beside the other host-owned state under the gent home, one file per branch. */
const goalPath = Effect.gen(function* () {
  const ctx = yield* ExtensionContext
  return {
    directory: ctx.Files.join(ctx.home, "goals"),
    file: ctx.Files.join(ctx.home, "goals", `${ctx.branchId}.json`),
  }
})

export const readGoal = Effect.fn("GoalStore.read")(function* () {
  const ctx = yield* ExtensionContext
  const { file } = yield* goalPath
  if (!(yield* ctx.Files.exists(file))) return Option.none<GoalState>()
  const text = yield* ctx.Files.read(file)
  return decode(text)
})

export const writeGoal = Effect.fn("GoalStore.write")(function* (goal: GoalState) {
  const ctx = yield* ExtensionContext
  const { directory, file } = yield* goalPath
  yield* ctx.Files.makeDirectory(directory, { recursive: true })
  yield* ctx.Files.write(file, encode(goal))
})

/** Serializes read-modify-write cycles on one branch's goal across concurrent hooks. */
export const modifyGoal = <A, E, R>(
  update: (
    goal: Option.Option<GoalState>,
  ) => Effect.Effect<{ readonly goal: Option.Option<GoalState>; readonly result: A }, E, R>,
) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const { file } = yield* goalPath
    return yield* ctx.FileLock.withLock(
      file,
      Effect.gen(function* () {
        const current = yield* readGoal()
        const next = yield* update(current)
        if (Option.isSome(next.goal)) yield* writeGoal(next.goal.value)
        return next.result
      }),
    )
  })
