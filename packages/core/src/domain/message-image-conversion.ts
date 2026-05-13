import { Schema } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import * as Response from "effect/unstable/ai/Response"

export class UrlBackedImageNotSupportedError extends Schema.TaggedErrorClass<UrlBackedImageNotSupportedError>()(
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
  if (typeof part.data === "string") return part.data
  if (part.data instanceof URL) return part.data.toString()
  return `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`
}

export const fileDataFromImage = (part: Prompt.FilePart): string | URL | Uint8Array => {
  if (typeof part.data !== "string") return part.data
  if (part.data.startsWith("data:")) return part.data
  try {
    return new URL(part.data)
  } catch {
    return part.data
  }
}

export const dataUrlToBytes = (value: string): Uint8Array | undefined => {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(value)
  if (match === null) return undefined
  const data = match[2]
  if (data === undefined) return undefined
  return Uint8Array.from(Buffer.from(data, "base64"))
}

export const imagePartToResponseFilePart = (part: Prompt.FilePart): Response.FilePart => {
  let data: Uint8Array | undefined
  if (typeof part.data === "string") {
    data = dataUrlToBytes(part.data)
  } else if (!(part.data instanceof URL)) {
    data = part.data
  }

  if (data === undefined) {
    throw new UrlBackedImageNotSupportedError({ image: filePartDataToDisplay(part) })
  }
  return Response.makePart("file", {
    data,
    mediaType: part.mediaType,
  })
}

export const responseFilePartToImagePart = (part: Response.FilePart): Prompt.FilePart | undefined =>
  part.mediaType.startsWith("image/")
    ? Prompt.filePart({
        data: `data:${part.mediaType};base64,${Buffer.from(part.data).toString("base64")}`,
        mediaType: part.mediaType,
      })
    : undefined
