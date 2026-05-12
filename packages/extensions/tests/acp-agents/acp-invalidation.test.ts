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
import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Exit, Fiber, Scope, Sink, Stream } from "effect"
import { BadArgument, PlatformError } from "effect/PlatformError"
import {
  makeAcpConnection,
  type AcpClosedError,
  type AcpConnection,
  type AcpError,
} from "../../src/acp-agents/protocol.js"
/**
 * Build a never-closing stdout stream and a write-spy stdin sink so
 * `makeAcpConnection` can be exercised without a child process.
 * The remote never replies — every RPC parks on its Deferred.
 * Exposes `firstWrite` so tests can deterministically wait for the
 * RPC helper to register its pending Deferred without sleeping.
 */
const makeFakeProc = (firstWrite?: Deferred.Deferred<void>) => {
  const writes: string[] = []
  const decoder = new TextDecoder()
  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.gen(function* () {
      writes.push(decoder.decode(chunk))
      if (firstWrite !== undefined) {
        yield* Deferred.succeed(firstWrite, void 0).pipe(Effect.ignore)
      }
    }),
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
 * Variant where stdout *ends naturally* after the first stdin write —
 * models "agent process exited cleanly without error" — the runDrain
 * finishes without throwing. Without the post-runDrain seal in the
 * reader fiber, pending RPCs would never be failed.
 *
 * Gated on `firstWrite` instead of a wall-clock sleep so the test is
 * deterministic: stdout cannot close before `initialize` has written
 * its request and registered the pending Deferred.
 */
const makeFakeProcStdoutEof = (firstWrite: Deferred.Deferred<void>) => {
  const writes: string[] = []
  const decoder = new TextDecoder()
  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.gen(function* () {
      writes.push(decoder.decode(chunk))
      yield* Deferred.succeed(firstWrite, void 0).pipe(Effect.ignore)
    }),
  )
  const stdout = Stream.fromEffect(Deferred.await(firstWrite)).pipe(
    Stream.flatMap(() => Stream.empty),
  )
  return { writes, proc: { stdin, stdout } }
}
/**
 * Variant where stdout fails with a PlatformError after the first
 * stdin write — models "broken pipe / read error from a dying child
 * process". Without the reader's catchEager calling failPendingWith,
 * pending RPCs would be left parked.
 *
 * Gated on `firstWrite` instead of a wall-clock sleep so the read
 * failure cannot fire before `initialize` has registered its pending
 * Deferred.
 */
const makeFakeProcStdoutError = (firstWrite: Deferred.Deferred<void>) => {
  const writes: string[] = []
  const decoder = new TextDecoder()
  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.gen(function* () {
      writes.push(decoder.decode(chunk))
      yield* Deferred.succeed(firstWrite, void 0).pipe(Effect.ignore)
    }),
  )
  const err = new PlatformError(
    new BadArgument({
      module: "test",
      method: "stdout",
      description: "simulated read error",
    }),
  )
  const stdout = Stream.fromEffect(
    Deferred.await(firstWrite).pipe(Effect.andThen(Effect.fail(err))),
  )
  return { writes, proc: { stdin, stdout } }
}
/**
 * Variant where stdout replies after the first stdin write. The response
 * id is deterministic because each fake connection starts `nextIdRef`
 * at 1. The stream then ends naturally; by then the pending RPC has
 * already been resolved or failed by `handleResponse`.
 */
const makeFakeProcStdoutLine = (firstWrite: Deferred.Deferred<void>, line: string) => {
  const writes: string[] = []
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const stdin = Sink.forEach((chunk: Uint8Array) =>
    Effect.gen(function* () {
      writes.push(decoder.decode(chunk))
      yield* Deferred.succeed(firstWrite, void 0).pipe(Effect.ignore)
    }),
  )
  const stdout = Stream.fromEffect(Deferred.await(firstWrite)).pipe(
    Stream.flatMap(() => Stream.fromIterable([encoder.encode(line)])),
  )
  return { writes, proc: { stdin, stdout } }
}

const invalidResponseLine = (result: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result }) + "\n"

describe("AcpConnection.close", () => {
  it.live("fails in-flight RPC Deferreds with AcpClosedError", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const scope = yield* Scope.make()
        const firstWrite = yield* Deferred.make<void>()
        const { proc } = makeFakeProc(firstWrite)
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
        // Wait for the rpc helper to write its request and register its
        // pending Deferred — deterministic, no Effect.sleep guess.
        yield* Deferred.await(firstWrite)
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
      const exit = yield* program
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        // The cause should carry our typed AcpClosedError.
        const failure = exit.cause
        const repr = Bun.inspect(failure)
        expect(repr).toContain("AcpClosedError")
        expect(repr).toContain("driver invalidated")
      }
    }),
  )
  it.live("refuses new RPCs after close with AcpClosedError", () =>
    Effect.gen(function* () {
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
      const exit = yield* program
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const repr = Bun.inspect(exit.cause)
        expect(repr).toContain("AcpClosedError")
      }
    }),
  )
  it.live("racing rpcRaw + close cannot leak a parked Deferred", () =>
    Effect.gen(function* () {
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
      const exits = yield* program
      expect(exits.length).toBe(50)
      for (const exit of exits) {
        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          expect(Bun.inspect(exit.cause)).toContain("AcpClosedError")
        }
      }
    }),
  )
  it.live("close is idempotent — second call is a no-op", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const scope = yield* Scope.make()
        const { proc } = makeFakeProc()
        const conn = yield* makeAcpConnection(proc).pipe(Effect.provideService(Scope.Scope, scope))
        yield* conn.close("first")
        yield* conn.close("second") // must not throw or re-fail anything
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore)
      })
      yield* program
    }),
  )
  // Counsel BLOCKER #141: writer/reader fibers used to log a warning
  // and exit on PlatformError without disturbing stateRef or the
  // pending map. A pending RPC past the registration point would park
  // forever because handleResponse is the only resolver and the dead
  // reader will never run it. Both stdio-failure variants below
  // exercise the failPendingWith hand-off.
  it.live("stdout error fails in-flight RPCs with AcpClosedError", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const scope = yield* Scope.make()
        const firstWrite = yield* Deferred.make<void>()
        const { proc } = makeFakeProcStdoutError(firstWrite)
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
        // The fake stdout fails once initialize has written its request
        // and registered its pending Deferred. The reader fiber's
        // catchEager must then seal stateRef and fail every pending
        // Deferred. Bound by timeout so a regression surfaces as a hang.
        const exit = yield* Fiber.await(inflight).pipe(Effect.timeout("1 seconds"))
        yield* Scope.close(scope, exit).pipe(Effect.ignore)
        return exit
      })
      const exit = yield* program
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const repr = Bun.inspect(exit.cause)
        expect(repr).toContain("AcpClosedError")
        expect(repr).toContain("reader error")
      }
    }),
  )
  it.live("stdout natural EOF fails in-flight RPCs with AcpClosedError", () =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const scope = yield* Scope.make()
        const firstWrite = yield* Deferred.make<void>()
        const { proc } = makeFakeProcStdoutEof(firstWrite)
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
      const exit = yield* program
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") {
        const repr = Bun.inspect(exit.cause)
        expect(repr).toContain("AcpClosedError")
        expect(repr).toContain("stdout closed")
      }
    }),
  )
})

describe("AcpConnection RPC response decoding", () => {
  it.live("invalid wire responses fail with AcpError instead of defects", () =>
    Effect.gen(function* () {
      const scenarios: ReadonlyArray<{
        readonly method: string
        readonly result: unknown
        readonly run: (conn: AcpConnection) => Effect.Effect<unknown, AcpError | AcpClosedError>
      }> = [
        {
          method: "initialize",
          result: { protocolVersion: "bad" },
          run: (conn) =>
            conn.initialize({
              protocolVersion: 1,
              clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
              },
              clientInfo: { name: "gent-test", version: "0.0.0" },
            }),
        },
        {
          method: "session/new",
          result: { sessionId: 123 },
          run: (conn) => conn.newSession({ cwd: "/tmp/gent-acp-test" }),
        },
        {
          method: "session/prompt",
          result: { stopReason: "invalid_stop" },
          run: (conn) => conn.prompt({ sessionId: "acp-session", prompt: [] }),
        },
      ]

      for (const scenario of scenarios) {
        const scope = yield* Scope.make()
        const firstWrite = yield* Deferred.make<void>()
        const { proc } = makeFakeProcStdoutLine(firstWrite, invalidResponseLine(scenario.result))
        const conn = yield* makeAcpConnection(proc).pipe(Effect.provideService(Scope.Scope, scope))
        const exit = yield* scenario.run(conn).pipe(Effect.exit)
        yield* Scope.close(scope, exit).pipe(Effect.ignore)

        expect(exit._tag).toBe("Failure")
        if (exit._tag === "Failure") {
          const repr = Bun.inspect(exit.cause)
          expect(repr).toContain("AcpError")
          expect(repr).toContain(`invalid ACP ${scenario.method} response`)
        }
      }
    }),
  )
})
