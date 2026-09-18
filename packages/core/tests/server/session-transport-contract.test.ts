/**
 * The public read surface a client sees around one session.
 *
 * `message-send.test.ts` proves a turn persists; this proves the queries a
 * client reads it back through -- `session.list`, `session.get`,
 * `session.getSnapshot`, `queue.get` and `message.list` -- agree with each
 * other and with the session that was just created, and that two sessions on
 * two working directories stay apart.
 */
import { describe, expect, it } from "effect-bun-test"
import { Effect } from "effect"
import { extractText, Gent } from "@gent/sdk"
import {
  LanguageModelLayers,
  makeTempDirectoryScoped,
  waitFor,
} from "../../src/test-utils/language-model"
import { createE2ELayer } from "../../src/test-utils/index"
import { e2ePreset } from "../../../extensions/tests/helpers/test-preset"

// The debug model answers every turn, so a test may send more than one
// message without scripting a step per send. `retries: false` turns off its
// synthetic 429s, which fire on a hash of the user text and would otherwise
// make a message's own wording decide whether the turn retries.
const makeClient = () =>
  Gent.test(
    createE2ELayer({
      ...e2ePreset,
      providerLayer: LanguageModelLayers.debug({ retries: false }),
    }),
  )

describe("session transport contract", () => {
  it.live(
    "a created session appears in list and get with an empty snapshot and queue",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeClient()
          const initialSessions = yield* client.session.list()

          const created = yield* client.session.create({ cwd: process.cwd() })

          const sessions = yield* client.session.list()
          const createdSession = sessions.find((session) => session.id === created.sessionId)

          expect(createdSession).toBeDefined()
          expect(sessions.length).toBe(initialSessions.length + 1)
          expect(createdSession?.activeBranchId).toBe(created.branchId)

          const loaded = yield* client.session.get({ sessionId: created.sessionId })
          expect(loaded?.id).toBe(created.sessionId)
          expect(loaded?.activeBranchId).toBe(created.branchId)

          const initialSnapshot = yield* client.session.getSnapshot({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })
          expect(initialSnapshot.messages).toEqual([])
          expect(initialSnapshot.branchId).toBe(created.branchId)
          expect(initialSnapshot.sessionId).toBe(created.sessionId)

          const initialQueue = yield* client.queue.get({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })
          expect(initialQueue.followUp).toEqual([])
          expect(initialQueue.steering).toEqual([])
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )

  it.live(
    "a sent message is readable through message.list and the session snapshot, and leaves the queue empty",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeClient()
          const created = yield* client.session.create({ cwd: process.cwd() })

          yield* client.message.send({
            sessionId: created.sessionId,
            branchId: created.branchId,
            content: "hello from the transport contract",
          })

          const messages = yield* waitFor(
            client.message.list({ branchId: created.branchId }),
            (items) =>
              items.some(
                (message) => extractText(message.parts) === "hello from the transport contract",
              ),
          )

          expect(
            messages.some((message) => {
              if (message.role !== "user") return false
              return extractText(message.parts) === "hello from the transport contract"
            }),
          ).toBe(true)

          yield* waitFor(client.message.list({ branchId: created.branchId }), (items) =>
            items.some((message) => message.role === "assistant"),
          )

          yield* waitFor(
            client.session.getSnapshot({
              sessionId: created.sessionId,
              branchId: created.branchId,
            }),
            (state) =>
              state.messages.some(
                (message) =>
                  message.role === "user" &&
                  extractText(message.parts) === "hello from the transport contract",
              ),
          )

          const queueAfterSend = yield* client.queue.get({
            sessionId: created.sessionId,
            branchId: created.branchId,
          })
          expect(queueAfterSend.followUp).toEqual([])
          expect(queueAfterSend.steering).toEqual([])
        }),
      ).pipe(Effect.timeout("13 seconds")),
    15_000,
  )

  // Two sessions on two distinct cwds must have independent per-session
  // profile + event routing -- a regression to launch-cwd-only event
  // delivery (where session B's events leak into session A's stream)
  // would fail this test.
  it.live(
    "two sessions on distinct cwds isolate snapshots and events",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* makeClient()
          const cwdA = yield* makeTempDirectoryScoped("gent-secondary-A-")
          const cwdB = yield* makeTempDirectoryScoped("gent-secondary-B-")
          const a = yield* client.session.create({ cwd: cwdA })
          const b = yield* client.session.create({ cwd: cwdB })
          expect(a.sessionId).not.toBe(b.sessionId)

          yield* client.message.send({
            sessionId: a.sessionId,
            branchId: a.branchId,
            content: "msg-A",
          })
          yield* client.message.send({
            sessionId: b.sessionId,
            branchId: b.branchId,
            content: "msg-B",
          })

          // Each session's snapshot must contain ONLY its own user message.
          // A regression where event-store fanout sends events to the wrong
          // session's stream would surface here.
          //
          // Wait until BOTH sessions have observed their own message before
          // running absence checks. If we only checked A first, a delayed
          // mis-routed msg-B could arrive into A's stream after the first
          // poll succeeded but before the absence check ran, masking a
          // genuine routing leak.
          yield* waitFor(
            client.session.getSnapshot({ sessionId: b.sessionId, branchId: b.branchId }),
            (s) => s.messages.some((m) => m.role === "user" && extractText(m.parts) === "msg-B"),
          )
          const snapshotA = yield* waitFor(
            client.session.getSnapshot({ sessionId: a.sessionId, branchId: a.branchId }),
            (s) => s.messages.some((m) => m.role === "user" && extractText(m.parts) === "msg-A"),
          )
          const snapshotB = yield* client.session.getSnapshot({
            sessionId: b.sessionId,
            branchId: b.branchId,
          })
          expect(
            snapshotA.messages.every((m) => m.role !== "user" || extractText(m.parts) !== "msg-B"),
          ).toBe(true)
          expect(
            snapshotB.messages.every((m) => m.role !== "user" || extractText(m.parts) !== "msg-A"),
          ).toBe(true)

          // Sessions are listed under both cwds.
          const sessions = yield* client.session.list()
          const sa = sessions.find((s) => s.id === a.sessionId)
          const sb = sessions.find((s) => s.id === b.sessionId)
          expect(sa?.cwd).toBe(cwdA)
          expect(sb?.cwd).toBe(cwdB)
        }),
      ).pipe(Effect.timeout("18 seconds")),
    20_000,
  )
})
