import { Effect, Option, Schema } from "effect"
import { ExtensionContext } from "@gent/core/extensions/api"
import { GoalSnapshot, type GoalState } from "./goal-protocol.js"

export class GoalStoreError extends Schema.TaggedError<GoalStoreError>()("GoalStoreError", {
  message: Schema.String,
}) {}

/** The file holds a snapshot so a cleared goal is an empty snapshot, not a deleted file. */
const codec = Schema.fromJsonString(GoalSnapshot)
const decode = Schema.decodeUnknownEffect(codec)
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
  // Corrupt state is an error the user must see, never a silently missing goal.
  const snapshot = yield* decode(text).pipe(
    Effect.mapError(
      (cause) => new GoalStoreError({ message: `Goal file ${file} is invalid: ${cause.message}` }),
    ),
  )
  return Option.fromUndefinedOr(snapshot.goal)
})

export const writeGoal = Effect.fn("GoalStore.write")(function* (goal: Option.Option<GoalState>) {
  const ctx = yield* ExtensionContext
  const { directory, file } = yield* goalPath
  yield* ctx.Files.makeDirectory(directory, { recursive: true })
  // A sibling file plus rename keeps a reader from ever seeing a half-written snapshot.
  const staging = `${file}.${yield* ctx.Process.randomId}.tmp`
  yield* ctx.Files.write(
    staging,
    encode(
      Option.match(goal, {
        onNone: (): GoalSnapshot => ({}),
        onSome: (value): GoalSnapshot => ({ goal: value }),
      }),
    ),
  )
  yield* ctx.Files.rename(staging, file)
})

/** Serializes read-modify-write cycles on one branch's goal across concurrent hooks. */
export const modifyGoal = <A, E, R>(
  update: (
    goal: Option.Option<GoalState>,
  ) => Effect.Effect<{ readonly next: Option.Option<GoalState>; readonly result: A }, E, R>,
) =>
  Effect.gen(function* () {
    const ctx = yield* ExtensionContext
    const { file } = yield* goalPath
    return yield* ctx.FileLock.withLock(
      file,
      Effect.gen(function* () {
        const current = yield* readGoal()
        const { next, result } = yield* update(current)
        if (Option.getOrUndefined(next) !== Option.getOrUndefined(current)) yield* writeGoal(next)
        return result
      }),
    )
  })
