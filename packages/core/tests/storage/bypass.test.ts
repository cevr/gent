/**
 * Session bypass toggle tests
 */

import { describe, it, expect } from "effect-bun-test"
import { Effect } from "effect"
import { Session } from "@gent/core/domain/message"
import { Storage } from "@gent/core/storage/sqlite-storage"

const test = it.live.layer(Storage.Test())

describe("Session bypass", () => {
  describe("Storage", () => {
    test("createSession stores bypass=true by default", () =>
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
        const result = yield* storage.getSession("test-session-1")
        expect(result?.bypass).toBe(true)
      }))

    test("createSession stores bypass=false when specified", () =>
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
        const result = yield* storage.getSession("test-session-2")
        expect(result?.bypass).toBe(false)
      }))

    test("updateSession can toggle bypass from true to false", () =>
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

        const result = yield* storage.getSession("test-session-3")
        expect(result?.bypass).toBe(false)
      }))

    test("updateSession can toggle bypass from false to true", () =>
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

        const result = yield* storage.getSession("test-session-4")
        expect(result?.bypass).toBe(true)
      }))

    test("bypass persists across session retrieval", () =>
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

        expect(first?.bypass).toBe(false)
        expect(second?.bypass).toBe(false)
      }))
  })
})
