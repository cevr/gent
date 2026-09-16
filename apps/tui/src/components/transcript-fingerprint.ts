/**
 * What a transcript item looks like on screen, as a value that does not depend
 * on how the item was built.
 *
 * Two readers compare transcript items for identity: native history decides
 * what already reached scrollback, and the display boundary decides what a
 * `/clear` already dismissed. Both used a JSON encode of the whole item, which
 * carries key order — and the feed built one message two ways, so the same
 * message encoded to two different strings. Native history replayed and
 * cleared the terminal's saved lines; the boundary would report an unchanged
 * tool call as changed.
 *
 * Naming the drawn fields in a fixed order answers both. A rebuild is silent;
 * new text, a completed tool call, and a changed event still change the value.
 *
 * @module
 */

import { Predicate, Schema } from "effect"
import type { AssistantSegment, SessionItem, ToolCall } from "./message-list"

const encodeFingerprint = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** The tool-call fields that change what a reader sees, nested calls included. */
export const toolFingerprint = (call: ToolCall): ReadonlyArray<unknown> => [
  call.id,
  call.toolName,
  call.status,
  call.summary,
  call.output,
  call.durationMs,
  (call.operations ?? []).map(toolFingerprint),
]

/** One answer piece, by what it draws rather than by its encoding. */
export const segmentFingerprint = (segment: AssistantSegment): ReadonlyArray<unknown> => {
  if (segment._tag === "tool-call") return [segment._tag, toolFingerprint(segment.toolCall)]
  if (segment._tag === "image") return [segment._tag, segment.image.mediaType]
  return [segment._tag, segment.content]
}

/** A tool call as one comparable string. */
export const toolIdentity = (call: ToolCall): string => encodeFingerprint(toolFingerprint(call))

/** A segment as one comparable string. */
export const segmentIdentity = (segment: AssistantSegment): string =>
  encodeFingerprint(segmentFingerprint(segment))

const isMessageItem = Predicate.or(
  Predicate.isTagged("regular-message"),
  Predicate.isTagged("interjection-message"),
)

/** A whole transcript item as one comparable string. */
export const transcriptFingerprint = (item: SessionItem): string => {
  if (isMessageItem(item))
    return encodeFingerprint([
      item._tag,
      item.id,
      item.role,
      item.content,
      item.reasoning,
      item.images.length,
      item.createdAt,
      item.pendingMode,
      (item.toolCalls ?? []).map(toolFingerprint),
      (item.segments ?? []).map(segmentFingerprint),
      item.metadata?.customType,
      item.metadata?.hidden,
    ])
  if (item._tag === "turn-ended")
    return encodeFingerprint([
      item._tag,
      item.createdAt,
      item.seq,
      item.durationSeconds,
      item.steps.count,
      item.steps.toolCalls,
      item.steps.costUsd,
    ])
  if (item._tag === "error")
    return encodeFingerprint([item._tag, item.createdAt, item.seq, item.error])
  if (item._tag === "retrying")
    return encodeFingerprint([
      item._tag,
      item.createdAt,
      item.seq,
      item.attempt,
      item.maxAttempts,
      item.delayMs,
      item.resolved,
    ])
  return encodeFingerprint([item._tag, item.createdAt, item.seq])
}
