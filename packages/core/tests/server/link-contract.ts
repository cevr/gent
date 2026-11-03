/**
 * Prints the link contract of the program this process runs, on the Bun
 * platform: the program is `Bun.main`, this file or a fixture that imports
 * it. The link tests compare runs of it. `hold` prints it, waits for a line
 * on stdin and prints it again; `lazy` prints `started`, waits for the line
 * and only then reads it.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, Stdio, Stream } from "effect"
import { BunGentPlatformLive } from "../../src/runtime/gent-platform-bun"
import { linkContract } from "../../src/server/link"

const print = linkContract.pipe(Effect.flatMap(Console.log))

BunRuntime.runMain(
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const [mode = "once"] = yield* stdio.args
    if (mode === "lazy") yield* Console.log("started")
    else yield* print
    if (mode === "once") return
    // The next chunk on stdin: the test's line.
    yield* stdio.stdin.pipe(Stream.take(1), Stream.runDrain)
    yield* print
  }).pipe(Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer))),
)
