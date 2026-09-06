import { Predicate } from "effect"
import type { AgentEvent, EventEnvelope } from "@gent/core-internal/domain/event"

type ToolLifecycleEvent = Extract<
  AgentEvent,
  { readonly _tag: "ToolCallStarted" | "ToolCallSucceeded" | "ToolCallFailed" }
>

const hasToolLifecycleTag = Predicate.or(
  Predicate.isTagged("ToolCallStarted"),
  Predicate.or(Predicate.isTagged("ToolCallSucceeded"), Predicate.isTagged("ToolCallFailed")),
)
const isToolLifecycleEvent: Predicate.Refinement<AgentEvent, ToolLifecycleEvent> = (
  event,
): event is ToolLifecycleEvent => hasToolLifecycleTag(event)

export const isToolEventFor =
  (toolName: string) =>
  (envelope: EventEnvelope): envelope is EventEnvelope & { readonly event: ToolLifecycleEvent } =>
    isToolLifecycleEvent(envelope.event) && envelope.event.toolName === toolName

type ToolResultEvent = Extract<
  AgentEvent,
  { readonly _tag: "ToolCallSucceeded" | "ToolCallFailed" }
>

const hasToolResultTag = Predicate.or(
  Predicate.isTagged("ToolCallSucceeded"),
  Predicate.isTagged("ToolCallFailed"),
)
const isToolResultEvent: Predicate.Refinement<AgentEvent, ToolResultEvent> = (
  event,
): event is ToolResultEvent => hasToolResultTag(event)

export const isToolResultFor =
  (toolName: string) =>
  (envelope: EventEnvelope): envelope is EventEnvelope & { readonly event: ToolResultEvent } =>
    isToolResultEvent(envelope.event) && envelope.event.toolName === toolName
