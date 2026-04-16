import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ToolCallId } from "@gent/core/domain/ids.js"
import { extractText } from "@gent/sdk"
import { transportCases, waitFor } from "./transport-harness"

describe("GentClient transport contract", () => {
  for (const transport of transportCases) {
    test(`${transport.name} creates, lists, sends, and snapshots persisted session state`, async () => {
      await transport.run(({ client }) =>
        Effect.gen(function* () {
          const initialSessions = yield* client.session
            .list()
            .pipe(Effect.mapError((error) => new Error(String(error))))

          const created = yield* client.session
            .create({
              cwd: process.cwd(),
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          const sessions = yield* client.session
            .list()
            .pipe(Effect.mapError((error) => new Error(String(error))))
          const createdSession = sessions.find((session) => session.id === created.sessionId)

          expect(createdSession).toBeDefined()
          expect(sessions.length).toBe(initialSessions.length + 1)
          expect(createdSession?.branchId).toBe(created.branchId)

          const loaded = yield* client.session
            .get({ sessionId: created.sessionId })
            .pipe(Effect.mapError((error) => new Error(String(error))))
          expect(loaded?.id).toBe(created.sessionId)
          expect(loaded?.branchId).toBe(created.branchId)

          const initialSnapshot = yield* client.session
            .getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          expect(initialSnapshot.messages).toEqual([])
          expect(initialSnapshot.branchId).toBe(created.branchId)
          expect(initialSnapshot.sessionId).toBe(created.sessionId)

          const initialQueue = yield* client.queue
            .get({
              sessionId: created.sessionId,
              branchId: created.branchId,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          expect(initialQueue.followUp).toEqual([])
          expect(initialQueue.steering).toEqual([])

          yield* client.message
            .send({
              sessionId: created.sessionId,
              branchId: created.branchId,
              content: `hello from ${transport.name}`,
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          const messages = yield* waitFor(
            client.message
              .list({ branchId: created.branchId })
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
            client.session
              .getSnapshot({
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

          const queueAfterSend = yield* client.queue
            .get({
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

  for (const transport of transportCases) {
    test(`${transport.name} message.send accepts runSpec`, async () => {
      await transport.run(({ client }) =>
        Effect.gen(function* () {
          const { sessionId, branchId } = yield* client.session
            .create({ cwd: process.cwd() })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          // Send with runSpec — should not error on schema validation
          yield* client.message
            .send({
              sessionId,
              branchId,
              content: "overrides test",
              runSpec: {
                parentToolCallId: ToolCallId.of("tc-e2e-test"),
                tags: ["e2e-transport-test"],
              },
            })
            .pipe(Effect.mapError((error) => new Error(String(error))))

          // Verify the message was delivered (proves overrides didn't break the flow)
          const messages = yield* waitFor(
            client.message
              .list({ branchId })
              .pipe(Effect.mapError((error) => new Error(String(error)))),
            (items) => items.some((m) => extractText(m.parts) === "overrides test"),
          )

          expect(messages.some((m) => extractText(m.parts) === "overrides test")).toBe(true)
        }),
      )
    }, 15_000)
  }
})
