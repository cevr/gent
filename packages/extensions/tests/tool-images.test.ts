import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
  Clock,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Path,
  Predicate,
  Schema,
  Stream,
} from "effect"
import { BunServices } from "@effect/platform-bun"
import {
  defineExtension,
  ExtensionHost,
  omitUndefined,
  saveToolImage,
  tool,
  ToolImage,
  ToolImageError,
} from "@gent/core/extensions/api"
import {
  createRpcHarness,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  runToolWithCtx,
  testAgent,
  testToolContext,
  textStep,
  toolCallStep,
  waitFor,
} from "@gent/core/test-utils"

// ── image fixtures ──────────────────────────────────────────────────────────

const bytesOf = (...parts: ReadonlyArray<ReadonlyArray<number> | string>): Uint8Array =>
  Uint8Array.from(
    parts.flatMap((part) => {
      if (Predicate.isString(part)) return Array.from(part, (char) => char.charCodeAt(0))
      return [...part]
    }),
  )
const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const be32 = (value: number) => [...be16(Math.floor(value / 65_536)), ...be16(value & 0xffff)]
const le16 = (value: number) => [value & 0xff, (value >> 8) & 0xff]
const le24 = (value: number) => [...le16(value & 0xffff), (value >> 16) & 0xff]
/** Bytes after the header, so two fixtures of one format differ in content. */
const filler = (seed: number) => Array.from({ length: 64 }, (_, index) => (seed + index) % 256)

/** A PNG whose IHDR names `width` x `height`. */
const pngBytes = (width: number, height: number, seed = 0) =>
  bytesOf(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    "IHDR",
    be32(width),
    be32(height),
    [8, 6, 0, 0, 0],
    filler(seed),
  )

/** A JPEG with an APP0 segment before its start-of-frame. */
const jpegBytes = (width: number, height: number) =>
  bytesOf(
    [0xff, 0xd8],
    [0xff, 0xe0],
    be16(16),
    "JFIF",
    [0, 1, 1, 0, 0, 1, 0, 1, 0, 0],
    [0xff, 0xc0],
    be16(17),
    [8],
    be16(height),
    be16(width),
    [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
    filler(1),
  )

const gifBytes = (width: number, height: number) =>
  bytesOf("GIF89a", le16(width), le16(height), [0xf7, 0, 0], filler(2))

const webpChunk = (fourCC: string, payload: ReadonlyArray<number>) =>
  bytesOf("RIFF", [0, 0, 0, 0], "WEBP", fourCC, [payload.length, 0, 0, 0], payload, filler(3))

/** An extended WebP (`VP8X`): the canvas size minus one, in 24 bits each. */
const webpExtendedBytes = (width: number, height: number) =>
  webpChunk("VP8X", [0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)])

/** A lossless WebP (`VP8L`): 14 bits each of size minus one after the signature byte. */
const webpLosslessBytes = (width: number, height: number) => {
  const bits = (width - 1) | ((height - 1) << 14)
  return webpChunk("VP8L", [
    0x2f,
    bits & 0xff,
    (bits >> 8) & 0xff,
    (bits >> 16) & 0xff,
    (bits >>> 24) & 0xff,
  ])
}

/** A lossy WebP (`VP8 `): a frame tag, the start code, then 14 bits each of size. */
const webpLossyBytes = (width: number, height: number) =>
  webpChunk("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)])

// ── store ───────────────────────────────────────────────────────────────────

/** A tool that saves what it is handed and returns the reference. */
const SaveTool = tool({
  id: "save_image",
  description: "Save an image",
  params: Schema.Struct({
    base64: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    source: Schema.optional(Schema.String),
  }),
  output: Schema.Struct({ image: ToolImage }),
  execute: ({ base64, path, source }) =>
    Effect.gen(function* () {
      const label = omitUndefined({ source })
      if (Predicate.isString(path)) return { image: yield* saveToolImage({ path, ...label }) }
      return {
        image: yield* saveToolImage({ bytes: Buffer.from(base64 ?? "", "base64"), ...label }),
      }
    }),
})

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

const saveIn = (home: string, cwd: string, params: typeof SaveTool.parametersSchema.Type) =>
  runToolWithCtx(SaveTool, params, testToolContext({ home, cwd }))

const sha256Hex = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex")

describe("tool image store", () => {
  it.scopedLive("a saved image reads its format and size from its own header", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("tool-image-home-")
      const fs = yield* FileSystem.FileSystem
      const cases = [
        { bytes: pngBytes(640, 480), mediaType: "image/png", width: 640, height: 480, ext: "png" },
        {
          bytes: jpegBytes(1024, 768),
          mediaType: "image/jpeg",
          width: 1024,
          height: 768,
          ext: "jpg",
        },
        { bytes: gifBytes(32, 16), mediaType: "image/gif", width: 32, height: 16, ext: "gif" },
        {
          bytes: webpExtendedBytes(1920, 1080),
          mediaType: "image/webp",
          width: 1920,
          height: 1080,
          ext: "webp",
        },
        {
          bytes: webpLosslessBytes(300, 200),
          mediaType: "image/webp",
          width: 300,
          height: 200,
          ext: "webp",
        },
        {
          bytes: webpLossyBytes(800, 600),
          mediaType: "image/webp",
          width: 800,
          height: 600,
          ext: "webp",
        },
      ] as const
      for (const fixture of cases) {
        const { image } = yield* saveIn(home, home, {
          base64: base64(fixture.bytes),
          source: "shot",
        })
        expect(image).toEqual({
          _tag: "ToolImage",
          sha256: sha256Hex(fixture.bytes),
          mediaType: fixture.mediaType,
          width: fixture.width,
          height: fixture.height,
          bytes: fixture.bytes.length,
          source: "shot",
        })
        const stored = yield* fs.readFile(`${home}/.gent/blobs/${image.sha256}.${fixture.ext}`)
        expect(Buffer.from(stored).equals(Buffer.from(fixture.bytes))).toBe(true)
      }
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("the same bytes saved twice keep one file, and a path saves from the cwd", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("tool-image-home-")
      const cwd = yield* makeTempDirectoryScoped("tool-image-cwd-")
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const bytes = pngBytes(10, 20, 7)
      yield* fs.makeDirectory(path.join(cwd, "shots"))
      yield* fs.writeFile(path.join(cwd, "shots", "a.png"), bytes)
      const first = yield* saveIn(home, cwd, { base64: base64(bytes) })
      const second = yield* saveIn(home, cwd, { path: "shots/a.png" })
      expect(first.image.source).toBeUndefined()
      expect(second.image).toEqual({ ...first.image, source: "shots/a.png" })
      expect(yield* fs.readDirectory(path.join(home, ".gent", "blobs"))).toEqual([
        `${first.image.sha256}.png`,
      ])
    }).pipe(Effect.provide(BunServices.layer)),
  )

  it.scopedLive("bytes that are not an image, or are too large, fail and store nothing", () =>
    Effect.gen(function* () {
      const home = yield* makeTempDirectoryScoped("tool-image-home-")
      const fs = yield* FileSystem.FileSystem
      const failureOf = (params: { readonly base64?: string; readonly path?: string }) =>
        saveIn(home, home, params).pipe(
          Effect.exit,
          Effect.map((exit) => {
            if (Exit.isSuccess(exit)) return "stored"
            return Option.match(Cause.findErrorOption(exit.cause), {
              onNone: () => Cause.pretty(exit.cause),
              onSome: (error) => {
                expect(error).toBeInstanceOf(ToolImageError)
                return `${error._tag}: ${error.message}`
              },
            })
          }),
        )
      expect(yield* failureOf({ base64: base64(bytesOf("plain text, no image")) })).toBe(
        "ToolImageError: the bytes are not a PNG, JPEG, GIF or WebP image",
      )
      const huge = new Uint8Array(4 * 1024 * 1024)
      huge.set(pngBytes(100, 100))
      expect(yield* failureOf({ base64: base64(huge) })).toBe(
        "ToolImageError: the image is 4194304 bytes, over the 3932160-byte limit",
      )
      expect(yield* failureOf({ base64: base64(pngBytes(9000, 10)) })).toBe(
        "ToolImageError: the image is 9000x10; each side must be 1 to 8000 pixels",
      )
      expect(yield* failureOf({ path: "missing.png" })).toBe(
        "ToolImageError: cannot read the image missing.png",
      )
      expect(yield* fs.exists(`${home}/.gent/blobs`)).toBe(false)
    }).pipe(Effect.provide(BunServices.layer)),
  )
})

// ── acceptance ──────────────────────────────────────────────────────────────

const saveImageExtension = defineExtension({
  id: "image-saver",
  setup: Effect.gen(function* () {
    const host = yield* ExtensionHost
    yield* host.register("tool", SaveTool)
  }),
})

const decodeSaved = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ image: ToolImage })),
)

describe("tool images through a turn", () => {
  it.scopedLive(
    "a tool that saves an image returns its reference as the stored result",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("tool-image-turn-home-")
        const bytes = pngBytes(64, 32, 11)
        const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
          toolCallStep("save_image", { base64: base64(bytes), source: "screens/home.png" }),
          textStep("Saw it."),
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: [testAgent],
          extensionInputs: [saveImageExtension],
          providerLayer,
          home,
        })
        const turn = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.map(({ event }) => event),
          Stream.takeUntil((event) => event._tag === "TurnCompleted"),
          Stream.runCollect,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "save the screen" })
        const resultJson = Array.from(yield* Fiber.join(turn)).flatMap((event) => {
          if (event._tag !== "ToolCallSucceeded") return []
          return Option.toArray(Option.fromUndefinedOr(event.resultJson))
        })
        expect(resultJson).toHaveLength(1)
        expect(decodeSaved(resultJson[0]).image).toEqual({
          _tag: "ToolImage",
          sha256: sha256Hex(bytes),
          mediaType: "image/png",
          width: 64,
          height: 32,
          bytes: bytes.length,
          source: "screens/home.png",
        })
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.exists(`${home}/.gent/blobs/${sha256Hex(bytes)}.png`)).toBe(true)
        yield* controls.assertDone
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive(
    "a server start removes the blobs nobody used for 14 days and keeps the rest",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("tool-image-sweep-home-")
        const fs = yield* FileSystem.FileSystem
        const blobs = `${home}/.gent/blobs`
        yield* fs.makeDirectory(blobs, { recursive: true })
        const old = `${blobs}/${"a".repeat(64)}.png`
        const recent = `${blobs}/${"b".repeat(64)}.png`
        yield* fs.writeFile(old, pngBytes(1, 1, 1))
        yield* fs.writeFile(recent, pngBytes(1, 1, 2))
        const now = (yield* Clock.currentTimeMillis) / 1000
        const fifteenDaysAgo = now - 15 * 24 * 60 * 60
        const thirteenDaysAgo = now - 13 * 24 * 60 * 60
        yield* fs.utimes(old, fifteenDaysAgo, fifteenDaysAgo)
        yield* fs.utimes(recent, thirteenDaysAgo, thirteenDaysAgo)
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
        yield* createRpcHarness({
          agents: [testAgent],
          extensionInputs: [],
          providerLayer,
          home,
        })
        yield* waitFor(fs.exists(old), (exists) => !exists, 5_000, "the old blob removed")
        expect(yield* fs.exists(recent)).toBe(true)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    15_000,
  )
})
