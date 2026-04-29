import { Schema } from "effect"
import { AgentName, RunSpecSchema } from "../../domain/agent.js"
import { Message } from "../../domain/message.js"
import {
  ActorCommandId,
  BranchId,
  InteractionRequestId,
  MessageId,
  SessionId,
  ToolCallId,
} from "../../domain/ids.js"
import { SteerCommand } from "../../domain/steer.js"

export { SteerCommand }

export class AgentLoopError extends Schema.TaggedErrorClass<AgentLoopError>()("AgentLoopError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

const QueuedTurnCommandOptionFields = {
  agentOverride: Schema.optional(AgentName),
  runSpec: Schema.optional(RunSpecSchema),
  interactive: Schema.optional(Schema.Boolean),
}

const LoopTargetFields = {
  sessionId: SessionId,
  branchId: BranchId,
}

export const SubmitTurnCommand = Schema.TaggedStruct("SubmitTurn", {
  message: Message,
  ...QueuedTurnCommandOptionFields,
})
export type SubmitTurnCommand = typeof SubmitTurnCommand.Type

export const RunTurnCommand = Schema.TaggedStruct("RunTurn", {
  message: Message,
  ...QueuedTurnCommandOptionFields,
})
export type RunTurnCommand = typeof RunTurnCommand.Type

export const ApplySteerCommand = Schema.TaggedStruct("ApplySteer", {
  command: SteerCommand,
})
export type ApplySteerCommand = typeof ApplySteerCommand.Type

export const RespondInteractionCommand = Schema.TaggedStruct("RespondInteraction", {
  ...LoopTargetFields,
  requestId: InteractionRequestId,
})
export type RespondInteractionCommand = typeof RespondInteractionCommand.Type

export const RecordToolResultCommand = Schema.TaggedStruct("RecordToolResult", {
  ...LoopTargetFields,
  commandId: Schema.optional(ActorCommandId),
  toolCallId: ToolCallId,
  toolName: Schema.String,
  output: Schema.Unknown,
  isError: Schema.optional(Schema.Boolean),
})
export type RecordToolResultCommand = typeof RecordToolResultCommand.Type

export const InvokeToolCommand = Schema.TaggedStruct("InvokeTool", {
  ...LoopTargetFields,
  commandId: Schema.optional(ActorCommandId),
  toolName: Schema.String,
  input: Schema.Unknown,
})
export type InvokeToolCommand = typeof InvokeToolCommand.Type

export const LoopCommand = Schema.Union([
  SubmitTurnCommand,
  RunTurnCommand,
  ApplySteerCommand,
  RespondInteractionCommand,
  RecordToolResultCommand,
  InvokeToolCommand,
])
export type LoopCommand = typeof LoopCommand.Type

export const makeCommandId = () => ActorCommandId.make(Bun.randomUUIDv7())
export const toolCallIdForCommand = (commandId: ActorCommandId) => ToolCallId.make(commandId)
export const assistantMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.make(`${commandId}:assistant`)
export const toolResultMessageIdForCommand = (commandId: ActorCommandId) =>
  MessageId.make(`${commandId}:tool-result`)
