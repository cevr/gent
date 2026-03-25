import type { GentExtension } from "../domain/extension.js"
import { FsToolsExtension } from "./fs-tools.js"
import { ExecToolsExtension } from "./exec-tools.js"
import { NetworkToolsExtension } from "./network-tools.js"
import { SubagentToolsExtension } from "./subagent-tools.js"
import { InteractionToolsExtension } from "./interaction-tools.js"
import { SessionToolsExtension } from "./session-tools.js"
import { TaskToolsExtension } from "./task-tools.js"
import { WorkflowToolsExtension } from "./workflow-tools.js"
import { AgentsExtension } from "./agents.js"
import { PlanModeExtension } from "./plan-mode.js"

export {
  FsToolsExtension,
  ExecToolsExtension,
  NetworkToolsExtension,
  SubagentToolsExtension,
  InteractionToolsExtension,
  SessionToolsExtension,
  TaskToolsExtension,
  WorkflowToolsExtension,
  AgentsExtension,
  PlanModeExtension,
}

export const BuiltinExtensions: ReadonlyArray<GentExtension> = [
  FsToolsExtension,
  ExecToolsExtension,
  NetworkToolsExtension,
  SubagentToolsExtension,
  InteractionToolsExtension,
  SessionToolsExtension,
  TaskToolsExtension,
  WorkflowToolsExtension,
  AgentsExtension,
  PlanModeExtension,
]
