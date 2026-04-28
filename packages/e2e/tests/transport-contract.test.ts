import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ToolCallId } from "@gent/core/domain/ids.js"
import { extractText } from "@gent/sdk"
import { transportCases, waitFor } from "./transport-harness"
import { ignoreSyncDefect } from "../src/effect-test-adapters"

describe("GentClient transport contract", () => {
  for (const transport of transportCases) {
    test(
      `${transport.name} creates, lists, sends, and snapshots persisted session state`,
      () =>
        transport.run(({ client }) =>
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
              client.message
                .list({ branchId: created.branchId })
                .pipe(Effect.mapError((error) => new Error(String(error)))),
              (items) => items.some((message) => message.role === "assistant"),
            )

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
          }).pipe(Effect.timeout("13 seconds")),
        ),
      15_000,
    )
  }

  for (const transport of transportCases) {
    test(
      `${transport.name} message.send accepts runSpec`,
      () =>
        transport.run(({ client }) =>
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
                  parentToolCallId: ToolCallId.make("tc-e2e-test"),
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
          }).pipe(Effect.timeout("13 seconds")),
        ),
      15_000,
    )
  }

  // Two sessions on two distinct cwds must have independent per-session
  // profile + event routing — a regression to launch-cwd-only event
  // delivery (where session B's events leak into session A's stream)
  // would fail this test.
  for (const transport of transportCases) {
    test(
      `${transport.name} two sessions on distinct cwds isolate snapshots and events`,
      () =>
        transport.run(({ client }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const cwdA = yield* Effect.acquireRelease(
                Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "gent-secondary-A-"))),
                (dir) => ignoreSyncDefect(() => fs.rmSync(dir, { recursive: true, force: true })),
              )
              const cwdB = yield* Effect.acquireRelease(
                Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "gent-secondary-B-"))),
                (dir) => ignoreSyncDefect(() => fs.rmSync(dir, { recursive: true, force: true })),
              )
              const a = yield* client.session
                .create({ cwd: cwdA })
                .pipe(Effect.mapError((error) => new Error(String(error))))
              const b = yield* client.session
                .create({ cwd: cwdB })
                .pipe(Effect.mapError((error) => new Error(String(error))))
              expect(a.sessionId).not.toBe(b.sessionId)

              yield* client.message
                .send({
                  sessionId: a.sessionId,
                  branchId: a.branchId,
                  content: "msg-A",
                })
                .pipe(Effect.mapError((error) => new Error(String(error))))
              yield* client.message
                .send({
                  sessionId: b.sessionId,
                  branchId: b.branchId,
                  content: "msg-B",
                })
                .pipe(Effect.mapError((error) => new Error(String(error))))

              // Each session's snapshot must contain ONLY its own user message.
              // A regression where the per-cwd EventPublisher router fans out
              // events to the wrong session's stream would surface here.
              //
              // Wait until BOTH sessions have observed their own message before
              // running absence checks. If we only checked A first, a delayed
              // mis-routed msg-B could arrive into A's stream after the first
              // poll succeeded but before the absence check ran, masking a
              // genuine routing leak.
              yield* waitFor(
                client.session
                  .getSnapshot({ sessionId: b.sessionId, branchId: b.branchId })
                  .pipe(Effect.mapError((error) => new Error(String(error)))),
                (s) =>
                  s.messages.some((m) => m.role === "user" && extractText(m.parts) === "msg-B"),
              )
              const snapshotA = yield* waitFor(
                client.session
                  .getSnapshot({ sessionId: a.sessionId, branchId: a.branchId })
                  .pipe(Effect.mapError((error) => new Error(String(error)))),
                (s) =>
                  s.messages.some((m) => m.role === "user" && extractText(m.parts) === "msg-A"),
              )
              const snapshotB = yield* client.session
                .getSnapshot({ sessionId: b.sessionId, branchId: b.branchId })
                .pipe(Effect.mapError((error) => new Error(String(error))))
              expect(
                snapshotA.messages.every(
                  (m) => m.role !== "user" || extractText(m.parts) !== "msg-B",
                ),
              ).toBe(true)
              expect(
                snapshotB.messages.every(
                  (m) => m.role !== "user" || extractText(m.parts) !== "msg-A",
                ),
              ).toBe(true)

              // Sessions are listed under both cwds.
              const sessions = yield* client.session
                .list()
                .pipe(Effect.mapError((error) => new Error(String(error))))
              const sa = sessions.find((s) => s.id === a.sessionId)
              const sb = sessions.find((s) => s.id === b.sessionId)
              expect(sa?.cwd).toBe(cwdA)
              expect(sb?.cwd).toBe(cwdB)
            }),
          ).pipe(Effect.timeout("18 seconds")),
        ),
      20_000,
    )
  }
})
