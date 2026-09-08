import { describe, expect, it } from "effect-bun-test"
import { BunServices } from "@effect/platform-bun"
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, Queue, Stream } from "effect"
import { GentPlatform } from "@gent/core-internal/runtime/gent-platform"
import { BunGentPlatformLive } from "@gent/core-internal/runtime/gent-platform-bun"
import { openCellProcess } from "@gent/core-internal/runtime/code-cell/cell-process"
import {
  CellOperationHost,
  openCellKernel,
} from "@gent/core-internal/runtime/code-cell/cell-kernel"
import {
  CellProtocolError,
  CellRequest,
  type CellResponse,
} from "@gent/core-internal/runtime/code-cell/cell-protocol"
import { buildCellExecutable, buildCellWorker as buildWorker } from "./cell-worker-fixture.js"

const platformLayer = Layer.merge(BunServices.layer, BunGentPlatformLive)

describe.skipIf(process.platform !== "darwin")("cell worker process", () => {
  it.scopedLive(
    "runs a compiled worker with retained values, the Bun runtime, and the host environment",
    () =>
      Effect.gen(function* () {
        const artifact = yield* buildCellExecutable
        const kernel = yield* openCellKernel(artifact)
        const host = CellOperationHost.of({ call: () => Effect.succeed(21) })
        expect(
          (yield* kernel
            .evaluate("let saved = await tools.call('value', {}); saved")
            .pipe(Effect.provideService(CellOperationHost, host))).display,
        ).toBe("21")
        expect(
          (yield* kernel.evaluate("saved * 2").pipe(Effect.provideService(CellOperationHost, host)))
            .display,
        ).toBe("42")
        const executable = yield* kernel
          .evaluate("tools.call.constructor('return process.execPath')()")
          .pipe(Effect.provideService(CellOperationHost, host))
        const fs = yield* FileSystem.FileSystem
        expect(executable.display).toBe(yield* fs.realPath(artifact.binaryPath))
        expect(
          (yield* kernel
            .evaluate(
              "Object.keys(process.env).length > 0 && process.cwd() === tools.call.constructor('return process.cwd()')()",
            )
            .pipe(Effect.provideService(CellOperationHost, host))).display,
        ).toBe("true")
        const runtime = yield* kernel
          .evaluate(
            "const hosts = await Bun.file('/etc/hosts').text(); const fsm = await import('node:fs/promises'); [hosts.length > 0, typeof fsm.readdir, typeof require('node:path').join, (await Bun.$`printf ok`.text())]",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(runtime.display).toBe("[ true, 'function', 'function', 'ok' ]")
        yield* kernel.reset
        expect(
          (yield* kernel
            .evaluate("typeof saved")
            .pipe(Effect.provideService(CellOperationHost, host))).display,
        ).toBe("undefined")
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platformLayer)),
    12000,
  )

  it.scopedLive(
    "close waits for active host cleanup and prevents recovery",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const kernel = yield* openCellKernel(yield* buildWorker)
        const started = yield* Deferred.make<number>()
        const stopped = yield* Deferred.make<boolean>()
        const host = CellOperationHost.of({
          call: (request) =>
            Deferred.succeed(started, Number(request.input)).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, true)),
            ),
        })
        const evaluation = yield* kernel
          .evaluate("await tools.call('wait', tools.call.constructor('return process.pid')())")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.forkScoped)
        const pid = yield* Deferred.await(started)
        yield* kernel.close
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        const error = yield* Fiber.join(evaluation).pipe(Effect.flip)
        if (error._tag !== "CellKernelError") return yield* error
        expect(error.reason).toBe("closed")
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("closed")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "cancels a waiting host call and discards its worker before interruption returns",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const kernel = yield* openCellKernel(yield* buildWorker)
        const started = yield* Deferred.make<number>()
        const stopped = yield* Deferred.make<boolean>()
        const host = CellOperationHost.of({
          call: (request) =>
            Deferred.succeed(started, Number(request.input)).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, true)),
            ),
        })
        const evaluation = yield* kernel
          .evaluate("await tools.call('wait', tools.call.constructor('return process.pid')())")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.forkScoped)
        const pid = yield* Deferred.await(started)
        yield* Fiber.interrupt(evaluation)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        const error = yield* kernel
          .evaluate("1")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        if (error._tag !== "CellKernelError") return yield* error
        expect(error.reason).toBe("recovery-required")
        expect(error.stateLost).toBe(true)
        yield* kernel.reset
        const fresh = yield* kernel
          .evaluate("21 * 2")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(fresh.display).toBe("42")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "retains values after cell errors, uses the current host, and resets explicitly",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel(yield* buildWorker)
        const firstHost = CellOperationHost.of({ call: () => Effect.succeed(20) })
        const nextHost = CellOperationHost.of({ call: () => Effect.succeed(22) })
        const first = yield* kernel
          .evaluate("let n = await tools.call('value', {}); n")
          .pipe(Effect.provideService(CellOperationHost, firstHost))
        expect(first.display).toBe("20")
        const error = yield* kernel
          .evaluate("n++; throw new Error('cell failed')")
          .pipe(Effect.provideService(CellOperationHost, firstHost), Effect.flip)
        expect(error._tag).toBe("CellEvaluationError")
        const next = yield* kernel
          .evaluate("n + await tools.call('value', {})")
          .pipe(Effect.provideService(CellOperationHost, nextHost))
        expect(next.display).toBe("43")
        yield* kernel.reset
        const cleared = yield* kernel
          .evaluate("typeof n")
          .pipe(Effect.provideService(CellOperationHost, nextHost))
        expect(cleared.display).toBe("undefined")
        yield* kernel.close
        const closed = yield* kernel
          .evaluate("1")
          .pipe(Effect.provideService(CellOperationHost, nextHost), Effect.flip)
        expect(closed._tag).toBe("CellKernelError")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "kills a CPU-bound cell at its deadline without repeating its host operation",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const kernel = yield* openCellKernel({
          ...(yield* buildWorker),
          evaluationTimeoutMs: 1000,
          maximumReplacements: 1,
        })
        let calls = 0
        let pid = 0
        const host = CellOperationHost.of({
          call: (request) =>
            Effect.sync(() => {
              calls++
              pid = Number(request.input)
              return true
            }),
        })
        const error = yield* kernel
          .evaluate(
            "let retained = 41; await tools.call('started', tools.call.constructor('return process.pid')()); while (true) {}",
          )
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(error._tag).toBe("CellKernelError")
        if (error._tag !== "CellKernelError") return yield* error
        expect(error.reason).toBe("timeout")
        expect(error.stateLost).toBe(true)
        expect(calls).toBe(1)
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        const later = yield* kernel
          .evaluate("await tools.call('started', 0)")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(later._tag).toBe("CellKernelError")
        expect(calls).toBe(1)
        yield* kernel.reset
        const fresh = yield* kernel
          .evaluate("typeof retained")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(fresh.display).toBe("undefined")
        expect(calls).toBe(1)
        const crash = yield* kernel
          .evaluate("tools.call.constructor('process.exit(7)')()")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        if (crash._tag !== "CellKernelError") return yield* crash
        expect(crash.reason).toBe("process")
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("replacement-limit")
        yield* kernel.close
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("closed")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "pauses the deadline while a host operation is pending",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          ...(yield* buildWorker),
          evaluationTimeoutMs: 400,
          maximumReplacements: 1,
        })
        // Host operations own their bounds: a slow one outlives the compute deadline.
        const host = CellOperationHost.of({
          // gent/no-sleep: allow real-clock host operation that outlives the kernel deadline
          call: () => Effect.sleep("900 millis").pipe(Effect.as(5)),
        })
        const slow = yield* kernel
          .evaluate("const v = await tools.call('slow', 0); v + 1")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(slow.display).toBe("6")
        // Compute after the host operation returns is bounded again.
        const spun = yield* kernel
          .evaluate("await tools.call('slow', 0); while (true) {}")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(spun._tag).toBe("CellKernelError")
        if (spun._tag !== "CellKernelError") return yield* spun
        expect(spun.reason).toBe("timeout")
        expect(spun.stateLost).toBe(true)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "ships the catalog once per hash and again to a replacement worker",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          ...(yield* buildWorker),
          evaluationTimeoutMs: 1000,
          maximumReplacements: 1,
        })
        const catalog = {
          hash: "read-v1",
          tools: [{ name: "read", description: "Read a file", guidelines: [], parameters: {} }],
        }
        const host = CellOperationHost.of({ catalog, call: () => Effect.succeed(true) })
        const describe = "tools.describe('read').description"
        const first = yield* kernel
          .evaluate(describe)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(first.display).toBe("Read a file")
        // Same hash: the worker keeps its copy and the second cell still reads it.
        const again = yield* kernel
          .evaluate(describe)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(again.display).toBe("Read a file")
        // A host without a catalog leaves the worker's catalog unchanged.
        const bare = CellOperationHost.of({ call: () => Effect.succeed(true) })
        const kept = yield* kernel
          .evaluate(describe)
          .pipe(Effect.provideService(CellOperationHost, bare))
        expect(kept.display).toBe("Read a file")
        const lost = yield* kernel
          .evaluate("while (true) {}")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(lost._tag).toBe("CellKernelError")
        yield* kernel.reset
        // The replacement worker started empty and received the full catalog again.
        const restored = yield* kernel
          .evaluate(describe)
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(restored.display).toBe("Read a file")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "counts failed replacement starts and does not reopen a closed kernel",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const launch = yield* buildWorker
        const kernel = yield* openCellKernel({ ...launch, maximumReplacements: 1 })
        const host = CellOperationHost.of({ call: () => Effect.succeed(true) })
        const crash = yield* kernel
          .evaluate("tools.call.constructor('process.exit(7)')()")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(crash._tag).toBe("CellKernelError")
        yield* fs.writeFileString(launch.workerPath, "process.exit(2)")
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("process")
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("replacement-limit")
        yield* kernel.close
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("closed")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "exchanges real frames beside cell writes to stdout and stops at scope exit",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const launch = yield* buildWorker
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* openCellProcess(launch)
            const responses = yield* Queue.make<CellResponse>({ capacity: 8 })
            yield* child.responses.pipe(
              Stream.runForEach((response) => Queue.offer(responses, response)),
              Effect.catchTag("CellProcessError", () => Effect.void),
              Effect.forkScoped,
            )
            expect((yield* Queue.take(responses))._tag).toBe("Ready")
            yield* child.send(
              CellRequest.cases.Evaluate.make({
                cellId: "one",
                source: "const n = await tools.call('count', {}); n + 1",
              }),
            )
            const call = yield* Queue.take(responses)
            if (call._tag !== "HostCall")
              return yield* new CellProtocolError({ message: "Expected host call" })
            yield* child.send(
              CellRequest.cases.HostSucceeded.make({
                cellId: call.cellId,
                operationId: call.operationId,
                value: 41,
              }),
            )
            const result = yield* Queue.take(responses)
            if (result._tag !== "Evaluated")
              return yield* new CellProtocolError({ message: "Expected evaluation" })
            expect(result.result.display).toBe("42")
            // Frames travel on dedicated descriptors, so stdout writes from the cell never reach the reader.
            yield* child.send(
              CellRequest.cases.Evaluate.make({
                cellId: "two",
                source:
                  "process.stdout.write('not a frame\\n'); console.log('captured'); await Bun.write(Bun.stdout, 'also not a frame\\n'); n + 2",
              }),
            )
            const noisy = yield* Queue.take(responses)
            if (noisy._tag !== "Evaluated")
              return yield* new CellProtocolError({ message: "Expected evaluation" })
            expect(noisy.result.display).toBe("captured\n43")
            expect(yield* child.diagnostics).toContain("not a frame")
            expect(yield* child.isRunning).toBe(true)
            yield* platform.signal(child.pid, 0)
            return child.pid
          }),
        )
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "stops the process and rejects later sends",
    () =>
      Effect.gen(function* () {
        const launch = yield* buildWorker
        const child = yield* openCellProcess(launch)
        yield* child.stop
        expect(yield* child.isRunning).toBe(false)
        const error = yield* child
          .send(CellRequest.cases.Reset.make({ requestId: "too-late" }))
          .pipe(Effect.flip)
        expect(error.phase).toBe("exit")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "keeps the pipe open between successive reply reads",
    () =>
      Effect.gen(function* () {
        const launch = yield* buildWorker
        const child = yield* openCellProcess(launch)
        const next = child.responses.pipe(Stream.take(1), Stream.runCollect)
        expect((yield* next).map((response) => response._tag)).toEqual(["Ready"])
        yield* child.send(
          CellRequest.cases.Evaluate.make({ cellId: "one", source: "let n = 41; n" }),
        )
        expect((yield* next).map((response) => response._tag)).toEqual(["Evaluated"])
        yield* child.send(CellRequest.cases.Evaluate.make({ cellId: "two", source: "n + 1" }))
        const replies = yield* next
        expect(replies.length).toBe(1)
        for (const response of replies) {
          if (response._tag !== "Evaluated")
            return yield* new CellProtocolError({ message: "Expected evaluation" })
          expect(response.result.display).toBe("42")
        }
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )

  it.scopedLive(
    "kills a worker that never becomes ready before returning the timeout",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const platform = yield* GentPlatform
        const binaryPath = yield* platform.execPath
        const directory = yield* fs.makeTempDirectoryScoped()
        const workerPath = path.join(directory, "stalled.js")
        yield* fs.writeFileString(workerPath, "console.error(process.pid); while (true) {}")
        const error = yield* openCellProcess({
          binaryPath,
          workerPath,
          readinessTimeoutMs: 1000,
        }).pipe(Effect.flip)
        expect(error.phase).toBe("launch")
        expect(error.message).toContain("readiness timed out")
        const pid = Number(error.diagnostics.trim())
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platformLayer)),
    10000,
  )
})
