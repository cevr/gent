import { describe, expect, it } from "effect-bun-test"
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schema,
  Stream,
  SynchronizedRef,
} from "effect"
import { crc32, deflateSync } from "node:zlib"
import { BunServices } from "@effect/platform-bun"
import { LanguageModel } from "effect/ai"
import * as Prompt from "effect/ai/Prompt"
import type { ChildProcessSpawner } from "effect/process"
import {
  AgentDefinition,
  type CatalogPlan,
  defineExtension,
  ExtensionHost,
  isRecord,
  isRecordArray,
  Model,
  modelFromCatalog,
  ModelId,
  omitUndefined,
  ProviderAuthInfo,
  ProviderId,
  saveToolImage,
  tool,
  ToolImage,
  ToolImageError,
} from "@gent/core/extensions/api"
import {
  BunGentPlatformLive,
  createRpcHarness,
  LanguageModelLayers,
  makeTempDirectoryScoped,
  runToolWithCtx,
  type SequenceStep,
  testAgent,
  testToolContext,
  textStep,
  toolCallStep,
  waitFor,
} from "@gent/core/test-utils"
import {
  AnthropicPlatform,
  buildAnthropicModelDriver,
  type ClaudeCredentials,
  MESSAGES_CLASS,
} from "../src/anthropic.js"
import { buildOpenAIModelDriver, type OpenAICredentials, RESPONSES_CLASS } from "../src/openai.js"
import {
  CHAT_COMPLETIONS_CLASS,
  type CredentialCacheCell,
  EMPTY_CREDENTIAL_CELL,
} from "../src/providers.js"
import { fakeFetchLayer, makeFakeFetchState } from "./helpers/fake-http-client.js"

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

// Real images, which a codec decodes: the header fixtures above have no pixels.

/** The byte limit of the store: its base64 fits Anthropic's 5 MiB an image. */
const TOOL_IMAGE_MAX_BYTES = (5 * 1024 * 1024 * 3) / 4

const pngChunk = (type: string, data: Uint8Array) => {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data])
  return Buffer.concat([Buffer.from(be32(data.length)), body, Buffer.from(be32(crc32(body)))])
}

/** A truecolor PNG of `width` x `height`, each pixel as `pixel` paints it. */
const paintedPng = (
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
) => {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y)
      const at = y * stride + 1 + x * 3
      raw[at] = red
      raw[at + 1] = green
      raw[at + 2] = blue
    }
  }
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", Uint8Array.from([...be32(width), ...be32(height), 8, 2, 0, 0, 0])),
      pngChunk("IDAT", deflateSync(raw)),
      pngChunk("IEND", new Uint8Array()),
    ]),
  )
}

/** A gradient PNG, which compresses well. */
const realPng = (width: number, height: number) =>
  paintedPng(width, height, (x, y) => [x % 256, y % 256, 90])

/** A PNG of noise from a fixed seed: no lossy encoder makes it small. */
const noisePng = (width: number, height: number) => {
  let state = 2_463_534_242
  const next = () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) & 0xff
  }
  return paintedPng(width, height, () => [next(), next(), next()])
}

/**
 * A two-colour GIF of `width` x `height`. Each pixel is a clear code and the
 * pixel's code, three bits each, so the code width never grows.
 */
const realGif = (width: number, height: number) => {
  const bits: Array<number> = []
  const put = (code: number) => {
    for (let bit = 0; bit < 3; bit += 1) bits.push((code >> bit) & 1)
  }
  for (let index = 0; index < width * height; index += 1) {
    put(4)
    put(((index % width) >> 4) & 1)
  }
  put(5)
  const data: Array<number> = []
  for (let at = 0; at < bits.length; at += 8) {
    let byte = 0
    for (let bit = 0; bit < 8; bit += 1) byte |= (bits[at + bit] ?? 0) << bit
    data.push(byte)
  }
  const blocks: Array<number> = []
  for (let at = 0; at < data.length; at += 255) {
    const block = data.slice(at, at + 255)
    blocks.push(block.length, ...block)
  }
  return bytesOf(
    "GIF89a",
    le16(width),
    le16(height),
    [0x80, 0, 0, 0, 0, 0, 255, 255, 255],
    [0x2c, 0, 0, 0, 0],
    le16(width),
    le16(height),
    [0, 2],
    blocks,
    [0, 0x3b],
  )
}

/** `png` encoded as `format` by Bun's codec. */
const encodeAs = (png: Uint8Array, format: "jpeg" | "webp", quality = 80) =>
  Effect.promise(() => {
    const image = new Bun.Image(png)
    if (format === "jpeg") return image.jpeg({ quality }).bytes()
    return image.webp({ quality }).bytes()
  })

/** The size and format an image's bytes decode to. */
const imageMetadata = (bytes: Uint8Array) =>
  Effect.promise(() => new Bun.Image(bytes).metadata()).pipe(
    Effect.map(({ width, height, format }) => ({ width, height, format })),
  )

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

/** The platform a saved image runs on: the Bun services and gent's own, the image codec's owner. */
const storePlatform = Layer.merge(BunServices.layer, BunGentPlatformLive)

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
    }).pipe(Effect.provide(storePlatform)),
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
    }).pipe(Effect.provide(storePlatform)),
  )

  it.scopedLive("bytes no codec decodes fail and store nothing", () =>
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
        "ToolImageError: the bytes are not an image",
      )
      // A header with no pixels behind it: the store must decode it to scale it, and cannot.
      const huge = new Uint8Array(4 * 1024 * 1024)
      huge.set(pngBytes(100, 100))
      expect(yield* failureOf({ base64: base64(huge) })).toBe(
        "ToolImageError: the image cannot be decoded",
      )
      expect(yield* failureOf({ base64: base64(pngBytes(2001, 10)) })).toBe(
        "ToolImageError: the image cannot be decoded",
      )
      expect(yield* failureOf({ path: "missing.png" })).toBe(
        "ToolImageError: cannot read the image missing.png",
      )
      expect(yield* fs.exists(`${home}/.gent/blobs`)).toBe(false)
      // Inside both limits the store keeps the bytes as they are, with no decode.
      expect(yield* failureOf({ base64: base64(pngBytes(2000, 2000)) })).toBe("stored")
    }).pipe(Effect.provide(storePlatform)),
  )

  it.scopedLive(
    "an image past 2,000 pixels a side is scaled to fit, keeps its aspect ratio, and records its original size",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("tool-image-home-")
        const fs = yield* FileSystem.FileSystem
        const cases = [
          {
            name: "png",
            bytes: realPng(4000, 1000),
            mediaType: "image/png",
            ext: "png",
            size: [2000, 500],
            original: [4000, 1000],
          },
          {
            name: "webp",
            bytes: yield* encodeAs(realPng(1500, 3000), "webp"),
            mediaType: "image/webp",
            ext: "webp",
            size: [1000, 2000],
            original: [1500, 3000],
          },
          // No platform encodes GIF: a scaled GIF is a PNG of its first frame.
          {
            name: "gif",
            bytes: realGif(2100, 10),
            mediaType: "image/png",
            ext: "png",
            size: [2000, 10],
            original: [2100, 10],
          },
        ] as const
        for (const fixture of cases) {
          const { image } = yield* saveIn(home, home, {
            base64: base64(fixture.bytes),
            source: fixture.name,
          })
          const stored = yield* fs.readFile(`${home}/.gent/blobs/${image.sha256}.${fixture.ext}`)
          expect({ name: fixture.name, image }).toEqual({
            name: fixture.name,
            image: {
              _tag: "ToolImage",
              sha256: sha256Hex(stored),
              mediaType: fixture.mediaType,
              width: fixture.size[0],
              height: fixture.size[1],
              bytes: stored.length,
              source: fixture.name,
              originalWidth: fixture.original[0],
              originalHeight: fixture.original[1],
            },
          })
          // The blob is the scaled image: its own header names the stored size.
          expect(yield* imageMetadata(stored)).toEqual({
            width: fixture.size[0],
            height: fixture.size[1],
            format: fixture.ext,
          })
        }
      }).pipe(Effect.provide(storePlatform), Effect.timeout("20 seconds")),
    25_000,
  )

  it.scopedLive(
    "an image past the byte limit is encoded again under it",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("tool-image-home-")
        const fs = yield* FileSystem.FileSystem
        const jpeg = yield* encodeAs(noisePng(1800, 1800), "jpeg", 100)
        expect(jpeg.length).toBeGreaterThan(TOOL_IMAGE_MAX_BYTES)
        const { image } = yield* saveIn(home, home, { base64: base64(jpeg) })
        const stored = yield* fs.readFile(`${home}/.gent/blobs/${image.sha256}.jpg`)
        expect(image.mediaType).toBe("image/jpeg")
        expect(image.bytes).toBe(stored.length)
        expect(image.bytes).toBeLessThanOrEqual(TOOL_IMAGE_MAX_BYTES)
        // Its sides were inside the limit, so only its bytes changed.
        expect([image.width, image.height]).toEqual([1800, 1800])
        expect(image.originalWidth).toBeUndefined()
        expect(yield* imageMetadata(stored)).toEqual({ width: 1800, height: 1800, format: "jpeg" })
      }).pipe(Effect.provide(storePlatform), Effect.timeout("20 seconds")),
    25_000,
  )

  it.live("a ToolImage stored before scaling, with no original size, still decodes", () =>
    Effect.gen(function* () {
      const stored = {
        _tag: "ToolImage",
        sha256: "a".repeat(64),
        mediaType: "image/png",
        width: 64,
        height: 32,
        bytes: 100,
        source: "shot.png",
      } as const
      expect(yield* Schema.decodeEffect(ToolImage)(stored)).toEqual(stored)
    }),
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
    "a server start keeps every blob a stored message references and removes old ones nobody does",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("tool-image-sweep-home-")
        // One workspace across the starts, so a later start can delete the session.
        const cwd = yield* makeTempDirectoryScoped("tool-image-sweep-cwd-")
        const storagePath = `${home}/gent.db`
        const fs = yield* FileSystem.FileSystem
        const blobs = `${home}/.gent/blobs`
        // The first server stores a session whose tool result references the shot.
        const { sessionId } = yield* Effect.scoped(
          imageTurn({ paths: ["shot.png"], home, cwd, storagePath }),
        )
        const referenced = `${blobs}/${sha256Hex(SHOT)}.png`
        const unreferenced = `${blobs}/${"c".repeat(64)}.png`
        const fresh = `${blobs}/${"d".repeat(64)}.png`
        yield* fs.writeFile(unreferenced, pngBytes(1, 1, 1))
        yield* fs.writeFile(fresh, pngBytes(1, 1, 2))
        const now = (yield* Clock.currentTimeMillis) / 1000
        const ago = (hours: number) => now - hours * 60 * 60
        // Unused for 20 days, as an unloaded session's image is; a fresh one may be another server's save in flight.
        yield* fs.utimes(referenced, ago(20 * 24), ago(20 * 24))
        yield* fs.utimes(unreferenced, ago(20 * 24), ago(20 * 24))
        yield* fs.utimes(fresh, ago(1), ago(1))
        const restart = <A, E>(then: (client: RpcClient) => Effect.Effect<A, E>) =>
          Effect.scoped(
            Effect.gen(function* () {
              const { layer: providerLayer } = yield* LanguageModelLayers.sequence([])
              const { client } = yield* createRpcHarness({
                agents: [testAgent],
                extensionInputs: [],
                providerLayer,
                home,
                cwd,
                storagePath,
              })
              yield* then(client)
            }),
          )
        yield* restart(() =>
          waitFor(
            fs.exists(unreferenced),
            (exists) => !exists,
            5_000,
            "the unreferenced blob removed",
          ),
        )
        expect(yield* fs.exists(referenced)).toBe(true)
        expect(yield* fs.exists(fresh)).toBe(true)
        // Its session deleted, the image has no reference left: the next start removes it.
        yield* restart((client) => client.session.delete({ sessionId }).pipe(Effect.orDie))
        yield* restart(() =>
          waitFor(fs.exists(referenced), (exists) => !exists, 5_000, "the released blob removed"),
        )
        expect(yield* fs.exists(fresh)).toBe(true)
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("20 seconds")),
    25_000,
  )
})

// ── request ─────────────────────────────────────────────────────────────────

/** The image the tool saves from the `index`th path of a turn. */
const shotBytes = (index: number) => pngBytes(64, 32, 11 + index)
const SHOT = shotBytes(0)
const SHOT_DATA = base64(SHOT)

/**
 * One turn: the model calls `save_image` once for each path in `paths`, one
 * call a step, then answers. Returns the prompt of each request, in order.
 * Each path is a copy of `SHOT` with its own filler, written in the cwd.
 */
type RpcClient = Effect.Success<ReturnType<typeof createRpcHarness>>["client"]

const imageTurn = Effect.fn("test.imageTurn")(function* (params: {
  readonly paths: ReadonlyArray<string>
  /** The bytes of each path; a copy of `SHOT` with its own filler when absent. */
  readonly shots?: ReadonlyArray<Uint8Array>
  readonly agent?: AgentDefinition
  readonly models?: ReadonlyArray<Model>
  /** A home and a database file the test keeps across server starts. */
  readonly home?: string
  readonly cwd?: string
  readonly storagePath?: string
}) {
  const home = yield* Option.match(Option.fromUndefinedOr(params.home), {
    onNone: () => makeTempDirectoryScoped("tool-image-request-home-"),
    onSome: Effect.succeed,
  })
  const cwd = yield* Option.match(Option.fromUndefinedOr(params.cwd), {
    onNone: () => makeTempDirectoryScoped("tool-image-request-cwd-"),
    onSome: Effect.succeed,
  })
  const fs = yield* FileSystem.FileSystem
  for (const [index, path] of params.paths.entries()) {
    yield* fs.writeFile(`${cwd}/${path}`, params.shots?.[index] ?? shotBytes(index))
  }
  const prompts: Array<Prompt.Prompt> = []
  const seen: SequenceStep["assertOptions"] = (options) => {
    prompts.push(options.prompt)
  }
  const { layer: providerLayer, controls } = yield* LanguageModelLayers.sequence([
    ...params.paths.map((path) => ({
      ...toolCallStep("save_image", { path }),
      assertOptions: seen,
    })),
    { ...textStep("Saw them."), assertOptions: seen },
  ])
  const { client, sessionId, branchId } = yield* createRpcHarness({
    agents: [params.agent ?? testAgent],
    extensionInputs: [saveImageExtension],
    providerLayer,
    home,
    cwd,
    ...omitUndefined({ models: params.models, storagePath: params.storagePath }),
  })
  const turn = yield* client.session.events({ sessionId, branchId }).pipe(
    Stream.map(({ event }) => event),
    Stream.takeUntil((event) => event._tag === "TurnCompleted"),
    Stream.runDrain,
    Effect.forkScoped,
  )
  yield* client.message.send({ sessionId, branchId, content: "look at the screens" })
  yield* Fiber.join(turn)
  yield* controls.assertDone
  const stored = yield* client.message.list({ branchId })
  return { prompts, stored, home, sessionId }
})

/** The message after the last tool message of `prompt`, and that tool message. */
const afterLastToolMessage = (prompt: Prompt.Prompt) => {
  const index = prompt.content.findLastIndex((message) => message.role === "tool")
  return {
    tool: Option.fromUndefinedOr(prompt.content[index]),
    next: Option.fromUndefinedOr(prompt.content[index + 1]),
  }
}

/** The parts of a user message, as the type and the text or data each carries. */
const partsOf = (message: Option.Option<Prompt.Message>) => {
  if (Option.isNone(message) || message.value.role !== "user") return []
  return message.value.content.map((part) => {
    if (part.type === "text") return { type: "text", value: part.text }
    if (Predicate.isString(part.data)) return { type: part.type, value: part.data }
    return { type: part.type, value: "<bytes>" }
  })
}

// The real drivers: each sends the prompt the turn built, through a fake fetch.

const apiKey = ProviderAuthInfo.cases.Api.make({ key: "image-test-key" })

const anthropicModel = Effect.gen(function* () {
  const credentialCellRef =
    yield* SynchronizedRef.make<CredentialCacheCell<ClaudeCredentials>>(EMPTY_CREDENTIAL_CELL)
  const services = Context.add(
    yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
    >(),
    AnthropicPlatform,
    AnthropicPlatform.of({ platform: "darwin", home: "/nonexistent/gent-test-home", env: {} }),
  )
  const driver = buildAnthropicModelDriver(credentialCellRef, Option.none(), services, "1h")
  return yield* driver.resolveModel("claude-sonnet-4-5", apiKey)
}).pipe(Effect.provide(BunServices.layer))

const responsesModel = Effect.gen(function* () {
  const credentialCellRef =
    yield* SynchronizedRef.make<CredentialCacheCell<OpenAICredentials>>(EMPTY_CREDENTIAL_CELL)
  const driver = buildOpenAIModelDriver(
    credentialCellRef,
    new Map(),
    Option.none(),
    yield* Crypto.Crypto,
  )
  return yield* driver.resolveModel("gpt-5.4", apiKey)
}).pipe(Effect.provide(BunServices.layer))

const chatCompletionsModel = CHAT_COMPLETIONS_CLASS.resolveModel({
  providerId: "compat",
  model: { id: "vision-chat", name: "Vision chat" },
  apiKey: Option.some("image-test-key"),
  baseUrl: Option.some("https://chat.example.test/v1"),
  transformClient: Option.none(),
  hints: Option.none(),
})

/** The JSON body `model` sends for `prompt`; the fake answers 400, so nothing streams back. */
const requestBody = (
  model: Layer.Layer<LanguageModel.LanguageModel>,
  prompt: Prompt.Prompt,
): Effect.Effect<Schema.Json> =>
  Effect.gen(function* () {
    const state = makeFakeFetchState()
    yield* LanguageModel.streamText({ prompt }).pipe(
      Stream.runDrain,
      Effect.provide(
        Layer.provideMerge(
          model,
          fakeFetchLayer(state, () => ({ status: 400, body: '{"error":"refused by the test"}' })),
        ),
      ),
      Effect.exit,
    )
    return decodeJson(state.captured[0]?.body ?? "null")
  })

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))

/** The items of `body[key]`, as JSON objects. */
const itemsOf = (
  body: Schema.Json | Record<string, Schema.Json>,
  key: string,
): ReadonlyArray<Record<string, Schema.Json>> => {
  if (!isRecord(body)) return []
  const items = body[key]
  if (!isRecordArray(items)) return []
  return items.map((item) => decodeObject(item))
}
const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json))

describe("tool images in a request", () => {
  it.scopedLive(
    "the step after an image tool sends the image in a user message after the result",
    () =>
      Effect.gen(function* () {
        const { prompts } = yield* imageTurn({ paths: ["shot.png"] })
        expect(prompts).toHaveLength(2)
        // The first request has no tool result yet.
        expect(prompts[0]?.content.some((message) => message.role === "tool")).toBe(false)
        const { tool, next } = afterLastToolMessage(prompts[1] ?? Prompt.empty)
        expect(Option.map(tool, (message) => message.role)).toEqual(Option.some("tool"))
        expect(partsOf(next)).toEqual([
          { type: "text", value: "Image from save_image shot.png 64x32:" },
          { type: "file", value: `data:image/png;base64,${SHOT_DATA}` },
        ])
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive(
    "a scaled image's line names its original size and the factor that maps coordinates back",
    () =>
      Effect.gen(function* () {
        const { prompts, stored } = yield* imageTurn({
          paths: ["canvas.png"],
          shots: [realPng(4000, 2000)],
        })
        const { next } = afterLastToolMessage(prompts[1] ?? Prompt.empty)
        expect(partsOf(next)[0]).toEqual({
          type: "text",
          value:
            "Image from save_image canvas.png 2000x1000, scaled from 4000x2000 (multiply coordinates by 2.00 to map to the original):",
        })
        // The stored result keeps the original size beside the scaled one.
        const results = stored
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "tool-result" && part.name === "save_image")
        expect(results[0]).toMatchObject({
          result: {
            image: { width: 2000, height: 1000, originalWidth: 4000, originalHeight: 2000 },
          },
        })
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "each real driver sends the image where its API takes one",
    () =>
      Effect.gen(function* () {
        // The turn runs on a model of each class, so its prompt carries that class's image options.
        const classTurn = (id: string, apiClass: CatalogPlan) =>
          Effect.gen(function* () {
            const model = modelFromCatalog("p", { id, name: id }, apiClass)
            const { prompts } = yield* imageTurn({
              paths: ["shot.png"],
              agent: AgentDefinition.make({
                name: testAgent.name,
                description: id,
                model: model.id,
              }),
              models: [Model.make({ ...model, contextLength: 200_000 })],
            })
            return prompts[1] ?? Prompt.empty
          })
        const prompt = yield* classTurn("claude-sonnet-4-5", MESSAGES_CLASS)
        const openAiPrompt = yield* classTurn("gpt-5.4", RESPONSES_CLASS)
        const dataUrl = `data:image/png;base64,${SHOT_DATA}`

        // Messages: the image joins the tool result in one user turn.
        const anthropic = itemsOf(yield* requestBody(yield* anthropicModel, prompt), "messages")
        const resultTurn = anthropic.find(
          (message) =>
            isRecordArray(message["content"]) &&
            message["content"].some((block) => block["type"] === "tool_result"),
        )
        expect(resultTurn?.["role"]).toBe("user")
        const blocks = itemsOf(resultTurn ?? {}, "content")
        expect(blocks.map((block) => block["type"])).toEqual(["tool_result", "text", "image"])
        expect(blocks[1]?.["text"]).toBe("Image from save_image shot.png 64x32:")
        expect(blocks[2]?.["source"]).toEqual({
          type: "base64",
          media_type: "image/png",
          data: SHOT_DATA,
        })

        // Responses: a user input_image right after the function call output, at
        // the `high` detail its cost counts at.
        const responses = itemsOf(yield* requestBody(yield* responsesModel, openAiPrompt), "input")
        const output = responses.findIndex((item) => item["type"] === "function_call_output")
        expect(output).toBeGreaterThan(-1)
        const imageItem = responses[output + 1]
        expect(imageItem?.["role"]).toBe("user")
        expect(itemsOf(imageItem ?? {}, "content")).toEqual([
          { type: "input_text", text: "Image from save_image shot.png 64x32:" },
          { type: "input_image", image_url: dataUrl, detail: "high" },
        ])

        // Chat Completions: a user image_url message right after the tool message.
        const chat = itemsOf(
          yield* requestBody(yield* chatCompletionsModel, openAiPrompt),
          "messages",
        )
        const toolMessage = chat.findIndex((message) => message["role"] === "tool")
        expect(toolMessage).toBeGreaterThan(-1)
        const imageMessage = chat[toolMessage + 1]
        expect(imageMessage?.["role"]).toBe("user")
        expect(itemsOf(imageMessage ?? {}, "content")).toEqual([
          { type: "text", text: "Image from save_image shot.png 64x32:" },
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
        ])
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("15 seconds")),
    20_000,
  )

  it.scopedLive(
    "a model the catalog says reads no images gets a line in place of each",
    () =>
      Effect.gen(function* () {
        const blind = ModelId.make("test/blind")
        const { prompts } = yield* imageTurn({
          paths: ["shot.png"],
          agent: AgentDefinition.make({ name: testAgent.name, description: "Blind", model: blind }),
          models: [
            Model.make({
              id: blind,
              name: "Blind",
              provider: ProviderId.make("test"),
              contextLength: 200_000,
              imageInput: false,
            }),
          ],
        })
        const { next } = afterLastToolMessage(prompts[1] ?? Prompt.empty)
        expect(partsOf(next)).toEqual([
          {
            type: "text",
            value: "[image not shown: this model takes no image input: save_image shot.png 64x32]",
          },
        ])
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    15_000,
  )

  it.scopedLive(
    "an image whose blob is gone gets a line in its place",
    () =>
      Effect.gen(function* () {
        const home = yield* makeTempDirectoryScoped("tool-image-gone-home-")
        const prompts: Array<Prompt.Prompt> = []
        const seen: SequenceStep["assertOptions"] = (options) => {
          prompts.push(options.prompt)
        }
        // The tool saves the image, then removes its blob before the next step reads it.
        const GoneTool = tool({
          id: "save_image",
          description: "Save an image, then lose it",
          params: Schema.Struct({}),
          output: Schema.Struct({ image: ToolImage }),
          execute: () =>
            Effect.gen(function* () {
              const image = yield* saveToolImage({ bytes: SHOT, source: "lost.png" })
              const fs = yield* FileSystem.FileSystem
              yield* fs.remove(`${home}/.gent/blobs/${image.sha256}.png`).pipe(Effect.orDie)
              return { image }
            }),
        })
        const { layer: providerLayer } = yield* LanguageModelLayers.sequence([
          { ...toolCallStep("save_image", {}), assertOptions: seen },
          { ...textStep("Gone."), assertOptions: seen },
        ])
        const { client, sessionId, branchId } = yield* createRpcHarness({
          agents: [testAgent],
          extensionInputs: [
            defineExtension({
              id: "image-loser",
              setup: Effect.gen(function* () {
                const host = yield* ExtensionHost
                yield* host.register("tool", GoneTool)
              }),
            }),
          ],
          providerLayer,
          home,
        })
        const turn = yield* client.session.events({ sessionId, branchId }).pipe(
          Stream.takeUntil(({ event }) => event._tag === "TurnCompleted"),
          Stream.runDrain,
          Effect.forkScoped,
        )
        yield* client.message.send({ sessionId, branchId, content: "lose it" })
        yield* Fiber.join(turn)
        const { next } = afterLastToolMessage(prompts[1] ?? Prompt.empty)
        expect(partsOf(next)).toEqual([
          { type: "text", value: "[image no longer stored: save_image lost.png 64x32]" },
        ])
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds")),
    15_000,
  )
})

// ── bound ───────────────────────────────────────────────────────────────────

const encodeMessage = Schema.encodeSync(Schema.fromJsonString(Prompt.Message))
const encodeResult = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json))

/** The prompt's messages as JSON text, the bytes a cache compares. */
const messageTexts = (prompt: Prompt.Prompt) =>
  prompt.content.map((message) => encodeMessage(message))

/** The text parts of the user messages that carry tool images, in prompt order. */
const imageTexts = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) => {
    if (message.role !== "user") return []
    return message.content.flatMap((part) => {
      if (part.type !== "text" || !/^(Image from|\[earlier image)/.test(part.text)) return []
      return [part.text]
    })
  })

describe("tool image bound in a turn", () => {
  it.scopedLive(
    "the oldest images leave five at a time, each request between drops keeps the prefix, and the session keeps every image",
    () =>
      Effect.gen(function* () {
        const paths = Array.from({ length: 26 }, (_, index) => `shot-${index + 1}.png`)
        // A Messages model, so each image counts at its class's cost: a model whose
        // class names none counts gpt-4o-mini's tiles, and 26 would fill the window.
        const model = modelFromCatalog("p", { id: "bound", name: "Bound" }, MESSAGES_CLASS)
        const { prompts, stored, home } = yield* imageTurn({
          paths,
          agent: AgentDefinition.make({
            name: testAgent.name,
            description: "Bound",
            model: model.id,
          }),
          models: [Model.make({ ...model, contextLength: 200_000 })],
        })
        // One request before any image, then one after each.
        expect(prompts).toHaveLength(27)

        // 20 images go whole; the 21st leaves the oldest five as lines; the 26th, ten.
        const dropped = prompts.map(
          (prompt) => imageTexts(prompt).filter((text) => text.startsWith("[earlier")).length,
        )
        expect(dropped.slice(19, 27)).toEqual([0, 0, 5, 5, 5, 5, 5, 10])
        expect(imageTexts(prompts[21] ?? Prompt.empty).slice(0, 6)).toEqual([
          "[earlier image left out to keep the request small: save_image shot-1.png 64x32]",
          "[earlier image left out to keep the request small: save_image shot-2.png 64x32]",
          "[earlier image left out to keep the request small: save_image shot-3.png 64x32]",
          "[earlier image left out to keep the request small: save_image shot-4.png 64x32]",
          "[earlier image left out to keep the request small: save_image shot-5.png 64x32]",
          "Image from save_image shot-6.png 64x32:",
        ])

        // Each request starts with the one before it, byte for byte, except
        // where a drop changed an earlier image: at the 21st and the 26th.
        const changedPrefix = prompts.flatMap((prompt, index) => {
          const before = messageTexts(prompts[index - 1] ?? Prompt.empty)
          const now = messageTexts(prompt).slice(0, before.length)
          if (index === 0 || now.every((text, at) => text === before[at])) return []
          return [index]
        })
        expect(changedPrefix).toEqual([21, 26])

        // The stored session keeps all 26 references, and the store all 26 blobs.
        const references = stored.flatMap((message) =>
          message.parts.flatMap((part) => {
            if (part.type !== "tool-result") return []
            return [decodeSaved(encodeResult(part.result)).image]
          }),
        )
        expect(references).toHaveLength(26)
        const fs = yield* FileSystem.FileSystem
        for (const image of references) {
          expect(yield* fs.exists(`${home}/.gent/blobs/${image.sha256}.png`)).toBe(true)
        }
      }).pipe(Effect.provide(BunServices.layer), Effect.timeout("40 seconds")),
    45_000,
  )
})
