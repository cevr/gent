import { describe, expect, it } from "effect-bun-test"
import { Effect, Fiber, Queue, Stream } from "effect"
import {
  CellWorkerTransport,
  runCellWorker,
} from "@gent/core-internal/runtime/code-cell/cell-worker"
import { CellWorkerEnvironment } from "@gent/core-internal/runtime/code-cell/bun-evaluator-boundary"
import {
  CellProtocolError,
  CellRequest,
  type CellResponse,
} from "@gent/core-internal/runtime/code-cell/cell-protocol"

const makeHarness = Effect.gen(function* () {
  const requests = yield* Queue.make<CellRequest>({ capacity: 64 })
  const responses = yield* Queue.make<CellResponse>({ capacity: 64 })
  const fiber = yield* runCellWorker.pipe(
    Effect.provideService(CellWorkerTransport, {
      requests: Stream.fromQueue(requests),
      send: (response) => Queue.offer(responses, response).pipe(Effect.asVoid),
      endCellOutput: () => Effect.void,
    }),
    Effect.provideService(CellWorkerEnvironment, { workingDirectory: process.cwd() }),
    Effect.forkScoped,
  )
  expect((yield* Queue.take(responses))._tag).toBe("Ready")
  return {
    send: (request: CellRequest) => Queue.offer(requests, request),
    next: Queue.take(responses),
    fiber,
  }
})

describe("cell worker", () => {
  it.scopedLive("handles host replies during evaluation and retains values until reset", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "const count = await tools.call('count', {}); count",
        }),
      )
      const call = yield* worker.next
      if (call._tag !== "HostCall")
        return yield* new CellProtocolError({ message: "Expected host call" })
      expect(call.cellId).toBe("one")
      expect(call.name).toBe("count")
      yield* worker.send(
        CellRequest.cases.HostSucceeded.make({
          cellId: call.cellId,
          operationId: call.operationId,
          value: 42,
        }),
      )
      const completed = yield* worker.next
      if (completed._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(completed.result.display).toBe("42")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "two",
          outputToken: "two-token",
          source: "count + 1",
        }),
      )
      const next = yield* worker.next
      if (next._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(next.result.display).toBe("43")
      yield* worker.send(CellRequest.cases.Reset.make({ requestId: "reset" }))
      expect((yield* worker.next)._tag).toBe("Reset")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "three",
          outputToken: "three-token",
          source: "typeof count",
        }),
      )
      const cleared = yield* worker.next
      if (cleared._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(cleared.result.display).toBe("undefined")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("keeps the shipped catalog for later cells that carry none", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "tools.describe('read').description",
          catalog: {
            hash: "a",
            tools: [{ name: "read", description: "Read a file", guidelines: [], parameters: {} }],
          },
        }),
      )
      const first = yield* worker.next
      if (first._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(first.result.display).toBe("Read a file")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "two",
          outputToken: "two-token",
          source: "tools.search('').total",
        }),
      )
      const second = yield* worker.next
      if (second._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(second.result.display).toBe("1")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "three",
          outputToken: "three-token",
          source: "tools.search('').tools.map((t) => t.name).join(',')",
          catalog: {
            hash: "b",
            tools: [{ name: "write", description: "Write a file", guidelines: [], parameters: {} }],
          },
        }),
      )
      const third = yield* worker.next
      if (third._tag !== "Evaluated")
        return yield* new CellProtocolError({ message: "Expected result" })
      expect(third.result.display).toBe("write")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("rejects overlapping evaluations while waiting for a host reply", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "await tools.call('wait', {})",
        }),
      )
      expect((yield* worker.next)._tag).toBe("HostCall")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({ cellId: "two", outputToken: "two-token", source: "42" }),
      )
      const error = yield* Fiber.join(worker.fiber).pipe(Effect.flip)
      expect(error.message).toContain("already active")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("rejects replies that do not belong to the active cell", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.HostSucceeded.make({ cellId: "old", operationId: "missing", value: 0 }),
      )
      const error = yield* Fiber.join(worker.fiber).pipe(Effect.flip)
      expect(error.message).toContain("Stale or unknown")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("returns host failures as cell failures without dispatching again", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "await tools.call('denied', {})",
        }),
      )
      const call = yield* worker.next
      if (call._tag !== "HostCall")
        return yield* new CellProtocolError({ message: "Expected host call" })
      yield* worker.send(
        CellRequest.cases.HostFailed.make({
          cellId: call.cellId,
          operationId: call.operationId,
          message: "Permission denied",
        }),
      )
      const result = yield* worker.next
      if (result._tag !== "Failed")
        return yield* new CellProtocolError({ message: "Expected failure" })
      expect(result.error.message).toContain("Permission denied")
      yield* worker.send(
        CellRequest.cases.Evaluate.make({ cellId: "two", outputToken: "two-token", source: "42" }),
      )
      expect((yield* worker.next)._tag).toBe("Evaluated")
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("rejects reset during an active cell", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "await tools.call('wait', {})",
        }),
      )
      expect((yield* worker.next)._tag).toBe("HostCall")
      yield* worker.send(CellRequest.cases.Reset.make({ requestId: "reset" }))
      expect((yield* Fiber.join(worker.fiber).pipe(Effect.flip)).message).toContain(
        "already active",
      )
    }).pipe(Effect.timeout("3 seconds")),
  )

  it.scopedLive("stops when a cell exceeds the pending host-call limit", () =>
    Effect.gen(function* () {
      const worker = yield* makeHarness
      yield* worker.send(
        CellRequest.cases.Evaluate.make({
          cellId: "one",
          outputToken: "one-token",
          source: "await Promise.all(Array.from({ length: 33 }, () => tools.call('wait', {})))",
        }),
      )
      const error = yield* Fiber.join(worker.fiber).pipe(Effect.flip)
      expect(error.message).toContain("pending host calls")
    }).pipe(Effect.timeout("3 seconds")),
  )
})
