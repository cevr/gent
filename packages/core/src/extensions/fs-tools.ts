import { Effect } from "effect"
import { defineExtension } from "../domain/extension.js"
import { ReadTool } from "../tools/read.js"
import { WriteTool } from "../tools/write.js"
import { EditTool } from "../tools/edit.js"
import { GlobTool } from "../tools/glob.js"
import { GrepTool } from "../tools/grep.js"

export const FsToolsExtension = defineExtension({
  manifest: { id: "@gent/fs-tools" },
  setup: () =>
    Effect.succeed({
      tools: [ReadTool, WriteTool, EditTool, GlobTool, GrepTool],
    }),
})
