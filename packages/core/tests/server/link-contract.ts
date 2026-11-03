/**
 * Prints link contracts from a process of its own, on the Bun platform, so
 * the link tests compare them across processes. `platform` prints the
 * contract of the release this process runs (`GentPlatform.source`: the
 * compiled define's when the run defines one). `checkout <directory>` prints
 * the contract of the release the checkout at `directory` holds
 * (`sourceRelease`: this process's own id when it holds none). `release`
 * reads its arguments four at a time, a commit, a tree, a lock and a Bun,
 * and prints the contract of each release, one line each.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Console, Effect, Layer, References, Stdio } from "effect"
import { GentPlatform, GentRelease } from "../../src/runtime/gent-platform"
import { BunGentPlatformLive, sourceRelease } from "../../src/runtime/gent-platform-bun"
import { linkContract } from "../../src/server/link"

/** `linkContract` on this process's platform, with `release` as its source. */
const contractOf = (release: GentRelease) =>
  linkContract.pipe(
    Effect.provideServiceEffect(
      GentPlatform,
      Effect.gen(function* () {
        const platform = yield* GentPlatform
        return GentPlatform.of({ ...platform, source: Effect.succeed(release) })
      }),
    ),
  )

const FACTS = 4

BunRuntime.runMain(
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio
    const [mode = "", ...rest] = yield* stdio.args
    if (mode === "platform") {
      yield* Console.log(yield* linkContract)
      return
    }
    if (mode === "checkout") {
      yield* Console.log(yield* contractOf(yield* sourceRelease(rest[0] ?? "")))
      return
    }
    for (let at = 0; at + FACTS <= rest.length; at += FACTS) {
      const release = GentRelease.cases.Released.make({
        commit: rest[at] ?? "",
        tree: rest[at + 1] ?? "",
        lock: rest[at + 2] ?? "",
        bun: rest[at + 3] ?? "",
      })
      yield* Console.log(yield* contractOf(release))
    }
  }).pipe(
    // Its stdout is the contracts alone: a source run that names no release logs why.
    Effect.provideService(References.MinimumLogLevel, "None"),
    Effect.provide(Layer.mergeAll(BunGentPlatformLive, BunServices.layer)),
  ),
)
