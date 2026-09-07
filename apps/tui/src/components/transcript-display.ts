import { Option, Predicate, Schema } from "effect"
import type { AssistantSegment, Message, SessionItem } from "./message-list"

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const isMessage = Predicate.or(
  Predicate.isTagged("regular-message"),
  Predicate.isTagged("interjection-message"),
)
const isTextSegment = Predicate.or(Predicate.isTagged("text"), Predicate.isTagged("reasoning"))

interface MessageBoundary {
  readonly content: string
  readonly reasoning: string
  readonly imageCount: number
  readonly segments: readonly string[]
  readonly tools: ReadonlyMap<string, string>
}

export interface TranscriptDisplayBoundary {
  readonly items: ReadonlySet<string>
  readonly messages: ReadonlyMap<string, MessageBoundary>
}

const itemKey = (item: SessionItem): string => {
  if (isMessage(item)) return item.id
  return `${item._tag}:${item.createdAt}:${item.seq}`
}

const segmentContent = (segment: AssistantSegment): string => {
  if (isTextSegment(segment)) return segment.content
  return encode(segment)
}

export function captureTranscriptDisplay(items: SessionItem[]): TranscriptDisplayBoundary {
  const messages = new Map<string, MessageBoundary>()
  for (const item of items) {
    if (!isMessage(item)) continue
    messages.set(item.id, {
      content: item.content,
      reasoning: item.reasoning,
      imageCount: item.images.length,
      segments: (item.segments ?? []).map(segmentContent),
      tools: new Map((item.toolCalls ?? []).map((tool) => [tool.id, encode(tool)])),
    })
  }
  return { items: new Set(items.map(itemKey)), messages }
}

const afterPrefix = (content: string, prefix: string): string => {
  if (content.startsWith(prefix)) return content.slice(prefix.length)
  return content
}

function projectMessage(message: Message, boundary: MessageBoundary): Message {
  const segments: AssistantSegment[] = []
  for (const [index, segment] of (message.segments ?? []).entries()) {
    const previous = boundary.segments[index] ?? ""
    if (isTextSegment(segment)) {
      const content = afterPrefix(segment.content, previous)
      if (content.length > 0) segments.push({ ...segment, content })
    } else if (segmentContent(segment) !== previous) {
      segments.push(segment)
    }
  }
  const toolCalls = Option.map(Option.fromNullishOr(message.toolCalls), (tools) =>
    tools.filter((tool) => boundary.tools.get(tool.id) !== encode(tool)),
  )
  return {
    ...message,
    content: afterPrefix(message.content, boundary.content),
    reasoning: afterPrefix(message.reasoning, boundary.reasoning),
    images: message.images.slice(boundary.imageCount),
    segments: Option.getOrUndefined(
      Option.map(Option.fromNullishOr(message.segments), () => segments),
    ),
    toolCalls: Option.getOrUndefined(toolCalls),
  }
}

export function projectTranscriptDisplay(
  items: SessionItem[],
  boundary: TranscriptDisplayBoundary,
): SessionItem[] {
  const visible: SessionItem[] = []
  for (const item of items) {
    if (!boundary.items.has(itemKey(item))) {
      visible.push(item)
      continue
    }
    if (!isMessage(item)) continue
    const cleared = Option.fromNullishOr(boundary.messages.get(item.id))
    if (Option.isSome(cleared)) visible.push(projectMessage(item, cleared.value))
  }
  return visible
}
