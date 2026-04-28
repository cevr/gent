/**
 * ACP protocol — close-during-pending-RPC regression.
 *
 * Counsel BLOCKER: `AcpConnection.close` previously left pending RPC
 * `Deferred`s un-failed and `updatesPubSub` un-shut, so a mid-turn
 * driver invalidation (manager `tearDown`) parked the executor on
 * `Stream.interruptWhen(promptDone)` forever — `promptDone` only
 * resolves from the `prompt` RPC, whose pending Deferred would sit
 * unsignalled.
 *
 * The fix folds the closed-flag and the pending-RPC map into a single
 * `ConnState` cell so check-open + register-pending and seal + claim
 * are each one atomic `Ref.modify`. Both directions are race-free.
 *
 * This test exercises that contract directly at the protocol layer
 * (no real subprocess) — the agent-loop wiring is covered separately.
 */
import { describe, test, expect } from "bun:test"
import { Effect, Exit, Fiber, Scope, Sink, Stream } from "effect"
import { BadArgument, PlatformError } from "effect/PlatformError"
import { makeAcpConnection } from "@gent/extensions/acp-agents/protocol"

/**
 * Build a never-closing stdout stream and a write-spy stdin sink so
 * `makeAcpConnection` can be exercised without a child process.
 * The remote never replies — every RPC parks on its Deferred.
 */
const makeFakeProc = () => {
  const writes: string[] = []
  const decoder = new TextDecoder()
  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.sync(() => writes.push(decoder.decode(chunk))),
  )
  // Never-ending stream — reader fiber stays alive so `close` must
  // fail pending Deferreds through the Deferred path, not via stream end.
  const stdout = Stream.never
  return {
    writes,
    proc: {
      stdin,
      stdout,
    },
  }
}

/**
 * Variant where stdout *ends naturally* after a short delay. Models
 * "agent process exited cleanly without error" — the runDrain finishes
 * without throwing. Without the post-runDrain seal in the reader fiber,
 * pending RPCs would never be failed.
 */
const makeFakeProcStdoutEof = () => {
  const writes: string[] = []
  const decoder = new TextDecoder()
  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.sync(() => writes.push(decoder.decode(chunk))),
  )
  // Stream that yields nothing for 50ms then ends — emulates agent
  // closing stdout after exiting cleanly. The delay gives `initialize`
  // time to register its pending Deferred before the seal fires.
  const stdout = Stream.fromEffect(Effect.sleep("50 millis")).pipe(
    Stream.flatMap(() => Stream.empty),
  )
  return { writes, proc: { stdin, stdout } }
}

/**
 * Variant where stdout fails with a PlatformError after a short delay.
 * Models "broken pipe / read error from a dying child process". Without
 * the reader's catchEager calling failPendingWith, pending RPCs would
 * be left parked.
 */
const makeFakeProcStdoutError = () => {
  const writes: string[] = []
  const decoder = new TextDecoder()
  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.sync(() => writes.push(decoder.decode(chunk))),
  )
  const err = new PlatformError(
    new BadArgument({
      module: "test",
      method: "stdout",
      description: "simulated read error",
    }),
  )
  // 50ms gives `initialize` time to register its pending Deferred
  // before the read failure fires.
  const stdout = Stream.fromEffect(Effect.sleep("50 millis").pipe(Effect.andThen(Effect.fail(err))))
  return { writes, proc: { stdin, stdout } }
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

  test("racing rpcRaw + close cannot leak a parked Deferred", async () => {
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

  // Counsel BLOCKER #141: writer/reader fibers used to log a warning
  // and exit on PlatformError without disturbing stateRef or the
  // pending map. A pending RPC past the registration point would park
  // forever because handleResponse is the only resolver and the dead
  // reader will never run it. Both stdio-failure variants below
  // exercise the failPendingWith hand-off.

  test("stdout error fails in-flight RPCs with AcpClosedError", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { proc } = makeFakeProcStdoutError()
      const conn = yield* makeAcpConnection(proc).pipe(Effect.provideService(Scope.Scope, scope))

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

      // The fake stdout fails after 5ms; the reader fiber's catchEager
      // must seal stateRef and fail every pending Deferred. Bound by
      // timeout so a regression surfaces as a hang.
      const exit = yield* Fiber.await(inflight).pipe(Effect.timeout("1 seconds"))
      yield* Scope.close(scope, exit).pipe(Effect.ignore)

      return exit
    })

    const exit = await Effect.runPromise(program)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const repr = JSON.stringify(exit.cause)
      expect(repr).toContain("AcpClosedError")
      expect(repr).toContain("reader error")
    }
  })

  test("stdout natural EOF fails in-flight RPCs with AcpClosedError", async () => {
    const program = Effect.gen(function* () {
      const scope = yield* Scope.make()
      const { proc } = makeFakeProcStdoutEof()
      const conn = yield* makeAcpConnection(proc).pipe(Effect.provideService(Scope.Scope, scope))

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

      // stdout empties without error; the reader fiber's post-runDrain
      // tap must seal stateRef so pending RPCs see the closure.
      const exit = yield* Fiber.await(inflight).pipe(Effect.timeout("1 seconds"))
      yield* Scope.close(scope, exit).pipe(Effect.ignore)

      return exit
    })

    const exit = await Effect.runPromise(program)
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const repr = JSON.stringify(exit.cause)
      expect(repr).toContain("AcpClosedError")
      expect(repr).toContain("stdout closed")
    }
  })
})
