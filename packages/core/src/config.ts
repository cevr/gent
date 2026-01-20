import { Schema } from "effect"
import { PermissionRule } from "./permission"

// Agent Mode

export const AgentMode = Schema.Literal("build", "plan")
export type AgentMode = typeof AgentMode.Type

// Model Configuration

export class ModelConfig extends Schema.Class<ModelConfig>("ModelConfig")({
  default: Schema.String,
  plan: Schema.optional(Schema.String),
}) {}

// Gent Configuration

export class GentConfig extends Schema.Class<GentConfig>("GentConfig")({
  models: ModelConfig,
  permissions: Schema.optional(Schema.Array(PermissionRule)),
}) {}

// Default Configuration

export const defaultConfig: GentConfig = new GentConfig({
  models: new ModelConfig({
    default: "anthropic/claude-sonnet-4",
    plan: "anthropic/claude-sonnet-4",
  }),
  permissions: [],
})
