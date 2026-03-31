import { extension } from "./api.js"
import { ReadTool } from "../tools/read.js"
import { WriteTool } from "../tools/write.js"
import { EditTool } from "../tools/edit.js"
import { GlobTool } from "../tools/glob.js"
import { GrepTool } from "../tools/grep.js"

export const FsToolsExtension = extension("@gent/fs-tools", (ext) => {
  ext.tool(ReadTool)
  ext.tool(WriteTool)
  ext.tool(EditTool)
  ext.tool(GlobTool)
  ext.tool(GrepTool)
})
