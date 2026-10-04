/**
 * Tool images. A tool hands the model an image by reference: `saveToolImage`
 * writes the bytes once to the content-addressed blob store,
 * `<data dir>/blobs/<sha256>.<ext>`, and returns a `ToolImage` the tool puts
 * anywhere in its output. The stored tool result stays ordinary JSON. The
 * server sweeps the store when it starts (`sweepToolImages`). At request time
 * core finds each `ToolImage` in the window's tool results (`toolImagesOf`),
 * reads its bytes back (`readToolImage`), and sends them after the tool
 * results (`toPrompt` in `model-context.ts`).
 *
 * The extension API (the save) and the request projection (the read) share
 * this module; neither owns the other.
 *
 * @module
 */
import {
  Clock,
  Crypto,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Random,
  Schema,
} from "effect"
import { Base64, Hex } from "effect/encoding"
import type * as Prompt from "effect/ai/Prompt"
import { ExtensionContext } from "../domain/extension.js"
import { omitUndefined } from "../domain/guards.js"
import { resolveDataDir, writeFileAtomic } from "./gent-platform.js"

// ── schema ──────────────────────────────────────────────────────────────────

/** The image formats every shipped API class sends to a model. */
const ToolImageMediaType = Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"])
type ToolImageMediaType = typeof ToolImageMediaType.Type

const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * An image a tool returns, by reference: the SHA-256 of its bytes names its
 * file in the blob store. `source` is a display path or label the model reads
 * beside the image and in the line that stands for it once it is left out.
 */
export const ToolImage = Schema.TaggedStruct("ToolImage", {
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  mediaType: ToolImageMediaType,
  width: Positive,
  height: Positive,
  bytes: Positive,
  source: Schema.optional(Schema.String),
})
export type ToolImage = typeof ToolImage.Type

export class ToolImageError extends Schema.TaggedError<ToolImageError>()("ToolImageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The largest image the store takes, in bytes: its base64 fits Anthropic's
 * 5 MiB cap on one image. A larger one would fail every later request of the
 * session, as the image stays in the history, so the save refuses it.
 */
const TOOL_IMAGE_MAX_BYTES = (5 * 1024 * 1024 * 3) / 4

/**
 * The longest side the store takes, in pixels. Anthropic refuses a side over
 * 2,000 pixels in a request of more than 20 images, and OpenAI's patch-based
 * models refuse an image of too many patches; at 2,000 pixels every driver's
 * request stays valid, whatever the number of images.
 */
const TOOL_IMAGE_MAX_SIDE = 2_000

/** The base64 characters an image of `bytes` takes in a request. */
export const toolImageBase64Chars = (bytes: number): number => Math.ceil(bytes / 3) * 4

const decodeToolImage = Schema.decodeUnknownOption(ToolImage)
const decodeJson = Schema.decodeUnknownOption(Schema.Json)

/**
 * The digests of the tool images the tool results among `parts` hold, once
 * each: what a stored message references in the blob store.
 */
export const toolImageDigests = (parts: ReadonlyArray<Prompt.Part>): ReadonlyArray<string> => {
  const digests = new Set<string>()
  for (const part of parts) {
    if (part.type !== "tool-result") continue
    for (const image of Option.match(decodeJson(part.result), {
      onNone: (): ReadonlyArray<ToolImage> => [],
      onSome: toolImagesOf,
    })) {
      digests.add(image.sha256)
    }
  }
  return [...digests]
}

/**
 * Each `ToolImage` in a tool result, in document order, once per image. A
 * value tagged `ToolImage` that does not decode is not an image.
 */
export const toolImagesOf = (value: Schema.Json): ReadonlyArray<ToolImage> => {
  const found: ToolImage[] = []
  const seen = new Set<string>()
  const visit = (node: Schema.Json): void => {
    if (
      Predicate.isNull(node) ||
      Predicate.isString(node) ||
      Predicate.isNumber(node) ||
      Predicate.isBoolean(node)
    ) {
      return
    }
    // An array or an object: either one's values are JSON.
    if (Predicate.isTagged(node, "ToolImage")) {
      const image = decodeToolImage(node)
      if (Option.isSome(image) && !seen.has(image.value.sha256)) {
        seen.add(image.value.sha256)
        found.push(image.value)
      }
      return
    }
    for (const item of Object.values(node)) visit(item)
  }
  visit(value)
  return found
}

// ── image header ────────────────────────────────────────────────────────────

interface ImageHeader {
  readonly mediaType: ToolImageMediaType
  readonly width: number
  readonly height: number
}

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0) =>
  prefix.every((byte, index) => bytes[at + index] === byte)

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0))

const uint16BE = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)
const uint16LE = (bytes: Uint8Array, at: number) => (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8)
const uint24LE = (bytes: Uint8Array, at: number) =>
  uint16LE(bytes, at) | ((bytes[at + 2] ?? 0) << 16)
const uint32BE = (bytes: Uint8Array, at: number) =>
  uint16BE(bytes, at) * 65_536 + uint16BE(bytes, at + 2)

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** The size a JPEG's first start-of-frame segment names, walking the segments before it. */
const jpegSize = (bytes: Uint8Array): Option.Option<ImageHeader> => {
  let at = 2
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return Option.none()
    const marker = bytes[at + 1] ?? 0
    // Fill bytes, and the markers that carry no length.
    if (marker === 0xff) {
      at += 1
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      at += 2
      continue
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isFrame) {
      return Option.some({
        mediaType: "image/jpeg",
        height: uint16BE(bytes, at + 5),
        width: uint16BE(bytes, at + 7),
      })
    }
    at += 2 + uint16BE(bytes, at + 2)
  }
  return Option.none()
}

/** The size a WebP names in its first chunk: lossy (`VP8 `), lossless (`VP8L`) or extended (`VP8X`). */
const webpSize = (bytes: Uint8Array): Option.Option<ImageHeader> => {
  const size = (width: number, height: number): Option.Option<ImageHeader> =>
    Option.some({ mediaType: "image/webp", width, height })
  if (startsWith(bytes, ascii("VP8X"), 12)) {
    return size(1 + uint24LE(bytes, 24), 1 + uint24LE(bytes, 27))
  }
  if (startsWith(bytes, ascii("VP8L"), 12)) {
    const b1 = bytes[22] ?? 0
    const b2 = bytes[23] ?? 0
    const b3 = bytes[24] ?? 0
    return size(
      1 + (((b1 & 0x3f) << 8) | (bytes[21] ?? 0)),
      1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    )
  }
  if (startsWith(bytes, ascii("VP8 "), 12)) {
    return size(uint16LE(bytes, 26) & 0x3fff, uint16LE(bytes, 28) & 0x3fff)
  }
  return Option.none()
}

/** The format and size an image's own header names; none for any other bytes. */
const readImageHeader = (bytes: Uint8Array): Option.Option<ImageHeader> => {
  if (startsWith(bytes, PNG_SIGNATURE) && startsWith(bytes, ascii("IHDR"), 12)) {
    return Option.some({
      mediaType: "image/png",
      width: uint32BE(bytes, 16),
      height: uint32BE(bytes, 20),
    })
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return jpegSize(bytes)
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return Option.some({
      mediaType: "image/gif",
      width: uint16LE(bytes, 6),
      height: uint16LE(bytes, 8),
    })
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8))
    return webpSize(bytes)
  return Option.none()
}

// ── blob store ──────────────────────────────────────────────────────────────

/**
 * A blob no stored message references is removed when a server starts, once
 * it was last written or read longer ago than this: a save another server
 * made a moment ago, whose tool result is not stored yet, stays.
 */
const UNREFERENCED_BLOB_GRACE = Duration.days(1)

const FILE_EXTENSIONS: Readonly<Record<ToolImageMediaType, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
}

/** Where the blobs live: `<data dir>/blobs`. */
export const toolImageDirectory = Effect.fn("ToolImage.directory")(function* (home: string) {
  const path = yield* Path.Path
  return path.join(yield* resolveDataDir(home), "blobs")
})

const blobPath = (path: Path.Path, directory: string, image: ToolImage) =>
  path.join(directory, `${image.sha256}.${FILE_EXTENSIONS[image.mediaType]}`)

const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * A blob the sweep moved aside: `.sweep-<blob name>-<id>`, in the store's
 * directory. One left by a sweep that stopped is settled by the next one.
 */
const SWEPT_NAME = /^\.sweep-([0-9a-f]{64})(\.[a-z]+)-[0-9a-f]{8}$/

/**
 * Removes the blobs under `home`'s data directory that no stored message
 * references (`referenced`, the durable reference count storage keeps) and
 * that were last written or read more than `UNREFERENCED_BLOB_GRACE` ago. A
 * blob a stored message references stays however old it is, so a session
 * resumed after months still shows its images. The server runs it once when
 * it starts.
 *
 * A save on another server may reuse a blob while the sweep looks at it, and
 * no lock spans the processes. So the sweep moves each candidate aside with
 * one rename, then reads its time and its references again. A save that
 * touched the blob before the move shows in that time, and the blob goes
 * back; a save after the move finds its file gone and writes it again (the
 * same bytes, as the name is their digest). Only a moved blob still old and
 * unreferenced is removed. A request that finds a blob gone sends a line
 * instead.
 */
export const sweepToolImages = Effect.fn("ToolImage.sweep")(function* <E>(
  home: string,
  referenced: (sha256: string) => Effect.Effect<boolean, E>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* toolImageDirectory(home)
  const now = yield* Clock.currentTimeMillis
  /** Whether `file` was written or read inside the grace; false when it is gone. */
  const recent = (file: string) =>
    Effect.map(Effect.option(fs.stat(file)), (info) =>
      Option.exists(
        Option.flatMap(info, (stat) => stat.mtime),
        (at) => now - at.getTime() <= Duration.toMillis(UNREFERENCED_BLOB_GRACE),
      ),
    )
  /** A moved blob goes back to `file` when used or referenced since; else it is removed. */
  const settle = Effect.fnUntraced(function* (moved: string, file: string, sha256: string) {
    if ((yield* recent(moved)) || (yield* referenced(sha256))) {
      yield* fs.rename(moved, file).pipe(Effect.ignore)
      return
    }
    yield* fs.remove(moved).pipe(Effect.ignore)
  })
  const names = yield* fs
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
  for (const name of names) {
    const file = path.join(directory, name)
    const swept = Option.fromNullishOr(SWEPT_NAME.exec(name))
    if (Option.isSome(swept)) {
      const [, sha256 = "", extension = ""] = swept.value
      yield* settle(file, path.join(directory, `${sha256}${extension}`), sha256)
      continue
    }
    if (yield* recent(file)) continue
    const digest = Option.liftPredicate(name.split(".")[0] ?? "", (head) => SHA256_HEX.test(head))
    if (Option.isNone(digest)) {
      // No digest (a write that never finished): no save reuses it, and nothing references it.
      yield* fs.remove(file).pipe(Effect.ignore)
      continue
    }
    if (yield* referenced(digest.value)) continue
    const id = (yield* Random.nextIntBetween(0, 0xffffffff)).toString(16).padStart(8, "0")
    const moved = path.join(directory, `.sweep-${name}-${id}`)
    const movedAside = yield* fs.rename(file, moved).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (movedAside) yield* settle(moved, file, digest.value)
  }
})

/** Marks `file` as used now, so the sweep keeps it; false when it is gone. */
const touch = Effect.fn("ToolImage.touch")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const now = (yield* Clock.currentTimeMillis) / 1000
  return yield* fs.utimes(file, now, now).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )
})

/** Writes `bytes` to the store once and returns its reference. */
const storeToolImage = Effect.fn("ToolImage.store")(
  function* (home: string, bytes: Uint8Array, source: Option.Option<string>) {
    if (bytes.length > TOOL_IMAGE_MAX_BYTES) {
      return yield* new ToolImageError({
        message: `the image is ${bytes.length} bytes, over the ${TOOL_IMAGE_MAX_BYTES}-byte limit`,
      })
    }
    const header = readImageHeader(bytes)
    if (Option.isNone(header)) {
      return yield* new ToolImageError({
        message: "the bytes are not a PNG, JPEG, GIF or WebP image",
      })
    }
    const { width, height, mediaType } = header.value
    if (width < 1 || height < 1 || Math.max(width, height) > TOOL_IMAGE_MAX_SIDE) {
      return yield* new ToolImageError({
        message: `the image is ${width}x${height}; each side must be 1 to ${TOOL_IMAGE_MAX_SIDE} pixels: downscale it before you save it`,
      })
    }
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const directory = yield* toolImageDirectory(home)
    const sha256 = Hex.encode(yield* crypto.digest("SHA-256", bytes))
    const image = ToolImage.make({
      sha256,
      mediaType,
      width,
      height,
      bytes: bytes.length,
      ...omitUndefined({ source: Option.getOrUndefined(source) }),
    })
    const file = blobPath(path, directory, image)
    // A reuse marks the file as just used; a file gone is written again.
    if (!(yield* touch(file))) {
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* writeFileAtomic(file, bytes)
    }
    return image
  },
  Effect.mapError((cause) => {
    if (Schema.is(ToolImageError)(cause)) return cause
    return new ToolImageError({ message: "the image could not be stored", cause })
  }),
)

/** What `saveToolImage` reads an image from: its bytes, or a file (relative to the session cwd). */
type SaveToolImageInput = ({ readonly bytes: Uint8Array } | { readonly path: string }) & {
  /** A display path or label; a saved file names its own `path` when this is absent. */
  readonly source?: string
}

/**
 * Store an image a tool returns and get the `ToolImage` that stands for it.
 * Put the result anywhere in the tool's output (its schema holds `ToolImage`);
 * the model sees the image after the tool result, on a model that takes
 * images, and a line naming it on one that does not. The store keeps one file
 * per content (`<data dir>/blobs/<sha256>.<ext>`), keeps it while a stored
 * message holds it, and removes it a day after the last such message goes
 * (`sweepToolImages`). It takes PNG, JPEG, GIF and WebP, up to 3.75 MiB and 2,000
 * pixels a side; anything else fails with `ToolImageError`, and a larger
 * image must be downscaled first.
 */
export const saveToolImage = Effect.fn("saveToolImage")(function* (input: SaveToolImageInput) {
  const ctx = yield* ExtensionContext
  const source = Option.fromUndefinedOr(input.source)
  if ("bytes" in input) return yield* storeToolImage(ctx.home, input.bytes, source)
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const bytes = yield* fs
    .readFile(path.resolve(ctx.cwd, input.path))
    .pipe(
      Effect.mapError(
        (cause) => new ToolImageError({ message: `cannot read the image ${input.path}`, cause }),
      ),
    )
  return yield* storeToolImage(
    ctx.home,
    bytes,
    Option.orElse(source, () => Option.some(input.path)),
  )
})

/**
 * The file that holds `image`'s bytes, for code that reads them (a cell, a
 * command). It stays while a stored message references the image.
 */
export const toolImageFile = Effect.fn("ToolImage.file")(function* (image: ToolImage) {
  const ctx = yield* ExtensionContext
  const path = yield* Path.Path
  return blobPath(path, yield* toolImageDirectory(ctx.home), image)
})

// ── request read ────────────────────────────────────────────────────────────

/**
 * The image's bytes in base64, from the store under `directory`; none when
 * its file is gone or no longer holds `image.bytes` bytes. A read marks the
 * file as used, so the sweep keeps an image a session still sends.
 */
export const readToolImage = Effect.fn("ToolImage.read")(function* (
  directory: string,
  image: ToolImage,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = blobPath(path, directory, image)
  const bytes = yield* Effect.option(fs.readFile(file))
  if (Option.isNone(bytes) || bytes.value.length !== image.bytes) return Option.none<string>()
  yield* touch(file)
  return Option.some(Base64.encode(bytes.value))
})
