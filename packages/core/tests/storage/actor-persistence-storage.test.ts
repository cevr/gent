/**
 * ActorPersistenceStorage — profile-scoped durable actor state.
 *
 * Coverage:
 *  - save → load round-trip on (profileId, persistenceKey)
 *  - load returns undefined for unknown rows (new spawn falls back to initialState)
 *  - last-write-wins on the same (profileId, key) — matches engine's
 *    quiescent snapshot model: each write replaces the prior row
 *  - profile isolation: two profiles can hold the same key without collision
 *  - listActorStatesForProfile returns only that profile's rows
 *  - deleteActorStatesForProfile only drops the requested profile's rows
 */

import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Storage } from "@gent/core/storage/sqlite-storage"

describe("ActorPersistenceStorage", () => {
  it.live("saveActorState + loadActorState round-trips", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      yield* storage.saveActorState({
        profileId: "profile-a",
        persistenceKey: "@gent/counter/c1",
        stateJson: JSON.stringify({ count: 7 }),
      })
      const loaded = yield* storage.loadActorState({
        profileId: "profile-a",
        persistenceKey: "@gent/counter/c1",
      })
      expect(loaded?.stateJson).toBe(JSON.stringify({ count: 7 }))
      expect(typeof loaded?.updatedAt).toBe("number")
    }).pipe(Effect.provide(Storage.Test())),
  )

  it.live("loadActorState returns undefined for unknown (profileId, key)", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      const loaded = yield* storage.loadActorState({
        profileId: "profile-a",
        persistenceKey: "missing",
      })
      expect(loaded).toBeUndefined()
    }).pipe(Effect.provide(Storage.Test())),
  )

  it.live("repeated save on the same (profileId, key) replaces (last-write-wins)", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      yield* storage.saveActorState({
        profileId: "profile-a",
        persistenceKey: "k1",
        stateJson: JSON.stringify({ count: 1 }),
      })
      yield* storage.saveActorState({
        profileId: "profile-a",
        persistenceKey: "k1",
        stateJson: JSON.stringify({ count: 2 }),
      })
      const loaded = yield* storage.loadActorState({
        profileId: "profile-a",
        persistenceKey: "k1",
      })
      expect(loaded?.stateJson).toBe(JSON.stringify({ count: 2 }))
    }).pipe(Effect.provide(Storage.Test())),
  )

  it.live("two profiles can hold the same key independently", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      yield* storage.saveActorState({
        profileId: "profile-a",
        persistenceKey: "shared",
        stateJson: JSON.stringify({ from: "a" }),
      })
      yield* storage.saveActorState({
        profileId: "profile-b",
        persistenceKey: "shared",
        stateJson: JSON.stringify({ from: "b" }),
      })
      const a = yield* storage.loadActorState({
        profileId: "profile-a",
        persistenceKey: "shared",
      })
      const b = yield* storage.loadActorState({
        profileId: "profile-b",
        persistenceKey: "shared",
      })
      expect(a?.stateJson).toBe(JSON.stringify({ from: "a" }))
      expect(b?.stateJson).toBe(JSON.stringify({ from: "b" }))
    }).pipe(Effect.provide(Storage.Test())),
  )

  it.live("listActorStatesForProfile returns only the requested profile's rows", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      yield* storage.saveActorState({
        profileId: "profile-a",
        persistenceKey: "k1",
        stateJson: JSON.stringify({ n: 1 }),
      })
      yield* storage.saveActorState({
        profileId: "profile-a",
        persistenceKey: "k2",
        stateJson: JSON.stringify({ n: 2 }),
      })
      yield* storage.saveActorState({
        profileId: "profile-b",
        persistenceKey: "k1",
        stateJson: JSON.stringify({ n: 99 }),
      })
      const aRows = yield* storage.listActorStatesForProfile("profile-a")
      const keys = aRows.map((r) => r.persistenceKey).sort()
      expect(keys).toEqual(["k1", "k2"])
      // None of profile-b's rows leak through.
      expect(aRows.every((r) => r.profileId === "profile-a")).toBe(true)
    }).pipe(Effect.provide(Storage.Test())),
  )

  it.live("deleteActorStatesForProfile drops only the requested profile's rows", () =>
    Effect.gen(function* () {
      const storage = yield* Storage
      yield* storage.saveActorState({
        profileId: "profile-a",
        persistenceKey: "k1",
        stateJson: "{}",
      })
      yield* storage.saveActorState({
        profileId: "profile-b",
        persistenceKey: "k1",
        stateJson: "{}",
      })
      yield* storage.deleteActorStatesForProfile("profile-a")
      const a = yield* storage.listActorStatesForProfile("profile-a")
      const b = yield* storage.listActorStatesForProfile("profile-b")
      expect(a.length).toBe(0)
      expect(b.length).toBe(1)
    }).pipe(Effect.provide(Storage.Test())),
  )
})
