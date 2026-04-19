import { defineExtension, tool } from "@gent/core/extensions/api"
import { ReadTool } from "./read.js"
import { WriteTool } from "./write.js"
import { EditTool } from "./edit.js"
import { GlobTool } from "./glob.js"
import { GrepTool } from "./grep.js"

export const FsToolsExtension = defineExtension({
  id: "@gent/fs-tools",
  capabilities: [tool(ReadTool), tool(WriteTool), tool(EditTool), tool(GlobTool), tool(GrepTool)],
})
