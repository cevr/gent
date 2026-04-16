import { extension } from "@gent/core/extensions/api"
import { ReadTool } from "./read.js"
import { WriteTool } from "./write.js"
import { EditTool } from "./edit.js"
import { GlobTool } from "./glob.js"
import { GrepTool } from "./grep.js"

export const FsToolsExtension = extension("@gent/fs-tools", ({ ext }) =>
  ext.tools(ReadTool, WriteTool, EditTool, GlobTool, GrepTool),
)
