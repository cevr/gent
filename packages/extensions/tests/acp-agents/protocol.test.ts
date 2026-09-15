/**
 * The ACP transport, exercised end to end.
 *
 * `protocol.ts` carries the parts of the adapter that only break under
 * real framing: NDJSON line splitting, the id-keyed pending-request map,
 * and the `AcpClosedError` hand-off its own comments (lines ~40-49,
 * ~89-98, ~404-410) describe as the fix for a leaked Deferred. A stub at
 * the `AcpConnection` interface skips all of it, so these tests run the
 * real `makeAcpConnection` against an in-memory peer at the stdio
 * Stream/Sink boundary.
 */
import { Effect, Fiber, Predicate, Schema, Stream } from "effect"
import { describe, expect, it, yieldFibers } from "effect-bun-test"

import { AcpClosedError, makeAcpConnection } from "../../src/acp-agents/protocol.js"
import { makeFakeAcpPeer, type FakeAcpPeer } from "./fake-acp-peer.js"

const WireRecord = Schema.Record(Schema.String, Schema.Unknown)
const decodeWire = Schema.decodeUnknownSync(Schema.fromJsonString(WireRecord))
const encodeWire = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/**
 * Poll the peer's write log for a JSON-RPC message carrying `id`.
 *
 * Responses the client writes back to an agent-initiated request have no
 * waiter to take them off the queue, so the test watches the log instead.
 * `Effect.yieldNow` hands the writer fiber a turn — no sleeps.
 */
const waitForWrittenId = Effect.fn("waitForWrittenId")(function* (peer: FakeAcpPeer, id: number) {
  for (;;) {
    const lines = yield* peer.written
    const found = lines.find((line) => decodeWire(line)["id"] === id)
    if (Predicate.isNotUndefined(found)) return found
    yield* Effect.yieldNow
  }
})

describe("acp protocol transport", () => {
  it.scopedLive("carries initialize, session/new and session/prompt over real framing", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      // initialize
      const initFiber = yield* Effect.forkChild(
        conn.initialize({ protocolVersion: 1, clientInfo: { name: "gent", version: "0.0.0" } }),
      )
      const initReq = yield* peer.waitForRequest("initialize")
      yield* peer.reply(initReq.id, {
        protocolVersion: 1,
        agentInfo: { name: "fake", version: "1" },
      })
      const init = yield* Fiber.join(initFiber)
      expect(init.protocolVersion).toBe(1)

      // session/new
      const newFiber = yield* Effect.forkChild(conn.newSession({ cwd: "/tmp" }))
      const newReq = yield* peer.waitForRequest("session/new")
      yield* peer.reply(newReq.id, { sessionId: "acp-1" })
      const created = yield* Fiber.join(newFiber)
      expect(created.sessionId).toBe("acp-1")

      // session/prompt
      const promptFiber = yield* Effect.forkChild(
        conn.prompt({ sessionId: "acp-1", prompt: [{ type: "text", text: "hi" }] }),
      )
      const promptReq = yield* peer.waitForRequest("session/prompt")
      yield* peer.reply(promptReq.id, { stopReason: "end_turn" })
      const finished = yield* Fiber.join(promptFiber)
      expect(finished.stopReason).toBe("end_turn")

      // Each RPC carried a distinct id, one framed line each — the
      // pending map is keyed on that id, so a repeat would cross-wire
      // two replies.
      const ids = (yield* peer.written).map((line) => decodeWire(line)["id"])
      expect(ids).toEqual([1, 2, 3])
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("routes a reply to its own pending request when replies arrive out of order", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      const aFiber = yield* Effect.forkChild(conn.newSession({ cwd: "/a" }))
      const a = yield* peer.waitForRequest("session/new")
      const bFiber = yield* Effect.forkChild(conn.newSession({ cwd: "/b" }))
      const b = yield* peer.waitForRequest("session/new")

      // Answer the second request first. Without the id-keyed pending
      // map each caller would take whichever reply landed next.
      yield* peer.reply(b.id, { sessionId: "second" })
      yield* peer.reply(a.id, { sessionId: "first" })

      expect((yield* Fiber.join(aFiber)).sessionId).toBe("first")
      expect((yield* Fiber.join(bFiber)).sessionId).toBe("second")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("reassembles a JSON-RPC message split across stdout chunks", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      const fiber = yield* Effect.forkChild(conn.newSession({ cwd: "/tmp" }))
      const req = yield* peer.waitForRequest("session/new")

      // A pipe hands over arbitrary byte boundaries. `splitLines` must
      // buffer the head until the newline arrives.
      const line = `{"jsonrpc":"2.0","id":${req.id},"result":{"sessionId":"chunked"}}`
      yield* peer.emitRaw(line.slice(0, 12))
      yield* peer.emitRaw(line.slice(12))
      yield* peer.emitRaw("\n")

      expect((yield* Fiber.join(fiber)).sessionId).toBe("chunked")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("skips unparseable and blank lines without dropping the next message", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      const fiber = yield* Effect.forkChild(conn.newSession({ cwd: "/tmp" }))
      const req = yield* peer.waitForRequest("session/new")

      // Agents log to stdout. A non-JSON line must not kill the reader.
      yield* peer.emitRaw("starting up...\n")
      yield* peer.emitRaw("\n")
      yield* peer.emitRaw("   \n")
      yield* peer.reply(req.id, { sessionId: "survived" })

      expect((yield* Fiber.join(fiber)).sessionId).toBe("survived")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("surfaces a JSON-RPC error reply as a failed RPC", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      const fiber = yield* Effect.forkChild(conn.prompt({ sessionId: "s", prompt: [] }))
      const req = yield* peer.waitForRequest("session/prompt")
      yield* peer.replyError(req.id, -32000, "model unavailable")

      const exit = yield* Fiber.join(fiber).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      const failure = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(failure._tag).toBe("AcpError")
      expect(failure.message).toBe("model unavailable")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("publishes session/update notifications on the updates stream", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      const collector = yield* Effect.forkChild(
        conn.updates.pipe(Stream.take(2), Stream.runCollect),
      )
      // `updates` is a PubSub subscription that only exists once the
      // forked stream runs. Hand the fiber its turn before publishing,
      // rather than sleeping past the race.
      yield* yieldFibers
      yield* peer.notify("s1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "a" },
      })
      yield* peer.notify("s1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "b" },
      })

      const collected = yield* Fiber.join(collector)
      expect(collected).toHaveLength(2)
      expect(collected[0]!.sessionId).toBe("s1")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("fails a pending prompt with AcpClosedError when the connection closes", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      // Register the prompt, then close without ever replying. This is
      // the mid-turn invalidation the module comment calls out: without
      // the seal-and-fail hand-off the Deferred parks forever and the
      // executor's `Stream.interruptWhen(promptDone)` never fires.
      const fiber = yield* Effect.forkChild(conn.prompt({ sessionId: "s", prompt: [] }))
      yield* peer.waitForRequest("session/prompt")
      yield* conn.close("driver invalidated")

      const failure = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(Schema.is(AcpClosedError)(failure)).toBe(true)
      expect(Predicate.isTagged(failure, "AcpClosedError") && failure.reason).toBe(
        "driver invalidated",
      )
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("ends the updates stream when the connection closes mid-prompt", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      // A consumer parked on `updates` must be released too — a live
      // PubSub would hold the executor's part stream open after the
      // driver went away.
      const collector = yield* Effect.forkChild(conn.updates.pipe(Stream.runCollect))
      yield* yieldFibers
      const promptFiber = yield* Effect.forkChild(conn.prompt({ sessionId: "s", prompt: [] }))
      yield* peer.waitForRequest("session/prompt")

      yield* conn.close("driver invalidated")

      const collected = yield* Fiber.join(collector)
      expect(collected).toHaveLength(0)
      expect(Schema.is(AcpClosedError)(yield* Fiber.join(promptFiber).pipe(Effect.flip))).toBe(true)
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("rejects an RPC issued after close instead of parking it", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      yield* conn.close("shut down")
      // A late caller reads the sealed state inside the same
      // `Ref.modify` that registers the Deferred, so it never lands in
      // the drained pending map.
      const failure = yield* conn.newSession({ cwd: "/tmp" }).pipe(Effect.flip)
      expect(Schema.is(AcpClosedError)(failure)).toBe(true)
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("fails a pending request when the agent's stdout ends", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      // A subprocess that dies closes stdout without an error. The
      // reader fiber's natural completion must seal the connection, or
      // the caller waits on a reply nothing will ever send.
      const fiber = yield* Effect.forkChild(conn.prompt({ sessionId: "s", prompt: [] }))
      yield* peer.waitForRequest("session/prompt")
      yield* peer.endStdout

      const failure = yield* Fiber.join(fiber).pipe(Effect.flip)
      expect(Schema.is(AcpClosedError)(failure)).toBe(true)
      expect(Predicate.isTagged(failure, "AcpClosedError") && failure.reason).toBe("stdout closed")
    }).pipe(Effect.timeout("5 seconds")),
  )

  it.scopedLive("auto-approves a permission request the agent raises", () =>
    Effect.gen(function* () {
      const peer = yield* makeFakeAcpPeer
      const conn = yield* makeAcpConnection(peer.proc)

      const fiber = yield* Effect.forkChild(conn.prompt({ sessionId: "s", prompt: [] }))
      const promptReq = yield* peer.waitForRequest("session/prompt")

      // Agent → client request. The default handler picks the
      // `allow_once` option and writes a JSON-RPC result back.
      yield* peer.emitRaw(
        `${encodeWire({
          jsonrpc: "2.0",
          id: 900,
          method: "session/request_permission",
          params: {
            sessionId: "s",
            toolCall: { toolCallId: "t1" },
            options: [
              { optionId: "no", name: "Reject", kind: "reject_once" },
              { optionId: "yes", name: "Allow", kind: "allow_once" },
            ],
          },
        })}\n`,
      )

      const outcome = decodeWire(yield* waitForWrittenId(peer, 900))["result"]
      expect(outcome).toEqual({ outcome: { outcome: "selected", optionId: "yes" } })

      yield* peer.reply(promptReq.id, { stopReason: "end_turn" })
      expect((yield* Fiber.join(fiber)).stopReason).toBe("end_turn")
    }).pipe(Effect.timeout("5 seconds")),
  )
})
