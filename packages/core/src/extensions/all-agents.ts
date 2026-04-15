/**
 * Collects all builtin agent definitions from their respective extensions.
 * Used by test-utils and TUI that need agent definitions for setup/resolution.
 *
 * Production code registers agents via extension setup — do not import this
 * to register agents. Use the extension API instead.
 */

import { type AgentDefinition } from "./api.js"
import { CoreAgents } from "./agents.js"
import { architect } from "./research/index.js"
import { auditor } from "./audit/index.js"
import { librarian } from "./librarian/index.js"

export const AllBuiltinAgents: ReadonlyArray<AgentDefinition> = [
  ...CoreAgents,
  architect,
  auditor,
  librarian,
]

/**
 * Backward-compat keyed object for test files that use `Agents.cowork` etc.
 * Prefer `AllBuiltinAgents` array for new code.
 */
export const Agents = Object.fromEntries(AllBuiltinAgents.map((a) => [a.name, a])) as Record<
  string,
  AgentDefinition
>
