import { defineExtension, tool } from "@gent/core/extensions/api"
import { ReadTool } from "./read.js"
import { WriteTool } from "./write.js"
import { EditTool } from "./edit.js"
import { GlobTool } from "./glob.js"
import { GrepTool } from "./grep.js"

export const FsToolsExtension = defineExtension({
  id: "@gent/fs-tools",
  // ReadTool is already a Capability (authored via `tool(...)` directly,
  // the new B11.5 shape); the other four still go through the legacy
  // `tool(defineTool({...}))` double-wrap pending mass migration.
  capabilities: [ReadTool, tool(WriteTool), tool(EditTool), tool(GlobTool), tool(GrepTool)],
})
