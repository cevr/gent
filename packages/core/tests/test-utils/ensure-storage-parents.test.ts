import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Ref } from "effect"
import { SessionId } from "@gent/core-internal/domain/ids"
import type { Session } from "@gent/core-internal/domain/message"
import { ensureStorageParents } from "@gent/core-internal/test-utils"
import {
  SessionStorage,
  type SessionStorageService,
} from "@gent/core-internal/storage/session-storage"

const sessionOnlyLayer = (sessions: Ref.Ref<ReadonlyMap<SessionId, Session>>) =>
  Layer.succeed(SessionStorage, {
    createSession: (session) =>
      Ref.update(sessions, (map) => new Map(map).set(session.id, session)).pipe(Effect.as(session)),
    getSession: (id) => Ref.get(sessions).pipe(Effect.map((map) => map.get(id))),
    // oxlint-disable-next-line effect/noNullish -- SessionStorage uses undefined for an absent latest session.
    getLastSessionByCwd: () => Effect.void.pipe(Effect.as(undefined)),
    listSessions: Ref.get(sessions).pipe(Effect.map((map) => [...map.values()])),
    updateSession: (session) =>
      Ref.update(sessions, (map) => new Map(map).set(session.id, session)).pipe(Effect.as(session)),
    deleteSession: (id) =>
      Ref.modify(sessions, (map) => {
        const next = new Map(map)
        next.delete(id)
        return [[id], next]
      }),
  } satisfies SessionStorageService)

describe("ensureStorageParents", () => {
  it.live("creates a session without requiring branch storage", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyMap<SessionId, Session>>(new Map())
      const sessionId = SessionId.make("session-only")

      // oxlint-disable-next-line effect/noInlineProvide -- This test composes the service layer for this operation.
      yield* ensureStorageParents({ sessionId }).pipe(Effect.provide(sessionOnlyLayer(sessions)))

      const stored = yield* Ref.get(sessions)
      expect(stored.has(sessionId)).toBe(true)
    }),
  )
})
