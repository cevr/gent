import { describe, expect, it } from "effect-bun-test"
import { Cause, Effect, Exit, Fiber, FileSystem, Option, Path, Queue, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { GentPlatform } from "@gent/core/host"
import { waitFor } from "@gent/core/test-utils"
import { CellOperationHost, CellWorker, openCellKernel, openCellProcess } from "../src/cell.js"
import type { CellResponse } from "../src/cell-protocol.js"
import {
  CellProtocolError,
  CellRequest,
  decodeCellResponse,
  encodeCellRequest,
  makeCellFrameReader,
} from "../src/cell-protocol.js"
import {
  packageDirectory,
  buildCellWorker,
  buildCellExecutable,
  platform,
  hostCatalog,
} from "./helpers/cell-kernel.js"

// The cell worker process: frames, pipes, launch failures and exit paths.

describe("cell worker process", () => {
  it.scopedLive(
    "exchanges real frames beside cell writes to stdout and stops at scope exit",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const launch = yield* buildCellWorker
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const child = yield* openCellProcess({ worker: launch, cwd: packageDirectory })
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
                outputToken: "one-token",
                source: "const n = await tools.count({}); n + 1",
                catalog: hostCatalog("count"),
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
                outputToken: "two-token",
                source:
                  "process.stdout.write('not a frame\\n'); console.log('captured'); await Bun.write(Bun.stdout, 'also not a frame\\n'); n + 2",
              }),
            )
            const noisy = yield* Queue.take(responses)
            if (noisy._tag !== "Evaluated")
              return yield* new CellProtocolError({ message: "Expected evaluation" })
            expect(noisy.result.display).toBe("captured\n43")
            expect(yield* child.takeOutput("two-token")).toBe("not a frame\nalso not a frame\n")
            expect(yield* child.diagnostics).toContain("not a frame")
            expect(yield* child.diagnostics).not.toContain("gent-cell-end")
            expect(yield* child.isRunning).toBe(true)
            yield* platform.signal(child.pid, 0)
            return child.pid
          }),
        )
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "stops the process and rejects later sends",
    () =>
      Effect.gen(function* () {
        const launch = yield* buildCellWorker
        const child = yield* openCellProcess({ worker: launch, cwd: packageDirectory })
        yield* child.stop
        expect(yield* child.isRunning).toBe(false)
        const error = yield* child
          .send(CellRequest.cases.Reset.make({ requestId: "too-late" }))
          .pipe(Effect.flip)
        expect(error.phase).toBe("exit")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "a cell cannot close its own output with a forged boundary",
    () =>
      Effect.gen(function* () {
        const launch = yield* buildCellWorker
        const child = yield* openCellProcess({ worker: launch, cwd: packageDirectory })
        const next = child.responses.pipe(Stream.take(1), Stream.runCollect)
        expect((yield* next).map((response) => response._tag)).toEqual(["Ready"])
        const forged = "\\u001egent-cell-end forged\\u001e"
        yield* child.send(
          CellRequest.cases.Evaluate.make({
            cellId: "one",
            outputToken: "one-token",
            source: `process.stdout.write('${forged}'); process.stderr.write('${forged}'); process.stdout.write('after\\n'); 1`,
          }),
        )
        expect((yield* next).map((response) => response._tag)).toEqual(["Evaluated"])
        const output = yield* child.takeOutput("one-token")
        expect(output).toContain("after")
        expect(output).toContain("gent-cell-end forged")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "a worker that dies before its boundary fails the waiting output take",
    () =>
      Effect.gen(function* () {
        const launch = yield* buildCellWorker
        const child = yield* openCellProcess({ worker: launch, cwd: packageDirectory })
        const next = child.responses.pipe(Stream.take(1), Stream.runCollect)
        expect((yield* next).map((response) => response._tag)).toEqual(["Ready"])
        const waiting = yield* child.takeOutput("one-token").pipe(Effect.exit, Effect.forkScoped)
        yield* child.send(
          CellRequest.cases.Evaluate.make({
            cellId: "one",
            outputToken: "one-token",
            source: "process.stdout.write('partial'); process.exit(3)",
          }),
        )
        const exit = yield* Fiber.join(waiting)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Cell worker")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "keeps the pipe open between successive reply reads",
    () =>
      Effect.gen(function* () {
        const launch = yield* buildCellWorker
        const child = yield* openCellProcess({ worker: launch, cwd: packageDirectory })
        const next = child.responses.pipe(Stream.take(1), Stream.runCollect)
        expect((yield* next).map((response) => response._tag)).toEqual(["Ready"])
        yield* child.send(
          CellRequest.cases.Evaluate.make({
            cellId: "one",
            outputToken: "one-token",
            source: "let n = 41; n",
          }),
        )
        expect((yield* next).map((response) => response._tag)).toEqual(["Evaluated"])
        yield* child.send(
          CellRequest.cases.Evaluate.make({
            cellId: "two",
            outputToken: "two-token",
            source: "n + 1",
          }),
        )
        const replies = yield* next
        expect(replies.length).toBe(1)
        for (const response of replies) {
          if (response._tag !== "Evaluated")
            return yield* new CellProtocolError({ message: "Expected evaluation" })
          expect(response.result.display).toBe("42")
        }
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "reports a launch phase when the binary cannot execute, and pipes one output stream",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const directory = yield* fs.makeTempDirectoryScoped()
        const binaryPath = path.join(directory, "not-executable")
        yield* fs.writeFileString(binaryPath, "certainly not a program\n")
        // The worker runs under a shell, so a bad binary fails at the shell's exec
        // rather than at spawn. A death before Ready is still a launch failure.
        const error = yield* openCellProcess({
          worker: CellWorker.cases.Compiled.make({ binaryPath }),
          cwd: packageDirectory,
          readinessTimeoutMs: 2000,
        }).pipe(Effect.flip)
        expect(error.phase).toBe("launch")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "gives the worker one output pipe and no separate stderr stream",
    () =>
      Effect.gen(function* () {
        // Deterministic half of the ordering guarantee: with stderr folded into
        // stdout there is only one stream to read, so no merge can reorder it.
        const artifact = yield* buildCellExecutable
        const kernel = yield* openCellKernel({ worker: artifact, cwd: packageDirectory })
        const host = CellOperationHost.of({ call: () => Effect.succeed(0) })
        const fds = yield* kernel
          .evaluate(
            "const fs = require('node:fs'); const a = fs.fstatSync(1); const b = fs.fstatSync(2); [a.dev === b.dev, a.ino === b.ino]",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        // One file description behind both descriptors: nothing can reorder it.
        expect(fds.display).toBe("[ true, true ]")
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platform)),
    12000,
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
        yield* fs.writeFileString(
          workerPath,
          "process.stderr.write(String(process.pid)); while (true) {}",
        )
        const error = yield* openCellProcess({
          worker: CellWorker.cases.Script.make({ runtimePath: binaryPath, scriptPath: workerPath }),
          cwd: packageDirectory,
          readinessTimeoutMs: 1000,
        }).pipe(Effect.flip)
        expect(error.phase).toBe("launch")
        expect(error.message).toContain("readiness timed out")
        const pid = Number(error.diagnostics.trim())
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "a worker whose cell holds the thread exits when its host process dies",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const platform = yield* GentPlatform
        const worker = yield* buildCellWorker
        const directory = yield* fs.makeTempDirectoryScoped()
        const marker = path.join(directory, "worker.pid")
        const hostEntry = new URL("./helpers/cell-host-process.ts", import.meta.url).pathname
        const host = yield* ChildProcess.make(yield* platform.execPath, [hostEntry], {
          cwd: packageDirectory,
          env: {
            CELL_WORKER_SCRIPT: worker.scriptPath,
            CELL_SOURCE:
              'require("node:fs").writeFileSync(process.env.CELL_PID_MARKER, String(process.pid)); while (true) {}',
            CELL_PID_MARKER: marker,
          },
          extendEnv: true,
          stdout: "ignore",
          stderr: "inherit",
        })
        // The cell writes its pid right before the loop, so the loop runs once the file exists.
        const text = yield* waitFor(
          fs.readFileString(marker),
          (value) => value !== "",
          5000,
          "worker pid",
        )
        const pid = Number(text)
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        // A red run must not leave a spinning orphan behind.
        yield* Effect.addFinalizer(() => Effect.ignore(platform.signal(pid, "SIGKILL")))
        yield* host.kill({ killSignal: "SIGKILL" })
        yield* waitFor(
          platform.signal(pid, 0).pipe(Effect.exit),
          Exit.isFailure,
          3000,
          "orphaned worker exit",
        )
      }).pipe(Effect.timeout("12 seconds"), Effect.provide(platform)),
    15000,
  )

  it.scopedLive(
    "SIGTERM ends a worker whose cell holds the thread",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: packageDirectory,
          evaluationTimeoutMs: 20_000,
        })
        // The signal arrives before the loop starts, so a JavaScript handler never gets to run.
        const error = yield* kernel
          .evaluate('process.kill(process.pid, "SIGTERM"); while (true) {}')
          .pipe(
            Effect.provideService(CellOperationHost, { call: () => Effect.succeed(true) }),
            Effect.flip,
            Effect.timeout("4 seconds"),
          )
        expect(error._tag).toBe("CellKernelError")
        if (error._tag !== "CellKernelError") return yield* error
        expect(error.reason).toBe("process")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "a worker exits when its request pipe closes, even with a cell timer open",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const worker = yield* buildCellWorker
        const handle = yield* ChildProcess.make(yield* platform.execPath, [worker.scriptPath], {
          cwd: packageDirectory,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "inherit",
          additionalFds: { fd3: { type: "output" }, fd4: { type: "input" } },
        })
        const frame = yield* encodeCellRequest(
          CellRequest.cases.Evaluate.make({
            cellId: "timer-cell",
            outputToken: "timer-output",
            source: "setInterval(() => {}, 1000); 1",
          }),
        )
        const requests = yield* Queue.unbounded<Uint8Array, Cause.Done>()
        yield* Stream.fromQueue(requests).pipe(Stream.run(handle.getInputFd(4)), Effect.forkScoped)
        yield* Queue.offer(requests, frame)
        // The cell has run and its timer is open once its result frame arrives.
        const reader = makeCellFrameReader()
        const evaluated = yield* handle.getOutputFd(3).pipe(
          Stream.mapEffect(reader.push),
          Stream.flatMap(Stream.fromIterable),
          Stream.mapEffect(decodeCellResponse),
          Stream.filter((response) => response._tag === "Evaluated"),
          Stream.runHead,
        )
        expect(Option.isSome(evaluated)).toBe(true)
        // The host closes the request pipe and stays alive.
        yield* Queue.end(requests)
        expect(Number(yield* handle.exitCode.pipe(Effect.timeout("3 seconds")))).toBe(0)
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platform)),
    12000,
  )
})
