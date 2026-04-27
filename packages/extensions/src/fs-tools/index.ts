import { defineExtension } from "@gent/core/extensions/api"
import { ReadTool } from "./read.js"
import { WriteTool } from "./write.js"
import { EditTool } from "./edit.js"
import { GlobTool } from "./glob.js"
import { GrepTool } from "./grep.js"

export const FsToolsExtension = defineExtension({
  id: "@gent/fs-tools",
  tools: [ReadTool, WriteTool, EditTool, GlobTool, GrepTool],
})
