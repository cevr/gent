import { BunServices } from "@effect/platform-bun"
import { describe, expect, it } from "effect-bun-test"
import { Clock, Deferred, Effect, Fiber, FileSystem, Layer, Option, Path } from "effect"
import { crc32, deflateSync } from "node:zlib"
import { ExtensionContext } from "../../src/domain/extension"
import {
  readToolImage,
  saveToolImage,
  sweepToolImages,
  toolImageDirectory,
} from "../../src/runtime/tool-image"
import { GentPlatform } from "../../src/runtime/gent-platform"
import { BunGentPlatformLive, BunPlatformLive } from "../../src/runtime/gent-platform-bun"
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

// ── scaling ──────────────────────────────────────────────────────────────────

/** The byte limit of the store: its base64 fits Anthropic's 5 MiB an image. */
const TOOL_IMAGE_MAX_BYTES = (5 * 1024 * 1024 * 3) / 4

/** A truecolor gradient PNG of `width` x `height`. */
const gradientPng = (width: number, height: number) => {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const head = Buffer.alloc(4)
    head.writeUInt32BE(data.length)
    const tail = Buffer.alloc(4)
    tail.writeUInt32BE(crc32(body))
    return Buffer.concat([head, body, tail])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2], 8)
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1)
      raw.set([x % 256, y % 256, 90], y * (width * 3 + 1) + 1 + x * 3)
  }
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ]),
  )
}

/**
 * The real codec, except that each encode to a side over `side` comes out
 * past the byte limit. No real image does at 2,000 pixels: JPEG at quality 20
 * keeps 2,000 x 2,000 pixels of noise under 0.8 MB.
 */
const codecPastTheLimitAbove = (side: number) =>
  Layer.effect(
    GentPlatform,
    Effect.gen(function* () {
      const platform = yield* GentPlatform
      return GentPlatform.of({
        ...platform,
        transcodeImage: (bytes, options) =>
          platform.transcodeImage(bytes, options).pipe(
            Effect.map((encoded) => {
              if (options.maxSide <= side) return encoded
              return { ...encoded, bytes: new Uint8Array(TOOL_IMAGE_MAX_BYTES + 1) }
            }),
          ),
      })
    }),
  ).pipe(Layer.provide(BunGentPlatformLive))

describe("tool image scaling", () => {
  it.scopedLive(
    "an image no encode fits at 2,000 pixels a side is scaled to the next side bound",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "gent-tool-image-scale-" })
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "gent-tool-image-scale-cwd-" })
        const image = yield* saveToolImage({ bytes: gradientPng(4000, 1000) }).pipe(
          Effect.provideService(ExtensionContext, testLeafContext(testToolContext({ home, cwd }))),
          Effect.provide(codecPastTheLimitAbove(1500)),
        )
        // Three quarters of 2,000 a side, its aspect ratio kept.
        expect(image).toMatchObject({
          mediaType: "image/png",
          width: 1500,
          height: 375,
          originalWidth: 4000,
          originalHeight: 1000,
        })
      }).pipe(Effect.timeout("10 seconds"), Effect.provide(BunServices.layer)),
    15_000,
  )
})
