import { Schema } from "effect"
import { ModelId } from "../model"

export const AgentKind = Schema.Literal("primary", "subagent", "system")
export type AgentKind = typeof AgentKind.Type

export const AgentName = Schema.Literal(
  "default",
  "deep",
  "explore",
  "architect",
  "compaction",
  "title",
)
export type AgentName = typeof AgentName.Type

export class AgentDefinition extends Schema.Class<AgentDefinition>("AgentDefinition")({
  name: AgentName,
  description: Schema.optional(Schema.String),
  kind: AgentKind,
  hidden: Schema.optional(Schema.Boolean),
  systemPromptAddendum: Schema.optional(Schema.String),
  allowedTools: Schema.optional(Schema.Array(Schema.String)),
  deniedTools: Schema.optional(Schema.Array(Schema.String)),
  preferredModel: Schema.optional(ModelId),
  temperature: Schema.optional(Schema.Number),
  canDelegateToAgents: Schema.optional(Schema.Array(AgentName)),
}) {}

export type AgentDefinitionInput = ConstructorParameters<typeof AgentDefinition>[0]

export const defineAgent = (input: AgentDefinitionInput): AgentDefinition =>
  new AgentDefinition(input)
