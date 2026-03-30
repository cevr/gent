/**
 * Builtin TUI client extensions — each follows the same ExtensionClientModule
 * contract as user/project extensions. Registered as an array so individual
 * builtins can be disabled by id.
 */

import type { ExtensionClientModule } from "@gent/core/domain/extension-client.js"
import tools from "./tools.client"
import plan from "./plan.client"
import auto from "./auto.client"
import tasks from "./tasks.client"
import connection from "./connection.client"
import interactions from "./interactions.client"

export const BUILTIN_CLIENT_EXTENSIONS: ReadonlyArray<ExtensionClientModule> = [
  tools,
  plan,
  auto,
  tasks,
  connection,
  interactions,
]
