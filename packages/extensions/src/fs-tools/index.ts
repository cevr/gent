import { defineExtension, defineResource } from "@gent/core/extensions/api"
import { ReadTool } from "./read.js"
import { WriteTool } from "./write.js"
import { EditTool } from "./edit.js"
import { GlobTool } from "./glob.js"
import { GrepTool } from "./grep.js"
import { FsRead } from "./read-service.js"

export const FsToolsExtension = defineExtension({
  id: "@gent/fs-tools",
  resources: [defineResource({ scope: "process", layer: FsRead.Live })],
  tools: [ReadTool, WriteTool, EditTool, GlobTool, GrepTool],
})
