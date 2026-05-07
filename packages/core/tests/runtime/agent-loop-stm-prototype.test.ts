import { describe, expect, it } from "effect-bun-test"
import { Effect, TxQueue, TxRef } from "effect"

type PrototypeRuntimeState = {
  readonly state: "idle" | "running"
  readonly startingState: string | undefined
  readonly steering: ReadonlyArray<string>
  readonly followUp: ReadonlyArray<string>
}

const reserveWithTxRef = (
  stateRef: TxRef.TxRef<PrototypeRuntimeState>,
  item: string,
): Effect.Effect<string | undefined> =>
  Effect.tx(
    TxRef.modify(stateRef, (state): [string | undefined, PrototypeRuntimeState] => {
      if (state.startingState !== undefined || state.state !== "idle") {
        return [
          undefined,
          {
            ...state,
            followUp: [...state.followUp, item],
          },
        ]
      }

      return [
        item,
        {
          ...state,
          startingState: item,
        },
      ]
    }),
  )

const finishAndTakeNextWithTxRef = (
  stateRef: TxRef.TxRef<PrototypeRuntimeState>,
): Effect.Effect<string | undefined> =>
  Effect.tx(
    TxRef.modify(stateRef, (state): [string | undefined, PrototypeRuntimeState] => {
      const [nextSteering, ...restSteering] = state.steering
      if (nextSteering !== undefined) {
        return [
          nextSteering,
          {
            ...state,
            state: "idle",
            startingState: nextSteering,
            steering: restSteering,
          },
        ]
      }

      const [nextFollowUp, ...restFollowUp] = state.followUp
      if (nextFollowUp !== undefined) {
        return [
          nextFollowUp,
          {
            ...state,
            state: "idle",
            startingState: nextFollowUp,
            followUp: restFollowUp,
          },
        ]
      }

      return [
        undefined,
        {
          ...state,
          state: "idle",
          startingState: undefined,
        },
      ]
    }),
  )

const drainQueueWithTxRef = (
  stateRef: TxRef.TxRef<PrototypeRuntimeState>,
): Effect.Effect<{
  readonly steering: ReadonlyArray<string>
  readonly followUp: ReadonlyArray<string>
}> =>
  Effect.tx(
    TxRef.modify(stateRef, (state) => [
      { steering: state.steering, followUp: state.followUp },
      { ...state, steering: [], followUp: [] },
    ]),
  )

describe("AgentLoop STM queue prototype", () => {
  it.live("TxRef atomically reserves exactly one concurrent idle start", () =>
    Effect.gen(function* () {
      const stateRef = yield* TxRef.make<PrototypeRuntimeState>({
        state: "idle",
        startingState: undefined,
        steering: [],
        followUp: [],
      })

      const starts = yield* Effect.all(
        [reserveWithTxRef(stateRef, "first"), reserveWithTxRef(stateRef, "second")],
        { concurrency: 2 },
      )
      const finalState = yield* Effect.tx(TxRef.get(stateRef))

      expect(starts.filter((start) => start !== undefined)).toHaveLength(1)
      expect(finalState.state).toBe("idle")
      expect(finalState.startingState).not.toBeUndefined()
      expect(finalState.followUp).toHaveLength(1)
      expect(
        [...starts.filter((start) => start !== undefined), ...finalState.followUp].sort(),
      ).toEqual(["first", "second"])
    }),
  )

  it.live("TxRef queues during the private startingState reservation window", () =>
    Effect.gen(function* () {
      const stateRef = yield* TxRef.make<PrototypeRuntimeState>({
        state: "idle",
        startingState: "reserved",
        steering: [],
        followUp: [],
      })

      const start = yield* reserveWithTxRef(stateRef, "second")
      const finalState = yield* Effect.tx(TxRef.get(stateRef))

      expect(start).toBeUndefined()
      expect(finalState.startingState).toBe("reserved")
      expect(finalState.followUp).toEqual(["second"])
    }),
  )

  it.live("TxRef can atomically take steering before follow-up and clear reservation", () =>
    Effect.gen(function* () {
      const stateRef = yield* TxRef.make<PrototypeRuntimeState>({
        state: "running",
        startingState: "current",
        steering: ["steering"],
        followUp: ["follow-up"],
      })

      expect(yield* finishAndTakeNextWithTxRef(stateRef)).toBe("steering")
      expect(yield* finishAndTakeNextWithTxRef(stateRef)).toBe("follow-up")
      const finalState = yield* Effect.tx(TxRef.get(stateRef))

      expect(finalState).toEqual({
        state: "idle",
        startingState: "follow-up",
        steering: [],
        followUp: [],
      })
    }),
  )

  it.live("TxRef can return a durable queue snapshot while clearing observable queues", () =>
    Effect.gen(function* () {
      const stateRef = yield* TxRef.make<PrototypeRuntimeState>({
        state: "running",
        startingState: "current",
        steering: ["steering"],
        followUp: ["follow-up"],
      })

      const snapshot = yield* drainQueueWithTxRef(stateRef)
      const finalState = yield* Effect.tx(TxRef.get(stateRef))

      expect(snapshot).toEqual({ steering: ["steering"], followUp: ["follow-up"] })
      expect(finalState.steering).toEqual([])
      expect(finalState.followUp).toEqual([])
      expect(finalState.startingState).toBe("current")
    }),
  )

  it.live("TxQueue can transactionally prefer steering over follow-up turns", () =>
    Effect.gen(function* () {
      const statusRef = yield* TxRef.make<"idle" | "running">("running")
      const steering = yield* TxQueue.unbounded<string>()
      const followUp = yield* TxQueue.unbounded<string>()

      const finishAndTakeNext = Effect.tx(
        Effect.gen(function* () {
          yield* TxRef.set(statusRef, "idle")
          const steeringItem = yield* TxQueue.poll(steering)
          if (steeringItem._tag === "Some") {
            yield* TxRef.set(statusRef, "running")
            return steeringItem.value
          }

          const followUpItem = yield* TxQueue.poll(followUp)
          if (followUpItem._tag === "Some") {
            yield* TxRef.set(statusRef, "running")
            return followUpItem.value
          }

          return undefined
        }),
      )

      yield* Effect.tx(
        Effect.gen(function* () {
          yield* TxQueue.offer(followUp, "follow-up")
          yield* TxQueue.offer(steering, "steering")
        }),
      )

      expect(yield* finishAndTakeNext).toBe("steering")
      expect(yield* finishAndTakeNext).toBe("follow-up")
      expect(yield* Effect.tx(TxRef.get(statusRef))).toBe("running")
    }),
  )

  it.live("TxQueue public draining API consumes items, so durable snapshots need a mirror", () =>
    Effect.gen(function* () {
      const queue = yield* TxQueue.unbounded<string>()

      yield* Effect.tx(TxQueue.offerAll(queue, ["one", "two"]))
      const drained = yield* Effect.tx(TxQueue.takeAll(queue))
      const sizeAfterSnapshotAttempt = yield* Effect.tx(TxQueue.size(queue))

      expect([...drained]).toEqual(["one", "two"])
      expect(sizeAfterSnapshotAttempt).toBe(0)
    }),
  )
})
