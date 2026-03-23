import { Effect, Layer, Option, ServiceMap, Stream } from "effect"
import { Storage } from "../storage/sqlite-storage.js"
import type { AppServiceError } from "./errors.js"
import { SessionQueries } from "./session-queries.js"
import type {
  QueueSnapshotReadonly,
  SessionState,
  WatchQueueInput,
  WatchSessionStateInput,
} from "./transport-contract.js"

export interface SessionSubscriptionsService {
  readonly watchSessionState: (
    input: WatchSessionStateInput,
  ) => Stream.Stream<SessionState, AppServiceError>
  readonly watchQueue: (
    input: WatchQueueInput,
  ) => Stream.Stream<QueueSnapshotReadonly, AppServiceError>
}

const queueSnapshotKey = (snapshot: QueueSnapshotReadonly): string => JSON.stringify(snapshot)
const sessionStateKey = (state: SessionState): string => JSON.stringify(state)

export class SessionSubscriptions extends ServiceMap.Service<
  SessionSubscriptions,
  SessionSubscriptionsService
>()("@gent/core/src/server/session-subscriptions/SessionSubscriptions") {
  static Live = Layer.effect(
    SessionSubscriptions,
    Effect.gen(function* () {
      const queries = yield* SessionQueries
      const storage = yield* Storage

      const getLatestEventId = (input: {
        sessionId: WatchSessionStateInput["sessionId"]
        branchId?: WatchSessionStateInput["branchId"]
      }) => storage.getLatestEventId(input).pipe(Effect.map((id) => id ?? null))

      const getConsistentQueueSnapshot = (
        input: WatchQueueInput,
      ): Effect.Effect<QueueSnapshotReadonly, AppServiceError> => {
        const loop: Effect.Effect<QueueSnapshotReadonly, AppServiceError> = Effect.gen(
          function* () {
            const before = yield* getLatestEventId(input)
            const snapshot = yield* queries.getQueuedMessages(input)
            const after = yield* getLatestEventId(input)
            return before === after ? snapshot : yield* loop
          },
        )

        return loop
      }

      return {
        watchSessionState: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const initial = yield* queries.getSessionState(input)
              const pollDistinct = (
                lastKey: string,
              ): Stream.Stream<SessionState, AppServiceError> =>
                Stream.paginate(lastKey, (currentKey) =>
                  Effect.sleep("100 millis").pipe(
                    Effect.flatMap(() => queries.getSessionState(input)),
                    Effect.map((snapshot) => {
                      const nextKey = sessionStateKey(snapshot)
                      return nextKey === currentKey
                        ? ([[], Option.some(currentKey)] as const)
                        : ([[snapshot], Option.some(nextKey)] as const)
                    }),
                  ),
                )
              return Stream.concat(Stream.make(initial), pollDistinct(sessionStateKey(initial)))
            }),
          ),

        watchQueue: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const initial = yield* getConsistentQueueSnapshot(input)
              const pollDistinct = (
                lastKey: string,
              ): Stream.Stream<QueueSnapshotReadonly, AppServiceError> =>
                Stream.paginate(lastKey, (currentKey) =>
                  Effect.sleep("100 millis").pipe(
                    Effect.flatMap(() => getConsistentQueueSnapshot(input)),
                    Effect.map((snapshot) => {
                      const nextKey = queueSnapshotKey(snapshot)
                      return nextKey === currentKey
                        ? ([[], Option.some(currentKey)] as const)
                        : ([[snapshot], Option.some(nextKey)] as const)
                    }),
                  ),
                )

              return Stream.concat(Stream.make(initial), pollDistinct(queueSnapshotKey(initial)))
            }),
          ),
      } satisfies SessionSubscriptionsService
    }),
  )
}
