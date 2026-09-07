import { Option, Predicate, Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"

export class UrlBackedImageNotSupportedError extends Schema.TaggedError<UrlBackedImageNotSupportedError>()(
  "UrlBackedImageNotSupportedError",
  {
    image: Schema.String,
  },
) {
  override get message(): string {
    return `responsePartsFromMessages only supports data URL images; cannot encode URL-backed image "${this.image}"`
  }
}

export const filePartDataToDisplay = (part: Prompt.FilePart): string => {
  if (Predicate.isString(part.data)) return part.data
  if (part.data instanceof URL) return part.data.toString()
  return `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`
}

export const dataUrlToBytes = (value: string): Option.Option<Uint8Array> => {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(value)
  if (Predicate.isNull(match)) return Option.none()
  const data = match[2]
  if (Predicate.isUndefined(data)) return Option.none()
  return Option.some(Uint8Array.from(Buffer.from(data, "base64")))
}

export const imagePartToResponseFilePart = (part: Prompt.FilePart): Response.FilePart => {
  let data = Option.none<Uint8Array>()
  if (Predicate.isString(part.data)) {
    data = dataUrlToBytes(part.data)
  } else if (!(part.data instanceof URL)) {
    data = Option.some(part.data)
  }

  if (Option.isNone(data)) {
    // oxlint-disable-next-line effect/noThrowStatement -- This synchronous Prompt conversion exposes a tagged failure to its caller.
    throw new UrlBackedImageNotSupportedError({ image: filePartDataToDisplay(part) })
  }
  return Response.makePart("file", {
    data: data.value,
    mediaType: part.mediaType,
  })
}

export const responseFilePartToImagePart = (
  part: Response.FilePart,
): Option.Option<Prompt.FilePart> => {
  if (!part.mediaType.startsWith("image/")) return Option.none()
  return Option.some(
    Prompt.filePart({
      data: `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`,
      mediaType: part.mediaType,
    }),
  )
}
