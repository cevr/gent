import { describe, expect, it } from "effect-bun-test"
import { Effect, Layer, Ref } from "effect"
import { SessionId } from "@gent/core/domain/ids"
import type { Session } from "@gent/core/domain/message"
import { ensureStorageParents } from "@gent/core/test-utils"
import { SessionStorage, type SessionStorageService } from "@gent/core/storage/session-storage"

const sessionOnlyLayer = (sessions: Ref.Ref<ReadonlyMap<SessionId, Session>>) =>
  Layer.succeed(SessionStorage, {
    createSession: (session) =>
      Ref.update(sessions, (map) => new Map(map).set(session.id, session)).pipe(Effect.as(session)),
    getSession: (id) => Ref.get(sessions).pipe(Effect.map((map) => map.get(id))),
    getLastSessionByCwd: () => Effect.sync((): Session | undefined => undefined),
    listSessions: () => Ref.get(sessions).pipe(Effect.map((map) => [...map.values()])),
    updateSession: (session) =>
      Ref.update(sessions, (map) => new Map(map).set(session.id, session)).pipe(Effect.as(session)),
    deleteSession: (id) =>
      Ref.modify(sessions, (map) => {
        const next = new Map(map)
        next.delete(id)
        return [[id], next] as const
      }),
  } satisfies SessionStorageService)

describe("ensureStorageParents", () => {
  it.live("creates a session without requiring branch storage", () =>
    Effect.gen(function* () {
      const sessions = yield* Ref.make<ReadonlyMap<SessionId, Session>>(new Map())
      const sessionId = SessionId.make("session-only")

      yield* ensureStorageParents({ sessionId }).pipe(Effect.provide(sessionOnlyLayer(sessions)))

      const stored = yield* Ref.get(sessions)
      expect(stored.has(sessionId)).toBe(true)
    }),
  )
})
