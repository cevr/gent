import { Option } from "effect"
import * as Prompt from "effect/unstable/ai/Prompt"
import type * as Response from "effect/unstable/ai/Response"

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
