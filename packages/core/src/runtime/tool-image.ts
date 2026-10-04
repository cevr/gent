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
  Match,
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
import {
  GentPlatform,
  type ImageCodecError,
  type ImageTranscode,
  resolveDataDir,
  writeFileAtomic,
} from "./gent-platform.js"

// ── schema ──────────────────────────────────────────────────────────────────

/** The image formats every shipped API class sends to a model. */
const ToolImageMediaType = Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"])
type ToolImageMediaType = typeof ToolImageMediaType.Type

const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

/**
 * An image a tool returns, by reference: the SHA-256 of its bytes names its
 * file in the blob store. `source` is a display path or label the model reads
 * beside the image and in the line that stands for it once it is left out.
 * `originalWidth` and `originalHeight` are the size the tool saved when the
 * store scaled the image to fit; the stored bytes are the scaled image, of
 * `width` x `height`. A point at `(x, y)` in the stored image is at
 * `(x * originalWidth / width, y * originalHeight / height)` in the original.
 * Every size is of the upright image, as it shows: a JPEG its EXIF
 * orientation turns or mirrors is stored turned, so its raster is the image
 * the model sees, and its original size is the turned size, not the size its
 * raster had.
 */
export const ToolImage = Schema.TaggedStruct("ToolImage", {
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  mediaType: ToolImageMediaType,
  width: Positive,
  height: Positive,
  bytes: Positive,
  source: Schema.optional(Schema.String),
  originalWidth: Schema.optional(Positive),
  originalHeight: Schema.optional(Positive),
})
export type ToolImage = typeof ToolImage.Type

export class ToolImageError extends Schema.TaggedError<ToolImageError>()("ToolImageError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * The largest image the store keeps, in bytes: its base64 fits the 5 MiB cap
 * on one image that Anthropic's API takes on Bedrock and Vertex. A larger one
 * would fail every later request of the session, as the image stays in the
 * history, so the save encodes it again until it fits.
 */
const TOOL_IMAGE_MAX_BYTES = (5 * 1024 * 1024 * 3) / 4

/**
 * The longest side the store keeps, in pixels. Anthropic refuses a side over
 * 2,000 pixels in a request of more than 20 images; at 2,000 pixels every
 * driver's request stays valid, whatever the number of images. Each provider
 * scales a larger image down itself, so more pixels cost only bytes. Pi,
 * opencode and Claude Code keep the same bound (`PRIOR_ARTS.md`).
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
  /**
   * False for a JPEG whose EXIF orientation turns or mirrors its raster to
   * show it. Its header names the raster's size, not the size it shows at.
   */
  readonly upright: boolean
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
const uint32LE = (bytes: Uint8Array, at: number) =>
  uint16LE(bytes, at) + uint16LE(bytes, at + 2) * 65_536

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** A JPEG segment before the scan data: its marker, and where it starts (at `0xff`) and ends. */
interface JpegSegment {
  readonly marker: number
  readonly start: number
  readonly end: number
}

/** The segments of a JPEG up to its start of scan, which ends the walk. */
const jpegSegments = (bytes: Uint8Array): ReadonlyArray<JpegSegment> => {
  const segments: Array<JpegSegment> = []
  let at = 2
  while (at + 3 < bytes.length && bytes[at] === 0xff) {
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
    const end = at + 2 + uint16BE(bytes, at + 2)
    segments.push({ marker, start: at, end })
    if (marker === 0xda) break
    at = end
  }
  return segments
}

/**
 * The orientation a JPEG's EXIF block names (`0x0112` in its first image
 * directory), 1 (upright) when it names none.
 */
const jpegOrientation = (bytes: Uint8Array, segments: ReadonlyArray<JpegSegment>): number => {
  const exif = segments.find(
    ({ marker, start }) => marker === 0xe1 && startsWith(bytes, ascii("Exif\0\0"), start + 4),
  )
  if (Predicate.isUndefined(exif)) return 1
  const tiff = exif.start + 10
  const little = startsWith(bytes, ascii("II"), tiff)
  const read16 = (at: number) => {
    if (little) return uint16LE(bytes, at)
    return uint16BE(bytes, at)
  }
  const read32 = (at: number) => {
    if (little) return uint32LE(bytes, at)
    return uint32BE(bytes, at)
  }
  const directory = tiff + read32(tiff + 4)
  for (let index = 0; index < read16(directory); index += 1) {
    const entry = directory + 2 + index * 12
    if (entry + 12 > exif.end) return 1
    if (read16(entry) === 0x0112) return read16(entry + 8)
  }
  return 1
}

/** The size a JPEG's first start-of-frame segment names, and whether its EXIF orientation leaves it upright. */
const jpegSize = (bytes: Uint8Array): Option.Option<ImageHeader> => {
  const segments = jpegSegments(bytes)
  const frame = segments.find(
    ({ marker, start }) =>
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker) &&
      start + 9 < bytes.length,
  )
  if (Predicate.isUndefined(frame)) return Option.none()
  // Orientations 2 to 8 mirror or turn the raster; 0 and 1 leave it as it is.
  const orientation = jpegOrientation(bytes, segments)
  return Option.some({
    mediaType: "image/jpeg",
    height: uint16BE(bytes, frame.start + 5),
    width: uint16BE(bytes, frame.start + 7),
    upright: orientation < 2 || orientation > 8,
  })
}

/** The size a WebP names in its first chunk: lossy (`VP8 `), lossless (`VP8L`) or extended (`VP8X`). */
const webpSize = (bytes: Uint8Array): Option.Option<ImageHeader> => {
  const size = (width: number, height: number): Option.Option<ImageHeader> =>
    Option.some({ mediaType: "image/webp", width, height, upright: true })
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
      upright: true,
    })
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return jpegSize(bytes)
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return Option.some({
      mediaType: "image/gif",
      width: uint16LE(bytes, 6),
      height: uint16LE(bytes, 8),
      upright: true,
    })
  }
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8))
    return webpSize(bytes)
  return Option.none()
}

// ── colour profile ──────────────────────────────────────────────────────────

/** A byte range `[start, end)` of an image's container. */
type ByteRange = readonly [number, number]

/** `bytes` with each of `ranges` (in order, apart) left out. */
const withoutRanges = (bytes: Uint8Array, ranges: ReadonlyArray<ByteRange>): Uint8Array => {
  const kept: Array<Uint8Array> = []
  let from = 0
  for (const [start, end] of ranges) {
    kept.push(bytes.subarray(from, start))
    from = end
  }
  kept.push(bytes.subarray(from))
  const out = new Uint8Array(kept.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of kept) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** A JPEG holds its profile in APP2 segments that open with `ICC_PROFILE`. */
const jpegProfileRanges = (bytes: Uint8Array): ReadonlyArray<ByteRange> =>
  jpegSegments(bytes).flatMap(({ marker, start, end }): ReadonlyArray<ByteRange> => {
    if (marker !== 0xe2 || !startsWith(bytes, ascii("ICC_PROFILE\0"), start + 4)) return []
    return [[start, Math.min(end, bytes.length)]]
  })

/** A PNG holds its profile in an `iCCP` chunk, before its image data. */
const pngProfileRanges = (bytes: Uint8Array): ReadonlyArray<ByteRange> => {
  const ranges: Array<ByteRange> = []
  let at = PNG_SIGNATURE.length
  while (at + 8 <= bytes.length && !startsWith(bytes, ascii("IDAT"), at + 4)) {
    const end = at + 12 + uint32BE(bytes, at)
    if (startsWith(bytes, ascii("iCCP"), at + 4)) ranges.push([at, Math.min(end, bytes.length)])
    at = end
  }
  return ranges
}

/** An extended WebP holds its profile in an `ICCP` chunk, and flags it in its `VP8X` chunk. */
const webpProfileRanges = (bytes: Uint8Array): ReadonlyArray<ByteRange> => {
  const ranges: Array<ByteRange> = []
  let at = 12
  while (at + 8 <= bytes.length) {
    const size = uint32LE(bytes, at + 4)
    const end = at + 8 + size + (size % 2)
    if (startsWith(bytes, ascii("ICCP"), at)) ranges.push([at, Math.min(end, bytes.length)])
    at = end
  }
  return ranges
}

/**
 * The image without its ICC colour profile; none when it holds none. The
 * profile is the only metadata the codec carries into an encode (it drops
 * EXIF, XMP and comments), so it is the only metadata that can keep an encode
 * past the byte limit however few its pixels. Without it the image reads as
 * sRGB.
 */
const withoutColorProfile = (
  bytes: Uint8Array,
  mediaType: ToolImageMediaType,
): Option.Option<Uint8Array> => {
  const ranges = Match.value(mediaType).pipe(
    Match.when("image/jpeg", () => jpegProfileRanges(bytes)),
    Match.when("image/png", () => pngProfileRanges(bytes)),
    Match.when("image/webp", () => webpProfileRanges(bytes)),
    Match.orElse((): ReadonlyArray<ByteRange> => []),
  )
  if (ranges.length === 0) return Option.none()
  const plain = withoutRanges(bytes, ranges)
  if (mediaType === "image/webp") {
    // The RIFF size counts the bytes after it, and VP8X no longer flags a profile.
    new DataView(plain.buffer, plain.byteOffset).setUint32(4, plain.length - 8, true)
    if (startsWith(plain, ascii("VP8X"), 12)) plain[20] = (plain[20] ?? 0) & ~0x20
  }
  return Option.some(plain)
}

// ── scaling ─────────────────────────────────────────────────────────────────

/** The image the store keeps: its bytes, format and size, and the size the tool saved when scaled. */
interface FittedImage {
  readonly bytes: Uint8Array
  readonly mediaType: ToolImageMediaType
  readonly width: number
  readonly height: number
  readonly original: Option.Option<{ readonly width: number; readonly height: number }>
}

/**
 * The encoding a scaled image keeps: its own where the codec encodes it. A
 * GIF (no codec encodes one), or a format no model API takes, becomes a PNG.
 */
const SCALED_FORMATS: Readonly<Record<ToolImageMediaType, ImageTranscode["format"]>> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "png",
  "image/webp": "webp",
}

const ENCODED_MEDIA_TYPES: Readonly<Record<ImageTranscode["format"], ToolImageMediaType>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
}

/** The quality of a lossy encoding at first, and the JPEG qualities past the byte limit. */
const LOSSY_QUALITY = 80
const JPEG_QUALITIES = [80, 60, 40, 20]

/** The side bounds, longest first: each one past the qualities is three quarters of the last, down to 1. */
const SIDE_BOUNDS: ReadonlyArray<number> = (() => {
  const bounds = [TOOL_IMAGE_MAX_SIDE]
  while ((bounds.at(-1) ?? 1) > 1) bounds.push(Math.max(1, Math.floor((bounds.at(-1) ?? 1) * 0.75)))
  return bounds
})()

/**
 * The encodes the store tries, in order, until one is inside the byte limit:
 * at each side bound, the image's own format, then JPEG at falling quality.
 * The order is the prior arts' (`PRIOR_ARTS.md`, tool image scaling).
 */
const encodesFor = (format: ImageTranscode["format"]): ReadonlyArray<ImageTranscode> => {
  // PNG is lossless and takes no quality; JPEG's own encode is the ladder's first.
  const own: ReadonlyArray<Omit<ImageTranscode, "maxSide">> = Match.value(format).pipe(
    Match.when("png", () => [{ format }]),
    Match.when("webp", () => [{ format, quality: LOSSY_QUALITY }]),
    Match.orElse(() => []),
  )
  const jpegs = JPEG_QUALITIES.map((quality): Omit<ImageTranscode, "maxSide"> => ({
    format: "jpeg",
    quality,
  }))
  return SIDE_BOUNDS.flatMap((maxSide) =>
    [...own, ...jpegs].map((encode): ImageTranscode => ({ ...encode, maxSide })),
  )
}

/**
 * The largest colour profile a scaled image keeps: a quarter of the byte
 * limit. A profile is colour, not pixels. Ordinary ones (sRGB, Display P3,
 * Adobe RGB) take a few kilobytes and stay; a larger one would take the bytes
 * the pixels need, and one that alone fills the limit would keep every encode
 * past it. The store leaves a larger one out before it encodes. With at most
 * this much profile, the pixels keep three quarters of the limit, and JPEG at
 * quality 20 of 2,000 x 2,000 pixels of noise takes under 0.8 MB.
 */
const TOOL_IMAGE_MAX_PROFILE_BYTES = TOOL_IMAGE_MAX_BYTES / 4

const CODEC_MESSAGES: Readonly<Record<ImageCodecError["reason"], string>> = {
  "not-an-image": "the bytes are not an image",
  undecodable: "the image cannot be decoded",
  "too-large": "the image has more pixels than the codec decodes",
  failed: "the image cannot be scaled",
}

/**
 * The image scaled inside `TOOL_IMAGE_MAX_SIDE` a side with its aspect ratio
 * kept, and encoded inside `TOOL_IMAGE_MAX_BYTES`. It fails only when the
 * codec cannot decode the bytes.
 */
const fitToolImage = Effect.fn("ToolImage.fit")(
  function* (bytes: Uint8Array, header: Option.Option<ImageHeader>) {
    const platform = yield* GentPlatform
    const format = Option.match(header, {
      onNone: (): ImageTranscode["format"] => "png",
      onSome: ({ mediaType }) => SCALED_FORMATS[mediaType],
    })
    const input = header.pipe(
      Option.flatMap(({ mediaType }) => withoutColorProfile(bytes, mediaType)),
      Option.filter((plain) => bytes.length - plain.length > TOOL_IMAGE_MAX_PROFILE_BYTES),
      Option.getOrElse(() => bytes),
    )
    for (const encode of encodesFor(format)) {
      const encoded = yield* platform.transcodeImage(input, encode)
      if (encoded.bytes.length > TOOL_IMAGE_MAX_BYTES) continue
      const original = Option.liftPredicate(
        { width: encoded.sourceWidth, height: encoded.sourceHeight },
        (source) => source.width !== encoded.width || source.height !== encoded.height,
      )
      return {
        bytes: encoded.bytes,
        mediaType: ENCODED_MEDIA_TYPES[encode.format],
        width: encoded.width,
        height: encoded.height,
        original,
      } satisfies FittedImage
    }
    // A guard: with its profile at most a quarter of the limit, an image fits
    // at the first side bound with the real codec (TOOL_IMAGE_MAX_PROFILE_BYTES).
    return yield* new ToolImageError({ message: "the image cannot be encoded small enough" })
  },
  Effect.mapError((cause) => {
    if (Schema.is(ToolImageError)(cause)) return cause
    return new ToolImageError({ message: CODEC_MESSAGES[cause.reason], cause })
  }),
)

/**
 * The image as the store keeps it: the bytes as they are when their header
 * names an upright size inside the side bound and they are inside the byte
 * limit (no decode), else scaled and encoded to fit (`fitToolImage`). A JPEG
 * its EXIF orientation turns or mirrors goes through the codec, which turns
 * it upright, so the stored raster is the image as it shows.
 */
const fittedToolImage = (bytes: Uint8Array) => {
  const header = readImageHeader(bytes)
  const fits =
    bytes.length <= TOOL_IMAGE_MAX_BYTES &&
    Option.exists(
      header,
      ({ width, height, upright }) =>
        upright && width >= 1 && height >= 1 && Math.max(width, height) <= TOOL_IMAGE_MAX_SIDE,
    )
  if (fits && Option.isSome(header)) {
    const { mediaType, width, height } = header.value
    return Effect.succeed<FittedImage>({
      bytes,
      mediaType,
      width,
      height,
      original: Option.none(),
    })
  }
  return fitToolImage(bytes, header)
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

/** Writes `bytes` to the store once, scaled to fit, and returns its reference. */
const storeToolImage = Effect.fn("ToolImage.store")(
  function* (home: string, input: Uint8Array, source: Option.Option<string>) {
    const fitted = yield* fittedToolImage(input)
    const { bytes } = fitted
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const crypto = yield* Crypto.Crypto
    const directory = yield* toolImageDirectory(home)
    const sha256 = Hex.encode(yield* crypto.digest("SHA-256", bytes))
    const image = ToolImage.make({
      sha256,
      mediaType: fitted.mediaType,
      width: fitted.width,
      height: fitted.height,
      bytes: bytes.length,
      ...omitUndefined({
        source: Option.getOrUndefined(source),
        originalWidth: Option.getOrUndefined(Option.map(fitted.original, (size) => size.width)),
        originalHeight: Option.getOrUndefined(Option.map(fitted.original, (size) => size.height)),
      }),
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
 * (`sweepToolImages`). It keeps PNG, JPEG, GIF and WebP up to 3.75 MiB and
 * 2,000 pixels a side as they are, when upright. A larger image is scaled to
 * fit, its aspect ratio kept, and encoded again where its bytes are still past
 * the limit (a GIF, or another format the codec decodes, becomes a PNG); its
 * `ToolImage` then names its `originalWidth` and `originalHeight`, and the
 * model reads them beside the image. A colour profile past a quarter of the
 * byte limit is left out before the encode. A JPEG its EXIF orientation turns
 * is stored upright. Only bytes no codec decodes fail, with `ToolImageError`.
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
