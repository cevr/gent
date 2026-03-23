import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { extractText } from "@gent/sdk"
import { transportCases, waitFor } from "./transport-harness"

describe("GentClient transport contract", () => {
  for (const transport of transportCases) {
    test(`${transport.name} creates, lists, sends, and snapshots session state`, async () => {
      await transport.run((client) =>
        Effect.gen(function* () {
          const initialSessions = yield* client
            .listSessions()
            .pipe(Effect.mapError((error) => new Error(String(error))))

          const created = yield* client
            .createSession({
              cwd: process.cwd(),
              bypass: true,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          const sessions = yield* client
            .listSessions()
            .pipe(Effect.mapError((error) => new Error(String(error))))
          const createdSession = sessions.find((session) => session.id === created.sessionId)

          expect(createdSession).toBeDefined()
          expect(sessions.length).toBe(initialSessions.length + 1)
          expect(createdSession?.branchId).toBe(created.branchId)
          expect(createdSession?.bypass).toBe(true)

          const loaded = yield* client
            .getSession(created.sessionId)
            .pipe(Effect.mapError((error) => new Error(String(error))))
          expect(loaded?.id).toBe(created.sessionId)
          expect(loaded?.branchId).toBe(created.branchId)

          const initialState = yield* client
            .getSessionState({
              sessionId: created.sessionId,
              branchId: created.branchId,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          expect(initialState.messages).toEqual([])
          expect(initialState.branchId).toBe(created.branchId)
          expect(initialState.sessionId).toBe(created.sessionId)

          const initialQueue = yield* client
            .getQueuedMessages({
              sessionId: created.sessionId,
              branchId: created.branchId,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          expect(initialQueue.followUp).toEqual([])
          expect(initialQueue.steering).toEqual([])

          yield* client
            .sendMessage({
              sessionId: created.sessionId,
              branchId: created.branchId,
              content: `hello from ${transport.name}`,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          const messages = yield* waitFor(
            client
              .listMessages(created.branchId)
              .pipe(Effect.mapError((error) => new Error(String(error)))),
            (items) =>
              items.some(
                (message) => extractText(message.parts) === `hello from ${transport.name}`,
              ),
          )

          expect(
            messages.some((message) => {
              if (message.role !== "user") return false
              return extractText(message.parts) === `hello from ${transport.name}`
            }),
          ).toBe(true)

          yield* waitFor(
            client
              .getSessionState({
                sessionId: created.sessionId,
                branchId: created.branchId,
              })
              .pipe(Effect.mapError((error) => new Error(String(error)))),
            (state) =>
              state.messages.some(
                (message) =>
                  message.role === "user" &&
                  extractText(message.parts) === `hello from ${transport.name}`,
              ),
          )

          const queueAfterSend = yield* client
            .getQueuedMessages({
              sessionId: created.sessionId,
              branchId: created.branchId,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          expect(queueAfterSend.followUp).toEqual([])
          expect(queueAfterSend.steering).toEqual([])
        }),
      )
    }, 15_000)
  }
})
