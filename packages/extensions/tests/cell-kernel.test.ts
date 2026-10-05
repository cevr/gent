import { describe, expect, it } from "effect-bun-test"
import { Deferred, Effect, Fiber, FileSystem, Path, Schema } from "effect"
import { GentPlatform } from "@gent/core/host"
import {
  type LoadedExtension,
  createRpcHarness,
  LanguageModelLayers,
  textStep,
  toolCallStep,
} from "@gent/core/test-utils"
import { AgentDefinition, DEFAULT_AGENT_NAME } from "@gent/core/protocol"
import {
  ExtensionId,
  tool,
  LoadedArtifactIdentity,
  ToolResultFailure,
} from "@gent/core/extensions/api"
import {
  CellKernelResource,
  CellStorageResource,
  CellOperationHost,
  CellTool,
  CellWorker,
  cellWorkerLaunch,
  openCellKernel,
} from "../src/cell.js"
import { CellEvaluationError, maximumCellFrameBytes } from "../src/cell-protocol.js"
import {
  cellWorkerSource,
  packageDirectory,
  buildCellWorker,
  buildCellExecutable,
  cellResultsAfterTurn,
  platform,
  hostCatalog,
} from "./helpers/cell-kernel.js"

// The cell worker kernel: compiled and source workers, globals, deadlines,
// catalog shipping, replacement and the failed-launch limit, large replies.

describe("cell worker kernel", () => {
  it.scopedLive(
    "runs a compiled worker with retained values, the Bun runtime, and the host environment",
    () =>
      Effect.gen(function* () {
        const artifact = yield* buildCellExecutable
        const kernel = yield* openCellKernel({ worker: artifact, cwd: yield* packageDirectory })
        const host = CellOperationHost.of({
          catalog: hostCatalog("value"),
          call: () => Effect.succeed(21),
        })
        expect(
          (yield* kernel
            .evaluate("let saved = await tools.value({}); saved")
            .pipe(Effect.provideService(CellOperationHost, host))).display,
        ).toBe("21")
        expect(
          (yield* kernel.evaluate("saved * 2").pipe(Effect.provideService(CellOperationHost, host)))
            .display,
        ).toBe("42")
        const executable = yield* kernel
          .evaluate("process.execPath")
          .pipe(Effect.provideService(CellOperationHost, host))
        const fs = yield* FileSystem.FileSystem
        expect(executable.display).toBe(yield* fs.realPath(artifact.binaryPath))
        expect(
          (yield* kernel
            .evaluate("Object.keys(process.env).length > 0 && process.cwd() === process.cwd()")
            .pipe(Effect.provideService(CellOperationHost, host))).display,
        ).toBe("true")
        const runtime = yield* kernel
          .evaluate(
            "const hosts = await Bun.file('/etc/hosts').text(); const fsm = await import('node:fs/promises'); [hosts.length > 0, typeof fsm.readdir, typeof require('node:path').join, (await Bun.$`printf ok`.text())]",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(runtime.display).toBe("[ true, 'function', 'function', 'ok' ]")
        // Process output written during the cell returns ahead of its display, Prime style.
        const streamed = yield* kernel
          .evaluate(
            "process.stdout.write('via stdout\\n'); process.stderr.write('via stderr\\n'); Bun.spawnSync(['echo', 'from child'], { stdout: 'inherit' }); 'value'",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(streamed.display).toBe("via stdout\nvia stderr\nfrom child\nvalue")
        // A large write right before the result still lands in full: the worker marks the
        // end of the cell on its one output pipe, and the host waits for that mark.
        const large = yield* kernel
          .evaluate("process.stdout.write('y'.repeat(40000)); 'tail'")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(large.display).toBe(`${"y".repeat(40000)}\ntail`)
        // Interleaved writes return in write order. Two pipes cannot do this: a stderr
        // write spanning several chunks, then stdout, then more stderr arrives inverted,
        // because a merge of two pipes preserves order only within each one. The filler
        // stays under maximumCellDisplayLength so the marks are not truncated away.
        const interleaved = yield* kernel
          .evaluate(
            "process.stderr.write('E'.repeat(16000) + '\\n'); process.stdout.write('LAST-OUT\\n'); process.stderr.write('TRAILING-ERR\\n'); 'done'",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        const marks = interleaved.display
          .split("\n")
          .filter((line) => line === "LAST-OUT" || line === "TRAILING-ERR")
        expect(marks).toEqual(["LAST-OUT", "TRAILING-ERR"])
        // A process the cell spawns writes to the same pipe, so its stderr is kept too.
        const spawned = yield* kernel
          .evaluate(
            "Bun.spawnSync(['sh', '-c', 'echo child-err 1>&2'], { stderr: 'inherit' }); 'after'",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(spawned.display).toBe("child-err\nafter")
        const quiet = yield* kernel
          .evaluate("'nothing streamed'")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(quiet.display).toBe("nothing streamed")
        yield* kernel.reset
        expect(
          (yield* kernel
            .evaluate("typeof saved")
            .pipe(Effect.provideService(CellOperationHost, host))).display,
        ).toBe("undefined")
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platform)),
    12000,
  )

  it.scopedLive(
    "a source run launches the worker source of this checkout under the running Bun",
    () =>
      Effect.gen(function* () {
        const launch = yield* cellWorkerLaunch
        const platform = yield* GentPlatform
        expect(launch).toEqual(
          CellWorker.cases.Script.make({
            runtimePath: yield* platform.execPath,
            scriptPath: yield* cellWorkerSource,
          }),
        )
        // The launch runs: the namespace in this checkout answers a host call.
        const kernel = yield* openCellKernel({ worker: launch, cwd: yield* packageDirectory })
        const host = CellOperationHost.of({
          catalog: hostCatalog("read.file"),
          call: (request) => Effect.succeed(request.name),
        })
        const evaluation = yield* kernel
          .evaluate("await tools.read.file({})")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(evaluation.display).toBe("read.file")
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platform)),
    12000,
  )

  // Bindings were the global names the worker lacked at start, so a cell that
  // rebound a Bun global (`prompt`, `performance`) or a host namespace bound
  // nothing: no report, no snapshot, and a reset kept its value.
  it.scopedLive(
    "a declaration that rebinds a worker global is a binding; the host namespaces come back each cell",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* cellWorkerLaunch,
          cwd: yield* packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const evaluate = (code: string) =>
          kernel.evaluate(code).pipe(Effect.provideService(CellOperationHost, host))
        const bound = yield* evaluate("const prompt = 'draft'; var performance = 5; 1")
        expect(bound.bindings).toEqual(["performance", "prompt"])
        expect(bound.bindingCount).toBe(2)
        // The host namespaces cannot be rebound: a declaration fails its cell and they stay.
        const shadowed = yield* Effect.flip(evaluate("const tools = 7; typeof tools"))
        expect(shadowed.message).toContain("tools")
        const redefined = yield* Effect.flip(
          evaluate(
            "Object.defineProperty(globalThis, 'context', { value: null, configurable: false }); 1",
          ),
        )
        expect(redefined.message).toContain("unconfigurable")
        const after = yield* evaluate("[typeof tools, typeof context.status].join(',')")
        expect(after.display).toBe("function,function")
        expect(after.bindingCount).toBe(2)
        const snapshot = yield* kernel.snapshot
        expect(snapshot.bindings.map((binding) => binding.name).sort()).toEqual([
          "performance",
          "prompt",
        ])
        // A reset puts every rebound global back as the worker found it.
        yield* kernel.reset
        expect((yield* evaluate("[typeof prompt, typeof performance.now].join(',')")).display).toBe(
          "function,function",
        )
        expect([...(yield* kernel.restore(snapshot.bindings))].sort()).toEqual([
          "performance",
          "prompt",
        ])
        expect((yield* evaluate("[prompt, performance].join(',')")).display).toBe("draft,5")
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platform)),
    12000,
  )

  // Reset once deleted new names and ignored a refusal, and compared globals
  // by value only, so a non-configurable global or a changed flag survived it.
  it.scopedLive(
    "a reset that cannot put a global back replaces the worker; a changed flag is put back",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* cellWorkerLaunch,
          cwd: yield* packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const evaluate = (code: string) =>
          kernel.evaluate(code).pipe(Effect.provideService(CellOperationHost, host))
        const flagged = yield* evaluate(
          "Object.defineProperty(globalThis, 'prompt', { writable: false }); 1",
        )
        expect(flagged.bindings).toEqual(["prompt"])
        yield* kernel.reset
        expect(
          (yield* evaluate(
            "String(Object.getOwnPropertyDescriptor(globalThis, 'prompt').writable)",
          )).display,
        ).toBe("true")
        yield* evaluate(
          "Object.defineProperty(globalThis, 'stuck', { value: 1, configurable: false }); var pid = process.pid; 1",
        )
        const before = (yield* evaluate("pid")).display
        yield* kernel.reset
        expect((yield* evaluate("typeof stuck")).display).toBe("undefined")
        expect((yield* evaluate("String(process.pid)")).display).not.toBe(before)
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platform)),
    12000,
  )

  // An uncaught value is shown to the next cell; `inspect` once ran its getter.
  it.scopedLive(
    "an uncaught value with a looping getter reaches the next cell as text",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* cellWorkerLaunch,
          cwd: yield* packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const evaluate = (code: string) =>
          kernel.evaluate(code).pipe(Effect.provideService(CellOperationHost, host))
        yield* evaluate(
          "let kept = 7; setTimeout(() => { throw { get [Symbol.toStringTag]() { for (;;) {} } } }, 0); 1",
        )
        const shown = yield* evaluate("kept").pipe(
          Effect.repeat({ until: (result) => result.display.includes("Uncaught"), times: 20 }),
        )
        expect(shown.display).toBe(
          "Uncaught (from cell 1): { Symbol(Symbol.toStringTag): [Getter] }\n7",
        )
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platform)),
    12000,
  )

  it.scopedLive(
    "a source-run worker ignores the project bunfig preload and .env files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const project = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "gent-cell-project-" }),
        )
        const marker = path.join(project, "preload-ran")
        yield* fs.writeFileString(path.join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
        yield* fs.writeFileString(
          path.join(project, "preload.ts"),
          `await Bun.write('${marker}', 'ran')\n`,
        )
        yield* fs.writeFileString(path.join(project, ".env"), "GENT_CELL_PROJECT_ENV=loaded\n")
        const kernel = yield* openCellKernel({ worker: yield* cellWorkerLaunch, cwd: project })
        const host = CellOperationHost.of({ call: () => Effect.die("No host calls expected") })
        const evaluate = (code: string) =>
          kernel.evaluate(code).pipe(Effect.provideService(CellOperationHost, host))
        expect((yield* evaluate("process.cwd()")).display).toBe(project)
        expect(yield* fs.exists(marker)).toBe(false)
        expect((yield* evaluate("process.env.GENT_CELL_PROJECT_ENV ?? 'absent'")).display).toBe(
          "absent",
        )
        yield* kernel.close
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(platform)),
    12000,
  )

  it.scopedLive(
    "a late throw or an unawaited rejection reaches the cell output and the worker lives",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
        })
        const host = CellOperationHost.of({
          catalog: hostCatalog("broken"),
          call: () =>
            Effect.fail(
              new CellEvaluationError({ phase: "execute", message: "service down", output: "" }),
            ),
        })
        const run = (source: string) =>
          kernel.evaluate(source).pipe(Effect.provideService(CellOperationHost, host))
        // The cell goes on only once the process handlers saw the error. The
        // worker's handler comes first and queues the report, which runs on
        // the next immediate; the cell resumes two immediates later, so the
        // report always lands while the cell still runs.
        const reported = (event: "uncaughtException" | "unhandledRejection") =>
          `await new Promise((resolve) => process.once('${event}', () => setImmediate(() => setImmediate(resolve))))`
        // A timer throws while its own cell runs: that cell's output carries it.
        const own = yield* run(
          `var kept = 5; setTimeout(() => { throw new Error('own timer') }, 0); ${reported("uncaughtException")}; 1`,
        )
        expect(own.display).toContain("own timer")
        // A timer from cell A throws while cell B runs: B does not claim it,
        // and the next cell names A as its origin.
        yield* run(
          "var releaseLate = false; setTimeout(function waitForCellB() { if (!releaseLate) { setTimeout(waitForCellB, 0); return; } throw new Error('late timer'); }, 0); 1",
        )
        const whileLate = yield* run(`releaseLate = true; ${reported("uncaughtException")}; kept`)
        expect(whileLate.display).not.toContain("late timer")
        expect(whileLate.display).toContain("5")
        const afterTimer = yield* run("2")
        expect(afterTimer.display).toMatch(/Uncaught \(from cell \d+\): .*late timer/)
        // A rejection nobody awaits has no known origin: it is never the
        // running cell's error, and the next cell reports it as unknown.
        const dropped = yield* run(
          `Promise.reject(new Error('dropped promise')); ${reported("unhandledRejection")}; 2`,
        )
        expect(dropped.display).not.toContain("dropped promise")
        const afterDropped = yield* run("kept")
        expect(afterDropped.display).toContain(
          "Uncaught (origin unknown: an unawaited promise or microtask): ",
        )
        expect(afterDropped.display).toContain("dropped promise")
        // A host call the cell never awaits fails while the cell still runs:
        // an unhandled rejection, so it too waits for the next cell, unattributed.
        const orphan = yield* run(`tools.broken({}); ${reported("unhandledRejection")}; 3`)
        expect(orphan.display).toBe("3")
        const afterOrphan = yield* run("4")
        expect(afterOrphan.display).toContain("Uncaught (origin unknown")
        expect(afterOrphan.display).toContain("service down")
        yield* kernel.close
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "process output past the display limit keeps its tail, so a trailing error survives",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.succeed(0) })
        // The filler alone exceeds maximumCellDisplayLength, so the buffer must drop
        // something. A head-only policy drops the end, taking the trailing marker with it.
        const evaluation = yield* kernel
          .evaluate(
            "process.stdout.write('f'.repeat(90000) + '\\n'); process.stderr.write('TRAILING-FAILURE\\n'); 'done'",
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(evaluation.display.startsWith("fff")).toBe(true)
        expect(evaluation.display).toContain("characters omitted")
        expect(evaluation.display).toContain("TRAILING-FAILURE")
        yield* kernel.close
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "close waits for active host cleanup and prevents recovery",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
        })
        const started = yield* Deferred.make<number>()
        const stopped = yield* Deferred.make<boolean>()
        const host = CellOperationHost.of({
          catalog: hostCatalog("wait"),
          call: (request) =>
            Deferred.succeed(started, Number(request.input)).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, true)),
            ),
        })
        const evaluation = yield* kernel
          .evaluate("await tools.wait(process.pid)")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.forkScoped)
        const pid = yield* Deferred.await(started)
        yield* kernel.close
        expect(yield* Deferred.isDone(stopped)).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        const error = yield* Fiber.join(evaluation).pipe(Effect.flip)
        if (error._tag !== "CellKernelError") return yield* error
        expect(error.reason).toBe("closed")
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("closed")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "cancels a waiting host call and discards its worker before interruption returns",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
        })
        const started = yield* Deferred.make<number>()
        const stopped = yield* Deferred.make<boolean>()
        const host = CellOperationHost.of({
          catalog: hostCatalog("wait"),
          call: (request) =>
            Deferred.succeed(started, Number(request.input)).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, true)),
            ),
        })
        const evaluation = yield* kernel
          .evaluate("await tools.wait(process.pid)")
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
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "retains values after cell errors, uses the current host, and resets explicitly",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
        })
        const firstHost = CellOperationHost.of({
          catalog: hostCatalog("value"),
          call: () => Effect.succeed(20),
        })
        const nextHost = CellOperationHost.of({
          catalog: hostCatalog("value"),
          call: () => Effect.succeed(22),
        })
        const first = yield* kernel
          .evaluate("let n = await tools.value({}); n")
          .pipe(Effect.provideService(CellOperationHost, firstHost))
        expect(first.display).toBe("20")
        const error = yield* kernel
          .evaluate("n++; throw new Error('cell failed')")
          .pipe(Effect.provideService(CellOperationHost, firstHost), Effect.flip)
        expect(error._tag).toBe("CellEvaluationError")
        const next = yield* kernel
          .evaluate("n + await tools.value({})")
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
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "kills a CPU-bound cell at its deadline without repeating its host operation",
    () =>
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
          evaluationTimeoutMs: 1000,
          maximumFailedLaunches: 1,
        })
        let calls = 0
        let pid = 0
        const host = CellOperationHost.of({
          catalog: hostCatalog("started"),
          call: (request) =>
            Effect.sync(() => {
              calls++
              pid = Number(request.input)
              return true
            }),
        })
        const error = yield* kernel
          .evaluate("let retained = 41; await tools.started(process.pid); while (true) {}")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(error._tag).toBe("CellKernelError")
        if (error._tag !== "CellKernelError") return yield* error
        expect(error.reason).toBe("timeout")
        expect(error.stateLost).toBe(true)
        expect(calls).toBe(1)
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        expect((yield* platform.signal(pid, 0).pipe(Effect.flip))._tag).toBe("SignalError")
        const later = yield* kernel
          .evaluate("await tools.started(0)")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(later._tag).toBe("CellKernelError")
        expect(calls).toBe(1)
        yield* kernel.reset
        const fresh = yield* kernel
          .evaluate("typeof retained")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(fresh.display).toBe("undefined")
        expect(calls).toBe(1)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "pauses the deadline while a host operation is pending",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
          evaluationTimeoutMs: 400,
          maximumFailedLaunches: 1,
        })
        // Host operations own their bounds: a slow one outlives the compute deadline.
        const host = CellOperationHost.of({
          catalog: hostCatalog("slow"),
          // Real-clock host operation that outlives the kernel deadline
          call: () => Effect.sleep("900 millis").pipe(Effect.as(5)),
        })
        const slow = yield* kernel
          .evaluate("const v = await tools.slow(0); v + 1")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(slow.display).toBe("6")
        // Compute after the host operation returns is bounded again.
        const spun = yield* kernel
          .evaluate("await tools.slow(0); while (true) {}")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(spun._tag).toBe("CellKernelError")
        if (spun._tag !== "CellKernelError") return yield* spun
        expect(spun.reason).toBe("timeout")
        expect(spun.stateLost).toBe(true)
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "ships the catalog listing once per hash and again to a replacement worker, and serves its details",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
          evaluationTimeoutMs: 1000,
          maximumFailedLaunches: 1,
        })
        const catalog = {
          hash: "read-v1",
          tools: [
            {
              name: "read",
              description: "Read a file",
              guidelines: [],
              parameters: {},
              signature: "",
              summary: "",
            },
          ],
        }
        const host = CellOperationHost.of({ catalog, call: () => Effect.succeed(true) })
        // The worker holds the listing; the kernel answers the details from the catalog it kept.
        const describe = "(await tools('read')).description"
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
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "an oversized description fails catchably and preserves retained functions",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
        })
        const host = CellOperationHost.of({
          catalog: {
            hash: "oversized-description",
            tools: [
              {
                name: "huge",
                description: "A small listing with large guidelines",
                guidelines: ["😀".repeat(maximumCellFrameBytes / 4)],
                parameters: {},
                signature: "",
                summary: "",
              },
            ],
          },
          call: () => Effect.die("Description must not execute a tool"),
        })
        const seeded = yield* kernel
          .evaluate('var retainedDescriptionValue = () => 41; "seeded"')
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(seeded.display).toBe("seeded")
        const described = yield* kernel
          .evaluate(
            'try { await tools("huge") } catch (error) { console.log(error.message) }; retainedDescriptionValue() + 1',
          )
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(described.display).toContain("description exceeds the cell frame byte limit")
        expect(described.display.length).toBeLessThan(200)
        expect(kernel.isLost()).toBe(false)
        const retained = yield* kernel
          .evaluate("retainedDescriptionValue() + 1")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(retained.display).toBe("42")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "a listing too large for one frame fails the cell and names the tool count to cut",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
        })
        const catalog = {
          hash: "huge-v1",
          tools: [
            {
              name: "huge",
              description: "A tool whose summary alone fills a frame",
              guidelines: [],
              parameters: {},
              signature: "",
              summary: "x".repeat(maximumCellFrameBytes),
            },
          ],
        }
        const host = CellOperationHost.of({ catalog, call: () => Effect.succeed(true) })
        const failed = yield* kernel
          .evaluate("1 + 1")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(failed.message).toContain(
          "the listing of 1 host tools does not fit one frame; select fewer tools for this agent",
        )
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "a lost worker is replaced as often as cells need once each worker completed a cell",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
          maximumFailedLaunches: 1,
        })
        const host = CellOperationHost.of({ call: () => Effect.succeed(true) })
        const run = (source: string) =>
          kernel.evaluate(source).pipe(Effect.provideService(CellOperationHost, host))
        // More losses than the failed-launch limit: each worker completed a cell first.
        for (let lost = 0; lost < 5; lost++) {
          expect((yield* run("1 + 1")).display).toBe("2")
          const crash = yield* run("process.exit(7)").pipe(Effect.flip)
          if (crash._tag !== "CellKernelError") return yield* crash
          expect(crash.reason).toBe("process")
          yield* kernel.reset
        }
        expect((yield* run("21 * 2")).display).toBe("42")
        yield* kernel.close
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("closed")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "workers that launch and die in their first cell trip the failed-launch limit",
    () =>
      Effect.gen(function* () {
        const kernel = yield* openCellKernel({
          worker: yield* buildCellWorker,
          cwd: yield* packageDirectory,
        })
        const host = CellOperationHost.of({ call: () => Effect.succeed(true) })
        const crash = Effect.gen(function* () {
          const error = yield* kernel
            .evaluate("process.exit(7)")
            .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
          if (error._tag !== "CellKernelError") return yield* Effect.die(error)
          return error.reason
        })
        // Each worker reaches Ready, then dies before it completes a cell.
        for (let launch = 0; launch < 2; launch++) {
          expect(yield* crash).toBe("process")
          yield* kernel.reset
        }
        expect(yield* crash).toBe("process")
        const refused = yield* kernel.reset.pipe(Effect.flip)
        expect(refused.reason).toBe("replacement-limit")
        expect(refused.message).toContain("3 times in a row")
        yield* kernel.close
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )

  it.scopedLive(
    "counts failed replacement starts and does not reopen a closed kernel",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const launch = yield* buildCellWorker
        const kernel = yield* openCellKernel({
          worker: launch,
          cwd: yield* packageDirectory,
          maximumFailedLaunches: 1,
        })
        const host = CellOperationHost.of({ call: () => Effect.succeed(true) })
        // The first worker completes a cell, so its later death is not a failed launch.
        const completed = yield* kernel
          .evaluate("1")
          .pipe(Effect.provideService(CellOperationHost, host))
        expect(completed.display).toBe("1")
        const crash = yield* kernel
          .evaluate("process.exit(7)")
          .pipe(Effect.provideService(CellOperationHost, host), Effect.flip)
        expect(crash._tag).toBe("CellKernelError")
        yield* fs.writeFileString(launch.scriptPath, "process.exit(2)")
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("process")
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("replacement-limit")
        yield* kernel.close
        expect((yield* kernel.reset.pipe(Effect.flip)).reason).toBe("closed")
      }).pipe(Effect.timeout("8 seconds"), Effect.provide(platform)),
    10000,
  )
})

describe("large host replies", () => {
  it.scopedLive(
    "a tool result past the frame cap reaches the cell bounded with a read pointer, and the worker keeps its bindings",
    () =>
      Effect.gen(function* () {
        const large = "x".repeat(1_100_000)
        const extensions: ReadonlyArray<LoadedExtension> = [
          {
            manifest: { id: ExtensionId.make("cell-large-reply") },
            scope: "builtin",
            sourcePath: "cell-large-reply",
            artifactIdentity: LoadedArtifactIdentity.make("cell-large-reply-source"),
            contributions: {
              resources: [CellStorageResource, CellKernelResource],
              tools: [
                CellTool,
                tool({
                  id: "large",
                  description: "Return a large text",
                  params: Schema.Struct({}),
                  output: Schema.String,
                  execute: () => Effect.succeed(large),
                }),
                tool({
                  id: "largeFailure",
                  description: "Fail with a large message",
                  params: Schema.Struct({}),
                  output: Schema.String,
                  execute: () =>
                    Effect.fail(new ToolResultFailure({ message: large, result: large })),
                }),
                // Each NUL takes one byte raw and six bytes as JSON: the frame carries JSON.
                tool({
                  id: "escapedFailure",
                  description: "Fail with an error whose JSON escapes grow past the frame cap",
                  params: Schema.Struct({}),
                  output: Schema.String,
                  execute: () =>
                    Effect.fail(
                      new ToolResultFailure({
                        message: "escaped",
                        result: { error: "\u0000".repeat(200_000) },
                      }),
                    ),
                }),
              ],
            },
          },
        ]
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          toolCallStep("cell", { code: "var kept = 7; kept" }),
          toolCallStep("cell", {
            code: [
              "const r = await tools.large({})",
              'const page = await context.read(r.read.match(/"(.+?)"/)[1], { offset: 1_099_991 })',
              "JSON.stringify([r.truncated, r.totalChars, r.text.length < 1_000_000, page.text, kept])",
            ].join("\n"),
          }),
          toolCallStep("cell", {
            code: "let failure; try { await tools.largeFailure({}) } catch (e) { failure = e.message }\nJSON.stringify([failure.length < 1_000_000, failure.includes('context.read('), kept])",
          }),
          toolCallStep("cell", {
            code: "let failure; try { await tools.escapedFailure({}) } catch (e) { failure = e.message }\nJSON.stringify([failure.length < 200_000, failure.includes('context.read('), kept])",
          }),
          textStep("Read the large results"),
        ])
        const harness = yield* createRpcHarness({
          extensions,
          providerLayer,
          agents: [new AgentDefinition({ name: DEFAULT_AGENT_NAME })],
        })
        const { client, sessionId, branchId } = harness
        yield* client.message.send({ sessionId, branchId, content: "Read large results" })
        const results = yield* cellResultsAfterTurn(harness)
        expect(results).toHaveLength(4)
        // The JSON text of the string result is its characters plus two quotes;
        // its last page ends in ten characters and the closing quote.
        expect(results[1]).toMatchObject({
          result: { display: '[true,1100002,true,"xxxxxxxxxx\\"",7]' },
        })
        expect(results[2]).toMatchObject({ result: { display: "[true,true,7]" } })
        expect(results[3]).toMatchObject({ result: { display: "[true,true,7]" } })
      }).pipe(Effect.timeout("25 seconds"), Effect.provide(platform)),
    30000,
  )
})
