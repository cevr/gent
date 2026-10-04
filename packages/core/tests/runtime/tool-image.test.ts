import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Clock, Deferred, Effect, Fiber, FileSystem, Layer, Option, Path } from "effect"
import { ExtensionContext } from "../../src/domain/extension"
import {
  readToolImage,
  saveToolImage,
  sweepToolImages,
  toolImageDirectory,
} from "../../src/runtime/tool-image"
import { BunPlatformLive } from "../../src/runtime/gent-platform-bun"
import { testLeafContext, testToolContext } from "../../src/test-utils/harness"

/** A 1x1 PNG, base64. */
const DOT_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
const DOT_BYTES = Uint8Array.from(Buffer.from(DOT_PNG, "base64"))

/** Where the sweep stops: before its first move or removal of a file, or right after it. */
type GatePoint = "before" | "after"

/**
 * The file system with the sweep's first rename or removal held at `point`:
 * `reached` opens there, and the step goes on once `release` opens.
 */
const heldFileSystem = (
  point: GatePoint,
  reached: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const held = { first: true }
      const hold = <A, E>(step: Effect.Effect<A, E>) =>
        Effect.gen(function* () {
          if (!held.first) return yield* step
          held.first = false
          if (point === "before") {
            yield* Deferred.complete(reached, Effect.void)
            yield* Deferred.await(release)
            return yield* step
          }
          const result = yield* step
          yield* Deferred.complete(reached, Effect.void)
          yield* Deferred.await(release)
          return result
        })
      return FileSystem.FileSystem.of({
        ...fs,
        rename: (from, to) => hold(fs.rename(from, to)),
        remove: (path, options) => hold(fs.remove(path, options)),
      })
    }),
  ).pipe(Layer.provide(BunServices.layer))

describe("tool image sweep", () => {
  for (const [point, story] of [
    ["before", "a save that reuses a blob before the sweep moves it keeps the blob"],
    ["after", "a save that finds a blob moved by the sweep writes it again"],
  ] as const) {
    it.scopedLive(`${story}, and the image stays readable`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-tool-image-sweep-" })
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gent-tool-image-sweep-cwd-" })
        const context = testLeafContext(testToolContext({ home, cwd }))
        const save = saveToolImage({ bytes: DOT_BYTES }).pipe(
          Effect.provideService(ExtensionContext, context),
        )
        const image = yield* save
        const directory = yield* toolImageDirectory(home)
        const path = yield* Path.Path
        const file = path.join(directory, `${image.sha256}.png`)
        // Two days unused and no stored message references it: a candidate.
        const twoDaysAgo = ((yield* Clock.currentTimeMillis) - 2 * 24 * 60 * 60 * 1000) / 1000
        yield* fs.utimes(file, twoDaysAgo, twoDaysAgo)

        const reached = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const sweep = yield* sweepToolImages(home, () => Effect.succeed(false)).pipe(
          Effect.provide(heldFileSystem(point, reached, release)),
          Effect.forkScoped,
        )
        yield* Deferred.await(reached)
        // Another server saves the same image while the sweep is held.
        expect(yield* save).toEqual(image)
        yield* Deferred.complete(release, Effect.void)
        yield* Fiber.join(sweep)

        expect(yield* readToolImage(directory, image)).toEqual(Option.some(DOT_PNG))
        expect(yield* fs.readDirectory(directory)).toEqual([`${image.sha256}.png`])
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(BunPlatformLive)),
    )
  }

  it.scopedLive("an old blob nobody references is removed; a fresh one stays", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-tool-image-sweep-" })
      const context = testLeafContext(testToolContext({ home, cwd: home }))
      const image = yield* saveToolImage({ bytes: DOT_BYTES }).pipe(
        Effect.provideService(ExtensionContext, context),
      )
      const directory = yield* toolImageDirectory(home)
      const path = yield* Path.Path
      const file = path.join(directory, `${image.sha256}.png`)
      yield* sweepToolImages(home, () => Effect.succeed(false))
      expect(yield* fs.exists(file)).toBe(true)
      const twoDaysAgo = ((yield* Clock.currentTimeMillis) - 2 * 24 * 60 * 60 * 1000) / 1000
      yield* fs.utimes(file, twoDaysAgo, twoDaysAgo)
      yield* sweepToolImages(home, () => Effect.succeed(false))
      expect(yield* fs.readDirectory(directory)).toEqual([])
    }).pipe(Effect.timeout("5 seconds"), Effect.provide(BunPlatformLive)),
  )

  it.scopedLive(
    "a blob a stopped sweep left aside goes back when referenced and is removed when not",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-tool-image-sweep-" })
        const directory = yield* toolImageDirectory(home)
        yield* fs.makeDirectory(directory, { recursive: true })
        const kept = "a".repeat(64)
        const dropped = "b".repeat(64)
        const twoDaysAgo = ((yield* Clock.currentTimeMillis) - 2 * 24 * 60 * 60 * 1000) / 1000
        for (const sha256 of [kept, dropped]) {
          const aside = path.join(directory, `.sweep-${sha256}.png-0000beef`)
          yield* fs.writeFile(aside, DOT_BYTES)
          yield* fs.utimes(aside, twoDaysAgo, twoDaysAgo)
        }
        yield* sweepToolImages(home, (sha256) => Effect.succeed(sha256 === kept))
        expect(yield* fs.readDirectory(directory)).toEqual([`${kept}.png`])
      }).pipe(Effect.timeout("5 seconds"), Effect.provide(BunPlatformLive)),
  )
})
