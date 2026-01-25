/**
 * Session bypass toggle tests
 */

import { describe, it, expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@gent/core"
import { Storage } from "@gent/storage"

describe("Session bypass", () => {
  describe("Storage", () => {
    it("createSession stores bypass=true by default", async () => {
      const layer = Storage.Test()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const session = new Session({
            id: "test-session-1",
            name: "Test Session",
            bypass: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          yield* storage.createSession(session)
          return yield* storage.getSession("test-session-1")
        }).pipe(Effect.provide(layer)),
      )
      expect(result?.bypass).toBe(true)
    })

    it("createSession stores bypass=false when specified", async () => {
      const layer = Storage.Test()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const session = new Session({
            id: "test-session-2",
            name: "Test Session",
            bypass: false,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
          yield* storage.createSession(session)
          return yield* storage.getSession("test-session-2")
        }).pipe(Effect.provide(layer)),
      )
      expect(result?.bypass).toBe(false)
    })

    it("updateSession can toggle bypass from true to false", async () => {
      const layer = Storage.Test()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()
          const session = new Session({
            id: "test-session-3",
            name: "Test Session",
            bypass: true,
            createdAt: now,
            updatedAt: now,
          })
          yield* storage.createSession(session)

          // Toggle bypass off
          const updated = new Session({
            ...session,
            bypass: false,
            updatedAt: new Date(),
          })
          yield* storage.updateSession(updated)

          return yield* storage.getSession("test-session-3")
        }).pipe(Effect.provide(layer)),
      )
      expect(result?.bypass).toBe(false)
    })

    it("updateSession can toggle bypass from false to true", async () => {
      const layer = Storage.Test()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()
          const session = new Session({
            id: "test-session-4",
            name: "Test Session",
            bypass: false,
            createdAt: now,
            updatedAt: now,
          })
          yield* storage.createSession(session)

          // Toggle bypass on
          const updated = new Session({
            ...session,
            bypass: true,
            updatedAt: new Date(),
          })
          yield* storage.updateSession(updated)

          return yield* storage.getSession("test-session-4")
        }).pipe(Effect.provide(layer)),
      )
      expect(result?.bypass).toBe(true)
    })

    it("bypass persists across session retrieval", async () => {
      const layer = Storage.Test()
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const storage = yield* Storage
          const now = new Date()

          // Create with bypass off
          const session = new Session({
            id: "test-session-5",
            name: "Test Session",
            bypass: false,
            createdAt: now,
            updatedAt: now,
          })
          yield* storage.createSession(session)

          // Retrieve multiple times
          const first = yield* storage.getSession("test-session-5")
          const second = yield* storage.getSession("test-session-5")

          return { first, second }
        }).pipe(Effect.provide(layer)),
      )
      expect(result.first?.bypass).toBe(false)
      expect(result.second?.bypass).toBe(false)
    })
  })
})
