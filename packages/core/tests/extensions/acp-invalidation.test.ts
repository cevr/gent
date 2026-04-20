/**
 * ACP protocol — close-during-pending-RPC regression.
 *
 * Counsel BLOCKER: `AcpConnection.close` previously only flipped
 * `closedRef` and interrupted I/O fibers; pending RPC `Deferred`s in
 * `pendingRef` were never failed and `updatesPubSub` was never shut
 * down. A driver invalidation mid-turn (manager `tearDown`) parked the
 * executor on `Stream.interruptWhen(promptDone)` forever — `promptDone`
 * only resolves from the `prompt` RPC, whose pending Deferred would
 * sit unsignalled.
 *
 * The fix walks `pendingRef` atomically and fails each Deferred with a
 * typed `AcpClosedError` before tearing the fibers down. This test
 * exercises that contract directly at the protocol layer (no real
 * subprocess) — the agent-loop wiring is covered separately.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import { makeAcpConnection } from "@gent/extensions/acp-agents/protocol"

/**
 * Build a never-closing readable stdout and a write-spy stdin so
 * `makeAcpConnection` can be exercised without a child process.
 * The remote never replies — every RPC parks on its Deferred.
 */
const makeFakeProc = () => {
  const writes: string[] = []
  const stdout = new ReadableStream<Uint8Array>({
    start() {
      // Intentionally never enqueue / never close — keeps the reader
      // fiber alive so we can verify `close` fails the pending RPC
      // through the Deferred path, not via reader-stream end.
    },
  })
  return {
    writes,
    proc: {
      stdin: { write: (data: string) => writes.push(data) },
      stdout,
    },
  }
}

describe("AcpConnection.close", () => {
  test("fails in-flight RPC Deferreds with AcpClosedError", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { proc } = makeFakeProc()
      const conn = yield* makeAcpConnection(proc).pipe(Effect.provideService(Scope.Scope, scope))

      // Fork an RPC into the connection scope — parks because the remote
      // never replies. `Effect.forkIn` keeps the fiber's lifetime tied to
      // the scope we'll close at the end of the test.
      const inflight = yield* Effect.forkIn(
        conn.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "gent-test", version: "0.0.0" },
        }),
        scope,
      )

      // Yield once so the rpc helper writes its request and parks.
      yield* Effect.sleep("10 millis")

      // Close the connection — should fail the pending Deferred.
      yield* conn.close("driver invalidated")

      // Await the forked RPC's exit. Bound by Effect.timeout so a hang
      // surfaces as a test failure rather than a wall-clock stall.
      const exit = yield* Fiber.await(inflight).pipe(Effect.timeout("1 seconds"))

      // Cleanup the connection scope so the bun test runner doesn't
      // leak the (still-alive) fake-stdout reader fiber.
      yield* Scope.close(scope, exit).pipe(Effect.ignore)

      return exit
    })

    const exit = await Effect.runPromise(program)

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      // The cause should carry our typed AcpClosedError.
      const failure = exit.cause
      const repr = JSON.stringify(failure)
      expect(repr).toContain("AcpClosedError")
      expect(repr).toContain("driver invalidated")
    }
  })

  test("refuses new RPCs after close with AcpClosedError", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { proc } = makeFakeProc()
      const conn = yield* makeAcpConnection(proc).pipe(Effect.provideService(Scope.Scope, scope))

      yield* conn.close("test shutdown")

      const result = yield* conn
        .initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "gent-test", version: "0.0.0" },
        })
        .pipe(Effect.exit)

      yield* Scope.close(scope, result).pipe(Effect.ignore)

      return result
    })

    const exit = await Effect.runPromise(program)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const repr = JSON.stringify(exit.cause)
      expect(repr).toContain("AcpClosedError")
    }
  })

  test("racing rpcRaw + close cannot leak a parked Deferred (counsel BLOCKER)", async () => {
    // Race coverage: a naive layout (separate closedRef + pendingRef)
    // permits this interleaving: rpcRaw reads closed=false → close
    // drains pending → rpcRaw inserts into the now-empty map → rpcRaw
    // parks forever. The fix folds both into ConnState behind one
    // Ref.modify. This test fires N RPCs concurrently with close and
    // asserts every fiber terminates within the timeout — no parks.
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { proc } = makeFakeProc()
      const conn = yield* makeAcpConnection(proc).pipe(Effect.provideService(Scope.Scope, scope))

      const initParams = {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "gent-test", version: "0.0.0" },
      } as const

      // Fork 50 RPCs back-to-back into the connection scope. Each
      // either registers and is later failed, or finds the state
      // already closed and fails immediately. Neither path parks.
      const fibers = yield* Effect.forEach(
        Array.from({ length: 50 }, (_, i) => i),
        () => Effect.forkIn(conn.initialize(initParams), scope),
      )

      // Race the close against the in-flight registrations. No sleep
      // here — we want the close to land at an arbitrary point in the
      // RPC sequence to exercise the interleaving.
      yield* conn.close("racing close")

      // Each fiber must terminate within the bound. A single park
      // would surface as a timeout.
      const exits = yield* Effect.forEach(fibers, (f) =>
        Fiber.await(f).pipe(Effect.timeout("2 seconds")),
      )

      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
      return exits
    })

    const exits = await Effect.runPromise(program)
    expect(exits.length).toBe(50)
    for (const exit of exits) {
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("AcpClosedError")
      }
    }
  })

  test("close is idempotent — second call is a no-op", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { proc } = makeFakeProc()
      const conn = yield* makeAcpConnection(proc).pipe(Effect.provideService(Scope.Scope, scope))

      yield* conn.close("first")
      yield* conn.close("second") // must not throw or re-fail anything

      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
    })

    await Effect.runPromise(program)
  })
})
